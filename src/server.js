import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CurfewEngine } from './engine.js';
import { ADAPTER_CATALOG, autoDetectRouter } from './adapters/index.js';
import { LocalDnsSinkhole, CATEGORY_PRESETS } from './dns-sinkhole.js';
import { normalizeMac, isValidMac, formatDuration, todayKey } from './state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function decodeParam(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw httpError(400, 'Invalid resource ID');
  }
}

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
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    req.on('data', (c) => {
      if (settled) return;
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      totalBytes += buf.length;
      if (totalBytes > 1e6) {
        settled = true;
        req.pause();
        reject(httpError(413, 'Request body too large (max 1MB)'));
        return;
      }
      chunks.push(buf);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return reject(httpError(400, 'Invalid JSON request body'));
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return reject(httpError(400, 'JSON request body must be an object'));
      }
      resolve(parsed);
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function isValidHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
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
      dnsSinkhole.startError = err.message;
      console.warn(`[curfewd] DNS sinkhole skipped on UDP :${sinkPort} (${err.message})`);
    }
  }

  let stopDaemon = null;
  if (enableDaemon) {
    stopDaemon = engine.startDaemon();
  }

  const server = http.createServer(async (req, res) => {
    try {
      let url;
      try {
        url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Invalid request URL' });
      }
      const p = url.pathname;

      if (req.method === 'GET' && p === '/api/health') {
        return sendJson(res, 200, { ok: true, name: 'curfewd', date: todayKey() });
      }

      if (req.method === 'GET' && p === '/api/state') {
        const state = engine.store.load();
        let deviceError = null;
        const devices = await engine.listDevices().catch((e) => {
          deviceError = e.message || 'Device discovery failed';
          return [];
        });
        const dateStr = todayKey();
        const quotas = (state.quotas || []).map((q) => {
          const entry = q.usageByDate?.[dateStr] || { usedSeconds: 0, bonusSeconds: 0, blockedToday: false };
          const limitSec = q.dailyLimitSeconds + (entry.bonusSeconds || 0);
          const macs = q.macs || [];
          return {
            id: q.id,
            name: q.name,
            macs,
            targetMacs: macs,
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

        const router = {
          driver: state.router.driver,
          gatewayUrl: state.router.gatewayUrl || '',
          username: state.router.username || '',
          hasPassword: Boolean(state.router.password),
          customHooks: {
            blockCmd: state.router.blockCmd || '',
            unblockCmd: state.router.unblockCmd || '',
            listCmd: state.router.listCmd || ''
          },
          pollIntervalSec: state.router.pollIntervalSec || 60
        };

        const dns = {
          enabled: state.dns.enabled !== false,
          port: dnsSinkhole.port,
          upstream: state.dns.upstream || '1.1.1.1',
          listening: Boolean(dnsSinkhole.server),
          active: Boolean(dnsSinkhole.server),
          error: dnsSinkhole.startError || dnsSinkhole.lastError || null,
          lanIp: getLanIp(),
          blockedCategories: state.blockedCategories || [],
          blockedDomains: state.blockedDomains || [],
          customBlockedDomains: state.customBlockedDomains || [],
          recentQueries: dnsSinkhole.queryLog.slice(0, 60)
        };

        const daemon = {
          running: Boolean(stopDaemon),
          pollIntervalSec: state.router.pollIntervalSec || 60,
          lastTickAt: engine._lastTickAt,
          lastSyncSummary: engine._lastSyncSummary
        };

        const presetsList = Object.values(CATEGORY_PRESETS);

        return sendJson(res, 200, {
          ok: true,
          time: new Date().toISOString(),
          setupCompleted: Boolean(state.setupCompleted),
          router,
          daemon,
          deviceError,
          devices,
          adapters: Object.values(ADAPTER_CATALOG),
          categoryPresets: presetsList,
          categories: presetsList,
          dns,
          quotas,
          schedules: state.schedules || [],
          pausedDevices: state.pausedDevices || {},
          aliases: state.aliases || {},
          pinnedMacs: state.pinnedMacs || [],
          auditLog: state.auditLog || [],
          state: engine.store.redactForClient(state)
        });
      }

      if (req.method === 'GET' && p === '/api/router/detect') {
        const detected = await autoDetectRouter();
        return sendJson(res, 200, detected);
      }

      if (req.method === 'POST' && p === '/api/setup') {
        const body = await readJson(req);
        const currentState = engine.store.load();
        const nextRouter = { ...currentState.router };

        let nextDriver = nextRouter.driver || 'universal';
        if (body.driver !== undefined) {
          const drv = String(body.driver || '').trim();
          if (!Object.hasOwn(ADAPTER_CATALOG, drv)) {
            throw httpError(400, `Unknown router driver: "${drv}"`);
          }
          nextDriver = drv;
        }

        const isOptionalGateway = nextDriver === 'universal' || nextDriver === 'custom';
        if (body.gatewayUrl !== undefined) {
          const gw = String(body.gatewayUrl ?? '').trim();
          if (gw === '') {
            if (!isOptionalGateway) {
              throw httpError(400, `gatewayUrl is required for driver "${nextDriver}"`);
            }
            nextRouter.gatewayUrl = '';
          } else if (nextDriver === 'universal' && gw === 'auto') {
            nextRouter.gatewayUrl = 'auto';
          } else {
            if (!isValidHttpUrl(gw)) {
              throw httpError(400, `Invalid gatewayUrl "${gw}": must start with http:// or https://`);
            }
            nextRouter.gatewayUrl = gw;
          }
        } else if (!isOptionalGateway && !isValidHttpUrl(nextRouter.gatewayUrl)) {
          throw httpError(400, `Valid http(s) gatewayUrl is required for driver "${nextDriver}"`);
        }

        nextRouter.driver = nextDriver;

        if (body.username !== undefined) {
          nextRouter.username = String(body.username ?? '').trim();
        }
        if (body.password !== undefined && body.password !== '••••••••') {
          nextRouter.password = String(body.password ?? '');
        }

        const hooks = body.customHooks && typeof body.customHooks === 'object' ? body.customHooks : {};
        if (hooks.blockCmd !== undefined || body.blockCmd !== undefined) {
          nextRouter.blockCmd = String((hooks.blockCmd !== undefined ? hooks.blockCmd : body.blockCmd) ?? '').trim();
        }
        if (hooks.unblockCmd !== undefined || body.unblockCmd !== undefined) {
          nextRouter.unblockCmd = String((hooks.unblockCmd !== undefined ? hooks.unblockCmd : body.unblockCmd) ?? '').trim();
        }
        if (hooks.listCmd !== undefined || body.listCmd !== undefined) {
          nextRouter.listCmd = String((hooks.listCmd !== undefined ? hooks.listCmd : body.listCmd) ?? '').trim();
        }

        if (body.pollIntervalSec !== undefined && body.pollIntervalSec !== null && String(body.pollIntervalSec).trim() !== '') {
          const sec = Number(body.pollIntervalSec);
          if (!Number.isInteger(sec) || sec < 5 || sec > 3600) {
            throw httpError(400, 'pollIntervalSec must be an integer between 5 and 3600');
          }
          nextRouter.pollIntervalSec = sec;
        }

        const testRes = await engine
          .getAdapter({ ...currentState, router: nextRouter })
          .testConnection()
          .catch((e) => ({ ok: false, detail: e.message }));

        const fresh = await engine.runStateWrite(() => {
          const s = engine.store.load();
          s.router = nextRouter;
          s.setupCompleted = true;
          engine.store.appendAudit(s, 'SETUP', nextRouter.driver, testRes.detail || 'Updated router configuration');
          engine.store.save(s);
          return s;
        });

        if (stopDaemon) {
          stopDaemon();
          stopDaemon = engine.startDaemon(fresh.router.pollIntervalSec);
        }

        const router = {
          driver: fresh.router.driver,
          gatewayUrl: fresh.router.gatewayUrl || '',
          username: fresh.router.username || '',
          hasPassword: Boolean(fresh.router.password),
          customHooks: {
            blockCmd: fresh.router.blockCmd || '',
            unblockCmd: fresh.router.unblockCmd || '',
            listCmd: fresh.router.listCmd || ''
          },
          pollIntervalSec: fresh.router.pollIntervalSec || 60
        };

        return sendJson(res, 200, {
          ok: true,
          router,
          test: testRes,
          setupCompleted: true,
          state: engine.store.redactForClient(fresh)
        });
      }

      if (req.method === 'POST' && p === '/api/devices/alias') {
        const body = await readJson(req);
        if (!isValidMac(body.mac)) {
          return sendJson(res, 400, { ok: false, error: 'Valid mac is required' });
        }
        const mac = normalizeMac(body.mac);
        const state = engine.store.load();
        const aliasInput = body.name !== undefined ? body.name : body.alias;
        if (aliasInput !== undefined) {
          const trimmed = String(aliasInput ?? '').trim();
          if (trimmed) state.aliases[mac] = trimmed;
          else delete state.aliases[mac];
        }
        if (body.pinned === true && !state.pinnedMacs.includes(mac)) state.pinnedMacs.push(mac);
        if (body.pinned === false) state.pinnedMacs = state.pinnedMacs.filter((m) => m !== mac);
        engine.store.appendAudit(state, 'DEVICE_ALIAS', mac, state.aliases[mac] ? `Renamed to ${state.aliases[mac]}` : 'Updated device preferences');
        engine.store.save(state);
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && p === '/api/devices/pause') {
        const body = await readJson(req);
        const target = body.target !== undefined ? body.target : body.mac;
        if (!target || !String(target).trim()) {
          return sendJson(res, 400, { ok: false, error: 'target or mac is required' });
        }
        const resPause = await engine.pauseDevice(target, body.duration ?? null, body.reason || 'Dashboard pause');
        return sendJson(res, 200, { ok: true, pause: resPause, sync: resPause.sync });
      }

      if (req.method === 'POST' && p === '/api/devices/resume') {
        const body = await readJson(req);
        const target = body.target !== undefined ? body.target : body.mac;
        if (!target || !String(target).trim()) {
          return sendJson(res, 400, { ok: false, error: 'target or mac is required' });
        }
        const resResume = await engine.resumeDevice(target, body.reason || 'Dashboard resume');
        return sendJson(res, 200, { ok: true, resume: resResume, sync: resResume.sync });
      }

      if (req.method === 'POST' && p === '/api/quotas') {
        const body = await readJson(req);
        const q = engine.setQuota({
          id: body.id,
          name: body.name,
          macs: body.macs,
          targetMacs: body.targetMacs,
          limit: body.limit,
          dailyLimitMinutes: body.dailyLimitMinutes,
          enabled: body.enabled
        });
        await engine.tick().catch(() => {});
        return sendJson(res, 200, { ok: true, quota: q });
      }

      if (req.method === 'POST' && p === '/api/quotas/bonus') {
        const body = await readJson(req);
        const minutes = body.minutes !== undefined ? body.minutes : '30m';
        const q = engine.addQuotaBonus(body.id, minutes);
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
        const id = decodeParam(p.slice('/api/quotas/'.length));
        engine.removeQuota(id);
        await engine.tick().catch(() => {});
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && p === '/api/schedules') {
        const body = await readJson(req);
        const sched = engine.setSchedule(body);
        await engine.tick().catch(() => {});
        return sendJson(res, 200, { ok: true, schedule: sched });
      }

      if (req.method === 'POST' && p === '/api/schedules/toggle') {
        const body = await readJson(req);
        if (!body.id || !String(body.id).trim()) {
          return sendJson(res, 400, { ok: false, error: 'Schedule id is required' });
        }
        if (typeof body.enabled !== 'boolean') {
          return sendJson(res, 400, { ok: false, error: 'enabled (boolean) is required' });
        }
        const sched = engine.toggleSchedule(body.id, body.enabled);
        await engine.tick().catch(() => {});
        return sendJson(res, 200, { ok: true, schedule: sched });
      }

      if (req.method === 'DELETE' && p.startsWith('/api/schedules/')) {
        const id = decodeParam(p.slice('/api/schedules/'.length));
        engine.removeSchedule(id);
        await engine.tick().catch(() => {});
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && p === '/api/dns/category') {
        const body = await readJson(req);
        if (!body.category || typeof body.category !== 'string') {
          return sendJson(res, 400, { ok: false, error: 'category is required' });
        }
        if (typeof body.enabled !== 'boolean') {
          return sendJson(res, 400, { ok: false, error: 'enabled (boolean) is required' });
        }
        engine.toggleCategory(body.category, body.enabled);
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && p === '/api/dns/domain') {
        const body = await readJson(req);
        const domain = String(body.domain ?? '').trim();
        if (!domain) {
          return sendJson(res, 400, { ok: false, error: 'domain is required' });
        }
        const action = body.action === undefined ? 'block' : String(body.action);
        if (action !== 'block' && action !== 'unblock') {
          return sendJson(res, 400, { ok: false, error: 'action must be "block" or "unblock"' });
        }
        if (action === 'unblock') engine.unblockDomain(domain);
        else engine.blockDomain(domain);
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && p === '/api/dns/test') {
        const body = await readJson(req);
        const domain = String(body.domain ?? '').trim();
        if (!domain) {
          return sendJson(res, 400, { ok: false, error: 'domain is required' });
        }
        if (!dnsSinkhole.server) {
          const result = {
            domain,
            ok: false,
            error: dnsSinkhole.startError || 'DNS sinkhole is not running'
          };
          return sendJson(res, 200, { ok: true, result });
        }
        const result = await dnsSinkhole.testQuery(domain);
        return sendJson(res, 200, { ...result, ok: true, result });
      }

      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }

      sendJson(res, 404, { ok: false, error: 'Not found' });
    } catch (err) {
      const status = err.status || 500;
      sendJson(res, status, { ok: false, error: err.message || 'Internal error' });
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
      if (stopDaemon) {
        stopDaemon();
        stopDaemon = null;
      }
      await dnsSinkhole.stop();
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}
