import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import curfewd, {
  CurfewEngine,
  parseDurationMinutes,
  formatDuration,
  normalizeMac,
  isScheduleActiveNow,
  LocalDnsSinkhole,
  ADAPTER_CATALOG,
  createAdapter,
  startServer
} from '../src/index.js';
import { isValidMac, StateStore } from '../src/state.js';
import { parseDnsQuestion, buildDnsQueryPacket } from '../src/dns-sinkhole.js';
import {
  UniversalAdapter,
  parseArpOutput,
  parseIpNeighOutput,
  parseNdpOutput
} from '../src/adapters/universal.js';
import { AttBgwAdapter } from '../src/adapters/att-bgw.js';
import { OpenWrtAdapter } from '../src/adapters/openwrt.js';
import { UniFiAdapter } from '../src/adapters/unifi.js';
import { AsusWrtAdapter } from '../src/adapters/asuswrt.js';
import { NetgearAdapter } from '../src/adapters/netgear.js';
import { CustomAdapter } from '../src/adapters/custom.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.resolve(__dirname, '../bin/curfewd.mjs');

function makeTempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curfewd-test-'));
  if (t) {
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  }
  return dir;
}

function createMockAdapter(initialDevices = [], { stateless = false, failSync = false } = {}) {
  const blocked = new Set();
  return {
    id: 'mock',
    blocked,
    devices: initialDevices,
    throwOnList: null,
    async testConnection() {
      return { ok: true, model: 'MockRouter', detail: 'ok' };
    },
    async listDevices() {
      if (this.throwOnList) throw this.throwOnList;
      return this.devices;
    },
    async blockDevice({ mac }) {
      if (failSync) return { ok: false, mode: 'mock-block', detail: 'Simulated router failure' };
      blocked.add(normalizeMac(mac));
      return { ok: true, mode: 'mock-block' };
    },
    async unblockDevice({ mac }) {
      if (failSync) return { ok: false, mode: 'mock-unblock', detail: 'Simulated router failure' };
      blocked.delete(normalizeMac(mac));
      return { ok: true, mode: 'mock-unblock' };
    },
    async isDeviceBlocked({ mac }) {
      if (stateless) return null;
      return blocked.has(normalizeMac(mac));
    }
  };
}

