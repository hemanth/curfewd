import { normalizeMac } from '../state.js';

export const ASUSWRT_META = {
  id: 'asuswrt',
  name: 'ASUSWRT / ASUSWRT-Merlin',
  vendor: 'ASUS',
  protocol: 'HTTP Token Cookie (asus_token) + appGet.cgi',
  defaultGateway: 'http://192.168.50.1',
  authFields: [
    { key: 'username', label: 'Admin Username (default: admin)', secret: false, required: false },
    { key: 'password', label: 'Admin Password', secret: true, required: true }
  ],
  capabilities: {
    discovery: 'Client list (/appGet.cgi?hook=get_clientlist())',
    pause: 'MULTIFILTER_MAC iptables drop (/start_apply.htm)',
    domainFilter: 'Local DNS Sinkhole (:5354)',
    zeroPassword: false
  }
};

function isSessionExpiredResponse(res, text) {
  if (res.status === 401 || res.status === 403) return true;
  if (/Main_Login\.asp/i.test(text)) return true;
  try {
    const data = JSON.parse(text);
    if (data && data.error_status !== undefined && data.error_status !== null && String(data.error_status) !== '0') {
      return true;
    }
  } catch {
    if (/"error_status"\s*:\s*"?[1-9]/i.test(text)) return true;
  }
  return false;
}

export class AsusWrtAdapter {
  constructor(config = {}) {
    this.id = 'asuswrt';
    this.meta = ASUSWRT_META;
    this.baseUrl = (config.gatewayUrl || ASUSWRT_META.defaultGateway).replace(/\/+$/, '');
    this.username = config.username || 'admin';
    this.password = config.password || '';
    this.token = null;
    this._queue = Promise.resolve();
  }

  _enqueue(fn) {
    const next = this._queue.then(fn, fn);
    this._queue = next.catch(() => {});
    return next;
  }

  async authenticate() {
    const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
    const res = await fetch(`${this.baseUrl}/login.cgi`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'asusrouter-Android-DUTUtil-1.0.0.245'
      },
      body: new URLSearchParams({ login_authorization: auth }).toString(),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) {
      return { ok: false, reason: `ASUSWRT login failed (HTTP ${res.status})` };
    }
    const data = await res.json().catch(() => ({}));
    if (!data.asus_token) return { ok: false, reason: 'ASUSWRT login failed (check admin username/password)' };
    this.token = data.asus_token;
    return { ok: true };
  }

  async _get(hook, retried = false) {
    if (!this.token) {
      const auth = await this.authenticate();
      if (!auth.ok) throw new Error(auth.reason);
    }
    const res = await fetch(`${this.baseUrl}/appGet.cgi?hook=${encodeURIComponent(hook)}`, {
      headers: {
        Cookie: `asus_token=${this.token}`,
        'User-Agent': 'asusrouter-Android-DUTUtil-1.0.0.245'
      },
      signal: AbortSignal.timeout(8000)
    });
    const text = await res.text();
    const expired = isSessionExpiredResponse(res, text);
    if (expired && !retried) {
      this.token = null;
      const auth = await this.authenticate();
      if (!auth.ok) throw new Error(auth.reason);
      return this._get(hook, true);
    }
    if (!res.ok) {
      throw new Error(`ASUSWRT HTTP ${res.status}`);
    }
    if (/Main_Login\.asp/i.test(text)) {
      throw new Error('ASUSWRT session expired');
    }
    try {
      const data = JSON.parse(text);
      if (data && data.error_status && String(data.error_status) !== '0') {
        throw new Error(`ASUSWRT error_status ${data.error_status}`);
      }
      return data;
    } catch (err) {
      if (err.message.startsWith('ASUSWRT')) throw err;
      throw new Error('Invalid JSON response from ASUSWRT appGet.cgi');
    }
  }

  async _apply(params, retried = false) {
    if (!this.token) {
      const auth = await this.authenticate();
      if (!auth.ok) throw new Error(auth.reason);
    }
    const res = await fetch(`${this.baseUrl}/start_apply.htm`, {
      method: 'POST',
      headers: {
        Cookie: `asus_token=${this.token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'asusrouter-Android-DUTUtil-1.0.0.245'
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(8000)
    });
    const text = await res.text();
    const expired = isSessionExpiredResponse(res, text);
    if (expired && !retried) {
      this.token = null;
      const auth = await this.authenticate();
      if (!auth.ok) throw new Error(auth.reason);
      return this._apply(params, true);
    }
    if (!res.ok) {
      throw new Error(`ASUSWRT apply HTTP ${res.status}`);
    }
    return text;
  }

  async _getBlockedMacs() {
    const data = await this._get('nvram_get(MULTIFILTER_MAC)');
    const raw = String(data?.MULTIFILTER_MAC || '');
    const list = [];
    for (const part of raw.split('<')) {
      const nm = normalizeMac(part);
      if (nm) {
        const upper = nm.toUpperCase();
        if (!list.includes(upper)) list.push(upper);
      }
    }
    return list;
  }

  async testConnection() {
    try {
      const auth = await this.authenticate();
      if (!auth.ok) return { ok: false, model: 'ASUSWRT', detail: auth.reason };
      const clients = await this.listDevices();
      return { ok: true, model: 'ASUSWRT', detail: `Connected (${clients.length} client(s) discovered)` };
    } catch (err) {
      return { ok: false, model: null, detail: err.message };
    }
  }

  async listDevices() {
    const data = await this._get('get_clientlist()');
    const map = data?.get_clientlist || {};
    const devices = [];
    for (const [k, info] of Object.entries(map)) {
      if (!info || typeof info !== 'object') continue;
      const mac = normalizeMac(info.mac || k);
      if (!mac) continue;
      devices.push({
        mac,
        name: info.nickName || info.name || info.ip || mac,
        ipv4: info.ip || null,
        ipv6: null,
        ipv6List: [],
        status: String(info.isOnline) === '1' ? 'online' : 'offline',
        band: String(info.isWL) === '2' ? '5 GHz Wi-Fi' : String(info.isWL) === '1' ? '2.4 GHz Wi-Fi' : 'Ethernet',
        lastActivity: ''
      });
    }
    return devices;
  }

  async blockDevice({ mac }) {
    const cleanMac = normalizeMac(mac);
    if (!cleanMac) return { ok: false, mode: 'asuswrt-multifilter', detail: 'Invalid MAC address' };
    return this._enqueue(async () => {
      try {
        const upperMac = cleanMac.toUpperCase();
        const existing = await this._getBlockedMacs();
        const merged = existing.includes(upperMac) ? existing : [...existing, upperMac];
        await this._apply({
          action_mode: 'apply',
          rc_service: 'restart_firewall',
          MULTIFILTER_ENABLE: '1',
          MULTIFILTER_MAC: merged.join('<'),
          MULTIFILTER_DEVICENAME: merged.map(() => 'curfewd').join('<')
        });
        return { ok: true, mode: 'asuswrt-multifilter', detail: `Blocked ${upperMac} via ASUSWRT MULTIFILTER` };
      } catch (err) {
        return { ok: false, mode: 'asuswrt-multifilter', detail: err.message };
      }
    });
  }

  async unblockDevice({ mac }) {
    const cleanMac = normalizeMac(mac);
    if (!cleanMac) return { ok: false, mode: 'asuswrt-multifilter', detail: 'Invalid MAC address' };
    return this._enqueue(async () => {
      try {
        const upperMac = cleanMac.toUpperCase();
        const existing = await this._getBlockedMacs();
        const remaining = existing.filter((m) => m !== upperMac);
        if (remaining.length > 0) {
          await this._apply({
            action_mode: 'apply',
            rc_service: 'restart_firewall',
            MULTIFILTER_ENABLE: '1',
            MULTIFILTER_MAC: remaining.join('<'),
            MULTIFILTER_DEVICENAME: remaining.map(() => 'curfewd').join('<')
          });
        } else {
          await this._apply({
            action_mode: 'apply',
            rc_service: 'restart_firewall',
            MULTIFILTER_ENABLE: '0',
            MULTIFILTER_MAC: '',
            MULTIFILTER_DEVICENAME: ''
          });
        }
        return { ok: true, mode: 'asuswrt-multifilter', detail: `Unblocked ${cleanMac} via ASUSWRT` };
      } catch (err) {
        return { ok: false, mode: 'asuswrt-multifilter', detail: err.message };
      }
    });
  }

  async isDeviceBlocked() {
    return null;
  }
}
