import { execFile } from 'node:child_process';
import dns from 'node:dns/promises';
import { promisify } from 'node:util';
import { normalizeMac } from '../state.js';

const execFileAsync = promisify(execFile);
const PTR_CACHE = new Map(); // ipv4 -> { name, expiresAt }
const PTR_TTL_MS = 5 * 60_000;
let cachedGatewayIp = null;

async function getGatewayIpForPtr(gatewayUrl) {
  if (cachedGatewayIp) return cachedGatewayIp;
  try {
    const { stdout } = await execFileAsync('route', ['-n', 'get', 'default'], { timeout: 1000 });
    const m = stdout.match(/gateway:\s*(\d+\.\d+\.\d+\.\d+)/i);
    if (m) { cachedGatewayIp = m[1]; return cachedGatewayIp; }
  } catch {}
  try {
    const { stdout } = await execFileAsync('ip', ['route', 'show', 'default'], { timeout: 1000 });
    const m = stdout.match(/default\s+via\s+(\d+\.\d+\.\d+\.\d+)/i);
    if (m) { cachedGatewayIp = m[1]; return cachedGatewayIp; }
  } catch {}
  if (gatewayUrl) {
    try {
      const host = new URL(gatewayUrl).hostname;
      if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;
    } catch {}
  }
  return null;
}

function cleanLanHostname(names) {
  if (!Array.isArray(names) || names.length === 0) return null;
  const preferred = names.find((n) => !n.includes('.')) || names[0];
  return preferred.replace(/\.(attlocal\.net|local|lan|home|localdomain)\.?$/i, '').trim() || null;
}

async function resolveLanHostnames(devices, gatewayUrl) {
  const candidates = devices.filter((d) => d.ipv4 && /^LAN Host \(/.test(d.name));
  if (candidates.length === 0) return devices;

  const now = Date.now();
  const gwIp = await getGatewayIpForPtr(gatewayUrl);
  const resolver = new dns.Resolver();
  if (gwIp) {
    try { resolver.setServers([gwIp]); } catch {}
  }

  await Promise.all(
    candidates.map(async (dev) => {
      const cached = PTR_CACHE.get(dev.ipv4);
      if (cached && cached.expiresAt > now) {
        if (cached.name) dev.name = cached.name;
        return;
      }
      const names = await Promise.race([
        resolver.reverse(dev.ipv4).catch(() => []),
        new Promise((r) => setTimeout(() => r([]), 350))
      ]);
      const clean = cleanLanHostname(names);
      PTR_CACHE.set(dev.ipv4, { name: clean, expiresAt: now + PTR_TTL_MS });
      if (clean) dev.name = clean;
    })
  );
  return devices;
}

export const UNIVERSAL_META = {
  id: 'universal',
  name: 'Universal Any-Router (ARP/NDP + DNS Sinkhole)',
  vendor: 'Any Router (eero, Nest WiFi, Xfinity, Spectrum, Orbi, Verizon, TP-Link)',
  protocol: 'OS ARP/NDP Neighbor Cache + Local UDP DNS Sinkhole',
  defaultGateway: 'auto',
  authFields: [],
  capabilities: {
    discovery: 'Live OS ARP (IPv4) + NDP (IPv6) table scan',
    pause: 'Local DNS Sinkhole blackout (0.0.0.0 / ::)',
    domainFilter: 'Wildcard DNS sinkhole on UDP :5354',
    zeroPassword: true
  }
};

function isMulticastOrBroadcastMac(mac) {
  return mac === 'ff:ff:ff:ff:ff:ff' || mac.startsWith('01:00:5e') || mac.startsWith('33:33:');
}

export function parseArpOutput(stdout, byMac = new Map()) {
  for (const line of String(stdout || '').split('\n')) {
    const m = line.match(/^(\S+)\s+\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([0-9a-f:]{11,17})(?:\s+\[[^\]]+\])?\s+on\s+(\S+)/i);
    if (!m) continue;
    const hostHint = m[1] !== '?' ? m[1] : null;
    const ipv4 = m[2];
    const mac = normalizeMac(m[3]);
    if (!mac || isMulticastOrBroadcastMac(mac)) continue;
    byMac.set(mac, {
      mac,
      name: hostHint || `LAN Host (${ipv4})`,
      ipv4,
      ipv6: null,
      ipv6List: [],
      status: 'online',
      band: `LAN (${m[4]})`,
      lastActivity: 'Active in ARP cache'
    });
  }
  return byMac;
}