async function startMockHttpServer(t, handler) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    await handler(req, res, body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${addr.port}`;
}

// ============================================================================
// Suite 1: State, MAC Validation & Persistence (F1)
// ============================================================================

test('Suite 1.1: normalizeMac & isValidMac handle valid formats and reject invalid input', () => {
  assert.equal(normalizeMac('AA-BB-CC-1-2-3'), 'aa:bb:cc:01:02:03');
  assert.equal(normalizeMac('AA:BB:CC:DD:EE:FF'), 'aa:bb:cc:dd:ee:ff');
  assert.equal(normalizeMac('aabb.ccdd.eeff'), 'aa:bb:cc:dd:ee:ff');
  assert.equal(normalizeMac('  01-23-45-67-89-ab  '), '01:23:45:67:89:ab');

  assert.equal(normalizeMac('not-a-mac'), '');
  assert.equal(normalizeMac('zz:bb:cc:dd:ee:ff'), '');
  assert.equal(normalizeMac('123:bb:cc:dd:ee:ff'), '');
  assert.equal(normalizeMac('aa:bb:cc:dd:ee'), '');
  assert.equal(normalizeMac('aa:bb-cc:dd:ee:ff'), '');
  assert.equal(normalizeMac('aa:bb:cc:dd:ee:ff; rm -rf /'), '');
  assert.equal(normalizeMac(''), '');
  assert.equal(normalizeMac(null), '');

  assert.equal(isValidMac('aa:bb:cc:dd:ee:ff'), true);
  assert.equal(isValidMac('AABB.CCDD.EEFF'), true);
  assert.equal(isValidMac('invalid'), false);
});

test('Suite 1.2: duration parsing and formatting', () => {
  assert.equal(parseDurationMinutes('1h30m'), 90);
  assert.equal(parseDurationMinutes('1:30'), 90);
  assert.equal(parseDurationMinutes('90m'), 90);
  assert.equal(parseDurationMinutes(45), 45);
  assert.equal(parseDurationMinutes(0), 0);
  assert.equal(parseDurationMinutes('abc'), null);
  assert.equal(parseDurationMinutes('-5'), null);
  assert.equal(formatDuration(5400), '1h 30m');
});

test('Suite 1.3: StateStore.save uses PID-safe atomic writes and load sanitizes invalid MACs', (t) => {
  const homeDir = makeTempHome(t);
  const store = new StateStore(homeDir);
  store.ensure();

  const raw = JSON.parse(fs.readFileSync(store.stateFile, 'utf8'));
  raw.pinnedMacs = ['AA-BB-CC-1-2-3', 'not-a-mac', 'aa:bb:cc:01:02:03'];
  raw.enforcedBlocks = ['bad-mac', 'AABB.CCDD.EEFF'];
  raw.pendingUnblockMacs = ['aa:bb:cc:dd:ee:ff', 'bad'];
  raw.blockedDomains = [{ domain: 'custom.example', category: 'custom', enabled: true }];
  fs.writeFileSync(store.stateFile, JSON.stringify(raw, null, 2));

  const loaded = store.load();
  assert.deepEqual(loaded.pinnedMacs, ['aa:bb:cc:01:02:03']);
  assert.deepEqual(loaded.enforcedBlocks, ['aa:bb:cc:dd:ee:ff']);
  assert.deepEqual(loaded.pendingUnblockMacs, ['aa:bb:cc:dd:ee:ff']);
  assert.deepEqual(loaded.customBlockedDomains, ['custom.example']);

  store.save(loaded);
  const files = fs.readdirSync(homeDir);
  assert.deepEqual(files, ['state.json']);
});

// ============================================================================
// Suite 2: Engine Core, Schedules, Quotas, Orphan Cleanup & DNS Policy (F2, F3, F6)
// ============================================================================

test('Suite 2.1: overnight and same-day schedule evaluation including numeric days & validation', () => {
  const sched = {
    enabled: true,
    days: ['Mon'],
    startTime: '21:00',
    endTime: '07:00',
    targetMacs: ['aa:bb:cc:dd:ee:ff']
  };
  assert.equal(isScheduleActiveNow(sched, new Date(2026, 10, 23, 22, 0)), true);
  assert.equal(isScheduleActiveNow(sched, new Date(2026, 10, 24, 6, 30)), true);
  assert.equal(isScheduleActiveNow(sched, new Date(2026, 10, 24, 8, 0)), false);

  // Numeric day 1 = Monday, same-day range
  const daySched = { enabled: true, days: [1], startTime: '09:00', endTime: '17:00' };
  assert.equal(isScheduleActiveNow(daySched, new Date(2026, 10, 23, 12, 0)), true);
  assert.equal(isScheduleActiveNow({ ...daySched, enabled: false }, new Date(2026, 10, 23, 12, 0)), false);
  assert.equal(isScheduleActiveNow({ ...daySched, startTime: '09:00', endTime: '09:00' }, new Date(2026, 10, 23, 9, 0)), false);
  assert.equal(isScheduleActiveNow({ ...daySched, startTime: 'bad' }, new Date(2026, 10, 23, 12, 0)), false);
});

test('Suite 2.2: daily quota tracks online usage, blocks at limit, unblocks on bonus and midnight reset', async (t) => {
  const homeDir = makeTempHome(t);
  const mac = 'aa:bb:cc:dd:ee:01';
  const adapter = createMockAdapter([
    { mac, name: 'Kids-PC', ipv4: '192.168.1.50', ipv6List: [], status: 'online', band: 'Wi-Fi' }
  ]);
  const guard = curfewd({ homeDir, adapter });
  guard.quota.set({ name: 'Kids PC', macs: [mac], limit: '2m' });

  const t0 = new Date(2026, 10, 23, 15, 0, 0);
  await guard.tick({ now: t0 });
  assert.equal(adapter.blocked.has(mac), false);

  await guard.tick({ now: new Date(t0.getTime() + 60_000) });
  assert.equal(adapter.blocked.has(mac), false);

  await guard.tick({ now: new Date(t0.getTime() + 120_000) });
  assert.equal(adapter.blocked.has(mac), true);

  guard.quota.bonus('Kids PC', '10m');
  await guard.tick({ now: new Date(t0.getTime() + 125_000) });
  assert.equal(adapter.blocked.has(mac), false);

  const tomorrow = new Date(2026, 10, 24, 9, 0, 0);
  await guard.tick({ now: tomorrow });
  assert.equal(adapter.blocked.has(mac), false);
});

test('Suite 2.3: orphaned router blocks are cleaned up across stateful AND stateless (isDeviceBlocked -> null) adapters', async (t) => {
  for (const stateless of [false, true]) {
    const homeDir = makeTempHome(t);
    const macA = 'aa:bb:cc:dd:ee:11';
    const macB = 'aa:bb:cc:dd:ee:12';
    const adapter = createMockAdapter(
      [
        { mac: macA, name: 'KidA', ipv4: '192.168.1.61', ipv6List: [], status: 'online', band: 'Wi-Fi' },
        { mac: macB, name: 'KidB', ipv4: '192.168.1.62', ipv6List: [], status: 'online', band: 'Wi-Fi' }
      ],
      { stateless }
    );
    const engine = new CurfewEngine({ homeDir, adapter });

    // Schedule blocks both devices
    const mon22 = new Date(2026, 10, 23, 22, 0);
    const sched = engine.setSchedule({
      id: 'bed',
      name: 'Bedtime',
      targetMacs: [macA, macB],
      days: [1],
      startTime: '21:00',
      endTime: '07:00'
    });
    await engine.tick({ now: mon22 });
    assert.equal(adapter.blocked.has(macA), true);
    assert.equal(adapter.blocked.has(macB), true);

    // Shrinking targetMacs to only macA must unblock macB on next tick
    engine.setSchedule({ ...sched, targetMacs: [macA] });
    await engine.tick({ now: mon22 });
    assert.equal(adapter.blocked.has(macA), true);
    assert.equal(adapter.blocked.has(macB), false);

    // Disabling schedule must unblock macA
    engine.toggleSchedule('bed', false);
    await engine.tick({ now: mon22 });
    assert.equal(adapter.blocked.has(macA), false);

    // Re-enable, then delete schedule -> must unblock macA
    engine.toggleSchedule('bed', true);
    await engine.tick({ now: mon22 });
    assert.equal(adapter.blocked.has(macA), true);
    engine.removeSchedule('bed');
    await engine.tick({ now: mon22 });
    assert.equal(adapter.blocked.has(macA), false);

    // Timed pause expires -> must unblock macA even on stateless adapter
    await engine.pauseDevice(macA, '5m');
    assert.equal(adapter.blocked.has(macA), true);
    await engine.tick({ now: new Date(Date.now() + 10 * 60_000) });
    assert.equal(adapter.blocked.has(macA), false);

    // Quota hits limit then removed -> must unblock macA
    engine.setQuota({ id: 'q1', name: 'Kid Quota', targetMacs: [macA], dailyLimitMinutes: 1 });
    const qt0 = new Date(2026, 10, 23, 14, 0, 0);
    await engine.tick({ now: qt0 });
    await engine.tick({ now: new Date(qt0.getTime() + 65_000) });
    assert.equal(adapter.blocked.has(macA), true);
    engine.removeQuota('q1');
    await engine.tick({ now: new Date(qt0.getTime() + 70_000) });
    assert.equal(adapter.blocked.has(macA), false);
  }
});

test('Suite 2.4: engine validates schedules/quotas/pauses and handles DNS IPv4-mapped IPv6 & custom domains', async (t) => {
  const homeDir = makeTempHome(t);
  const mac = 'aa:bb:cc:dd:ee:21';
  const adapter = createMockAdapter([
    { mac, name: 'Phone', ipv4: '192.168.1.70', ipv6List: ['2001:db8::70'], status: 'online', band: 'Wi-Fi' }
  ]);
  const engine = new CurfewEngine({ homeDir, adapter });

  assert.throws(() => engine.setSchedule({ name: '', targetMacs: [mac], startTime: '21:00', endTime: '07:00' }), { status: 400 });
  assert.throws(() => engine.setSchedule({ name: 'Bed', targetMacs: [], startTime: '21:00', endTime: '07:00' }), { status: 400 });
  assert.throws(() => engine.setSchedule({ name: 'Bed', targetMacs: [mac], days: [9], startTime: '21:00', endTime: '07:00' }), { status: 400 });
  assert.throws(() => engine.setSchedule({ name: 'Bed', targetMacs: [mac], days: [1], startTime: '25:00', endTime: '07:00' }), { status: 400 });
  assert.throws(() => engine.toggleSchedule('missing', false), { status: 404 });
  assert.throws(() => engine.removeSchedule('missing'), { status: 404 });
  assert.throws(() => engine.removeQuota('missing'), { status: 404 });
  assert.throws(() => engine.setQuota({ name: 'Q', macs: [mac], limit: '0m' }), { status: 400 });
  await assert.rejects(() => engine.pauseDevice('unknown-device', '10m'), { status: 400 });
  await assert.rejects(() => engine.pauseDevice(mac, 'abc'), { status: 400 });

  // Cold _lastDevices check: pauseDevice populates pausedDevices IP fields, evaluateDnsQuery matches before tick()
  await engine.pauseDevice(mac, '10m');
  engine._lastDevices = []; // simulate cold engine instance
  assert.equal(engine.evaluateDnsQuery('example.com', '::ffff:192.168.1.70').blocked, true);
  assert.equal(engine.evaluateDnsQuery('example.com', '2001:db8::70').blocked, true);

  // Expired pause must not block DNS between ticks
  const state = engine.store.load();
  state.pausedDevices[mac].expiresAt = Date.now() - 1000;
  engine.store.save(state);
  assert.equal(engine.evaluateDnsQuery('example.com', '::ffff:192.168.1.70').blocked, false);

  // Custom blocked domain survives toggling overlapping category off
  engine.blockDomain('youtube.com');
  engine.toggleCategory('youtube', true);
  engine.toggleCategory('youtube', false);
  assert.equal(engine.evaluateDnsQuery('www.youtube.com', '192.168.1.99').blocked, true);
  assert.equal(engine.evaluateDnsQuery('youtu.be', '192.168.1.99').blocked, false);
});

// ============================================================================
// Suite 3: DNS Sinkhole (src/dns-sinkhole.js)
// ============================================================================

test('Suite 3.1: embedded RFC-1035 UDP DNS sinkhole blocks A & AAAA, handles !server and port conflicts', async (t) => {
  // Unstarted sinkhole returns fast (<200ms) with ok: false
  const cold = new LocalDnsSinkhole({ port: 5354 });
  const tStart = Date.now();
  const coldRes = await cold.testQuery('roblox.com');
  assert.equal(coldRes.ok, false);
  assert.ok(Date.now() - tStart < 500);

  // Malformed labels rejected
  assert.equal(buildDnsQueryPacket(''), null);
  const badBuf = Buffer.alloc(18, 0);
  badBuf[12] = 64; // >63 byte label
  assert.equal(parseDnsQuestion(badBuf), null);

  const sink = new LocalDnsSinkhole({
    port: 0,
    isBlockedFn: (domain) => ({
      blocked: domain === 'roblox.com' || domain.endsWith('.roblox.com'),
      reason: 'Blocked'
    })
  });
  await sink.start();
  t.after(() => sink.stop());

  const res = await sink.testQuery('www.roblox.com');
  assert.equal(res.ok, true);
  assert.equal(res.sinkholed, true);
  assert.equal(res.resolvedIp, '0.0.0.0');

  // AAAA query also sinkholed with ::
  const aaaaPacket = buildDnsQueryPacket('www.roblox.com', 28);
  const aaaaReply = await new Promise((resolve, reject) => {
    const c = dgram.createSocket('udp4');
    c.on('error', reject);
    c.on('message', (msg) => {
      c.close();
      resolve(msg);
    });
    c.send(aaaaPacket, sink.port, '127.0.0.1');
  });
  assert.equal(aaaaReply.readUInt16BE(6), 1);

  // Conflict on already-bound port sets startError and testQuery fails fast
  const conflict = new LocalDnsSinkhole({ port: sink.port });
  await assert.rejects(() => conflict.start());
  assert.ok(conflict.startError);
  const conflictTest = await conflict.testQuery('roblox.com');
  assert.equal(conflictTest.ok, false);
  assert.equal(conflictTest.error, conflict.startError);
});

// ============================================================================
// Suite 4: HTTP API Server (src/server.js)
// ============================================================================

test('Suite 4.1: HTTP API contracts, status codes (400/404/413), setup, CRUD & orphan unblocking', async (t) => {
  const homeDir = makeTempHome(t);
  const mac = 'aa:bb:cc:dd:ee:02';
  const adapter = createMockAdapter([
    { mac, name: 'Tablet', ipv4: '192.168.1.51', ipv6List: [], status: 'online', band: 'Wi-Fi' }
  ]);
  const srv = await startServer({
    homeDir,
    port: 0,
    dnsPort: 0,
    enableDns: true,
    enableDaemon: true,
    adapter
  });
  t.after(() => srv.close());

  const reqJson = async (pathname, opts = {}) => {
    const r = await fetch(`${srv.url}${pathname}`, {
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      ...opts,
      body: opts.rawBody !== undefined ? opts.rawBody : (opts.body ? JSON.stringify(opts.body) : undefined)
    });
    const data = await r.json();
    return { status: r.status, data };
  };

  // Health + state shape
  const health = await reqJson('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);

  const stateRes = await reqJson('/api/state');
  assert.equal(stateRes.status, 200);
  assert.equal(stateRes.data.ok, true);
  assert.equal(stateRes.data.devices.length, 1);
  assert.equal(stateRes.data.adapters.length, 7);
  assert.equal(stateRes.data.deviceError, null);
  assert.equal(stateRes.data.dns.listening, true);
  assert.equal(stateRes.data.daemon.running, true);
  assert.ok(Array.isArray(stateRes.data.categoryPresets));

  // Device discovery failure surfaces deviceError cleanly
  adapter.throwOnList = new Error('Router unreachable');
  const errState = await reqJson('/api/state');
  assert.equal(errState.status, 200);
  assert.equal(errState.data.deviceError, 'Router unreachable');
  assert.deepEqual(errState.data.devices, []);
  adapter.throwOnList = null;

  // Setup validation & field clearing
  assert.equal((await reqJson('/api/setup', { method: 'POST', body: { driver: 'bogus' } })).status, 400);
  assert.equal((await reqJson('/api/setup', { method: 'POST', body: { driver: 'openwrt', gatewayUrl: 'ftp://bad' } })).status, 400);
  assert.equal((await reqJson('/api/setup', { method: 'POST', body: { pollIntervalSec: 2 } })).status, 400);

  const setupOk = await reqJson('/api/setup', {
    method: 'POST',
    body: {
      driver: 'custom',
      gatewayUrl: '',
      username: '',
      password: '',
      customHooks: { blockCmd: 'echo {{mac}}', unblockCmd: '', listCmd: '' },
      pollIntervalSec: 10
    }
  });
  assert.equal(setupOk.status, 200);
  assert.equal(setupOk.data.router.pollIntervalSec, 10);
  assert.equal(setupOk.data.router.customHooks.blockCmd, 'echo {{mac}}');

  // Alias & pause/resume
  assert.equal((await reqJson('/api/devices/alias', { method: 'POST', body: { mac: 'bad' } })).status, 400);
  assert.equal((await reqJson('/api/devices/alias', { method: 'POST', body: { mac, name: 'Kid Tablet', pinned: true } })).status, 200);
  assert.equal((await reqJson('/api/devices/pause', { method: 'POST', body: { target: mac, duration: 'bad' } })).status, 400);

  const pauseRes = await reqJson('/api/devices/pause', { method: 'POST', body: { target: mac, duration: '15m' } });
  assert.equal(pauseRes.status, 200);
  assert.equal(pauseRes.data.sync.ok, true);
  assert.equal(adapter.blocked.has(mac), true);

  const resumeRes = await reqJson('/api/devices/resume', { method: 'POST', body: { target: mac } });
  assert.equal(resumeRes.status, 200);
  assert.equal(adapter.blocked.has(mac), false);

  // Schedule CRUD + active block + toggle off unblock + delete unblock
  const now = new Date();
  const prevMin = (now.getHours() * 60 + now.getMinutes() - 5 + 1440) % 1440;
  const nextMin = (now.getHours() * 60 + now.getMinutes() + 15) % 1440;
  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  assert.equal((await reqJson('/api/schedules', { method: 'POST', body: { name: '', targetMacs: [mac] } })).status, 400);
  assert.equal((await reqJson('/api/schedules/toggle', { method: 'POST', body: { id: 'missing', enabled: false } })).status, 404);
  assert.equal((await reqJson('/api/schedules/missing', { method: 'DELETE' })).status, 404);

  const schedCreate = await reqJson('/api/schedules', {
    method: 'POST',
    body: {
      id: 'focus-now',
      name: 'Focus Now',
      targetMacs: [mac],
      days: [0, 1, 2, 3, 4, 5, 6],
      startTime: fmt(prevMin),
      endTime: fmt(nextMin)
    }
  });
  assert.equal(schedCreate.status, 200);
  assert.equal(adapter.blocked.has(mac), true);

  const schedToggleOff = await reqJson('/api/schedules/toggle', {
    method: 'POST',
    body: { id: 'focus-now', enabled: false }
  });
  assert.equal(schedToggleOff.status, 200);
  assert.equal(adapter.blocked.has(mac), false);

  const schedDelete = await reqJson('/api/schedules/focus-now', { method: 'DELETE' });
  assert.equal(schedDelete.status, 200);

  // Quota CRUD + 400/404 + DELETE triggers immediate unblock
  assert.equal((await reqJson('/api/quotas/bonus', { method: 'POST', body: { id: 'missing', minutes: '10m' } })).status, 404);
  assert.equal((await reqJson('/api/quotas/missing', { method: 'DELETE' })).status, 404);
  const qCreate = await reqJson('/api/quotas', {
    method: 'POST',
    body: { id: 'tablet-q', name: 'Tablet Quota', targetMacs: [mac], dailyLimitMinutes: 30 }
  });
  assert.equal(qCreate.status, 200);
  assert.equal((await reqJson('/api/quotas/bonus', { method: 'POST', body: { id: 'tablet-q', minutes: 0 } })).status, 400);
  assert.equal((await reqJson('/api/quotas/tablet-q', { method: 'DELETE' })).status, 200);

  // DNS API validation + test
  assert.equal((await reqJson('/api/dns/category', { method: 'POST', body: { category: 'nope', enabled: true } })).status, 400);
  assert.equal((await reqJson('/api/dns/domain', { method: 'POST', body: { domain: '', action: 'block' } })).status, 400);
  assert.equal((await reqJson('/api/dns/test', { method: 'POST', body: { domain: '' } })).status, 400);
  const dnsTest = await reqJson('/api/dns/test', { method: 'POST', body: { domain: 'roblox.com' } });
  assert.equal(dnsTest.status, 200);
  assert.equal(dnsTest.data.result.ok, true);

  // Malformed JSON (400), missing route (404), >1MB body (413)
  const badJson = await reqJson('/api/setup', { method: 'POST', rawBody: '{broken' });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.data.ok, false);

  const notFound = await reqJson('/api/nonexistent');
  assert.equal(notFound.status, 404);
  assert.equal(notFound.data.ok, false);

  const huge = JSON.stringify({ pad: 'x'.repeat(1_050_000) });
  const tooLarge = await reqJson('/api/setup', { method: 'POST', rawBody: huge });
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.data.ok, false);

  const html = await fetch(`${srv.url}/`).then((r) => r.text());
  assert.ok(html.includes('curfewd'));
});

test('Suite 4.2: POST /api/dns/test fast-fails without hanging when DNS sinkhole is disabled', async (t) => {
  const homeDir = makeTempHome(t);
  const srv = await startServer({
    homeDir,
    port: 0,
    dnsPort: 0,
    enableDns: false,
    enableDaemon: false,
    adapter: createMockAdapter([])
  });
  t.after(() => srv.close());

  const t0 = Date.now();
  const r = await fetch(`${srv.url}/api/dns/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain: 'roblox.com' })
  });
  const data = await r.json();
  assert.equal(r.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.result.ok, false);
  assert.ok(Date.now() - t0 < 500);
});

