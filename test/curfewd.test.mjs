import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import curfewd, {
  parseDurationMinutes,
  formatDuration,
  normalizeMac,
  isScheduleActiveNow,
  LocalDnsSinkhole,
  ADAPTER_CATALOG,
  startServer
} from '../src/index.js';

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'curfewd-test-'));
}

function createMockAdapter(initialDevices = []) {
  const blocked = new Set();
  return {
    id: 'mock',
    blocked,
    devices: initialDevices,
    async testConnection() {
      return { ok: true, model: 'MockRouter', detail: 'ok' };
    },
    async listDevices() {
      return this.devices;
    },
    async blockDevice({ mac }) {
      blocked.add(normalizeMac(mac));
      return { ok: true, mode: 'mock-block' };
    },
    async unblockDevice({ mac }) {
      blocked.delete(normalizeMac(mac));
      return { ok: true, mode: 'mock-unblock' };
    },
    async isDeviceBlocked({ mac }) {
      return blocked.has(normalizeMac(mac));
    }
  };
}

test('duration parsing and formatting', () => {
  assert.equal(parseDurationMinutes('1h30m'), 90);
  assert.equal(parseDurationMinutes('1:30'), 90);
  assert.equal(parseDurationMinutes('90m'), 90);
  assert.equal(parseDurationMinutes(45), 45);
  assert.equal(formatDuration(5400), '1h 30m');
  assert.equal(normalizeMac('AA-BB-CC-1-2-3'), 'aa:bb:cc:01:02:03');
});

test('overnight bedtime schedule evaluation', () => {
  const sched = {
    enabled: true,
    days: ['Mon'],
    startTime: '21:00',
    endTime: '07:00',
    targetMacs: ['aa:bb:cc:dd:ee:ff']
  };
  // Monday 22:00 -> active
  assert.equal(isScheduleActiveNow(sched, new Date(2026, 10, 23, 22, 0)), true);
  // Tuesday 06:30 -> active (carried over from Monday night)
  assert.equal(isScheduleActiveNow(sched, new Date(2026, 10, 24, 6, 30)), true);
  // Tuesday 08:00 -> inactive
  assert.equal(isScheduleActiveNow(sched, new Date(2026, 10, 24, 8, 0)), false);
});

test('daily quota tracks online usage, blocks at limit, unblocks on bonus and midnight reset', async () => {
  const homeDir = makeTempHome();
  const mac = 'aa:bb:cc:dd:ee:01';
  const adapter = createMockAdapter([
    { mac, name: 'Kids-PC', ipv4: '192.168.1.50', ipv6List: [], status: 'online', band: 'Wi-Fi' }
  ]);
  const guard = curfewd({ homeDir, adapter });
  guard.quota.set({ name: 'Kids PC', macs: [mac], limit: '2m' });

  const t0 = new Date(2026, 10, 23, 15, 0, 0);
  await guard.tick({ now: t0 });
  assert.equal(adapter.blocked.has(mac), false);

  // +60s online -> 60s / 120s
  await guard.tick({ now: new Date(t0.getTime() + 60_000) });
  assert.equal(adapter.blocked.has(mac), false);

  // +60s online -> 120s / 120s -> blocked!
  await guard.tick({ now: new Date(t0.getTime() + 120_000) });
  assert.equal(adapter.blocked.has(mac), true);

  // Add +10m bonus -> unblocked!
  guard.quota.bonus('Kids PC', '10m');
  await guard.tick({ now: new Date(t0.getTime() + 125_000) });
  assert.equal(adapter.blocked.has(mac), false);

  // Next day -> fresh quota
  const tomorrow = new Date(2026, 10, 24, 9, 0, 0);
  await guard.tick({ now: tomorrow });
  assert.equal(adapter.blocked.has(mac), false);
});

test('embedded RFC-1035 UDP DNS sinkhole blocks matching domains with 0.0.0.0', async () => {
  const sink = new LocalDnsSinkhole({
    port: 0,
    isBlockedFn: (domain) => ({
      blocked: domain === 'roblox.com' || domain.endsWith('.roblox.com'),
      reason: 'Blocked'
    })
  });
  await sink.start();
  try {
    const res = await sink.testQuery('www.roblox.com');
    assert.equal(res.ok, true);
    assert.equal(res.sinkholed, true);
    assert.equal(res.resolvedIp, '0.0.0.0');
  } finally {
    await sink.stop();
  }
});

test('adapter catalog includes universal + 5 hardware router drivers and web server serves API', async () => {
  assert.ok(ADAPTER_CATALOG.universal);
  assert.ok(ADAPTER_CATALOG['att-bgw']);
  assert.ok(ADAPTER_CATALOG.openwrt);
  assert.ok(ADAPTER_CATALOG.unifi);
  assert.ok(ADAPTER_CATALOG.asuswrt);
  assert.ok(ADAPTER_CATALOG.netgear);
  assert.ok(ADAPTER_CATALOG.custom);

  const homeDir = makeTempHome();
  const adapter = createMockAdapter([
    { mac: 'aa:bb:cc:dd:ee:02', name: 'Tablet', ipv4: '192.168.1.51', ipv6List: [], status: 'online', band: 'Wi-Fi' }
  ]);
  const srv = await startServer({
    homeDir,
    port: 0,
    dnsPort: 0,
    enableDns: true,
    enableDaemon: false,
    adapter
  });
  try {
    const health = await fetch(`${srv.url}/api/health`).then((r) => r.json());
    assert.equal(health.ok, true);

    const stateRes = await fetch(`${srv.url}/api/state`).then((r) => r.json());
    assert.equal(stateRes.devices.length, 1);
    assert.equal(stateRes.adapters.length, 7);

    const html = await fetch(`${srv.url}/`).then((r) => r.text());
    assert.ok(html.includes('curfewd'));
  } finally {
    await srv.close();
  }
});
