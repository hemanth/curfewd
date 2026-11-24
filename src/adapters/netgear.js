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

function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getSoapError(xml) {
  if (/<SOAP-ENV:Fault>/i.test(xml)) {
    const fault = xml.match(/<faultstring>([\s\S]*?)<\/faultstring>/i)?.[1]?.trim();
    return fault || 'Netgear SOAP Fault';
  }
  const code = xml.match(/<ResponseCode>(\d+)<\/ResponseCode>/i)?.[1];
  if (code && code !== '000') {
    return `Netgear SOAP ResponseCode ${code}`;
  }
  return null;
}

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
    if (!res.ok) {
      throw new Error(`Netgear SOAP HTTP ${res.status}`);
    }
    return res.text();
  }

  async authenticate() {
    const xml = await this._soap(
      'ParentalControl',
      'Authenticate',
      `<NewUsername>${escapeXml(this.username)}</NewUsername><NewPassword>${escapeXml(this.password)}</NewPassword>`
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
    const auth = await this.authenticate();
    if (!auth.ok) throw new Error(auth.reason);

    // Prefer GetAttachDevice2 XML format, fall back to legacy GetAttachDevice
    try {
      const xml2 = await this._soap('DeviceInfo', 'GetAttachDevice2');
      const soapErr = getSoapError(xml2);
      const raw2 = xml2.match(/<NewAttachDevice2>([\s\S]*?)<\/NewAttachDevice2>/i)?.[1];
      if (!soapErr && raw2) {
        const devices = [];
        for (const block of raw2.matchAll(/<Device>([\s\S]*?)<\/Device>/gi)) {
          const item = block[1];
          const rawMac = item.match(/<MAC>([\s\S]*?)<\/MAC>/i)?.[1]?.trim();
          const mac = normalizeMac(rawMac);
          if (!mac) continue;
          const ip = item.match(/<IP>([\s\S]*?)<\/IP>/i)?.[1]?.trim() || null;
          const name = item.match(/<Name>([\s\S]*?)<\/Name>/i)?.[1]?.trim() || ip || mac;
          const conn =
            item.match(/<ConnectionType>([\s\S]*?)<\/ConnectionType>/i)?.[1]?.trim() ||
            item.match(/<ConnectionMethod>([\s\S]*?)<\/ConnectionMethod>/i)?.[1]?.trim() ||
            'LAN';
          devices.push({
            mac,
            name,
            ipv4: ip,
            ipv6: null,
            ipv6List: [],
            status: 'online',
            band: conn,
            lastActivity: ''
          });
        }
        return devices;
      }
    } catch {}

    const xml = await this._soap('DeviceInfo', 'GetAttachDevice');
    const soapErr = getSoapError(xml);
    if (soapErr) throw new Error(soapErr);
    const raw = xml.match(/<NewAttachDevice>([\s\S]*?)<\/NewAttachDevice>/i)?.[1] || '';
    const devices = [];
    for (const row of raw.split('@').slice(1)) {
      const parts = row.split(';');
      if (parts.length < 4) continue;
      const mac = normalizeMac(parts[3]);
      if (!mac) continue;
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
    const cleanMac = normalizeMac(mac);
    if (!cleanMac) return { ok: false, mode: 'netgear-soap', detail: 'Invalid MAC address' };
    try {
      const auth = await this.authenticate();
      if (!auth.ok) return { ok: false, mode: 'netgear-soap', detail: auth.reason };
      const upperMac = cleanMac.toUpperCase();
      const xml = await this._soap(
        'DeviceConfig',
        'SetBlockDeviceByMAC',
        `<NewAllowOrBlock>Block</NewAllowOrBlock><NewMACAddress>${upperMac}</NewMACAddress>`
      );
      const soapErr = getSoapError(xml);
      if (soapErr) return { ok: false, mode: 'netgear-soap', detail: soapErr };
      return { ok: true, mode: 'netgear-soap', detail: `Blocked ${upperMac} via Netgear SOAP` };
    } catch (err) {
      return { ok: false, mode: 'netgear-soap', detail: err.message };
    }
  }

  async unblockDevice({ mac }) {
    const cleanMac = normalizeMac(mac);
    if (!cleanMac) return { ok: false, mode: 'netgear-soap', detail: 'Invalid MAC address' };
    try {
      const auth = await this.authenticate();
      if (!auth.ok) return { ok: false, mode: 'netgear-soap', detail: auth.reason };
      const upperMac = cleanMac.toUpperCase();
      const xml = await this._soap(
        'DeviceConfig',
        'SetBlockDeviceByMAC',
        `<NewAllowOrBlock>Allow</NewAllowOrBlock><NewMACAddress>${upperMac}</NewMACAddress>`
      );
      const soapErr = getSoapError(xml);
      if (soapErr) return { ok: false, mode: 'netgear-soap', detail: soapErr };
      return { ok: true, mode: 'netgear-soap', detail: `Unblocked ${upperMac} via Netgear SOAP` };
    } catch (err) {
      return { ok: false, mode: 'netgear-soap', detail: err.message };
    }
  }

  async isDeviceBlocked() {
    return null;
  }
}
