import crypto from 'node:crypto';
import { normalizeMac } from '../state.js';

export const ATT_BGW_META = {
  id: 'att-bgw',
  name: 'AT&T Fiber BGW320-500 / BGW210',
  vendor: 'HUMAX / Arris (AT&T)',
  protocol: 'HTTP CGI (.ha) + MD5 Nonce Auth',
  defaultGateway: 'http://192.168.1.254',
  authFields: [
    { key: 'password', label: 'Device Access Code (printed on router label)', secret: true, required: true }
  ],
  capabilities: {
    discovery: 'Full (/cgi-bin/devices.ha IPv4 + IPv6 + Band + Signal)',
    pause: 'L2/L3 Hardware Packet Filter Drop (/cgi-bin/packetfilter.ha)',
    domainFilter: 'Local DNS Sinkhole (:5354) + Gateway Packet Filter',
    zeroPassword: false
  }
};

export function computeBgwLoginPayload(accessCode, nonce) {
  const hashpassword = crypto
    .createHash('md5')
    .update(`${accessCode}${nonce}`, 'utf8')
    .digest('hex');
  return {
    nonce,
    password: '*'.repeat(accessCode.length),
    hashpassword,
    Continue: 'Continue'
  };
}

export class AttBgwAdapter {
  constructor(config = {}) {
    this.id = 'att-bgw';
    this.meta = ATT_BGW_META;
    this.baseUrl = (config.gatewayUrl || ATT_BGW_META.defaultGateway).replace(/\/+$/, '');
    this.accessCode = (config.password || '').trim();
    this.sessionCookie = null;
    this._queue = Promise.resolve();
  }

