import { normalizeMac } from '../state.js';

export const OPENWRT_META = {
  id: 'openwrt',
  name: 'OpenWrt / GL.iNet / LuCI',
  vendor: 'OpenWrt / GL.iNet / Turris',
  protocol: 'ubus JSON-RPC (/ubus + UCI Firewall)',
  defaultGateway: 'http://192.168.1.1',
  authFields: [
    { key: 'username', label: 'Username (default: root)', secret: false, required: false },
    { key: 'password', label: 'Root / LuCI Password', secret: true, required: true }
  ],
  capabilities: {
    discovery: 'ubus luci-rpc getHostHints (MAC + IPv4 + IPv6)',
    pause: 'UCI Firewall Drop Rule (fw4/nftables forward drop by MAC)',
    domainFilter: 'Local DNS Sinkhole (:5354)',
    zeroPassword: false
  }
};

export class OpenWrtAdapter {
  constructor(config = {}) {
    this.id = 'openwrt';
    this.meta = OPENWRT_META;
    this.baseUrl = (config.gatewayUrl || OPENWRT_META.defaultGateway).replace(/\/+$/, '');
    this.username = config.username || 'root';
    this.password = config.password || '';
    this.sessionToken = null;
    this._rpcId = 1;
  }

  async _ubus(session, object, method, params = {}) {
    const res = await fetch(`${this.baseUrl}/ubus`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: this._rpcId++,
        method: 'call',
        params: [session, object, method, params]
      }),
      signal: AbortSignal.timeout(8000)
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'ubus RPC error');
    return data.result;
  }

  async authenticate() {
    const result = await this._ubus('00000000000000000000000000000000', 'session', 'login', {
      username: this.username,
      password: this.password
    });
    if (!Array.isArray(result) || result[0] !== 0 || !result[1]?.ubus_rpc_session) {
      return { ok: false, reason: 'OpenWrt ubus login failed (check root password & uhttpd-mod-ubus)' };
    }
    this.sessionToken = result[1].ubus_rpc_session;
    return { ok: true };
  }

  async testConnection() {
    try {
      const auth = await this.authenticate();
      if (!auth.ok) return { ok: false, model: 'OpenWrt', detail: auth.reason };
      const [, info] = await this._ubus(this.sessionToken, 'system', 'board', {});
      const model = info?.model || 'OpenWrt Router';
      return { ok: true, model, detail: `Connected to ${model} (${info?.release?.description || 'OpenWrt'})` };
    } catch (err) {
      return { ok: false, model: null, detail: err.message };
    }
  }

  async listDevices() {
    if (!this.sessionToken) await this.authenticate();
    const [, hints] = await this._ubus(this.sessionToken, 'luci-rpc', 'getHostHints', {});
    const devices = [];
    for (const [rawMac, info] of Object.entries(hints || {})) {
      const mac = normalizeMac(rawMac);
      devices.push({
        mac,
        name: info.name || info.ipaddrs?.[0] || `Host ${mac.slice(-5)}`,
        ipv4: info.ipaddrs?.[0] || null,
        ipv6: info.ip6addrs?.[0] || null,
        ipv6List: info.ip6addrs || [],
        status: (info.ipaddrs?.length || info.ip6addrs?.length) ? 'online' : 'offline',
        band: 'LAN / Wi-Fi',
        lastActivity: 'Active in ubus hints'
      });
    }
    return devices;
  }

  _ruleName(mac) {
    return `curfewd_${normalizeMac(mac).replace(/:/g, '')}`;
  }

  async blockDevice({ mac }) {
    const auth = await this.authenticate();
    if (!auth.ok) return { ok: false, mode: 'openwrt', detail: auth.reason };
    const cleanMac = normalizeMac(mac);
    const name = this._ruleName(cleanMac);
    await this._ubus(this.sessionToken, 'uci', 'add', {
      config: 'firewall',
      type: 'rule',
      name,
      values: {
        name,
        src: 'lan',
        dest: 'wan',
        src_mac: cleanMac,
        target: 'REJECT',
        enabled: '1'
      }
    });
    await this._ubus(this.sessionToken, 'uci', 'commit', { config: 'firewall' });
    await this._ubus(this.sessionToken, 'file', 'exec', { command: '/etc/init.d/firewall', params: ['reload'] }).catch(() => {});
    return { ok: true, mode: 'openwrt-uci-firewall', detail: `Added UCI firewall REJECT rule ${name}` };
  }

  async unblockDevice({ mac }) {
    const auth = await this.authenticate();
    if (!auth.ok) return { ok: false, mode: 'openwrt', detail: auth.reason };
    const name = this._ruleName(mac);
    await this._ubus(this.sessionToken, 'uci', 'delete', { config: 'firewall', section: name }).catch(() => {});
    await this._ubus(this.sessionToken, 'uci', 'commit', { config: 'firewall' });
    await this._ubus(this.sessionToken, 'file', 'exec', { command: '/etc/init.d/firewall', params: ['reload'] }).catch(() => {});
    return { ok: true, mode: 'openwrt-uci-firewall', detail: `Removed UCI firewall rule ${name}` };
  }

  async isDeviceBlocked({ mac }) {
    try {
      if (!this.sessionToken) await this.authenticate();
      const [, res] = await this._ubus(this.sessionToken, 'uci', 'get', {
        config: 'firewall',
        section: this._ruleName(mac)
      });
      return Boolean(res?.values);
    } catch {
      return false;
    }
  }
}