// ============================================================================
// Suite 5: Router Adapters (src/adapters/*.js)
// ============================================================================

test('Suite 5.1: UniversalAdapter parses macOS arp, Linux arp [ether], ip neigh, and filters multicast NDP', async () => {
  const arpMap = parseArpOutput([
    '? (192.168.1.1) at aa:bb:cc:1:2:3 on en0 ifscope [ethernet]',
    '? (192.168.1.25) at aa:bb:cc:dd:ee:05 [ether] on eth0',
    '? (224.0.0.251) at 01:00:5e:00:00:fb on en0 ifscope permanent [ethernet]'
  ].join('\n'));
  assert.equal(arpMap.size, 2);
  assert.equal(arpMap.get('aa:bb:cc:01:02:03').ipv4, '192.168.1.1');
  assert.equal(arpMap.get('aa:bb:cc:dd:ee:05').band, 'LAN (eth0)');

  const neighMap = parseIpNeighOutput([
    '192.168.1.1 dev eth0 lladdr aa:bb:cc:dd:ee:01 router REACHABLE',
    '192.168.1.255 dev eth0 lladdr ff:ff:ff:ff:ff:ff PERMANENT'
  ].join('\n'));
  assert.equal(neighMap.size, 1);
  assert.equal(neighMap.get('aa:bb:cc:dd:ee:01').status, 'online');

  const ndpMap = parseNdpOutput([
    'ff02::2%en0                        33:33:00:00:00:02  en0 permanent R',
    '2001:db8::50                       aa:bb:cc:dd:ee:50  en0 23h59m59s S'
  ].join('\n'));
  assert.equal(ndpMap.size, 1);
  assert.equal(ndpMap.get('aa:bb:cc:dd:ee:50').ipv6, '2001:db8::50');

  const uni = new UniversalAdapter();
  const invalidRes = await uni.blockDevice({ mac: 'bad-mac' });
  assert.equal(invalidRes.ok, false);
});

