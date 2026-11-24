import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { UniversalAdapter, UNIVERSAL_META } from './universal.js';
import { AttBgwAdapter, ATT_BGW_META } from './att-bgw.js';
import { OpenWrtAdapter, OPENWRT_META } from './openwrt.js';
import { UniFiAdapter, UNIFI_META } from './unifi.js';
import { AsusWrtAdapter, ASUSWRT_META } from './asuswrt.js';
import { NetgearAdapter, NETGEAR_META } from './netgear.js';
import { CustomAdapter, CUSTOM_META } from './custom.js';

const execFileAsync = promisify(execFile);

export const ADAPTER_CATALOG = {
  universal: UNIVERSAL_META,
  'att-bgw': ATT_BGW_META,
  openwrt: OPENWRT_META,
  unifi: UNIFI_META,
  asuswrt: ASUSWRT_META,
  netgear: NETGEAR_META,
  custom: CUSTOM_META
};

const ADAPTER_CLASSES = {
  universal: UniversalAdapter,
  'att-bgw': AttBgwAdapter,
  openwrt: OpenWrtAdapter,
  unifi: UniFiAdapter,
  asuswrt: AsusWrtAdapter,
  netgear: NetgearAdapter,
  custom: CustomAdapter
};

export function createAdapter(routerConfig = {}) {
  const id = routerConfig.driver || 'universal';
  const Cls = Object.hasOwn(ADAPTER_CLASSES, id) ? ADAPTER_CLASSES[id] : UniversalAdapter;
  return new Cls(routerConfig);
}

export async function detectDefaultGatewayIp() {
  // macOS: route -n get default
  try {
    const { stdout } = await execFileAsync('route', ['-n', 'get', 'default'], { timeout: 2000 });
    const m = stdout.match(/gateway:\s*(\d+\.\d+\.\d+\.\d+)/i);
    if (m) return m[1];
  } catch {}

  // Linux: ip route show default
  try {
    const { stdout } = await execFileAsync('ip', ['route', 'show', 'default'], { timeout: 2000 });
    const m = stdout.match(/default\s+via\s+(\d+\.\d+\.\d+\.\d+)/i);
    if (m) return m[1];
  } catch {}

  // Cross-platform fallback: netstat -rn
  try {
    const { stdout } = await execFileAsync('netstat', ['-rn'], { timeout: 2000 });
    const m = stdout.match(/^(?:default|0\.0\.0\.0)\s+(\d+\.\d+\.\d+\.\d+)/m);
    if (m) return m[1];
  } catch {}

  return '192.168.1.1';
}

export async function autoDetectRouter() {
  const gatewayIp = await detectDefaultGatewayIp();
  const baseUrl = `http://${gatewayIp}`;
  let matchedDriver = 'universal';
  let modelHint = 'Generic Home Router (Universal ARP/NDP + DNS mode)';

  try {
    const res = await fetch(baseUrl, {
      redirect: 'follow',
      headers: { Connection: 'close' },
      signal: AbortSignal.timeout(2500)
    });
    const html = await res.text();
    const serverHdr = (res.headers.get('server') || '').toLowerCase();

    if (/BGW320|BGW210|\/cgi-bin\/home\.ha|\/cgi-bin\/sysinfo\.ha|HUMAX|AT&T/i.test(html)) {
      matchedDriver = 'att-bgw';
      const m = html.match(/BGW\d{3}-\d{3}|BGW\d{3}/i);
      modelHint = m ? `AT&T Fiber ${m[0]}` : 'AT&T Fiber BGW Gateway';
    } else if (/LuCI|OpenWrt|GL\.iNet|\/cgi-bin\/luci/i.test(html)) {
      matchedDriver = 'openwrt';
      modelHint = 'OpenWrt / GL.iNet Router';
    } else if (/UniFi|ubnt|Ubiquiti/i.test(html) || serverHdr.includes('unifi')) {
      matchedDriver = 'unifi';
      modelHint = 'Ubiquiti UniFi OS Gateway';
    } else if (/ASUSWRT|asus_token|Main_Login\.asp/i.test(html)) {
      matchedDriver = 'asuswrt';
      modelHint = 'ASUSWRT Router';
    } else if (/NETGEAR|Orbi|Nighthawk/i.test(html)) {
      matchedDriver = 'netgear';
      modelHint = 'Netgear Nighthawk / Orbi Router';
    }
  } catch {}

  if (matchedDriver === 'universal') {
    try {
      const bgwRes = await fetch(`${baseUrl}/cgi-bin/sysinfo.ha`, {
        headers: { Connection: 'close' },
        signal: AbortSignal.timeout(2500)
      });
      if (bgwRes.ok) {
        const bgwHtml = await bgwRes.text();
        if (/BGW\d{3}|HUMAX|Arris|Broadband/i.test(bgwHtml)) {
          matchedDriver = 'att-bgw';
          const m = bgwHtml.match(/BGW\d{3}-\d{3}|BGW\d{3}/i);
          modelHint = m ? `AT&T Fiber ${m[0]}` : 'AT&T Fiber BGW Gateway';
        }
      }
    } catch {}
  }

  return {
    gatewayIp,
    gatewayUrl: matchedDriver === 'unifi' ? `https://${gatewayIp}` : baseUrl,
    matchedDriver,
    driverMeta: ADAPTER_CATALOG[matchedDriver],
    modelHint,
    availableDrivers: Object.values(ADAPTER_CATALOG)
  };
}
