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
  if (buf.readUInt16BE(4) === 0) return null;
  let offset = 12;
  const labels = [];
  while (offset < buf.length) {
    const len = buf[offset];
    if (len === 0) {
      offset += 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (offset + 2 > buf.length) return null;
      offset += 2;
      break;
    }
    if (len > 63) return null;
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

function skipDnsName(buf, startOffset) {
  let offset = startOffset;
  let steps = 0;
  while (offset < buf.length && steps++ < 128) {
    const len = buf[offset];
    if (len === 0) return offset + 1;
    if ((len & 0xc0) === 0xc0) return offset + 2 <= buf.length ? offset + 2 : -1;
    if (len > 63) return -1;
    offset += 1 + len;
  }
  return -1;
}

function extractFirstARecordIp(reply) {
  if (!reply || reply.length < 12) return null;
  const ancount = reply.readUInt16BE(6);
  if (ancount === 0) return null;
  const q = parseDnsQuestion(reply);
  if (!q) return null;
  let offset = q.questionEndOffset;
  for (let i = 0; i < ancount && offset < reply.length; i++) {
    const nextOffset = skipDnsName(reply, offset);
    if (nextOffset < 0 || nextOffset + 10 > reply.length) break;
    const type = reply.readUInt16BE(nextOffset);
    const rdlength = reply.readUInt16BE(nextOffset + 8);
    const rdataStart = nextOffset + 10;
    if (rdataStart + rdlength > reply.length) break;
    if (type === 1 && rdlength === 4) {
      return `${reply[rdataStart]}.${reply[rdataStart + 1]}.${reply[rdataStart + 2]}.${reply[rdataStart + 3]}`;
    }
    offset = rdataStart + rdlength;
  }
  return null;
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
  const clean = String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  const labels = clean.split('.').filter(Boolean);
  if (!clean || labels.length === 0) return null;
  const parts = [
    Buffer.from([0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
  ];
  for (const label of labels) {
    const b = Buffer.from(label, 'utf8');
    if (b.length === 0 || b.length > 63) return null;
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
    this.startError = null;
    this.lastError = null;
  }

  start() {
    if (this.server) {
      this.startError = null;
      return Promise.resolve(this.port);
    }
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      let settled = false;

      sock.on('message', (msg, rinfo) => {
        try {
          const parsed = parseDnsQuestion(msg);
          if (!parsed || !parsed.domain) return;
          const verdict = this.isBlockedFn(parsed.domain, rinfo.address) || { blocked: false, reason: 'Allowed' };
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
            sock.send(reply, rinfo.port, rinfo.address, (err) => {
              if (err) this.lastError = err.message;
            });
            return;
          }

          const upstream = dgram.createSocket('udp4');
          const timer = setTimeout(() => {
            try { upstream.close(); } catch {}
          }, 2500);

          upstream.on('message', (upReply) => {
            clearTimeout(timer);
            sock.send(upReply, rinfo.port, rinfo.address, (err) => {
              if (err) this.lastError = err.message;
            });
            try { upstream.close(); } catch {}
          });
          upstream.on('error', (err) => {
            clearTimeout(timer);
            this.lastError = err.message;
            try { upstream.close(); } catch {}
          });
          upstream.send(msg, this.upstreamPort, this.upstreamHost, (err) => {
            if (err) {
              clearTimeout(timer);
              this.lastError = err.message;
              try { upstream.close(); } catch {}
            }
          });
        } catch (err) {
          this.lastError = err.message;
        }
      });

      sock.on('error', (err) => {
        if (!this.server) {
          this.startError = err.message;
          try { sock.close(); } catch {}
          if (!settled) {
            settled = true;
            reject(err);
          }
        } else {
          this.lastError = err.message;
        }
      });

      try {
        sock.bind(this.port, '0.0.0.0', () => {
          this.server = sock;
          this.port = sock.address().port;
          this.startError = null;
          if (!settled) {
            settled = true;
            resolve(this.port);
          }
        });
      } catch (err) {
        this.startError = err.message;
        try { sock.close(); } catch {}
        if (!settled) {
          settled = true;
          reject(err);
        }
      }
    });
  }

  stop() {
    if (!this.server) return Promise.resolve();
    return new Promise((resolve) => {
      const s = this.server;
      this.server = null;
      this.startError = null;
      s.close(() => resolve());
    });
  }

  async testQuery(domain = 'roblox.com') {
    if (!this.server) {
      return { domain, ok: false, error: this.startError || 'DNS sinkhole is not running' };
    }
    const packet = buildDnsQueryPacket(domain, 1);
    if (!packet) {
      return { domain, ok: false, error: 'Valid domain is required' };
    }
    return new Promise((resolve) => {
      const client = dgram.createSocket('udp4');
      let done = false;
      let timer = null;

      const finish = (payload) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        try { client.close(); } catch {}
        resolve(payload);
      };

      timer = setTimeout(() => {
        finish({ domain, ok: false, error: 'Timeout' });
      }, 2500);

      client.on('error', (err) => {
        finish({ domain, ok: false, error: err.message });
      });

      client.on('message', (reply) => {
        const resolvedIp = extractFirstARecordIp(reply);
        finish({
          domain,
          ok: true,
          resolvedIp,
          sinkholed: resolvedIp === '0.0.0.0'
        });
      });

      try {
        client.send(packet, this.port, '127.0.0.1', (err) => {
          if (err) finish({ domain, ok: false, error: err.message });
        });
      } catch (err) {
        finish({ domain, ok: false, error: err.message });
      }
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
