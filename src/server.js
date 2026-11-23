import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CurfewEngine } from './engine.js';
import { ADAPTER_CATALOG, autoDetectRouter, createAdapter } from './adapters/index.js';
import { LocalDnsSinkhole, CATEGORY_PRESETS } from './dns-sinkhole.js';
import { normalizeMac, formatDuration, todayKey } from './state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');

function getLanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254.')) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

export async function startServer({
  homeDir,
  port,
  dnsPort,
  enableDns = true,
  enableDaemon = true,
  host = '127.0.0.1',
  adapter = null
} = {}) {
  const engine = new CurfewEngine({ homeDir, adapter });
  const initialState = engine.store.load();
  const webPort = port !== undefined ? Number(port) : Number(process.env.PORT || initialState.web.port || 4320);
  const sinkPort = dnsPort !== undefined ? Number(dnsPort) : Number(process.env.DNS_PORT || initialState.dns.port || 5354);

  const dnsSinkhole = new LocalDnsSinkhole({
    port: sinkPort,
    upstreamHost: initialState.dns.upstream || '1.1.1.1',
    isBlockedFn: (domain, clientIp) => engine.evaluateDnsQuery(domain, clientIp)
  });

  if (enableDns && initialState.dns.enabled !== false) {
    try {
      await dnsSinkhole.start();
    } catch (err) {
      console.warn(`[curfewd] DNS sinkhole skipped on UDP :${sinkPort} (${err.message})`);
    }
  }

  let stopDaemon = null;
  if (enableDaemon) {
    stopDaemon = engine.startDaemon();
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const p = url.pathname;

      if (req.method === 'GET' && p === '/api/health') {
        return sendJson(res, 200, { ok: true, name: 'curfewd', date: todayKey() });
      }

      if (req.method === 'GET' && p === '/api/state') {
        const state = engine.store.load();
        const devices = await engine.listDevices().catch(() => []);
        const dateStr = todayKey();
        const quotas = (state.quotas || []).map((q) => {
          const entry = q.usageByDate?.[dateStr] || { usedSeconds: 0, bonusSeconds: 0, blockedToday: false };
          const limitSec = q.dailyLimitSeconds + (entry.bonusSeconds || 0);
          return {
            id: q.id,
            name: q.name,
            macs: q.macs,
            enabled: q.enabled,
            dailyLimitSeconds: q.dailyLimitSeconds,
            bonusSeconds: entry.bonusSeconds || 0,
            usedSeconds: entry.usedSeconds || 0,
            limitSeconds: limitSec,
            remainingSeconds: Math.max(0, limitSec - (entry.usedSeconds || 0)),
            blockedToday: Boolean(entry.blockedToday),
            usedFormatted: formatDuration(entry.usedSeconds || 0),
            limitFormatted: formatDuration(limitSec),
            remainingFormatted: formatDuration(Math.max(0, limitSec - (entry.usedSeconds || 0)))
          };
        });

        return sendJson(res, 200, {
          state: engine.store.redactForClient(state),
          devices,
          quotas,
          adapters: Object.values(ADAPTER_CATALOG),
          categories: Object.values(CATEGORY_PRESETS),
          dns: {
            lanIp: getLanIp(),
            port: dnsSinkhole.port,
            active: Boolean(dnsSinkhole.server),
            recentQueries: dnsSinkhole.queryLog.slice(0, 60)
          }
        });
      }

      if (req.method === 'GET' && p === '/api/router/detect') {
        const detected = await autoDetectRouter();
        return sendJson(res, 200, detected);
      }

      if (req.method === 'POST' && p === '/api/setup') {
        const body = await readJson(req);
        const state = engine.store.load();
        if (body.driver && ADAPTER_CATALOG[body.driver]) state.router.driver = body.driver;
        if (body.gatewayUrl) state.router.gatewayUrl = String(body.gatewayUrl).trim();
        if (body.username !== undefined) state.router.username = String(body.username).trim();
        if (body.password !== undefined && body.password !== '••••••••') {
          state.router.password = String(body.password);
        }
        if (body.blockCmd !== undefined) state.router.blockCmd = String(body.blockCmd).trim();
        if (body.unblockCmd !== undefined) state.router.unblockCmd = String(body.unblockCmd).trim();
        if (body.listCmd !== undefined) state.router.listCmd = String(body.listCmd).trim();
        if (body.pollIntervalSec) state.router.pollIntervalSec = Math.max(15, Number(body.pollIntervalSec));
        state.setupCompleted = true;

        const testRes = await createAdapter(state.router).testConnection().catch((e) => ({ ok: false, detail: e.message }));
        engine.store.appendAudit(state, 'SETUP', state.router.driver, testRes.detail || 'Updated router configuration');
        engine.store.save(state);
        return sendJson(res, 200, { ok: true, test: testRes, state: engine.store.redactForClient(state) });
      }

      if (req.method === 'POST' && p === '/api/devices/alias') {
        const body = await readJson(req);
        const mac = normalizeMac(body.mac);
        if (!mac) return sendJson(res, 400, { error: 'mac is required' });
        const state = engine.store.load();
        if (body.alias) state.aliases[mac] = String(body.alias).trim();
        else delete state.aliases[mac];
        if (body.pinned === true && !state.pinnedMacs.includes(mac)) state.pinnedMacs.push(mac);
        if (body.pinned === false) state.pinnedMacs = state.pinnedMacs.filter((m) => m !== mac);
        engine.store.save(state);
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && p === '/api/devices/pause') {
        const body = await readJson(req);
        if (!body.mac) return sendJson(res, 400, { error: 'mac is required' });
        const resPause = await engine.pauseDevice(body.mac, body.duration ?? null, body.reason || 'Dashboard pause');
        return sendJson(res, 200, { ok: true, pause: resPause });
      }

      if (req.method === 'POST' && p === '/api/devices/resume') {
        const body = await readJson(req);
        if (!body.mac) return sendJson(res, 400, { error: 'mac is required' });
        const resResume = await engine.resumeDevice(body.mac, 'Dashboard resume');
        return sendJson(res, 200, { ok: true, resume: resResume });
      }

      if (req.method === 'POST' && p === '/api/quotas') {
        const body = await readJson(req);
        const q = engine.setQuota({
          id: body.id,
          name: body.name,
          macs: body.macs,
          limit: body.limit
        });
        await engine.tick().catch(() => {});
        return sendJson(res, 200, { ok: true, quota: q });
      }

      if (req.method === 'POST' && p === '/api/quotas/bonus') {
        const body = await readJson(req);
        const q = engine.addQuotaBonus(body.id, body.minutes || '30m');
        await engine.tick().catch(() => {});
        return sendJson(res, 200, { ok: true, quota: q });
      }

      if (req.method === 'POST' && p === '/api/quotas/reset') {
        const body = await readJson(req);
        const q = engine.resetQuotaToday(body.id);
        await engine.tick().catch(() => {});
        return sendJson(res, 200, { ok: true, quota: q });
      }

      if (req.method === 'DELETE' && p.startsWith('/api/quotas/')) {
        const id = decodeURIComponent(p.slice('/api/quotas/'.length));
        engine.removeQuota(id);
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && p === '/api/schedules') {
        const body = await readJson(req);
        const sched = engine.setSchedule(body);
        await engine.tick().catch(() => {});
        return sendJson(res, 200, { ok: true, schedule: sched });
      }

      if (req.method === 'POST' && p === '/api/dns/category') {
        const body = await readJson(req);
        engine.toggleCategory(body.category, Boolean(body.enabled));
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && p === '/api/dns/domain') {
        const body = await readJson(req);
        if (body.action === 'unblock') engine.unblockDomain(body.domain);
        else engine.blockDomain(body.domain);
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && p === '/api/dns/test') {
        const body = await readJson(req);
        const result = await dnsSinkhole.testQuery(body.domain || 'roblox.com');
        return sendJson(res, 200, result);
      }

      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      sendJson(res, 500, { error: err.message || 'Internal error' });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(webPort, host, () => resolve());
  });

  const actualPort = server.address().port;
  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    dnsPort: dnsSinkhole.port,
    engine,
    dnsSinkhole,
    async close() {
      if (stopDaemon) stopDaemon();
      await dnsSinkhole.stop();
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}
