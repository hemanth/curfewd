import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeMac, isValidMac } from '../state.js';
import { scanArpNdpDevices } from './universal.js';

const execAsync = promisify(exec);

export const CUSTOM_META = {
  id: 'custom',
  name: 'Custom Router Hook (Shell / Webhook)',
  vendor: 'pfSense, OPNsense, MikroTik, FRITZ!Box, TP-Link Omada, or any scriptable router',
  protocol: 'Shell Command Hooks ({{mac}}, {{ip}}) or ARP/NDP Discovery',
  defaultGateway: 'http://192.168.1.1',
  authFields: [
    { key: 'blockCmd', label: 'Block command (uses {{mac}} and {{ip}})', secret: false, required: false },
    { key: 'unblockCmd', label: 'Unblock command (uses {{mac}} and {{ip}})', secret: false, required: false },
    { key: 'listCmd', label: 'Optional list command returning JSON array (blank = ARP/NDP)', secret: false, required: false }
  ],
  capabilities: {
    discovery: 'Custom JSON command or OS ARP/NDP fallback',
    pause: 'User-defined shell/SSH/API hook per MAC/IP',
    domainFilter: 'Local DNS Sinkhole (:5354 / :53)',
    zeroPassword: false
  }
};

function sanitizeIp(ip) {
  const s = String(ip ?? '').trim();
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(s)) return s;
  if (/^[0-9a-f:]+$/i.test(s) && s.includes(':')) return s;
  return '';
}

function interpolate(template, vars) {
  return String(template || '')
    .replace(/\{\{mac\}\}/gi, vars.mac || '')
    .replace(/\{\{ip\}\}/gi, vars.ip || '');
}

export class CustomAdapter {
  constructor(config = {}) {
    this.id = 'custom';
    this.meta = CUSTOM_META;
    const hooks = config.customHooks || {};
    this.blockCmd = (config.blockCmd ?? hooks.blockCmd ?? '').trim();
    this.unblockCmd = (config.unblockCmd ?? hooks.unblockCmd ?? '').trim();
    this.listCmd = (config.listCmd ?? hooks.listCmd ?? '').trim();
  }

  async testConnection() {
    try {
      const devices = await this.listDevices();
      return {
        ok: true,
        model: 'Custom Router Hook',
        detail: `Ready (${devices.length} LAN host(s), block hook: ${this.blockCmd ? 'configured' : 'DNS sinkhole fallback'})`
      };
    } catch (err) {
      return {
        ok: false,
        model: 'Custom Router Hook',
        detail: err.message
      };
    }
  }

  async listDevices() {
    if (this.listCmd) {
      const { stdout } = await execAsync(this.listCmd, { timeout: 8000 });
      const parsed = JSON.parse(stdout);
      if (Array.isArray(parsed)) {
        return parsed
          .map((d) => {
            const mac = normalizeMac(d.mac);
            if (!mac) return null;
            return {
              mac,
              name: d.name || d.ip || mac,
              ipv4: d.ipv4 || d.ip || null,
              ipv6: d.ipv6 || null,
              ipv6List: d.ipv6List || [],
              status: d.status || 'online',
              band: d.band || 'LAN',
              lastActivity: d.lastActivity || ''
            };
          })
          .filter(Boolean);
      }
    }
    return scanArpNdpDevices();
  }

  async blockDevice({ mac, ipv4 = null }) {
    const cleanMac = normalizeMac(mac);
    if (!isValidMac(cleanMac)) {
      return { ok: false, mode: 'custom-hook', detail: 'Invalid MAC address' };
    }
    if (!this.blockCmd) {
      return { ok: true, mode: 'custom-dns-fallback', detail: `No blockCmd set; enforced via DNS sinkhole for ${cleanMac}` };
    }
    try {
      const cmd = interpolate(this.blockCmd, { mac: cleanMac, ip: sanitizeIp(ipv4) });
      await execAsync(cmd, { timeout: 10000 });
      return { ok: true, mode: 'custom-hook', detail: `Executed block hook for ${cleanMac}` };
    } catch (err) {
      return { ok: false, mode: 'custom-hook', detail: err.message };
    }
  }

  async unblockDevice({ mac, ipv4 = null }) {
    const cleanMac = normalizeMac(mac);
    if (!isValidMac(cleanMac)) {
      return { ok: false, mode: 'custom-hook', detail: 'Invalid MAC address' };
    }
    if (!this.unblockCmd) {
      return { ok: true, mode: 'custom-dns-fallback', detail: `No unblockCmd set; released from DNS sinkhole for ${cleanMac}` };
    }
    try {
      const cmd = interpolate(this.unblockCmd, { mac: cleanMac, ip: sanitizeIp(ipv4) });
      await execAsync(cmd, { timeout: 10000 });
      return { ok: true, mode: 'custom-hook', detail: `Executed unblock hook for ${cleanMac}` };
    } catch (err) {
      return { ok: false, mode: 'custom-hook', detail: err.message };
    }
  }

  async isDeviceBlocked() {
    return null;
  }
}
