import dgram from 'node:dgram';
import dns from 'node:dns/promises';

export const CATEGORY_PRESETS = {
  youtube: {
    id: 'youtube',
    label: 'YouTube & Shorts',
    domains: ['youtube.com', 'm.youtube.com', 'youtu.be', 'googlevideo.com', 'ytimg.com']
  },
  tiktok: {
    id: 'tiktok',
    label: 'TikTok',
    domains: ['tiktok.com', 'tiktokv.com', 'tiktokcdn.com', 'musical.ly', 'byteoversea.com']
  },
  instagram: {
    id: 'instagram',
    label: 'Instagram & Reels',
    domains: ['instagram.com', 'cdninstagram.com', 'ig.me']
  },
  roblox: {
    id: 'roblox',
    label: 'Roblox',
    domains: ['roblox.com', 'rbxcdn.com', 'robloxlabs.com', 'rbx.com']
  },
  discord: {
    id: 'discord',
    label: 'Discord',
    domains: ['discord.com', 'discordapp.com', 'discord.gg', 'discord.media']
  },
  twitch: {
    id: 'twitch',
    label: 'Twitch & Kick',
    domains: ['twitch.tv', 'ttvnw.net', 'jtvnw.net', 'kick.com']
  },
  snapchat: {
    id: 'snapchat',
    label: 'Snapchat',
    domains: ['snapchat.com', 'sc-cdn.net', 'snapkit.co']
  },
  social: {
    id: 'social',
    label: 'Reddit & X',
    domains: ['reddit.com', 'redd.it', 'redditmedia.com', 'x.com', 'twitter.com', 'twimg.com']
  },
  webgames: {
    id: 'webgames',
    label: 'Browser & Epic Games',
    domains: ['poki.com', 'crazygames.com', 'coolmathgames.com', 'fortnite.com', 'epicgames.com']
  }
};

export function parseDnsQuestion(buf) {
  if (!buf || buf.length < 12) return null;
  let offset = 12;
  const labels = [];
  while (offset < buf.length) {
    const len = buf[offset];
    if (len === 0) {
      offset += 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      offset += 2;
      break;
    }
    offset += 1;
    if (offset + len > buf.length) return null;
    labels.push(buf.subarray(offset, offset + len).toString('utf8'));
    offset += len;
  }
  if (offset + 4 > buf.length) return null;
  const qtype = buf.readUInt16BE(offset);
  const qclass = buf.readUInt16BE(offset + 2);
  const qtypeName = { 1: 'A', 28: 'AAAA', 5: 'CNAME', 15: 'MX', 16: 'TXT', 65: 'HTTPS' }[qtype] || `TYPE${qtype}`;
  return {
    domain: labels.join('.').toLowerCase(),
    qtype,
    qtypeName,
    qclass,
    questionEndOffset: offset + 4
  };
}

