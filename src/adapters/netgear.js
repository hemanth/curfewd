import { normalizeMac } from '../state.js';

export const NETGEAR_META = {
  id: 'netgear',
  name: 'Netgear Nighthawk / Orbi (SOAP)',
  vendor: 'Netgear',
  protocol: 'SOAP Action (:5000/soap/server_sa/)',
  defaultGateway: 'http://192.168.1.1:5000',
  authFields: [
    { key: 'username', label: 'Admin Username (default: admin)', secret: false, required: false },
    { key: 'password', label: 'Router Admin Password', secret: true, required: true }
  ],
  capabilities: {
    discovery: 'DeviceInfo:GetAttachDevice2 SOAP',
    pause: 'DeviceConfig:SetBlockDeviceByMAC (Allow/Block)',
    domainFilter: 'Local DNS Sinkhole (:5354)',
    zeroPassword: false
  }
};

export class NetgearAdapter {
  constructor(config = {}) {
    this.id = 'netgear';
    this.meta = NETGEAR_META;
    this.baseUrl = (config.gatewayUrl || NETGEAR_META.defaultGateway).replace(/\/+$/, '');
    this.username = config.username || 'admin';
    this.password = config.password || '';
    this.sessionId = 'A7D88AE69687E58D9A00';
  }

  async _soap(service, action, bodyXml = '') {
    const envelope = `<?xml version="1.0" encoding="utf-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
  <SOAP-ENV:Header><SessionID>${this.sessionId}</SessionID></SOAP-ENV:Header>
  <SOAP-ENV:Body><M1:${action} xmlns:M1="urn:NETGEAR-ROUTER:service:${service}:1">${bodyXml}</M1:${action}></SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
    const res = await fetch(`${this.baseUrl}/soap/server_sa/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: `urn:NETGEAR-ROUTER:service:${service}:1#${action}`
      },
      body: envelope,
      signal: AbortSignal.timeout(8000)
    });
    return res.text();
  }

  async authenticate() {
    const xml = await this._soap(
      'ParentalControl',
      'Authenticate',
      `<NewUsername>${this.username}</NewUsername><NewPassword>${this.password}</NewPassword>`
    );
    const ok = xml.includes('<ResponseCode>000</ResponseCode>');
    return { ok, reason: ok ? 'Authenticated' : 'Netgear SOAP authentication failed' };
  }

  async testConnection() {
    try {
      const auth = await this.authenticate();
      if (!auth.ok) return { ok: false, model: 'Netgear', detail: auth.reason };
      return { ok: true, model: 'Netgear SOAP Router', detail: `Authenticated with ${this.baseUrl}` };
    } catch (err) {
      return { ok: false, model: null, detail: err.message };
    }
  }

  async listDevices() {
    await this.authenticate();
    const xml = await this._soap('DeviceInfo', 'GetAttachDevice');
    const raw = xml.match(/<NewAttachDevice>([\s\S]*?)<\/NewAttachDevice>/i)?.[1] || '';
    const devices = [];
    for (const row of raw.split('@').slice(1)) {
      const parts = row.split(';');
      if (parts.length < 4) continue;
      const mac = normalizeMac(parts[3]);
      if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) continue;
      devices.push({
        mac,
        name: parts[2] || parts[1] || mac,
        ipv4: parts[1] || null,
        ipv6: null,
        ipv6List: [],
        status: 'online',
        band: parts[4] || 'LAN',
        lastActivity: ''
      });
    }
    return devices;
  }

  async blockDevice({ mac }) {
    await this.authenticate();
    const upperMac = normalizeMac(mac).toUpperCase();
    await this._soap(
      'DeviceConfig',
      'SetBlockDeviceByMAC',
      `<NewAllowOrBlock>Block</NewAllowOrBlock><NewMACAddress>${upperMac}</NewMACAddress>`
    );
    return { ok: true, mode: 'netgear-soap', detail: `Blocked ${upperMac} via Netgear SOAP` };
  }

  async unblockDevice({ mac }) {
    await this.authenticate();
    const upperMac = normalizeMac(mac).toUpperCase();
    await this._soap(
      'DeviceConfig',
      'SetBlockDeviceByMAC',
      `<NewAllowOrBlock>Allow</NewAllowOrBlock><NewMACAddress>${upperMac}</NewMACAddress>`
    );
    return { ok: true, mode: 'netgear-soap', detail: `Unblocked ${upperMac} via Netgear SOAP` };
  }

  async isDeviceBlocked() {
    return null;
  }
}
