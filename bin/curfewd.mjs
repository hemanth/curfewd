#!/usr/bin/env node
import { CurfewEngine } from '../src/engine.js';
import { autoDetectRouter, ADAPTER_CATALOG } from '../src/adapters/index.js';
import { runInteractiveSetup, installBackgroundService, uninstallBackgroundService } from '../src/setup.js';
import { startServer } from '../src/server.js';
import { formatDuration, todayKey } from '../src/state.js';

const args = process.argv.slice(2);
const cmd = (args[0] || 'status').toLowerCase();

function printHelp() {
  console.log(`
curfewd - Local parental control daemon, CLI, and web studio for any home router

Usage:
  curfewd setup                         Interactive router & quota setup wizard
  curfewd serve [--port 4320]           Start local web dashboard + DNS sinkhole + daemon
  curfewd daemon                        Run headless background enforcement loop
  curfewd status                        Show router, devices, and daily quotas
  curfewd detect                        Auto-detect local gateway & router adapter
  curfewd pause <name|mac> [duration]   Pause a device (e.g. 60m, 2h, or until resumed)
  curfewd resume <name|mac>             Resume a paused device
  curfewd quota set <name> <macs> <dur> Set daily limit (e.g. "Kids PC" aa:bb:... 1h30m)
  curfewd quota add <name> <duration>   Grant bonus time today (e.g. 30m)
  curfewd quota reset <name>            Reset today's usage counter to 0
  curfewd block <domain>                Block domain via local DNS sinkhole
  curfewd unblock <domain>              Unblock domain
  curfewd service install|uninstall     Install/remove launchd (macOS) or systemd (Linux) daemon
`);
}

async function main() {
  if (cmd === '-h' || cmd === '--help' || cmd === 'help') {
    printHelp();
    return;
  }

  if (cmd === 'setup') {
    await runInteractiveSetup();
    return;
  }

  if (cmd === 'detect') {
    const info = await autoDetectRouter();
    console.log(JSON.stringify({
      gatewayIp: info.gatewayIp,
      gatewayUrl: info.gatewayUrl,
      recommendedAdapter: info.matchedDriver,
      modelHint: info.modelHint
    }, null, 2));
    return;
  }

  if (cmd === 'service') {
    const sub = (args[1] || 'install').toLowerCase();
    const res = sub === 'uninstall' || sub === 'remove'
      ? uninstallBackgroundService()
      : installBackgroundService();
    console.log(res.detail);
    return;
  }

  if (cmd === 'serve') {
    const portIdx = args.indexOf('--port');
    const port = portIdx >= 0 ? Number(args[portIdx + 1]) : undefined;
    const dnsIdx = args.indexOf('--dns-port');
    const dnsPort = dnsIdx >= 0 ? Number(args[dnsIdx + 1]) : undefined;
    const hostIdx = args.indexOf('--host');
    const host = hostIdx >= 0 ? args[hostIdx + 1] : '127.0.0.1';
    const srv = await startServer({ port, dnsPort, host });
    console.log(`curfewd web studio: ${srv.url}`);
    console.log(`curfewd DNS sinkhole: UDP :${srv.dnsPort}`);
    return;
  }

  const engine = new CurfewEngine();

  if (cmd === 'daemon') {
    console.log('[curfewd] daemon running...');
    engine.startDaemon();
    return;
  }

  if (cmd === 'status' || cmd === 'devices') {
    const state = engine.store.load();
    const devices = await engine.listDevices();
    const adapterMeta = ADAPTER_CATALOG[state.router.driver] || ADAPTER_CATALOG.universal;
    const dateStr = todayKey();
    const online = devices.filter((d) => d.status === 'online').length;

    console.log(`\ncurfewd  ·  ${adapterMeta.name}`);
    console.log(`  Gateway:  ${state.router.gatewayUrl}  |  Devices: ${online} online / ${devices.length} total`);
    console.log(`  Config:   ${engine.store.stateFile}\n`);

    if ((state.quotas || []).length > 0) {
      console.log(`  DAILY QUOTAS (${dateStr}):`);
      for (const q of state.quotas) {
        const entry = q.usageByDate?.[dateStr] || { usedSeconds: 0, bonusSeconds: 0, blockedToday: false };
        const lim = q.dailyLimitSeconds + (entry.bonusSeconds || 0);
        const rem = Math.max(0, lim - (entry.usedSeconds || 0));
        const tag = entry.blockedToday ? 'LOCKED' : 'ACTIVE';
        console.log(
          `    [${tag}] ${q.name.padEnd(22)} ${formatDuration(entry.usedSeconds || 0)} / ${formatDuration(lim)}  (${formatDuration(rem)} left)`
        );
      }
      console.log('');
    }

    const list = cmd === 'devices' ? devices : devices.slice(0, 15);
    console.log(`  DEVICES (${list.length}/${devices.length}):`);
    for (const d of list) {
      const badge = d.isBlocked ? 'BLOCKED' : d.status === 'online' ? 'ONLINE ' : 'OFFLINE';
      console.log(`    ${badge}  ${d.displayName.slice(0, 24).padEnd(25)} ${d.mac}  ${(d.ipv4 || '-').padEnd(15)} ${d.band}`);
    }
    console.log('');
    return;
  }

  if (cmd === 'pause') {
    const target = args[1];
    const duration = args[2] || null;
    if (!target) throw new Error('Usage: curfewd pause <name|mac> [duration]');
    const res = await engine.pauseDevice(target, duration);
    console.log(`Paused ${res.mac}${res.durationMinutes ? ` for ${res.durationMinutes}m` : ' until resumed'} (${res.sync?.mode || 'local'})`);
    return;
  }

  if (cmd === 'resume') {
    const target = args[1];
    if (!target) throw new Error('Usage: curfewd resume <name|mac>');
    const res = await engine.resumeDevice(target);
    console.log(`Resumed ${res.mac} (${res.sync?.mode || 'local'})`);
    return;
  }

  if (cmd === 'quota') {
    const sub = (args[1] || 'list').toLowerCase();
    if (sub === 'set') {
      const [, , name, macsCsv, limit] = args;
      if (!name || !macsCsv || !limit) {
        throw new Error('Usage: curfewd quota set <name> <mac1,mac2> <duration e.g. 1h30m>');
      }
      const q = engine.setQuota({ name, macs: macsCsv.split(','), limit });
      await engine.tick().catch(() => {});
      console.log(`Quota "${q.name}" set to ${formatDuration(q.dailyLimitSeconds)}/day for ${q.macs.join(', ')}`);
      return;
    }
    if (sub === 'add' || sub === 'bonus') {
      const q = engine.addQuotaBonus(args[2], args[3] || '30m');
      await engine.tick().catch(() => {});
      console.log(`Added bonus to "${q.name}"`);
      return;
    }
    if (sub === 'reset') {
      const q = engine.resetQuotaToday(args[2]);
      await engine.tick().catch(() => {});
      console.log(`Reset "${q.name}" usage for ${todayKey()}`);
      return;
    }
    const state = engine.store.load();
    console.log(JSON.stringify(state.quotas, null, 2));
    return;
  }

  if (cmd === 'block') {
    const d = engine.blockDomain(args[1]);
    console.log(`Blocked *.${d} in local DNS sinkhole`);
    return;
  }

  if (cmd === 'unblock') {
    engine.unblockDomain(args[1]);
    console.log(`Unblocked ${args[1]}`);
    return;
  }

  printHelp();
}

main().catch((err) => {
  console.error(`curfewd: ${err.message}`);
  process.exit(1);
});