export function buildSinkholeResponse(queryBuf, questionEndOffset, qtype) {
  const questionSlice = queryBuf.subarray(12, questionEndOffset);
  const header = Buffer.alloc(12);
  queryBuf.copy(header, 0, 0, 2);
  header.writeUInt16BE(0x8580, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(qtype === 1 || qtype === 28 ? 1 : 0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);

  if (qtype === 1) {
    const answer = Buffer.from([
      0xc0, 0x0c,
      0x00, 0x01,
      0x00, 0x01,
      0x00, 0x00, 0x00, 0x3c,
      0x00, 0x04,
      0x00, 0x00, 0x00, 0x00
    ]);
    return Buffer.concat([header, questionSlice, answer]);
  }
  if (qtype === 28) {
    const answer = Buffer.concat([
      Buffer.from([0xc0, 0x0c, 0x00, 0x1c, 0x00, 0x01, 0x00, 0x00, 0x00, 0x3c, 0x00, 0x10]),
      Buffer.alloc(16, 0)
    ]);
    return Buffer.concat([header, questionSlice, answer]);
  }
  header.writeUInt16BE(0x8583, 2);
  header.writeUInt16BE(0, 6);
  return Buffer.concat([header, questionSlice]);
}

export function buildDnsQueryPacket(domain, qtype = 1) {
  const clean = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const labels = clean.split('.').filter(Boolean);
  const parts = [
    Buffer.from([0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
  ];
  for (const label of labels) {
    const b = Buffer.from(label, 'utf8');
    parts.push(Buffer.from([b.length]), b);
  }
  parts.push(Buffer.from([0x00, (qtype >> 8) & 0xff, qtype & 0xff, 0x00, 0x01]));
  return Buffer.concat(parts);
}

export class LocalDnsSinkhole {
  constructor({ port = 5354, upstreamHost = '1.1.1.1', upstreamPort = 53, isBlockedFn } = {}) {
    this.port = port;
    this.upstreamHost = upstreamHost;
    this.upstreamPort = upstreamPort;
    this.isBlockedFn = isBlockedFn || (() => ({ blocked: false, reason: 'Allowed' }));
    this.queryLog = [];
    this.server = null;
  }

  start() {
    if (this.server) return Promise.resolve(this.port);
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      sock.on('message', (msg, rinfo) => {
        const parsed = parseDnsQuestion(msg);
        if (!parsed || !parsed.domain) return;
        const verdict = this.isBlockedFn(parsed.domain, rinfo.address);
        this.queryLog.unshift({
          id: `dns-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          ts: new Date().toISOString(),
          clientIp: rinfo.address,
          domain: parsed.domain,
          qtype: parsed.qtypeName,
          action: verdict.blocked ? 'BLOCKED' : 'ALLOWED',
          reason: verdict.reason || (verdict.blocked ? 'Blocked' : 'Forwarded')
        });
        if (this.queryLog.length > 200) this.queryLog.length = 200;

        if (verdict.blocked) {
          const reply = buildSinkholeResponse(msg, parsed.questionEndOffset, parsed.qtype);
          sock.send(reply, rinfo.port, rinfo.address);
          return;
        }

        const upstream = dgram.createSocket('udp4');
        const timer = setTimeout(() => {
          try { upstream.close(); } catch {}
        }, 2500);

        upstream.on('message', (upReply) => {
          clearTimeout(timer);
          sock.send(upReply, rinfo.port, rinfo.address);
          try { upstream.close(); } catch {}
        });
        upstream.on('error', () => {
          clearTimeout(timer);
          try { upstream.close(); } catch {}
        });
        upstream.send(msg, this.upstreamPort, this.upstreamHost);
      });

      sock.on('error', (err) => {
        if (!this.server) reject(err);
      });

      sock.bind(this.port, '0.0.0.0', () => {
        this.server = sock;
        this.port = sock.address().port;
        resolve(this.port);
      });
    });
  }

  stop() {
    if (!this.server) return Promise.resolve();
    return new Promise((resolve) => {
      const s = this.server;
      this.server = null;
      s.close(() => resolve());
    });
  }

  async testQuery(domain = 'roblox.com') {
    const packet = buildDnsQueryPacket(domain, 1);
    return new Promise((resolve) => {
      const client = dgram.createSocket('udp4');
      const timer = setTimeout(() => {
        try { client.close(); } catch {}
        resolve({ domain, ok: false, error: 'Timeout' });
      }, 2500);
      client.on('message', (reply) => {
        clearTimeout(timer);
        try { client.close(); } catch {}
        const ancount = reply.length >= 8 ? reply.readUInt16BE(6) : 0;
        let resolvedIp = null;
        if (ancount > 0 && reply.length >= 16) {
          const last4 = reply.subarray(reply.length - 4);
          resolvedIp = `${last4[0]}.${last4[1]}.${last4[2]}.${last4[3]}`;
        }
        resolve({
          domain,
          ok: true,
          resolvedIp,
          sinkholed: resolvedIp === '0.0.0.0'
        });
      });
      client.send(packet, this.port, '127.0.0.1');
    });
  }

  async resolveDomainIps(domain) {
    const clean = domain.toLowerCase().trim().replace(/^\*\./, '');
    const [ipv4, ipv6] = await Promise.all([
      dns.resolve4(clean).catch(() => []),
      dns.resolve6(clean).catch(() => [])
    ]);
    return { domain: clean, ipv4: ipv4.slice(0, 6), ipv6: ipv6.slice(0, 4) };
  }
}