test('Suite 5.2: AttBgwAdapter authenticates, parses devices, handles block/unblock, missing nonce & HTTP 500', async (t) => {
  let dropRules = 0;
  let forceMissingNonce = false;
  let force500 = false;

  const baseUrl = await startMockHttpServer(t, (req, res, body) => {
    if (force500) {
      res.writeHead(500);
      return res.end('Internal error');
    }
    if (req.url === '/cgi-bin/sysinfo.ha') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<table><tr><th>Model Number</th><td>BGW320-500</td></tr></table>');
    }
    if (req.url === '/cgi-bin/login.ha' && req.method === 'GET') {
      res.writeHead(200, { 'Set-Cookie': 'SessionID=abc123; Path=/' });
      return res.end('<form><input name="nonce" value="0123456789abcdef0123456789abcdef" /></form>');
    }
    if (req.url === '/cgi-bin/login.ha' && req.method === 'POST') {
      res.writeHead(302, { Location: '/cgi-bin/home.ha' });
      return res.end('');
    }
    if (req.url === '/cgi-bin/devices.ha') {
      res.writeHead(200);
      return res.end(`
        <table><tr><th>MAC Address</th><td>aa:bb:cc:dd:ee:31</td></tr>
        <tr><th>IPv4 Address / Name</th><td>192.168.1.80 / KidsPad</td></tr>
        <tr><th>Status</th><td>on</td></tr>
        <tr><th>Connection Type</th><td>Wi-Fi 5 GHz</td></tr></table>
      `);
    }
    if (req.url === '/cgi-bin/packetfilter.ha' && req.method === 'GET') {
      if (forceMissingNonce) {
        res.writeHead(200);
        return res.end('<div>No nonce here</div>');
      }
      const ruleHtml = dropRules > 0
        ? '<input name="Edit_1_1" value="aa:bb:cc:dd:ee:31" /><input name="Disable" />'
        : '<input name="Enable" />';
      res.writeHead(200);
      return res.end(`<form><input name="nonce" value="n1" />${ruleHtml}</form>`);
    }
    if (req.url === '/cgi-bin/packetfilter.ha' && req.method === 'POST') {
      if (body.includes('AddDropRule')) {
        res.writeHead(200);
        return res.end('<form><input name="nonce" value="n2" /><input name="AddMatch_1" /></form>');
      }
      if (body.includes('AddMatch_1')) {
        res.writeHead(200);
        return res.end('<form action="/cgi-bin/packetfilteredit.ha"><input name="nonce" value="e1" /></form>');
      }
      if (body.includes('DeleteRule_1')) dropRules = 0;
      res.writeHead(200);
      return res.end('<form><input name="nonce" value="n3" /></form>');
    }
    if (req.url === '/cgi-bin/packetfilteredit.ha') {
      if (body.includes('EnterMatch')) dropRules++;
      res.writeHead(200);
      return res.end('<form action="/cgi-bin/packetfilteredit.ha"><input name="nonce" value="e2" /></form>');
    }
    res.writeHead(404);
    res.end('');
  });

  const bgw = new AttBgwAdapter({ gatewayUrl: baseUrl, password: 'test-access-code' });
  const conn = await bgw.testConnection();
  assert.equal(conn.ok, true);
  assert.equal(conn.model, 'BGW320-500');

  const devs = await bgw.listDevices();
  assert.equal(devs.length, 1);
  assert.equal(devs[0].mac, 'aa:bb:cc:dd:ee:31');

  const blk = await bgw.blockDevice({ mac: 'aa:bb:cc:dd:ee:31', ipv4: '192.168.1.80' });
  assert.equal(blk.ok, true);
  assert.equal(await bgw.isDeviceBlocked({ mac: 'aa:bb:cc:dd:ee:31' }), true);

  const unblk = await bgw.unblockDevice({ mac: 'aa:bb:cc:dd:ee:31' });
  assert.equal(unblk.ok, true);

  forceMissingNonce = true;
  const badNonce = await bgw.blockDevice({ mac: 'aa:bb:cc:dd:ee:31' });
  assert.equal(badNonce.ok, false);
  forceMissingNonce = false;

  force500 = true;
  const errConn = await bgw.testConnection();
  assert.equal(errConn.ok, false);
});

