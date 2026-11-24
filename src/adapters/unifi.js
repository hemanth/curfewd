import https from 'node:https';
import { normalizeMac } from '../state.js';

export const UNIFI_META = {
  id: 'unifi',
  name: 'Ubiquiti UniFi OS (UDM / Cloud Gateway)',
  vendor: 'Ubiquiti Inc.',
  protocol: 'UniFi Network REST API (/proxy/network/api/s/default)',
  defaultGateway: 'https://192.168.1.1',
  authFields: [
    { key: 'username', label: 'Local Admin Username', secret: false, required: true },
    { key: 'password', label: 'Local Admin Password', secret: true, required: true }
  ],
  capabilities: {
    discovery: 'Active stations (/stat/sta) with RSSI & band',
    pause: 'Instant station block (/cmd/stamgr block-sta)',
    domainFilter: 'Local DNS Sinkhole (:5354)',
    zeroPassword: false
  }
};

const TLS_CERT_ERROR_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED'
]);

function isLocalPrivateHost(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return true;
    if (host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.')) return true;
    const m = host.match(/^172\.(\d+)\./);
    if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
    return false;
  } catch {
    return false;
  }
}

function httpsInsecureRequest(urlStr, init = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      {
        hostname: u.hostname.replace(/^\[|\]$/g, ''),
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: init.method || 'GET',
        headers: init.headers || {},
        rejectUnauthorized: false,
        timeout: 8000
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const rawSetCookie = res.headers['set-cookie'];
          const setCookies = Array.isArray(rawSetCookie) ? rawSetCookie : rawSetCookie ? [rawSetCookie] : [];
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            headers: {
              get(name) {
                const val = res.headers[String(name).toLowerCase()];
                return Array.isArray(val) ? val.join(', ') : val ?? null;
              },
              getSetCookie() {
                return setCookies;
              }
            },
            async json() {
              return JSON.parse(text);
            },
            async text() {
              return text;
            }
          });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('UniFi HTTPS request timeout'));
    });
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

export class UniFiAdapter {
  constructor(config = {}) {
    this.id = 'unifi';
    this.meta = UNIFI_META;
    this.baseUrl = (config.gatewayUrl || UNIFI_META.defaultGateway).replace(/\/+$/, '');
    this.username = config.username || '';
    this.password = config.password || '';
    this.site = config.site || 'default';
    this.allowSelfSigned = config.allowSelfSigned;
    this.cookie = null;
    this.csrf = null;
  }

  async _fetch(url, init = {}) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
    } catch (err) {
      const code = err?.cause?.code || err?.code || '';
      const allowInsecure = this.allowSelfSigned !== undefined ? Boolean(this.allowSelfSigned) : isLocalPrivateHost(this.baseUrl);
      if (url.startsWith('https://') && allowInsecure && TLS_CERT_ERROR_CODES.has(code)) {
        return await httpsInsecureRequest(url, init);
      }
      throw err;
    }
  }

  async authenticate() {
    const res = await this._fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.username, password: this.password, rememberMe: false })
    });
    if (!res.ok) return { ok: false, reason: `UniFi login failed (HTTP ${res.status})` };
    const multiCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    if (multiCookies.length > 0) {
      this.cookie = multiCookies.map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
    } else {
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) this.cookie = setCookie.split(';')[0].trim();
    }
    this.csrf = res.headers.get('x-csrf-token') || null;
    return { ok: true };
  }

  async _api(pathname, options = {}, retried = false) {
    if (!this.cookie) {
      const auth = await this.authenticate();
      if (!auth.ok) throw new Error(auth.reason);
    }
    const headers = {
      'Content-Type': 'application/json',
      ...(this.cookie ? { Cookie: this.cookie } : {}),
      ...(this.csrf ? { 'X-CSRF-Token': this.csrf } : {})
    };
    const res = await this._fetch(`${this.baseUrl}/proxy/network/api/s/${this.site}${pathname}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    if ((res.status === 401 || res.status === 403) && !retried) {
      this.cookie = null;
      this.csrf = null;
      const auth = await this.authenticate();
      if (!auth.ok) throw new Error(auth.reason);
      return this._api(pathname, options, true);
    }
    if (!res.ok) throw new Error(`UniFi API HTTP ${res.status}`);
    return res.json();
  }

  async testConnection() {
    try {
      const auth = await this.authenticate();
      if (!auth.ok) return { ok: false, model: 'UniFi OS', detail: auth.reason };
      const data = await this._api('/stat/sta');
      return { ok: true, model: 'Ubiquiti UniFi OS', detail: `Connected (${(data.data || []).length} active stations)` };
    } catch (err) {
      return { ok: false, model: null, detail: err.message };
    }
  }

  async listDevices() {
    const data = await this._api('/stat/sta');
    const devices = [];
    for (const sta of data.data || []) {
      const mac = normalizeMac(sta.mac);
      if (!mac) continue;
      devices.push({
        mac,
        name: sta.name || sta.hostname || sta.oui || sta.ip || mac,
        ipv4: sta.ip || null,
        ipv6: null,
        ipv6List: [],
        status: 'online',
        band: sta.is_wired ? 'Ethernet' : (sta.radio === 'na' ? '5 GHz Wi-Fi' : '2.4 GHz Wi-Fi'),
        lastActivity: sta.last_seen ? new Date(sta.last_seen * 1000).toISOString() : ''
      });
    }
    return devices;
  }

  async blockDevice({ mac }) {
    const cleanMac = normalizeMac(mac);
    if (!cleanMac) return { ok: false, mode: 'unifi-stamgr', detail: 'Invalid MAC address' };
    try {
      await this._api('/cmd/stamgr', {
        method: 'POST',
        body: { cmd: 'block-sta', mac: cleanMac }
      });
      return { ok: true, mode: 'unifi-stamgr', detail: `Blocked ${cleanMac} via UniFi stamgr` };
    } catch (err) {
      return { ok: false, mode: 'unifi-stamgr', detail: err.message };
    }
  }

  async unblockDevice({ mac }) {
    const cleanMac = normalizeMac(mac);
    if (!cleanMac) return { ok: false, mode: 'unifi-stamgr', detail: 'Invalid MAC address' };
    try {
      await this._api('/cmd/stamgr', {
        method: 'POST',
        body: { cmd: 'unblock-sta', mac: cleanMac }
      });
      return { ok: true, mode: 'unifi-stamgr', detail: `Unblocked ${cleanMac} via UniFi stamgr` };
    } catch (err) {
      return { ok: false, mode: 'unifi-stamgr', detail: err.message };
    }
  }

  async isDeviceBlocked() {
    return null;
  }
}
