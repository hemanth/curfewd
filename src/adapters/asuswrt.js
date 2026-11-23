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

export class AsusWrtAdapter {
  constructor(config = {}) {
    this.id = 'asuswrt';
    this.meta = ASUSWRT_META;
    this.baseUrl = (config.gatewayUrl || ASUSWRT_META.defaultGateway).replace(/\/+$/, '');
    this.username = config.username || 'admin';
    this.password = config.password || '';
    this.token = null;
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
    const data = await res.json().catch(() => ({}));
    if (!data.asus_token) return { ok: false, reason: 'ASUSWRT login failed (check admin username/password)' };
    this.token = data.asus_token;
    return { ok: true };
  }

  async _get(hook) {
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
    return res.json();
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
      if (!info || typeof info !== 'object' || !info.mac) continue;
      const mac = normalizeMac(info.mac || k);
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
    if (!this.token) await this.authenticate();
    const upperMac = normalizeMac(mac).toUpperCase();
    await fetch(`${this.baseUrl}/start_apply.htm`, {
      method: 'POST',
      headers: {
        Cookie: `asus_token=${this.token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'asusrouter-Android-DUTUtil-1.0.0.245'
      },
      body: new URLSearchParams({
        action_mode: 'apply',
        rc_service: 'restart_firewall',
        MULTIFILTER_ENABLE: '1',
        MULTIFILTER_MAC: upperMac,
        MULTIFILTER_DEVICENAME: 'curfewd'
      }).toString(),
      signal: AbortSignal.timeout(8000)
    });
    return { ok: true, mode: 'asuswrt-multifilter', detail: `Blocked ${upperMac} via ASUSWRT MULTIFILTER` };
  }

  async unblockDevice({ mac }) {
    if (!this.token) await this.authenticate();
    await fetch(`${this.baseUrl}/start_apply.htm`, {
      method: 'POST',
      headers: {
        Cookie: `asus_token=${this.token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'asusrouter-Android-DUTUtil-1.0.0.245'
      },
      body: new URLSearchParams({
        action_mode: 'apply',
        rc_service: 'restart_firewall',
        MULTIFILTER_ENABLE: '0',
        MULTIFILTER_MAC: ''
      }).toString(),
      signal: AbortSignal.timeout(8000)
    });
    return { ok: true, mode: 'asuswrt-multifilter', detail: `Unblocked ${normalizeMac(mac)} via ASUSWRT` };
  }

  async isDeviceBlocked() {
    return null;
  }
}
