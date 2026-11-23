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

export class UniFiAdapter {
  constructor(config = {}) {
    this.id = 'unifi';
    this.meta = UNIFI_META;
    this.baseUrl = (config.gatewayUrl || UNIFI_META.defaultGateway).replace(/\/+$/, '');
    this.username = config.username || '';
    this.password = config.password || '';
    this.site = config.site || 'default';
    this.cookie = null;
    this.csrf = null;
  }

  async authenticate() {
    const res = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.username, password: this.password, rememberMe: false }),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return { ok: false, reason: `UniFi login failed (HTTP ${res.status})` };
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    this.csrf = res.headers.get('x-csrf-token') || null;
    return { ok: true };
  }

  async _api(pathname, options = {}) {
    if (!this.cookie) {
      const auth = await this.authenticate();
      if (!auth.ok) throw new Error(auth.reason);
    }
    const headers = {
      'Content-Type': 'application/json',
      ...(this.cookie ? { Cookie: this.cookie } : {}),
      ...(this.csrf ? { 'X-CSRF-Token': this.csrf } : {})
    };
    const res = await fetch(`${this.baseUrl}/proxy/network/api/s/${this.site}${pathname}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(8000)
    });
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
    return (data.data || []).map((sta) => ({
      mac: normalizeMac(sta.mac),
      name: sta.name || sta.hostname || sta.oui || sta.ip || sta.mac,
      ipv4: sta.ip || null,
      ipv6: null,
      ipv6List: [],
      status: 'online',
      band: sta.is_wired ? 'Ethernet' : (sta.radio === 'na' ? '5 GHz Wi-Fi' : '2.4 GHz Wi-Fi'),
      lastActivity: sta.last_seen ? new Date(sta.last_seen * 1000).toISOString() : ''
    }));
  }

  async blockDevice({ mac }) {
    await this._api('/cmd/stamgr', {
      method: 'POST',
      body: { cmd: 'block-sta', mac: normalizeMac(mac) }
    });
    return { ok: true, mode: 'unifi-stamgr', detail: `Blocked ${normalizeMac(mac)} via UniFi stamgr` };
  }

  async unblockDevice({ mac }) {
    await this._api('/cmd/stamgr', {
      method: 'POST',
      body: { cmd: 'unblock-sta', mac: normalizeMac(mac) }
    });
    return { ok: true, mode: 'unifi-stamgr', detail: `Unblocked ${normalizeMac(mac)} via UniFi stamgr` };
  }

  async isDeviceBlocked() {
    return null;
  }
}
