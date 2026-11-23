import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ADAPTER_CATALOG, autoDetectRouter, createAdapter } from './adapters/index.js';
import { StateStore, normalizeMac, parseDurationMinutes } from './state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.resolve(__dirname, '../bin/curfewd.mjs');

export async function runInteractiveSetup({ homeDir } = {}) {
  const store = new StateStore(homeDir);
  const state = store.load();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log('\ncurfewd setup\n');
    console.log('Detecting local network gateway...');
    const detected = await autoDetectRouter();
    console.log(`  Gateway IP:  ${detected.gatewayIp}`);
    console.log(`  Detected:    ${detected.modelHint} (${detected.matchedDriver})\n`);

    const drivers = Object.values(ADAPTER_CATALOG);
    console.log('Choose a router adapter:');
    drivers.forEach((d, idx) => {
      const tag = d.id === detected.matchedDriver ? ' [recommended]' : '';
      console.log(`  ${idx + 1}) ${d.name}${tag}`);
    });

    const defaultIdx = drivers.findIndex((d) => d.id === detected.matchedDriver) + 1;
    const driverAns = (await rl.question(`\nAdapter [${defaultIdx}]: `)).trim();
    const chosenIdx = driverAns ? Number(driverAns) - 1 : defaultIdx - 1;
    const chosen = drivers[chosenIdx] || drivers[0];

    state.router.driver = chosen.id;
    if (chosen.id !== 'universal') {
      const defaultUrl = detected.matchedDriver === chosen.id ? detected.gatewayUrl : chosen.defaultGateway;
      const urlAns = (await rl.question(`Gateway URL [${defaultUrl}]: `)).trim();
      state.router.gatewayUrl = urlAns || defaultUrl;

      for (const field of chosen.authFields || []) {
        const cur = state.router[field.key] ? ' (keep existing)' : '';
        const ans = (await rl.question(`${field.label}${cur}: `)).trim();
        if (ans) state.router[field.key] = ans;
      }
    } else {
      state.router.gatewayUrl = detected.gatewayUrl;
      const lanIp = Object.values(os.networkInterfaces())
        .flat()
        .find((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))?.address || '192.168.1.x';
      console.log(`\nUniversal mode works on ANY router (eero, Nest WiFi, Xfinity, Spectrum, Orbi, Verizon).`);
      console.log(`To enforce blocks on locked routers, point your router's DHCP DNS (or kid's device DNS) to:`);
      console.log(`  DNS Server: ${lanIp}  (run "sudo curfewd serve --dns-port 53" for standard port 53)`);
    }

    // Test connection & discover devices
    console.log(`\nTesting ${chosen.name}...`);
    const adapter = createAdapter(state.router);
    const check = await adapter.testConnection();
    console.log(`  ${check.ok ? 'OK' : 'WARN'}: ${check.detail}`);

    const devices = await adapter.listDevices().catch(() => []);
    if (devices.length > 0) {
      console.log(`\nDiscovered ${devices.length} device(s):`);
      devices.slice(0, 15).forEach((d, i) => {
        console.log(`  ${String(i + 1).padStart(2)}) ${d.name.padEnd(24)} ${d.mac}  ${(d.ipv4 || '').padEnd(15)} [${d.status}]`);
      });

      const pick = (await rl.question('\nAdd a daily quota now? Enter device number(s) comma-separated (or Enter to skip): ')).trim();
      if (pick) {
        const macs = pick
          .split(',')
          .map((x) => devices[Number(x.trim()) - 1]?.mac)
          .filter(Boolean)
          .map(normalizeMac);
        if (macs.length > 0) {
          const qName = (await rl.question('Device/Group label (e.g. "Kids Desktop"): ')).trim() || 'Managed Device';
          const qLimit = (await rl.question('Daily time limit (e.g. 1h30m, 90m, 2h) [1h30m]: ')).trim() || '1h30m';
          const mins = parseDurationMinutes(qLimit) ?? 90;
          const id = qName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'device-quota';
          state.quotas = state.quotas.filter((q) => q.id !== id);
          state.quotas.push({
            id,
            name: qName,
            macs,
            dailyLimitSeconds: mins * 60,
            enabled: true,
            usageByDate: {}
          });
          for (const m of macs) {
            if (!state.pinnedMacs.includes(m)) state.pinnedMacs.push(m);
            if (!state.aliases[m]) state.aliases[m] = qName;
          }
          console.log(`  Saved daily quota: ${qName} -> ${mins}m/day`);
        }
      }
    }

    const webPortAns = (await rl.question(`\nWeb dashboard port [${state.web.port}]: `)).trim();
    if (webPortAns && Number.isFinite(Number(webPortAns))) state.web.port = Number(webPortAns);

    state.setupCompleted = true;
    store.appendAudit(state, 'SETUP', chosen.id, `Configured ${chosen.name}`);
    store.save(state);

    console.log(`\nSaved config to ${store.stateFile}`);
    const installSvc = (await rl.question('Install background daemon to run automatically on login? (y/N): ')).trim().toLowerCase();
    if (installSvc === 'y' || installSvc === 'yes') {
      const res = installBackgroundService({ homeDir: store.homeDir });
      console.log(`  ${res.detail}`);
    }

    console.log(`\nNext steps:`);
    console.log(`  curfewd serve     # open dashboard at http://localhost:${state.web.port}`);
    console.log(`  curfewd status    # check devices & remaining quotas\n`);
  } finally {
    rl.close();
  }
}