test('Suite 5.3: OpenWrtAdapter retries expired ubus sessions and filters invalid MACs', async (t) => {
  let activeSession = 'sess-1';
  let loginCount = 0;
  let forceExpiredOnce = false;
  let forceHttp500 = false;

  const baseUrl = await startMockHttpServer(t, (req, res, body) => {
    if (forceHttp500) {
      res.writeHead(500);
      return res.end('Server error');
    }
    const rpc = JSON.parse(body);
    const [sess, obj, method] = rpc.params;
    if (obj === 'session' && method === 'login') {
      loginCount++;
      activeSession = `sess-${loginCount}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: [0, { ubus_rpc_session: activeSession }] }));
    }
    if (forceExpiredOnce) {
      forceExpiredOnce = false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: [6] }));
    }
    if (sess !== activeSession) {
      res.writeHead(401);
      return res.end('Unauthorized');
    }
    if (obj === 'luci-rpc' && method === 'getHostHints') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        result: [0, { 'aa:bb:cc:dd:ee:41': { name: 'Laptop', ipaddrs: ['192.168.1.41'] }, invalid: { name: 'Bad' } }]
      }));
    }
    if (obj === 'uci' && method === 'get') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: [0, { values: { src_mac: 'aa:bb:cc:dd:ee:41' } }] }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: [0, { model: 'OpenWrt Test' }] }));
  });

  const owrt = new OpenWrtAdapter({ gatewayUrl: baseUrl, username: 'root', password: 'pw' });
  const devs = await owrt.listDevices();
  assert.equal(devs.length, 1);
  assert.equal(devs[0].mac, 'aa:bb:cc:dd:ee:41');

  forceExpiredOnce = true;
  const blk = await owrt.blockDevice({ mac: 'aa:bb:cc:dd:ee:41' });
  assert.equal(blk.ok, true);
  assert.equal(loginCount, 2);

  forceHttp500 = true;
  const blkFail = await owrt.blockDevice({ mac: 'aa:bb:cc:dd:ee:41' });
  assert.equal(blkFail.ok, false);
});

test('Suite 5.4: UniFiAdapter handles multi-cookie, 401 re-auth retry, and block/unblock', async (t) => {
  let tokenVersion = 0;
  let force401Once = false;
  const cmds = [];

  const baseUrl = await startMockHttpServer(t, (req, res, body) => {
    if (req.url === '/api/auth/login') {
      tokenVersion++;
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': [`TOKEN=v${tokenVersion}; Path=/; HttpOnly`, 'EXTRA=1; Path=/'],
        'X-CSRF-Token': `csrf-${tokenVersion}`
      });
      return res.end(JSON.stringify({ meta: { rc: 'ok' } }));
    }
    if (force401Once) {
      force401Once = false;
      res.writeHead(401);
      return res.end('Expired');
    }
    if (req.url.endsWith('/stat/sta')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ mac: 'aa:bb:cc:dd:ee:51', hostname: 'AppleTV', ip: '192.168.1.51' }] }));
    }
    if (req.url.endsWith('/cmd/stamgr')) {
      cmds.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ meta: { rc: 'ok' } }));
    }
    res.writeHead(404);
    res.end('');
  });

  const unifi = new UniFiAdapter({ gatewayUrl: baseUrl, username: 'admin', password: 'pw' });
  const devs = await unifi.listDevices();
  assert.equal(devs.length, 1);

  force401Once = true;
  const blk = await unifi.blockDevice({ mac: 'aa:bb:cc:dd:ee:51' });
  assert.equal(blk.ok, true);
  assert.equal(tokenVersion, 2);
  assert.equal(cmds[0].cmd, 'block-sta');
});

test('Suite 5.5: AsusWrtAdapter preserves concurrent MULTIFILTER_MAC devices and refreshes expired tokens', async (t) => {
  let tokenNum = 0;
  let multifilterMac = '';
  let multifilterEnable = '0';
  let forceExpireOnce = false;

  const baseUrl = await startMockHttpServer(t, (req, res, body) => {
    if (req.url === '/login.cgi') {
      tokenNum++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ asus_token: `tok-${tokenNum}` }));
    }
    if (forceExpireOnce) {
      forceExpireOnce = false;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<script>location.href="Main_Login.asp"</script>');
    }
    if (req.url.startsWith('/appGet.cgi')) {
      const hook = new URL(req.url, 'http://localhost').searchParams.get('hook');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (hook === 'nvram_get(MULTIFILTER_MAC)') {
        return res.end(JSON.stringify({ MULTIFILTER_MAC: multifilterMac }));
      }
      return res.end(JSON.stringify({
        get_clientlist: {
          'AA:BB:CC:DD:EE:61': { mac: 'AA:BB:CC:DD:EE:61', name: 'Dev1', ip: '192.168.1.61', isOnline: '1', isWL: '2' },
          'AA:BB:CC:DD:EE:62': { mac: 'AA:BB:CC:DD:EE:62', name: 'Dev2', ip: '192.168.1.62', isOnline: '1', isWL: '1' }
        }
      }));
    }
    if (req.url === '/start_apply.htm') {
      const p = new URLSearchParams(body);
      multifilterEnable = p.get('MULTIFILTER_ENABLE');
      multifilterMac = p.get('MULTIFILTER_MAC');
      res.writeHead(200);
      return res.end('OK');
    }
    res.writeHead(404);
    res.end('');
  });

  const asus = new AsusWrtAdapter({ gatewayUrl: baseUrl, username: 'admin', password: 'pw' });
  const devs = await asus.listDevices();
  assert.equal(devs.length, 2);

  await asus.blockDevice({ mac: 'aa:bb:cc:dd:ee:61' });
  assert.equal(multifilterEnable, '1');
  assert.equal(multifilterMac, 'AA:BB:CC:DD:EE:61');

  forceExpireOnce = true;
  await asus.blockDevice({ mac: 'aa:bb:cc:dd:ee:62' });
  assert.equal(tokenNum, 2);
  assert.equal(multifilterMac, 'AA:BB:CC:DD:EE:61<AA:BB:CC:DD:EE:62');

  // Unblocking one device keeps the other blocked
  await asus.unblockDevice({ mac: 'aa:bb:cc:dd:ee:61' });
  assert.equal(multifilterEnable, '1');
  assert.equal(multifilterMac, 'AA:BB:CC:DD:EE:62');

  // Unblocking last device disables MULTIFILTER
  await asus.unblockDevice({ mac: 'aa:bb:cc:dd:ee:62' });
  assert.equal(multifilterEnable, '0');
  assert.equal(multifilterMac, '');
});

test('Suite 5.6: NetgearAdapter supports GetAttachDevice2, GetAttachDevice fallback, and SOAP fault handling', async (t) => {
  let useLegacyFallback = false;
  let forceFault = false;

  const baseUrl = await startMockHttpServer(t, (req, res, body) => {
    const action = req.headers.soapaction || '';
    res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
    if (action.includes('#Authenticate')) {
      return res.end('<Envelope><Body><AuthenticateResponse><ResponseCode>000</ResponseCode></AuthenticateResponse></Body></Envelope>');
    }
    if (action.includes('#GetAttachDevice2')) {
      if (useLegacyFallback) {
        return res.end('<Envelope><Body><SOAP-ENV:Fault><faultstring>Unsupported</faultstring></SOAP-ENV:Fault></Body></Envelope>');
      }
      return res.end(`<Envelope><Body><GetAttachDevice2Response><ResponseCode>000</ResponseCode><NewAttachDevice2>
        <Device><IP>192.168.1.71</IP><Name>Console</Name><MAC>AA:BB:CC:DD:EE:71</MAC><ConnectionType>5GHz</ConnectionType></Device>
      </NewAttachDevice2></GetAttachDevice2Response></Body></Envelope>`);
    }
    if (action.includes('#GetAttachDevice')) {
      return res.end('<Envelope><Body><GetAttachDeviceResponse><ResponseCode>000</ResponseCode><NewAttachDevice>1@1;192.168.1.72;Switch;AA:BB:CC:DD:EE:72;wireless</NewAttachDevice></GetAttachDeviceResponse></Body></Envelope>');
    }
    if (action.includes('#SetBlockDeviceByMAC')) {
      if (forceFault || !body.includes('AA:BB:CC:DD:EE:71')) {
        return res.end('<Envelope><Body><ResponseCode>501</ResponseCode></Body></Envelope>');
      }
      return res.end('<Envelope><Body><ResponseCode>000</ResponseCode></Body></Envelope>');
    }
    res.end('');
  });

  const ng = new NetgearAdapter({ gatewayUrl: baseUrl, username: 'admin', password: 'pw&<1>' });
  const devs2 = await ng.listDevices();
  assert.equal(devs2.length, 1);
  assert.equal(devs2[0].mac, 'aa:bb:cc:dd:ee:71');

  useLegacyFallback = true;
  const devs1 = await ng.listDevices();
  assert.equal(devs1.length, 1);
  assert.equal(devs1[0].mac, 'aa:bb:cc:dd:ee:72');

  const blkOk = await ng.blockDevice({ mac: 'aa:bb:cc:dd:ee:71' });
  assert.equal(blkOk.ok, true);

  forceFault = true;
  const blkFail = await ng.blockDevice({ mac: 'aa:bb:cc:dd:ee:71' });
  assert.equal(blkFail.ok, false);
});

test('Suite 5.7: CustomAdapter executes process.execPath hooks safely and rejects invalid MACs', async (t) => {
  const homeDir = makeTempHome(t);
  const outFile = path.join(homeDir, 'hook.txt');
  const listScript = `console.log(JSON.stringify([{ mac: 'AA:BB:CC:DD:EE:81', name: 'Box', ipv4: '192.168.1.81' }, { mac: 'bad', name: 'Bad' }]))`;
  const blockScript = `require('node:fs').writeFileSync(${JSON.stringify(outFile)}, '{{mac}}|{{ip}}')`;

  const custom = new CustomAdapter({
    listCmd: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(listScript)}`,
    blockCmd: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(blockScript)}`
  });

  const devs = await custom.listDevices();
  assert.equal(devs.length, 1);
  assert.equal(devs[0].mac, 'aa:bb:cc:dd:ee:81');

  const okRes = await custom.blockDevice({ mac: 'aa:bb:cc:dd:ee:81', ipv4: '192.168.1.81; echo pwn' });
  assert.equal(okRes.ok, true);
  // Tainted IP is stripped to empty string
  assert.equal(fs.readFileSync(outFile, 'utf8'), 'aa:bb:cc:dd:ee:81|');

  const badMacRes = await custom.blockDevice({ mac: 'aa:bb:cc:dd:ee:ff; touch pwn' });
  assert.equal(badMacRes.ok, false);
});

// ============================================================================
// Suite 6: CLI Argument & Flag Validation (bin/curfewd.mjs)
// ============================================================================

test('Suite 6.1: CLI --help succeeds and invalid --port / --dns-port flags fail immediately', async (t) => {
  const homeDir = makeTempHome(t);
  const env = { ...process.env, CURFEWD_HOME: homeDir };

  const help = await execFileAsync(process.execPath, [BIN_PATH, '--help'], { env });
  assert.ok(help.stdout.includes('curfewd'));

  for (const badArgs of [
    ['serve', '--port', 'abc'],
    ['serve', '--port'],
    ['serve', '--port', '70000'],
    ['serve', '--dns-port', 'nope']
  ]) {
    await assert.rejects(
      () => execFileAsync(process.execPath, [BIN_PATH, ...badArgs], { env, timeout: 3000 }),
      (err) => err.code !== 0
    );
  }
});

// ============================================================================
// Suite 7: Iteration 2 Hardening Regressions (Multi-quota, Races, TLS, URI, Daemon)
// ============================================================================

test('Suite 7.1: multi-quota evaluation on same MAC enforces strictest blocked quota in listDevices and evaluateDnsQuery', async (t) => {
  const homeDir = makeTempHome(t);
  const mac = 'aa:bb:cc:dd:ee:91';
  const adapter = createMockAdapter([
    { mac, name: 'KidsConsole', ipv4: '192.168.1.91', ipv6List: [], status: 'online', band: 'Wi-Fi' }
  ]);
  const engine = new CurfewEngine({ homeDir, adapter });

  // Q1 has a high 60m limit (not blocked); Q2 has a 1m limit (will block)
  engine.setQuota({ id: 'q-wide', name: 'All Devices', macs: [mac], limit: '60m' });
  engine.setQuota({ id: 'q-strict', name: 'Console Limit', macs: [mac], limit: '1m' });

  const t0 = new Date(2026, 10, 23, 16, 0, 0);
  await engine.tick({ now: t0 });
  await engine.tick({ now: new Date(t0.getTime() + 65_000) });

  assert.equal(adapter.blocked.has(mac), true);
  const devs = await engine.listDevices();
  assert.equal(devs[0].isBlocked, true);
  assert.equal(devs[0].quota.id, 'q-strict');
  assert.equal(devs[0].quota.blockedToday, true);

  const dns = engine.evaluateDnsQuery('example.com', '192.168.1.91');
  assert.equal(dns.blocked, true);
  assert.ok(dns.reason.includes('Console Limit'));

  // Disabled first quota must not shadow an enabled second quota
  engine.setQuota({ id: 'q-wide', name: 'All Devices', macs: [mac], limit: '60m', enabled: false });
  const devsAfterDisable = await engine.listDevices();
  assert.equal(devsAfterDisable[0].isBlocked, true);
  assert.equal(devsAfterDisable[0].quota.id, 'q-strict');
});

test('Suite 7.2: concurrent state writes during slow async tick, pauseDevice, and POST /api/setup are never clobbered', async (t) => {
  const homeDir = makeTempHome(t);
  const mac = 'aa:bb:cc:dd:ee:92';
  const baseAdapter = createMockAdapter([
    { mac, name: 'Tablet', ipv4: '192.168.1.92', ipv6List: [], status: 'online', band: 'Wi-Fi' }
  ]);

  let releaseList = null;
  let releaseBlock = null;
  let pauseListCalls = false;
  let pauseBlockCalls = false;

  const slowAdapter = {
    ...baseAdapter,
    async listDevices() {
      if (pauseListCalls) {
        await new Promise((resolve) => { releaseList = resolve; });
      }
      return baseAdapter.listDevices();
    },
    async blockDevice(arg) {
      if (pauseBlockCalls) {
        await new Promise((resolve) => { releaseBlock = resolve; });
      }
      return baseAdapter.blockDevice(arg);
    }
  };

  const engine = new CurfewEngine({ homeDir, adapter: slowAdapter });

  // 1. Mutate state while tick() is awaiting adapter.listDevices()
  pauseListCalls = true;
  const tickP1 = engine.tick({ now: new Date(2026, 10, 23, 17, 0, 0) });
  await new Promise((r) => setTimeout(r, 20));
  engine.blockDomain('tiktok.com');
  engine.setQuota({ id: 'q-race', name: 'Race Quota', macs: [mac], limit: '5m' });
  pauseListCalls = false;
  releaseList();
  await tickP1;

  let saved = engine.store.load();
  assert.ok(saved.customBlockedDomains.includes('tiktok.com'));
  assert.ok(saved.quotas.some((q) => q.id === 'q-race'));

  // 2. Mutate state while pauseDevice() is awaiting adapter.blockDevice()
  pauseBlockCalls = true;
  const pauseP = engine.pauseDevice(mac, '15m');
  await new Promise((r) => setTimeout(r, 20));
  engine.blockDomain('discord.com');
  pauseBlockCalls = false;
  releaseBlock();
  await pauseP;

  saved = engine.store.load();
  assert.ok(saved.customBlockedDomains.includes('discord.com'));
  assert.ok(saved.pausedDevices[mac]);

  // 3. Concurrent tick() calls at the same timestamp serialize cleanly without double-crediting quota seconds
  await engine.resumeDevice(mac);
  const tBase = new Date(2026, 10, 23, 17, 1, 0);
  await Promise.all([
    engine.tick({ now: tBase }),
    engine.tick({ now: tBase })
  ]);
  const quotaAfterDoubleTick = engine.store.load().quotas.find((q) => q.id === 'q-race');
  const todayEntry = Object.values(quotaAfterDoubleTick.usageByDate)[0];
  assert.equal(todayEntry.usedSeconds, 60);

  // 3b. Mutate state while tick() is awaiting adapter.blockDevice()
  pauseBlockCalls = true;
  // Advance quota to 5m limit (300s) so tick() calls adapter.blockDevice()
  for (let i = 1; i <= 3; i++) {
    if (i < 3) {
      pauseBlockCalls = false;
      await engine.tick({ now: new Date(tBase.getTime() + i * 120_000) });
    }
  }
  pauseBlockCalls = true;
  const tickP2 = engine.tick({ now: new Date(tBase.getTime() + 300_000) });
  await new Promise((r) => setTimeout(r, 20));
  engine.blockDomain('twitch.tv');
  engine.removeQuota('q-race');
  pauseBlockCalls = false;
  releaseBlock();
  await tickP2;

  saved = engine.store.load();
  assert.ok(saved.customBlockedDomains.includes('twitch.tv'));
  assert.equal(saved.quotas.some((q) => q.id === 'q-race'), false);
  assert.ok(saved.pendingUnblockMacs.includes(mac));

  // 4. POST /api/setup with slow testConnection() preserves concurrent domain block
  let releaseTestConn = null;
  const setupAdapter = {
    ...baseAdapter,
    async testConnection() {
      await new Promise((resolve) => { releaseTestConn = resolve; });
      return { ok: true, model: 'SlowRouter', detail: 'ok' };
    }
  };
  const srv = await startServer({
    homeDir: makeTempHome(t),
    port: 0,
    dnsPort: 0,
    enableDns: false,
    enableDaemon: false,
    adapter: setupAdapter
  });
  t.after(() => srv.close());

  const setupReq = fetch(`${srv.url}/api/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ driver: 'custom', customHooks: { blockCmd: 'echo {{mac}}' }, pollIntervalSec: 15 })
  });
  await new Promise((r) => setTimeout(r, 20));
  srv.engine.blockDomain('roblox.com');
  releaseTestConn();
  const setupRes = await setupReq;
  assert.equal(setupRes.status, 200);
  const srvState = srv.engine.store.load();
  assert.ok(srvState.customBlockedDomains.includes('roblox.com'));
  assert.equal(srvState.router.driver, 'custom');
  assert.equal(srvState.router.pollIntervalSec, 15);
});