  async request(pathname, options = {}) {
    const run = async () => {
      const url = `${this.baseUrl}${pathname}`;
      const headers = {
        'User-Agent': 'curfewd/0.1 (Local LAN)',
        Connection: 'close',
        ...(options.headers || {})
      };
      if (this.sessionCookie) headers.Cookie = this.sessionCookie;

      const res = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body: options.body,
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs || 8000)
      });

      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        const m = setCookie.match(/SessionID=[^;]+/);
        if (m) this.sessionCookie = m[0];
      }

      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        if (pathname === '/cgi-bin/login.ha') {
          return { status: res.status, html: 'Authenticated', url };
        }
        const loc = res.headers.get('location');
        const nextPath = loc.startsWith('http') ? new URL(loc).pathname + new URL(loc).search : loc;
        const r2 = await fetch(`${this.baseUrl}${nextPath}`, {
          headers: this.sessionCookie ? { Cookie: this.sessionCookie, Connection: 'close' } : { Connection: 'close' },
          signal: AbortSignal.timeout(options.timeoutMs || 8000)
        });
        return { status: r2.status, html: await r2.text(), url: `${this.baseUrl}${nextPath}` };
      }

      return { status: res.status, html: await res.text(), url };
    };

    const next = this._queue.then(run, run);
    this._queue = next.catch(() => {});
    return next;
  }

  async authenticate() {
    if (!this.accessCode) {
      return { ok: false, reason: 'Device Access Code is required for AT&T BGW hardware blocking' };
    }
    let { html } = await this.request('/cgi-bin/login.ha');
    if (/Cookies must be enabled/i.test(html) || !html.includes('name="nonce"')) {
      html = (await this.request('/cgi-bin/login.ha')).html;
    }
    const nonce =
      html.match(/name="nonce"\s+value="([0-9a-f]+)"/i)?.[1] ||
      html.match(/value="([0-9a-f]{32,})"/i)?.[1];
    if (!nonce) {
      if (!/Access Code Required/i.test(html)) return { ok: true };
      return { ok: false, reason: 'Could not find login nonce on /cgi-bin/login.ha' };
    }
    const payload = computeBgwLoginPayload(this.accessCode, nonce);
    const { html: postHtml } = await this.request('/cgi-bin/login.ha', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(payload).toString()
    });
    const failed = /Access Code Required|Invalid Access Code/i.test(postHtml);
    return { ok: !failed, reason: failed ? 'Invalid Device Access Code' : 'Authenticated' };
  }

  async testConnection() {
    const { html } = await this.request('/cgi-bin/sysinfo.ha');
    const model = html.match(/<th[^>]*>\s*Model Number\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i)?.[1]?.replace(/<[^>]+>/g, '').trim();
    if (!model && !/BGW|HUMAX|Arris/i.test(html)) {
      return { ok: false, model: null, detail: `Gateway at ${this.baseUrl} did not respond as AT&T BGW` };
    }
    if (this.accessCode) {
      const auth = await this.authenticate();
      if (!auth.ok) return { ok: false, model: model || 'AT&T BGW', detail: auth.reason };
    }
    return { ok: true, model: model || 'AT&T BGW', detail: `Connected to ${model || 'AT&T BGW'} at ${this.baseUrl}` };
  }

  async listDevices() {
    const { html } = await this.request('/cgi-bin/devices.ha');
    const blocks = html.split(/<hr\s+class="reshr"[^>]*>/i);
    const devices = [];
    for (const block of blocks) {
      const rowRe = /<tr>\s*<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;
      const fields = {};
      const ipv6List = [];
      let m;
      while ((m = rowRe.exec(block)) !== null) {
        const key = m[1].replace(/<[^>]+>/g, '').trim();
        const text = m[2].replace(/<br\s*\/?>/gi, ' | ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
        fields[key] = text;
        if (key === 'IPv6 Address' && text) ipv6List.push(text.toLowerCase());
      }
      const mac = normalizeMac(fields['MAC Address']);
      if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) continue;

      let ipv4 = null;
      let name = fields['Name'] || 'Unknown Device';
      if (fields['IPv4 Address / Name']) {
        const parts = fields['IPv4 Address / Name'].split('/').map((s) => s.trim());
        if (parts.length >= 2) {
          ipv4 = parts[0];
          name = parts.slice(1).join(' / ');
        } else {
          name = fields['IPv4 Address / Name'];
        }
      }
      const conn = fields['Connection Type'] || 'LAN';
      const band = /5\s*GHz/i.test(conn) ? '5 GHz Wi-Fi' : /2\.4\s*GHz/i.test(conn) ? '2.4 GHz Wi-Fi' : /Wi-Fi/i.test(conn) ? 'Wi-Fi' : 'Ethernet';
      devices.push({
        mac,
        name,
        ipv4,
        ipv6: ipv6List.find((ip) => !ip.startsWith('fe80:')) || ipv6List[0] || null,
        ipv6List,
        status: (fields['Status'] || '').toLowerCase() === 'on' ? 'online' : 'offline',
        band,
        lastActivity: fields['Last Activity'] || ''
      });
    }
    return devices;
  }

  async _ensurePacketFiltersEnabled() {
    const { html } = await this.request('/cgi-bin/packetfilter.ha');
    if (html.includes('name="Enable"')) {
      const nonce = html.match(/name="nonce"\s+value="([^"]+)"/i)?.[1];
      if (nonce) {
        await this.request('/cgi-bin/packetfilter.ha', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ nonce, Enable: 'Enable Packet Filters' }).toString()
        });
      }
    }
  }

  async isDeviceBlocked({ mac }) {
    const auth = await this.authenticate();
    if (!auth.ok) return null;
    const { html } = await this.request('/cgi-bin/packetfilter.ha');
    if (!html.includes('name="Disable"')) return false;
    return html.toLowerCase().includes(normalizeMac(mac));
  }

  async blockDevice({ mac, ipv4 = null, ipv6List = [] }) {
    const auth = await this.authenticate();
    if (!auth.ok) return { ok: false, mode: 'att-bgw', detail: auth.reason };
    const cleanMac = normalizeMac(mac);

    const addOne = async (category, value) => {
      if (!value) return null;
      let { html } = await this.request('/cgi-bin/packetfilter.ha');
      if (html.toLowerCase().includes(value.toLowerCase())) return { category, value, status: 'exists' };
      const nonce1 = html.match(/name="nonce"\s+value="([^"]+)"/i)?.[1];
      html = (await this.request('/cgi-bin/packetfilter.ha', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ nonce: nonce1, AddDropRule: "Add a 'Drop' Rule" }).toString()
      })).html;
      const ids = [...html.matchAll(/name="AddMatch_(\d+)"/g)].map((m) => m[1]);
      const ruleId = ids[ids.length - 1];
      if (!ruleId) return null;

      const nonce2 = html.match(/name="nonce"\s+value="([^"]+)"/i)?.[1];
      const mRes = await this.request('/cgi-bin/packetfilter.ha', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ nonce: nonce2, [`AddMatch_${ruleId}`]: 'Add Match...' }).toString()
      });
      const editNonce1 = mRes.html.match(/action="\/cgi-bin\/packetfilteredit\.ha"[\s\S]*?name="nonce"\s+value="([^"]+)"/i)?.[1];
      const uRes = await this.request('/cgi-bin/packetfilteredit.ha', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ nonce: editNonce1, category, Update: 'Update' }).toString()
      });
      const editNonce2 = uRes.html.match(/action="\/cgi-bin\/packetfilteredit\.ha"[\s\S]*?name="nonce"\s+value="([^"]+)"/i)?.[1];

      const payload = { nonce: editNonce2, category, RuleComplete: 'on', EnterMatch: 'Enter Match' };
      if (category.includes('mac')) {
        payload.maclist = '';
        payload.hostmac = value;
      } else {
        payload.ipaddr = value;
      }
      await this.request('/cgi-bin/packetfilteredit.ha', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(payload).toString()
      });
      return { ruleId, category, value };
    };

    const rules = [];
    for (const [cat, val] of [
      ['src-host-mac', cleanMac],
      ['dst-host-mac', cleanMac],
      ...(ipv4 ? [['src-ip-addr', ipv4], ['dst-ip-addr', ipv4]] : []),
      ...(ipv6List || []).filter((x) => !x.startsWith('fe80:')).map((ip6) => ['dst-ip-addr', ip6])
    ]) {
      const r = await addOne(cat, val);
      if (r) rules.push(r);
    }
    await this._ensurePacketFiltersEnabled();
    return { ok: true, mode: 'bgw-packetfilter-drop', detail: `${rules.length} hardware Drop rules active` };
  }

  async unblockDevice({ mac, ipv4 = null, ipv6List = [] }) {
    const auth = await this.authenticate();
    if (!auth.ok) return { ok: false, mode: 'att-bgw', detail: auth.reason };
    const targets = [normalizeMac(mac), ipv4?.toLowerCase(), ...(ipv6List || []).map((x) => x.toLowerCase())].filter(Boolean);
    const removed = [];

    for (let pass = 0; pass < 30; pass++) {
      const { html } = await this.request('/cgi-bin/packetfilter.ha');
      const nonce = html.match(/name="nonce"\s+value="([^"]+)"/i)?.[1];
      let foundId = null;
      for (const tag of html.matchAll(/<input[^>]*name="Edit_(\d+)_\d+"[^>]*>/gi)) {
        const lowerTag = tag[0].toLowerCase();
        if (targets.some((t) => lowerTag.includes(t))) {
          foundId = tag[1];
          break;
        }
      }
      if (!foundId) break;
      let delNonce = nonce;
      if (html.includes(`name="UnComplete_${foundId}"`)) {
        const unRes = await this.request('/cgi-bin/packetfilter.ha', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ nonce, [`UnComplete_${foundId}`]: '' }).toString()
        });
        delNonce = unRes.html.match(/name="nonce"\s+value="([^"]+)"/i)?.[1] || nonce;
      }
      await this.request('/cgi-bin/packetfilter.ha', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ nonce: delNonce, [`DeleteRule_${foundId}`]: 'Delete' }).toString()
      });
      removed.push(foundId);
    }
    return { ok: true, mode: 'bgw-packetfilter-drop', detail: `Removed ${removed.length} hardware Drop rule(s)` };
  }
}