export function installBackgroundService({ homeDir } = {}) {
  const store = new StateStore(homeDir);
  store.ensure();
  const nodeBin = process.execPath;
  const logFile = path.join(store.homeDir, 'curfewd.log');
  const platform = os.platform();

  if (platform === 'darwin') {
    const agentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    fs.mkdirSync(agentsDir, { recursive: true });
    const plistPath = path.join(agentsDir, 'com.curfewd.daemon.plist');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.curfewd.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${BIN_PATH}</string>
    <string>daemon</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CURFEWD_HOME</key>
    <string>${store.homeDir}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logFile}</string>
  <key>StandardErrorPath</key>
  <string>${logFile}</string>
</dict>
</plist>
`;
    fs.writeFileSync(plistPath, plist);
    const uid = process.getuid();
    try { execFileSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { stdio: 'ignore' }); } catch {}
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
    return { ok: true, platform: 'darwin', path: plistPath, detail: `Installed & started launchd agent at ${plistPath}` };
  }

  if (platform === 'linux') {
    const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    const unitPath = path.join(unitDir, 'curfewd.service');
    const unit = `[Unit]
Description=curfewd local parental control daemon
After=network-online.target

[Service]
Type=simple
Environment=CURFEWD_HOME=${store.homeDir}
ExecStart=${nodeBin} ${BIN_PATH} daemon
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
    fs.writeFileSync(unitPath, unit);
    try {
      execFileSync('systemctl', ['--user', 'daemon-reload']);
      execFileSync('systemctl', ['--user', 'enable', '--now', 'curfewd.service']);
    } catch {}
    return { ok: true, platform: 'linux', path: unitPath, detail: `Installed systemd user service at ${unitPath}` };
  }

  return { ok: false, platform, detail: `Auto-service install is supported on macOS and Linux; run "curfewd daemon" manually.` };
}

export function uninstallBackgroundService() {
  const platform = os.platform();
  if (platform === 'darwin') {
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.curfewd.daemon.plist');
    try { execFileSync('launchctl', ['bootout', `gui/${process.getuid()}`, plistPath], { stdio: 'ignore' }); } catch {}
    if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
    return { ok: true, detail: 'Removed launchd agent com.curfewd.daemon' };
  }
  if (platform === 'linux') {
    const unitPath = path.join(os.homedir(), '.config', 'systemd', 'user', 'curfewd.service');
    try { execFileSync('systemctl', ['--user', 'disable', '--now', 'curfewd.service'], { stdio: 'ignore' }); } catch {}
    if (fs.existsSync(unitPath)) fs.unlinkSync(unitPath);
    return { ok: true, detail: 'Removed systemd user service curfewd.service' };
  }
  return { ok: false, detail: 'No background service installed for this platform' };
}