test('Suite 7.3: AsusWrtAdapter fails closed on nvram_get 500 without wiping MULTIFILTER_MAC and ignores error_status 0', async (t) => {
  let loginCalls = 0;
  let applyCalls = 0;
  let multifilterMac = '11:22:33:44:55:66<AA:BB:CC:DD:EE:02';
  let failNvramGet = false;

  const baseUrl = await startMockHttpServer(t, (req, res, body) => {
    if (req.url === '/login.cgi') {
      loginCalls++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ asus_token: `tok-${loginCalls}` }));
    }
    if (req.url.startsWith('/appGet.cgi')) {
      const hook = new URL(req.url, 'http://localhost').searchParams.get('hook');
      if (hook === 'nvram_get(MULTIFILTER_MAC)') {
        if (failNvramGet) {
          res.writeHead(500);
          return res.end('NVRAM read error');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error_status: '0', MULTIFILTER_MAC: multifilterMac }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        error_status: '0',
        get_clientlist: {
          'AA:BB:CC:DD:EE:93': { mac: 'AA:BB:CC:DD:EE:93', name: 'TestDev', ip: '192.168.1.93', isOnline: '1', isWL: '2' }
        }
      }));
    }
    if (req.url === '/start_apply.htm') {
      applyCalls++;
      const p = new URLSearchParams(body);
      multifilterMac = p.get('MULTIFILTER_MAC');
      res.writeHead(200);
      return res.end('OK');
    }
    res.writeHead(404);
    res.end('');
  });

  const asus = new AsusWrtAdapter({ gatewayUrl: baseUrl, username: 'admin', password: 'pw' });
  const devs = await asus.listDevices();
  assert.equal(devs.length, 1);
  // error_status: "0" must NOT trigger extra re-authentication
  assert.equal(loginCalls, 1);

  failNvramGet = true;
  const blkErr = await asus.blockDevice({ mac: 'aa:bb:cc:dd:ee:93' });
  assert.equal(blkErr.ok, false);
  const unblkErr = await asus.unblockDevice({ mac: 'aa:bb:cc:dd:ee:02' });
  assert.equal(unblkErr.ok, false);
  assert.equal(applyCalls, 0);
  assert.equal(multifilterMac, '11:22:33:44:55:66<AA:BB:CC:DD:EE:02');
});

test('Suite 7.4: malformed percent-encoding returns 400, equal schedule times return 400, and daemon handles immediate SIGTERM', async (t) => {
  const homeDir = makeTempHome(t);
  const mac = 'aa:bb:cc:dd:ee:94';
  const srv = await startServer({
    homeDir,
    port: 0,
    dnsPort: 0,
    enableDns: false,
    enableDaemon: false,
    adapter: createMockAdapter([{ mac, name: 'Dev', ipv4: '192.168.1.94', ipv6List: [], status: 'online', band: 'Wi-Fi' }])
  });
  t.after(() => srv.close());

  const badQuotaDel = await fetch(`${srv.url}/api/quotas/%E0%A4%A`, { method: 'DELETE' });
  assert.equal(badQuotaDel.status, 400);
  assert.equal((await badQuotaDel.json()).ok, false);

  const badSchedDel = await fetch(`${srv.url}/api/schedules/%E0%A4%A`, { method: 'DELETE' });
  assert.equal(badSchedDel.status, 400);
  assert.equal((await badSchedDel.json()).ok, false);

  const equalSched = await fetch(`${srv.url}/api/schedules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Equal Window',
      targetMacs: [mac],
      days: [1],
      startTime: '21:00',
      endTime: '21:00'
    })
  });
  assert.equal(equalSched.status, 400);
  assert.equal((await equalSched.json()).ok, false);

  // Daemon SIGTERM clean exit
  const daemonHome = makeTempHome(t);
  const child = spawn(process.execPath, [BIN_PATH, 'daemon'], {
    env: { ...process.env, CURFEWD_HOME: daemonHome },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const exitResult = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Daemon did not exit on SIGTERM'));
    }, 3000);
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      if (out.includes('daemon running')) {
        child.kill('SIGTERM');
      }
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  assert.equal(exitResult.code, 0);
});

test('Suite 7.5: UniFiAdapter falls back to self-signed HTTPS on local private hosts', async (t) => {
  const certDir = makeTempHome(t);
  const keyPath = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');
  try {
    await execFileAsync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-days', '1', '-subj', '/CN=127.0.0.1'
    ]);
  } catch (err) {
    t.skip(`openssl unavailable: ${err.message}`);
    return;
  }

  const tlsServer = https.createServer(
    { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
    (req, res) => {
      if (req.url === '/api/auth/login') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': ['TOKEN=tls-tok; Path=/; HttpOnly'],
          'X-CSRF-Token': 'tls-csrf'
        });
        return res.end(JSON.stringify({ meta: { rc: 'ok' } }));
      }
      if (req.url.endsWith('/stat/sta')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ mac: 'aa:bb:cc:dd:ee:95', hostname: 'TlsDev', ip: '192.168.1.95' }] }));
      }
      if (req.url.endsWith('/cmd/stamgr')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ meta: { rc: 'ok' } }));
      }
      res.writeHead(404);
      res.end('');
    }
  );
  await new Promise((resolve) => tlsServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => tlsServer.close(() => resolve())));
  const addr = tlsServer.address();

  const unifi = new UniFiAdapter({
    gatewayUrl: `https://127.0.0.1:${addr.port}`,
    username: 'admin',
    password: 'pw'
  });
  const devs = await unifi.listDevices();
  assert.equal(devs.length, 1);
  assert.equal(devs[0].mac, 'aa:bb:cc:dd:ee:95');

  const blk = await unifi.blockDevice({ mac: 'aa:bb:cc:dd:ee:95' });
  assert.equal(blk.ok, true);
});