export function parseIpNeighOutput(stdout, byMac = new Map()) {
  for (const line of String(stdout || '').split('\n')) {
    const m = line.match(/^(\S+)\s+dev\s+(\S+)\s+lladdr\s+([0-9a-f:]{11,17})(?:.*\s+(\S+))?/i);
    if (!m) continue;
    const ip = m[1];
    const dev = m[2];
    const mac = normalizeMac(m[3]);
    const state = (m[4] || 'UNKNOWN').toUpperCase();
    if (!mac || isMulticastOrBroadcastMac(mac)) continue;
    const isV6 = ip.includes(':');
    const existing = byMac.get(mac) || {
      mac,
      name: `LAN Host (${ip})`,
      ipv4: null,
      ipv6: null,
      ipv6List: [],
      status: state === 'REACHABLE' || state === 'DELAY' ? 'online' : 'offline',
      band: `LAN (${dev})`,
      lastActivity: `Neighbor ${state}`
    };
    if (isV6) {
      const lowerIp = ip.toLowerCase();
      if (!existing.ipv6List.includes(lowerIp)) existing.ipv6List.push(lowerIp);
      if (!existing.ipv6 || existing.ipv6.startsWith('fe80:')) existing.ipv6 = lowerIp;
    } else {
      existing.ipv4 = ip;
    }
    byMac.set(mac, existing);
  }
  return byMac;
}

export function parseNdpOutput(stdout, byMac = new Map()) {
  for (const line of String(stdout || '').split('\n')) {
    const m = line.match(/^([0-9a-f:]+(?:%\S+)?)\s+([0-9a-f:]{11,17})\s+(\S+)\s+(\S+)\s+([RSPDHA]+)/i);
    if (!m) continue;
    const ipv6 = m[1].replace(/%\S+$/, '').toLowerCase();
    const mac = normalizeMac(m[2]);
    if (!mac || isMulticastOrBroadcastMac(mac)) continue;
    const existing = byMac.get(mac) || {
      mac,
      name: `IPv6 Host (${mac.slice(-5)})`,
      ipv4: null,
      ipv6,
      ipv6List: [],
      status: 'online',
      band: `LAN (${m[3]})`,
      lastActivity: 'Active in NDP cache'
    };
    if (!existing.ipv6List.includes(ipv6)) existing.ipv6List.push(ipv6);
    if (!existing.ipv6 || existing.ipv6.startsWith('fe80:')) existing.ipv6 = ipv6;
    byMac.set(mac, existing);
  }
  return byMac;
}

export async function scanArpNdpDevices({ gatewayUrl } = {}) {
  const byMac = new Map();

  // IPv4 ARP table (macOS + Linux)
  try {
    const { stdout } = await execFileAsync('arp', ['-an'], { timeout: 3000 });
    parseArpOutput(stdout, byMac);
  } catch {}

  // Linux fallback: ip neigh show
  if (byMac.size === 0) {
    try {
      const { stdout } = await execFileAsync('ip', ['neigh', 'show'], { timeout: 3000 });
      parseIpNeighOutput(stdout, byMac);
    } catch {}
  }

  // macOS IPv6 NDP enrichment
  try {
    const { stdout } = await execFileAsync('ndp', ['-an'], { timeout: 3000 });
    parseNdpOutput(stdout, byMac);
  } catch {}

  const devices = [...byMac.values()];
  return resolveLanHostnames(devices, gatewayUrl);
}

export class UniversalAdapter {
  constructor(config = {}) {
    this.id = 'universal';
    this.meta = UNIVERSAL_META;
    this.config = config;
  }

  async testConnection() {
    const devices = await this.listDevices();
    return {
      ok: true,
      model: 'Universal LAN (ARP/NDP + DNS Sinkhole)',
      detail: `Discovered ${devices.length} active LAN host(s) with zero router credentials`
    };
  }

  async listDevices() {
    return scanArpNdpDevices({ gatewayUrl: this.config?.gatewayUrl });
  }

  async blockDevice({ mac }) {
    const cleanMac = normalizeMac(mac);
    if (!cleanMac) {
      return { ok: false, mode: 'dns-sinkhole', detail: 'Invalid MAC address' };
    }
    return {
      ok: true,
      mode: 'dns-sinkhole',
      detail: `MAC ${cleanMac} enforced via local DNS sinkhole (0.0.0.0 / ::)`
    };
  }

  async unblockDevice({ mac }) {
    const cleanMac = normalizeMac(mac);
    if (!cleanMac) {
      return { ok: false, mode: 'dns-sinkhole', detail: 'Invalid MAC address' };
    }
    return {
      ok: true,
      mode: 'dns-sinkhole',
      detail: `MAC ${cleanMac} released from local DNS sinkhole`
    };
  }

  async isDeviceBlocked() {
    return null;
  }
}