test('Suite 7.6: per-MAC router I/O serialization prevents tick() from inverting pauseDevice() and resumeDevice()', async (t) => {
  // Case 1 (Probe 2F): pauseDevice renewing an expired pause while tick() unblockDevice is in flight
  {
    const homeDir = makeTempHome(t);
    const mac = 'aa:bb:cc:dd:ee:96';
    const baseAdapter = createMockAdapter([
      { mac, name: 'Tablet', ipv4: '192.168.1.96', ipv6List: [], status: 'online', band: 'Wi-Fi' }
    ]);
    baseAdapter.blocked.add(mac);

    let unblockEnteredResolve = null;
    const unblockEntered = new Promise((r) => { unblockEnteredResolve = r; });
    let releaseUnblock = null;
    let holdUnblock = true;

    const adapter = {
      ...baseAdapter,
      async unblockDevice(arg) {
        if (holdUnblock) {
          unblockEnteredResolve();
          await new Promise((r) => { releaseUnblock = r; });
        }
        return baseAdapter.unblockDevice(arg);
      }
    };

    const engine = new CurfewEngine({ homeDir, adapter });
    const nowMs = Date.now();
    const st = engine.store.load();
    st.pausedDevices[mac] = {
      mac,
      ipv4: '192.168.1.96',
      ipv6List: [],
      pausedAt: new Date(nowMs - 60_000).toISOString(),
      expiresAt: nowMs - 10_000,
      durationMinutes: 1,
      reason: 'Old pause'
    };
    st.enforcedBlocks = [mac];
    engine.store.save(st);

    const tickP = engine.tick({ now: new Date(nowMs) });
    await unblockEntered;

    const pauseP = engine.pauseDevice(mac, '30m', 'Renewed pause');
    await new Promise((r) => setTimeout(r, 20));
    holdUnblock = false;
    releaseUnblock();

    await Promise.all([tickP, pauseP]);
    const finalState = engine.store.load();
    assert.equal(baseAdapter.blocked.has(mac), true);
    assert.equal(finalState.pausedDevices[mac]?.reason, 'Renewed pause');
    assert.equal(finalState.enforcedBlocks.includes(mac), true);
    assert.equal(engine._macSyncQueues.size, 0);
  }

  // Case 2: tick() waiting behind slow pauseDevice() sees renewed pause and does NOT unblock
  {
    const homeDir = makeTempHome(t);
    const mac = 'aa:bb:cc:dd:ee:98';
    const baseAdapter = createMockAdapter([
      { mac, name: 'Phone', ipv4: '192.168.1.98', ipv6List: [], status: 'online', band: 'Wi-Fi' }
    ]);
    baseAdapter.blocked.add(mac);

    let blockEnteredResolve = null;
    const blockEntered = new Promise((r) => { blockEnteredResolve = r; });
    let releaseBlock = null;
    let holdBlock = true;

    const adapter = {
      ...baseAdapter,
      async blockDevice(arg) {
        if (holdBlock) {
          blockEnteredResolve();
          await new Promise((r) => { releaseBlock = r; });
        }
        return baseAdapter.blockDevice(arg);
      }
    };

    const engine = new CurfewEngine({ homeDir, adapter });
    const nowMs = Date.now();
    const st = engine.store.load();
    st.pausedDevices[mac] = {
      mac,
      ipv4: '192.168.1.98',
      ipv6List: [],
      pausedAt: new Date(nowMs - 60_000).toISOString(),
      expiresAt: nowMs - 10_000,
      durationMinutes: 1,
      reason: 'Old pause'
    };
    st.enforcedBlocks = [mac];
    engine.store.save(st);

    const pauseP = engine.pauseDevice(mac, '30m', 'Renewed first');
    await blockEntered;

    const tickP = engine.tick({ now: new Date(nowMs) });
    await new Promise((r) => setTimeout(r, 20));
    holdBlock = false;
    releaseBlock();

    await Promise.all([pauseP, tickP]);
    const finalState = engine.store.load();
    assert.equal(baseAdapter.blocked.has(mac), true);
    assert.equal(finalState.pausedDevices[mac]?.reason, 'Renewed first');
    assert.equal(finalState.enforcedBlocks.includes(mac), true);
    assert.equal(engine._macSyncQueues.size, 0);
  }

  // Case 3 (Probe A): resumeDevice() while tick() blockDevice is in flight leaves router & state unblocked
  {
    const homeDir = makeTempHome(t);
    const mac = 'aa:bb:cc:dd:ee:80';
    const baseAdapter = createMockAdapter([
      { mac, name: 'Console', ipv4: '192.168.1.80', ipv6List: [], status: 'online', band: 'Wi-Fi' }
    ]);

    let blockEnteredResolve = null;
    const blockEntered = new Promise((r) => { blockEnteredResolve = r; });
    let releaseBlock = null;
    let holdBlock = true;

    const adapter = {
      ...baseAdapter,
      async blockDevice(arg) {
        if (holdBlock) {
          blockEnteredResolve();
          await new Promise((r) => { releaseBlock = r; });
        }
        return baseAdapter.blockDevice(arg);
      }
    };

    const engine = new CurfewEngine({ homeDir, adapter });
    const nowMs = Date.now();
    const st = engine.store.load();
    st.pausedDevices[mac] = {
      mac,
      ipv4: '192.168.1.80',
      ipv6List: [],
      pausedAt: new Date(nowMs - 5_000).toISOString(),
      expiresAt: nowMs + 600_000,
      durationMinutes: 10,
      reason: 'Active pause'
    };
    engine.store.save(st);

    const tickP = engine.tick({ now: new Date(nowMs) });
    await blockEntered;

    const resumeP = engine.resumeDevice(mac, 'User resumed');
    await new Promise((r) => setTimeout(r, 20));
    holdBlock = false;
    releaseBlock();

    await Promise.all([tickP, resumeP]);
    const finalState = engine.store.load();
    assert.equal(baseAdapter.blocked.has(mac), false);
    assert.equal(finalState.pausedDevices[mac], undefined);
    assert.equal(finalState.enforcedBlocks.includes(mac), false);
    assert.equal(engine._macSyncQueues.size, 0);
  }
});

test('Suite 7.7: addQuotaBonus and setQuota limit raise recompute blockedToday immediately even when tick() fails', async (t) => {
  const homeDir = makeTempHome(t);
  const mac = 'aa:bb:cc:dd:ee:97';
  const adapter = createMockAdapter([
    { mac, name: 'KidsTab', ipv4: '192.168.1.97', ipv6List: [], status: 'online', band: 'Wi-Fi' }
  ]);
  const srv = await startServer({
    homeDir,
    port: 0,
    dnsPort: 0,
    enableDns: false,
    enableDaemon: false,
    adapter
  });
  t.after(() => srv.close());

  // 1. Reach 1m quota limit
  await fetch(`${srv.url}/api/quotas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'q-bonus', name: 'Q1', targetMacs: [mac], dailyLimitMinutes: 1 })
  });
  const t0 = new Date();
  await srv.engine.tick({ now: t0 });
  await srv.engine.tick({ now: new Date(t0.getTime() + 65_000) });
  assert.equal(srv.engine.evaluateDnsQuery('example.com', '192.168.1.97').blocked, true);

  // Simulate router listDevices failing on subsequent tick()
  adapter.throwOnList = new Error('Router unreachable');

  // Bonus unblocks DNS & clears blockedToday in GET /api/state immediately
  const bonusRes = await fetch(`${srv.url}/api/quotas/bonus`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'q-bonus', minutes: '30m' })
  });
  assert.equal(bonusRes.status, 200);
  assert.equal(srv.engine.evaluateDnsQuery('example.com', '192.168.1.97').blocked, false);

  const stateAfterBonus = await fetch(`${srv.url}/api/state`).then((r) => r.json());
  assert.equal(stateAfterBonus.quotas[0].blockedToday, false);
  assert.equal(stateAfterBonus.state.quotas[0].usageByDate[Object.keys(stateAfterBonus.state.quotas[0].usageByDate)[0]].blockedToday, false);

  // 2. Lower limit back to 1m via setQuota (re-blocks), then raise to 60m while router is offline
  const lowerRes = await fetch(`${srv.url}/api/quotas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'q-bonus', name: 'Q1', targetMacs: [mac], dailyLimitMinutes: 1 })
  });
  assert.equal(lowerRes.status, 200);
  // Reset bonus by creating a fresh quota that hits 1m limit
  adapter.throwOnList = null;
  await fetch(`${srv.url}/api/quotas/q-bonus`, { method: 'DELETE' });
  await fetch(`${srv.url}/api/quotas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'q-raise', name: 'Q2', targetMacs: [mac], dailyLimitMinutes: 1 })
  });
  const t1 = new Date();
  await srv.engine.tick({ now: t1 });
  await srv.engine.tick({ now: new Date(t1.getTime() + 65_000) });
  assert.equal(srv.engine.evaluateDnsQuery('example.com', '192.168.1.97').blocked, true);

  adapter.throwOnList = new Error('Router unreachable');
  const raiseRes = await fetch(`${srv.url}/api/quotas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'q-raise', name: 'Q2', targetMacs: [mac], dailyLimitMinutes: 60 })
  });
  assert.equal(raiseRes.status, 200);
  assert.equal(srv.engine.evaluateDnsQuery('example.com', '192.168.1.97').blocked, false);

  const stateAfterRaise = await fetch(`${srv.url}/api/state`).then((r) => r.json());
  assert.equal(stateAfterRaise.quotas[0].blockedToday, false);
});

test('Suite 7.8: UniFiAdapter falls back to self-signed HTTPS on IPv6 loopback [::1]', async (t) => {
  const certDir = makeTempHome(t);
  const keyPath = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');
  try {
    await execFileAsync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-days', '1', '-subj', '/CN=localhost'
    ]);
  } catch (err) {
    t.skip(`openssl unavailable: ${err.message}`);
    return;
  }

  const tlsServer = https.createServer(
    { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
    (req, res) => {
      if (req.url === '/api/auth/login') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': ['TOKEN=v6-tok; Path=/; HttpOnly'],
          'X-CSRF-Token': 'v6-csrf'
        });
        return res.end(JSON.stringify({ meta: { rc: 'ok' } }));
      }
      if (req.url.endsWith('/stat/sta')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ mac: 'aa:bb:cc:dd:ee:99', hostname: 'V6Dev', ip: '192.168.1.99' }] }));
      }
      if (req.url.endsWith('/cmd/stamgr')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ meta: { rc: 'ok' } }));
      }
      res.writeHead(404);
      res.end('');
    }
  );

  try {
    await new Promise((resolve, reject) => {
      tlsServer.once('error', reject);
      tlsServer.listen(0, '::1', resolve);
    });
  } catch (err) {
    t.skip(`IPv6 loopback unavailable: ${err.code || err.message}`);
    return;
  }
  t.after(() => new Promise((resolve) => tlsServer.close(() => resolve())));
  const addr = tlsServer.address();

  const unifi = new UniFiAdapter({
    gatewayUrl: `https://[::1]:${addr.port}`,
    username: 'admin',
    password: 'pw'
  });
  const conn = await unifi.testConnection();
  assert.equal(conn.ok, true);
  const devs = await unifi.listDevices();
  assert.equal(devs.length, 1);
  assert.equal(devs[0].mac, 'aa:bb:cc:dd:ee:99');
  const blk = await unifi.blockDevice({ mac: 'aa:bb:cc:dd:ee:99' });
  assert.equal(blk.ok, true);
});

// ============================================================================
// Suite 8: Tier 5 White-Box Adversarial Hardening Regressions
// ============================================================================

test('Suite 8.1: prototype keys (constructor/toString/__proto__) return 400 and fall back safely', async (t) => {
  const homeDir = makeTempHome(t);
  const mac = 'aa:bb:cc:dd:ee:a1';
  const srv = await startServer({
    homeDir,
    port: 0,
    dnsPort: 0,
    enableDns: false,
    enableDaemon: false,
    adapter: createMockAdapter([{ mac, name: 'Dev', ipv4: '192.0.2.21', ipv6List: [], status: 'online', band: 'Wi-Fi' }])
  });
  t.after(() => srv.close());

  for (const key of ['constructor', 'toString', '__proto__', 'valueOf']) {
    const setupRes = await fetch(`${srv.url}/api/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ driver: key })
    });
    assert.equal(setupRes.status, 400, `driver="${key}" must return 400`);
    assert.equal((await setupRes.json()).ok, false);

    const catRes = await fetch(`${srv.url}/api/dns/category`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: key, enabled: true })
    });
    assert.equal(catRes.status, 400, `category="${key}" must return 400`);
    assert.equal((await catRes.json()).ok, false);

    const adapter = createAdapter({ driver: key });
    assert.equal(adapter.id, 'universal');
  }

  assert.throws(
    () => srv.engine.setSchedule({ name: 'ProtoDay', targetMacs: [mac], days: ['constructor'], startTime: '21:00', endTime: '07:00' }),
    { status: 400 }
  );
});

test('Suite 8.2: OpenWrtAdapter fails closed on non-zero ubus error codes while keeping uci delete idempotent', async (t) => {
  let uciAddCode = 0;
  let uciCommitCode = 0;
  let uciDeleteCode = 0;
  let hostHintsCode = 0;

  const baseUrl = await startMockHttpServer(t, (req, res, body) => {
    const rpc = JSON.parse(body);
    const [, obj, method] = rpc.params;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (obj === 'session' && method === 'login') {
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: [0, { ubus_rpc_session: 'sess-t5' }] }));
    }
    if (obj === 'luci-rpc' && method === 'getHostHints') {
      return res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        result: hostHintsCode === 0 ? [0, {}] : [hostHintsCode]
      }));
    }
    if (obj === 'uci' && method === 'add') {
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: uciAddCode === 0 ? [0, { section: 's1' }] : [uciAddCode] }));
    }
    if (obj === 'uci' && method === 'delete') {
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: [uciDeleteCode] }));
    }
    if (obj === 'uci' && method === 'commit') {
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: [uciCommitCode] }));
    }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: [0, {}] }));
  });

  const owrt = new OpenWrtAdapter({ gatewayUrl: baseUrl, username: 'root', password: 'pw' });

  uciAddCode = 4;
  const addFail = await owrt.blockDevice({ mac: 'aa:bb:cc:dd:ee:a2' });
  assert.equal(addFail.ok, false);
  uciAddCode = 0;

  uciCommitCode = 4;
  const commitFail = await owrt.blockDevice({ mac: 'aa:bb:cc:dd:ee:a2' });
  assert.equal(commitFail.ok, false);
  uciCommitCode = 0;

  // Deleting an already-absent rule (uci.delete -> [4]) stays idempotent when commit succeeds
  uciDeleteCode = 4;
  const unblkIdempotent = await owrt.unblockDevice({ mac: 'aa:bb:cc:dd:ee:a2' });
  assert.equal(unblkIdempotent.ok, true);

  // Commit failure during unblock still fails closed
  uciCommitCode = 4;
  const unblkCommitFail = await owrt.unblockDevice({ mac: 'aa:bb:cc:dd:ee:a2' });
  assert.equal(unblkCommitFail.ok, false);
  uciCommitCode = 0;

  hostHintsCode = 4;
  await assert.rejects(() => owrt.listDevices(), (err) => err.ubusCode === 4);
});

test('Suite 8.3: AsusWrtAdapter serializes concurrent blockDevice/unblockDevice calls on MULTIFILTER_MAC', async (t) => {
  let multifilterMac = '';

  const baseUrl = await startMockHttpServer(t, async (req, res, body) => {
    if (req.url === '/login.cgi') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ asus_token: 'tok-concurrent' }));
    }
    if (req.url.startsWith('/appGet.cgi')) {
      await new Promise((r) => setTimeout(r, 25));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error_status: '0', MULTIFILTER_MAC: multifilterMac }));
    }
    if (req.url === '/start_apply.htm') {
      await new Promise((r) => setTimeout(r, 15));
      const p = new URLSearchParams(body);
      multifilterMac = p.get('MULTIFILTER_MAC') || '';
      res.writeHead(200);
      return res.end('OK');
    }
    res.writeHead(404);
    res.end('');
  });

  const asus = new AsusWrtAdapter({ gatewayUrl: baseUrl, username: 'admin', password: 'pw' });
  const [r1, r2, r3] = await Promise.all([
    asus.blockDevice({ mac: 'aa:bb:cc:dd:ee:01' }),
    asus.blockDevice({ mac: 'aa:bb:cc:dd:ee:02' }),
    asus.blockDevice({ mac: 'aa:bb:cc:dd:ee:03' })
  ]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r3.ok, true);
  const blockedList = multifilterMac.split('<').filter(Boolean);
  assert.deepEqual(blockedList, ['AA:BB:CC:DD:EE:01', 'AA:BB:CC:DD:EE:02', 'AA:BB:CC:DD:EE:03']);

  const [u1, b4] = await Promise.all([
    asus.unblockDevice({ mac: 'aa:bb:cc:dd:ee:02' }),
    asus.blockDevice({ mac: 'aa:bb:cc:dd:ee:04' })
  ]);
  assert.equal(u1.ok, true);
  assert.equal(b4.ok, true);
  assert.deepEqual(multifilterMac.split('<').filter(Boolean), ['AA:BB:CC:DD:EE:01', 'AA:BB:CC:DD:EE:03', 'AA:BB:CC:DD:EE:04']);
});

test('Suite 8.4: StateStore.load() recovers cleanly from corrupt, empty, or non-object state.json', (t) => {
  const origWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => { console.warn = origWarn; });

  for (const payload of ['', '{truncated', 'null', '[]', '123']) {
    const homeDir = makeTempHome(t);
    const store = new StateStore(homeDir);
    store.ensure();
    fs.writeFileSync(store.stateFile, payload, 'utf8');

    const loaded = store.load();
    assert.equal(loaded.version, 1);
    assert.ok(Array.isArray(loaded.quotas));
    assert.ok(Array.isArray(loaded.schedules));
    assert.equal(typeof loaded.aliases, 'object');

    // Valid JSON saved back to state.json
    const persisted = JSON.parse(fs.readFileSync(store.stateFile, 'utf8'));
    assert.equal(persisted.version, 1);

    const backups = fs.readdirSync(homeDir).filter((f) => f.startsWith('state.json.corrupt.'));
    if (payload.trim().length > 0) {
      assert.equal(backups.length, 1, `Expected forensic backup for payload=${JSON.stringify(payload)}`);
      assert.equal(fs.readFileSync(path.join(homeDir, backups[0]), 'utf8'), payload);
    } else {
      assert.equal(backups.length, 0, 'Empty state.json should not create empty corrupt backup');
    }
  }
  assert.equal(warnings.length, 5);
});

test('Suite 8.5: malformed Host header returns 400, extreme pauseDevice duration returns 400, and QDCOUNT=0 DNS returns null', async (t) => {
  const homeDir = makeTempHome(t);
  const mac = 'aa:bb:cc:dd:ee:a5';
  const srv = await startServer({
    homeDir,
    port: 0,
    dnsPort: 0,
    enableDns: false,
    enableDaemon: false,
    adapter: createMockAdapter([{ mac, name: 'Dev', ipv4: '192.0.2.25', ipv6List: [], status: 'online', band: 'Wi-Fi' }])
  });
  t.after(() => srv.close());

  // 1. Malformed Host header -> HTTP 400
  const rawResp = await new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port: srv.port }, () => {
      sock.write('GET /api/health HTTP/1.1\r\nHost: bad host:with spaces\r\nConnection: close\r\n\r\n');
    });
    let data = '';
    sock.on('data', (c) => { data += c.toString('utf8'); });
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
  });
  assert.match(rawResp, /^HTTP\/1\.1 400 Bad Request/);
  assert.ok(rawResp.includes('"ok":false'));

  // 2. Extreme pauseDevice duration overflow -> HTTP 400
  await assert.rejects(() => srv.engine.pauseDevice(mac, 1e305), { status: 400 });
  const pauseOverflow = await fetch(`${srv.url}/api/devices/pause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: mac, duration: 1e305 })
  });
  assert.equal(pauseOverflow.status, 400);
  assert.equal((await pauseOverflow.json()).ok, false);

  const pauseTooLong = await fetch(`${srv.url}/api/devices/pause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: mac, duration: 525601 })
  });
  assert.equal(pauseTooLong.status, 400);

  // 3. QDCOUNT=0 DNS packet >= 16 bytes -> parseDnsQuestion returns null
  const qd0 = Buffer.alloc(24, 0);
  qd0.writeUInt16BE(0x1234, 0); // ID
  qd0.writeUInt16BE(0x0100, 2); // Flags
  qd0.writeUInt16BE(0, 4);      // QDCOUNT = 0
  qd0[12] = 3;
  qd0.write('foo', 13);
  qd0[16] = 0;
  qd0.writeUInt16BE(1, 17);
  qd0.writeUInt16BE(1, 19);
  assert.equal(parseDnsQuestion(qd0), null);
});
