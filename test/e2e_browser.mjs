#!/usr/bin/env node
/**
 * Opaque-box Playwright E2E, Responsive & Visual Verification Suite for curfewd.
 *
 * Usage:
 *   PLAYWRIGHT_PATH=/path/to/playwright node test/e2e_browser.mjs
 *   PLAYWRIGHT_PATH=/path/to/playwright node test/e2e_browser.mjs --self-check
 *   BASE_URL=http://127.0.0.1:4320 PLAYWRIGHT_PATH=/path/to/playwright node test/e2e_browser.mjs
 *
 * Environment variables:
 *   PLAYWRIGHT_PATH    - Package name, directory, or entry file for playwright (default: 'playwright')
 *   PLAYWRIGHT_CHANNEL - Optional Chromium launch channel override (e.g. 'chrome')
 *   BASE_URL           - Optional already-running server URL (skips in-process server lifecycle tests)
 *   SCREENSHOT_DIR     - Directory to store screenshots (default: temp dir under os.tmpdir())
 *   KEEP_SCREENSHOTS   - Set '1' to preserve SCREENSHOT_DIR on pass
 *   E2E_FILTER         - Optional substring filter for test IDs/names
 */

import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  startServer,
  createAdapter,
  normalizeMac,
  todayKey,
  ADAPTER_CATALOG,
  CATEGORY_PRESETS
} from '../src/index.js';

const ARGS = new Set(process.argv.slice(2));
const SELF_CHECK = ARGS.has('--self-check');
const FILTER = process.env.E2E_FILTER ? String(process.env.E2E_FILTER).toLowerCase() : '';
const EXTERNAL_BASE_URL = process.env.BASE_URL ? String(process.env.BASE_URL).replace(/\/+$/, '') : '';

const SYNTHETIC_MACS = [
  'aa:bb:cc:11:22:01',
  'aa:bb:cc:11:22:02',
  'aa:bb:cc:11:22:03',
  'aa:bb:cc:11:22:04',
  'aa:bb:cc:11:22:05'
];

const DEFAULT_DEVICES = [
  { mac: SYNTHETIC_MACS[0], name: 'Kids-Gaming-PC', ipv4: '192.0.2.10', ipv6List: ['fd00::10'], status: 'online', band: 'Ethernet' },
  { mac: SYNTHETIC_MACS[1], name: 'Study-iPad', ipv4: '192.0.2.11', ipv6List: ['fd00::11'], status: 'online', band: 'Wi-Fi 5GHz' },
  { mac: SYNTHETIC_MACS[2], name: 'Living-Room-TV', ipv4: '192.0.2.12', ipv6List: [], status: 'offline', band: 'Wi-Fi 2.4GHz' }
];

const VIEWPORTS = [
  { name: 'desktop-1440', width: 1440, height: 900, mobile: false, tablet: false },
  { name: 'tablet-768', width: 768, height: 1024, mobile: false, tablet: true },
  { name: 'phone-430', width: 430, height: 932, mobile: true, tablet: false },
  { name: 'phone-375', width: 375, height: 812, mobile: true, tablet: false }
];

const TABS = ['overview', 'schedules', 'dns', 'setup'];

// ---------------------------------------------------------------------------
// Playwright Loader & Browser Launcher (zero hardcoded personal paths)
// ---------------------------------------------------------------------------

async function loadPlaywright() {
  const pwTarget = process.env.PLAYWRIGHT_PATH || 'playwright';
  const candidates = [];

  const isBarePackage = !pwTarget.startsWith('.') && !path.isAbsolute(pwTarget) && !pwTarget.includes(path.sep);
  if (isBarePackage) {
    candidates.push(pwTarget);
  } else {
    const abs = path.resolve(pwTarget);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      const mjs = path.join(abs, 'index.mjs');
      const js = path.join(abs, 'index.js');
      if (fs.existsSync(mjs)) candidates.push(pathToFileURL(mjs).href);
      if (fs.existsSync(js)) candidates.push(pathToFileURL(js).href);
      candidates.push(abs);
    } else {
      candidates.push(pathToFileURL(abs).href);
      candidates.push(abs);
    }
  }

  let lastErr = null;
  for (const cand of candidates) {
    try {
      const mod = await import(cand);
      const pw = mod?.chromium ? mod : mod?.default?.chromium ? mod.default : null;
      if (pw) return pw;
    } catch (err) {
      lastErr = err;
    }
  }

  const req = createRequire(import.meta.url);
  try {
    const mod = req(isBarePackage ? pwTarget : path.resolve(pwTarget));
    if (mod?.chromium) return mod;
  } catch (err) {
    lastErr = err;
  }

  throw new Error(`Failed to load Playwright from "${pwTarget}": ${lastErr?.message || 'unknown error'}`);
}

async function launchChromium(pw) {
  const attempts = [];
  if (process.env.PLAYWRIGHT_CHANNEL) {
    attempts.push({ channel: process.env.PLAYWRIGHT_CHANNEL, headless: true });
  }
  attempts.push({ headless: true });
  attempts.push({ channel: 'chrome', headless: true });

  let lastErr = null;
  for (const opts of attempts) {
    try {
      return await pw.chromium.launch(opts);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`Unable to launch Chromium via Playwright: ${lastErr?.message || 'unknown error'}`);
}

// ---------------------------------------------------------------------------
// Isolated Test Infrastructure (Temp Home, Mock Adapter, Mock HTTP Router, Mock DNS)
// ---------------------------------------------------------------------------

function makeTempDir(prefix = 'curfewd-e2e-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createMockAdapter(initialDevices = DEFAULT_DEVICES) {
  const blocked = new Set();
  const state = {
    id: 'mock',
    blocked,
    devices: initialDevices.map((d) => ({ ...d })),
    failListDevices: null,
    failNextBlock: null,
    failNextUnblock: null,
    blockCalls: [],
    unblockCalls: [],
    async testConnection() {
      return { ok: true, model: 'MockRouter', detail: 'Connected to MockRouter' };
    },
    async listDevices() {
      if (state.failListDevices) {
        throw new Error(state.failListDevices);
      }
      return state.devices.map((d) => ({ ...d }));
    },
    async blockDevice({ mac, ipv4, ipv6List }) {
      const norm = normalizeMac(mac);
      state.blockCalls.push({ mac: norm, ipv4, ipv6List });
      if (state.failNextBlock) {
        const msg = state.failNextBlock;
        state.failNextBlock = null;
        return { ok: false, mode: 'mock-block-fail', detail: msg };
      }
      blocked.add(norm);
      return { ok: true, mode: 'mock-block', detail: 'Blocked' };
    },
    async unblockDevice({ mac, ipv4, ipv6List }) {
      const norm = normalizeMac(mac);
      state.unblockCalls.push({ mac: norm, ipv4, ipv6List });
      if (state.failNextUnblock) {
        const msg = state.failNextUnblock;
        state.failNextUnblock = null;
        return { ok: false, mode: 'mock-unblock-fail', detail: msg };
      }
      blocked.delete(norm);
      return { ok: true, mode: 'mock-unblock', detail: 'Unblocked' };
    },
    async isDeviceBlocked({ mac }) {
      return blocked.has(normalizeMac(mac));
    }
  };
  return state;
}

async function startMockRouterHttp() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: raw });
      // OpenWrt ubus mock
      if (req.url === '/ubus') {
        let parsed = {};
        try { parsed = JSON.parse(raw || '{}'); } catch {}
        const [, obj, method, args] = parsed.params || [];
        if (obj === 'session' && method === 'login') {
          if (args?.password === 'wrong-password') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: [6] }));
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            result: [0, { ubus_rpc_session: 'mock-ubus-session-token' }]
          }));
        }
        if (obj === 'system' && method === 'board') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            result: [0, { model: 'Mock OpenWrt AX3000', release: { description: 'OpenWrt 24.10' } }]
          }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: [0, {}] }));
      }

      // AT&T BGW mock
      if (req.url === '/cgi-bin/sysinfo.ha') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<html><body>BGW320-500 Mock</body></html>');
      }
      if (req.url === '/cgi-bin/login.ha') {
        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Set-Cookie': 'SessionID=mockbgw; Path=/'
        });
        return res.end('<form><input name="nonce" value="mocknonce123"></form>');
      }
      if (req.url === '/cgi-bin/devices.ha') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<html><body>Mock Devices</body></html>');
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, model: 'MockRouter' }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

async function getClosedLocalPort() {
  const srv = http.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

async function startMockDnsUpstream(answerIp = '93.184.216.34') {
  const sock = dgram.createSocket('udp4');
  const octets = answerIp.split('.').map(Number);
  sock.on('message', (msg, rinfo) => {
    if (msg.length < 12) return;
    // Echo a minimal A record response for any query
    const header = Buffer.alloc(12);
    msg.copy(header, 0, 0, 2);
    header.writeUInt16BE(0x8180, 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(1, 6);
    header.writeUInt16BE(0, 8);
    header.writeUInt16BE(0, 10);
    let idx = 12;
    while (idx < msg.length && msg[idx] !== 0) idx += msg[idx] + 1;
    const qEnd = Math.min(msg.length, idx + 5);
    const question = msg.subarray(12, qEnd);
    const answer = Buffer.from([
      0xc0, 0x0c, 0x00, 0x01, 0x00, 0x01,
      0x00, 0x00, 0x00, 0x3c, 0x00, 0x04,
      octets[0], octets[1], octets[2], octets[3]
    ]);
    sock.send(Buffer.concat([header, question, answer]), rinfo.port, rinfo.address);
  });
  await new Promise((resolve, reject) => {
    sock.once('error', reject);
    sock.bind(0, '127.0.0.1', () => resolve());
  });
  const port = sock.address().port;
  return {
    port,
    close: () => new Promise((resolve) => sock.close(() => resolve()))
  };
}

// ---------------------------------------------------------------------------
// DOM Measurement & Visual Audit Helpers (Opaque-Box)
// ---------------------------------------------------------------------------

async function auditColors(page) {
  return page.evaluate(() => {
    const linearToSrgb = (c) => {
      const cl = Math.max(0, Math.min(1, c));
      return cl < 0.0031308 ? 12.92 * cl : 1.055 * Math.pow(cl, 1 / 2.4) - 0.055;
    };
    const srgbToLinear = (c) => (c < 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

    const oklabToRgb = (L, a, b) => {
      const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
      const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
      const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
      const l = l_ * l_ * l_;
      const m = m_ * m_ * m_;
      const s = s_ * s_ * s_;
      const rl = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
      const gl = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
      const bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
      return {
        r: Math.round(linearToSrgb(rl) * 255),
        g: Math.round(linearToSrgb(gl) * 255),
        b: Math.round(linearToSrgb(bl) * 255)
      };
    };

    const parseAlpha = (rawAlpha) => {
      if (rawAlpha === undefined) return 1;
      const s = String(rawAlpha).trim();
      if (s.endsWith('%')) return parseFloat(s) / 100;
      return Number(s);
    };

    const parseColor = (raw) => {
      if (!raw || raw === 'none' || raw === 'transparent') return null;
      const rgbMatch = raw.match(/rgba?\(\s*([\d.]+%?)[,\s]+([\d.]+%?)[,\s]+([\d.]+%?)(?:[,/\s]+([\d.]+%?))?\s*\)/i);
      if (rgbMatch) {
        if (parseAlpha(rgbMatch[4]) === 0) return null;
        const ch = (v) => (v.endsWith('%') ? Math.round((parseFloat(v) / 100) * 255) : Number(v));
        return { r: ch(rgbMatch[1]), g: ch(rgbMatch[2]), b: ch(rgbMatch[3]) };
      }
      const hexMatch = raw.trim().match(/^#([0-9a-f]{3,8})$/i);
      if (hexMatch) {
        const h = hexMatch[1];
        if (h.length === 3 || h.length === 4) {
          if (h.length === 4 && parseInt(h[3] + h[3], 16) === 0) return null;
          return {
            r: parseInt(h[0] + h[0], 16),
            g: parseInt(h[1] + h[1], 16),
            b: parseInt(h[2] + h[2], 16)
          };
        }
        if (h.length === 6 || h.length === 8) {
          if (h.length === 8 && parseInt(h.slice(6, 8), 16) === 0) return null;
          return {
            r: parseInt(h.slice(0, 2), 16),
            g: parseInt(h.slice(2, 4), 16),
            b: parseInt(h.slice(4, 6), 16)
          };
        }
      }
      const srgbMatch = raw.match(/color\(srgb\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)(?:\s*\/\s*([\d.]+%?))?\)/i);
      if (srgbMatch) {
        if (parseAlpha(srgbMatch[4]) === 0) return null;
        return {
          r: Math.round(Math.max(0, Math.min(1, Number(srgbMatch[1]))) * 255),
          g: Math.round(Math.max(0, Math.min(1, Number(srgbMatch[2]))) * 255),
          b: Math.round(Math.max(0, Math.min(1, Number(srgbMatch[3]))) * 255)
        };
      }
      const p3Match = raw.match(/color\(display-p3\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)(?:\s*\/\s*([\d.]+%?))?\)/i);
      if (p3Match) {
        if (parseAlpha(p3Match[4]) === 0) return null;
        const rp = srgbToLinear(Number(p3Match[1]));
        const gp = srgbToLinear(Number(p3Match[2]));
        const bp = srgbToLinear(Number(p3Match[3]));
        const rl = 1.2249401 * rp - 0.2249401 * gp;
        const gl = -0.0420569 * rp + 1.0420569 * gp;
        const bl = -0.0196376 * rp - 0.0786361 * gp + 1.0982737 * bp;
        return {
          r: Math.round(linearToSrgb(rl) * 255),
          g: Math.round(linearToSrgb(gl) * 255),
          b: Math.round(linearToSrgb(bl) * 255)
        };
      }
      const oklabMatch = raw.match(/oklab\(\s*([\d.-]+%?)\s+([\d.-]+%?)\s+([\d.-]+%?)(?:\s*\/\s*([\d.]+%?))?\s*\)/i);
      if (oklabMatch) {
        if (parseAlpha(oklabMatch[4]) === 0) return null;
        const L = oklabMatch[1].endsWith('%') ? parseFloat(oklabMatch[1]) / 100 : Number(oklabMatch[1]);
        const ab = (v) => (v.endsWith('%') ? (parseFloat(v) * 0.4) / 100 : Number(v));
        return oklabToRgb(L, ab(oklabMatch[2]), ab(oklabMatch[3]));
      }
      const oklchMatch = raw.match(/oklch\(\s*([\d.-]+%?)\s+([\d.-]+%?)\s+([\d.-]+)(deg|rad|grad|turn)?(?:\s*\/\s*([\d.]+%?))?\s*\)/i);
      if (oklchMatch) {
        if (parseAlpha(oklchMatch[5]) === 0) return null;
        const L = oklchMatch[1].endsWith('%') ? parseFloat(oklchMatch[1]) / 100 : Number(oklchMatch[1]);
        const C = oklchMatch[2].endsWith('%') ? (parseFloat(oklchMatch[2]) * 0.4) / 100 : Number(oklchMatch[2]);
        let deg = Number(oklchMatch[3]);
        const unit = (oklchMatch[4] || 'deg').toLowerCase();
        if (unit === 'rad') deg = (deg * 180) / Math.PI;
        else if (unit === 'grad') deg = deg * 0.9;
        else if (unit === 'turn') deg = deg * 360;
        const rad = (deg * Math.PI) / 180;
        return oklabToRgb(L, C * Math.cos(rad), C * Math.sin(rad));
      }
      return null;
    };

    const isPurple = ({ r, g, b }) => {
      const rn = r / 255, gn = g / 255, bn = b / 255;
      const max = Math.max(rn, gn, bn);
      const min = Math.min(rn, gn, bn);
      const d = max - min;
      if (d === 0) return false;
      const l = ((max + min) / 2) * 100;
      const s = (d / (1 - Math.abs(2 * (max + min) / 2 - 1))) * 100;
      let h = 0;
      if (max === rn) h = ((gn - bn) / d) % 6;
      else if (max === gn) h = (bn - rn) / d + 2;
      else h = (rn - gn) / d + 4;
      h = Math.round(h * 60);
      if (h < 0) h += 360;
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      return (
        (h >= 242 && h <= 325 && chroma >= 18 && s >= 15 && l > 4 && l < 96) ||
        (h >= 234 && h < 242 && s >= 45 && chroma >= 45 && l > 4 && l < 96)
      );
    };

    const extractColorTokens = (val) => {
      if (!val || val === 'none') return [];
      const scrubbed = val.replace(/url\([^)]*\)/gi, ' ');
      return scrubbed.match(/rgba?\([^)]+\)|color\([^)]+\)|oklch\([^)]+\)|oklab\([^)]+\)|#[0-9a-f]{3,8}\b/gi) || [];
    };

    const violations = [];
    const styleText = [...document.querySelectorAll('style')].map((s) => s.textContent || '').join('\n');
    const bannedTokens = [
      'purple', 'violet', 'indigo', 'fuchsia',
      '#8b5cf6', '#7c3aed', '#a855f7', '#6366f1', '#9333ea', '#c084fc',
      '#4f46e5', '#4338ca', '#818cf8', '#5b21b6', '#6d28d9'
    ];
    for (const tok of bannedTokens) {
      if (styleText.toLowerCase().includes(tok)) {
        violations.push(`Banned style token found: ${tok}`);
      }
    }

    const svgTags = new Set(['svg', 'line', 'path', 'polyline', 'polygon', 'rect', 'circle', 'ellipse']);
    const props = ['color', 'backgroundColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'outlineColor', 'fill', 'stroke'];
    for (const el of document.querySelectorAll('*')) {
      const rect = el.getBoundingClientRect();
      const isSvg = svgTags.has(el.tagName.toLowerCase());
      if (isSvg ? (rect.width === 0 && rect.height === 0) : (rect.width === 0 || rect.height === 0)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      for (const prop of props) {
        const val = cs[prop];
        const parsed = parseColor(val);
        if (parsed && isPurple(parsed)) {
          violations.push(`Purple computed ${prop}=${val} on <${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}>`);
        }
      }
      for (const multiProp of ['backgroundImage', 'boxShadow']) {
        const val = cs[multiProp];
        for (const tok of extractColorTokens(val)) {
          const parsed = parseColor(tok);
          if (parsed && isPurple(parsed)) {
            violations.push(`Purple computed ${multiProp}=${tok} on <${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}>`);
          }
        }
      }
    }

    const bodyBg = getComputedStyle(document.body).backgroundColor;
    return { violations, bodyBg };
  });
}

async function auditOverflow(page, { checkTabletStats2x2 = false } = {}) {
  return page.evaluate(({ checkTabletStats2x2 }) => {
    const errors = [];
    const iw = window.innerWidth;
    if (document.documentElement.scrollWidth > iw) {
      errors.push(`documentElement.scrollWidth (${document.documentElement.scrollWidth}) > innerWidth (${iw})`);
    }
    if (document.body.scrollWidth > iw) {
      errors.push(`body.scrollWidth (${document.body.scrollWidth}) > innerWidth (${iw})`);
    }

    for (const el of document.querySelectorAll('.card, .row, .stat-sub, .stat-val, header')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (el.scrollWidth > el.clientWidth + 2) {
        errors.push(`Internal overflow on <${el.tagName.toLowerCase()}${el.id ? '#' + el.id : '.' + (el.className || '')}>: scrollWidth=${el.scrollWidth} > clientWidth=${el.clientWidth}`);
      }
    }

    let tabletGrid = null;
    if (checkTabletStats2x2) {
      const cards = [...document.querySelectorAll('.stats > .card')];
      if (cards.length === 4) {
        const rects = cards.map((c) => {
          const r = c.getBoundingClientRect();
          return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width) };
        });
        const rows = new Map();
        for (const r of rects) {
          const existingKey = [...rows.keys()].find((k) => Math.abs(k - r.top) <= 6);
          const key = existingKey ?? r.top;
          if (!rows.has(key)) rows.set(key, []);
          rows.get(key).push(r);
        }
        const rowCounts = [...rows.values()].map((arr) => arr.length);
        tabletGrid = { rowCount: rows.size, rowCounts, rects };
        if (rows.size !== 2 || rowCounts[0] !== 2 || rowCounts[1] !== 2) {
          errors.push(`Expected 2x2 tablet .stats grid at 768px, got rowCounts=${JSON.stringify(rowCounts)}`);
        }
      }
    }

    return { errors, tabletGrid, innerWidth: iw, docScrollWidth: document.documentElement.scrollWidth };
  }, { checkTabletStats2x2 });
}

async function auditGeometry(page, { mobile = false } = {}) {
  return page.evaluate(({ mobile }) => {
    const errors = [];
    const iw = window.innerWidth;
    const selector = 'button, a[href], input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), select, textarea, [role="tab"], [role="button"], .chip';
    const els = [...document.querySelectorAll(selector)].filter((el) => {
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' && !el.closest('.hidden');
    });

    const describe = (el) => {
      const txt = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 24);
      return `<${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}>"${txt}"`;
    };

    const rects = els.map((el) => ({ el, r: el.getBoundingClientRect(), desc: describe(el) }));

    for (const item of rects) {
      const { el, r, desc } = item;
      if (r.left < -1 || r.right > iw + 1) {
        errors.push(`Horizontal viewport clip on ${desc}: left=${Math.round(r.left)}, right=${Math.round(r.right)}, innerWidth=${iw}`);
      }

      let cur = el.parentElement;
      while (cur && cur !== document.body) {
        const pcs = getComputedStyle(cur);
        if (pcs.overflowX === 'hidden' || pcs.overflowX === 'clip') {
          const pr = cur.getBoundingClientRect();
          if (r.left < pr.left - 2 || r.right > pr.right + 2) {
            errors.push(`Ancestor horizontal clip on ${desc} inside <${cur.tagName.toLowerCase()}>`);
          }
        }
        cur = cur.parentElement;
      }

      if (el.matches('button, [role="tab"], .chip')) {
        if (el.scrollWidth > el.clientWidth + 2) {
          errors.push(`Button/chip text clipped on ${desc}: scrollWidth=${el.scrollWidth} > clientWidth=${el.clientWidth}`);
        }
      }

      if (mobile) {
        if (r.height < 44) {
          errors.push(`Mobile touch target height < 44px on ${desc}: ${Math.round(r.height)}px`);
        }
        if (r.width < 44) {
          errors.push(`Mobile touch target width < 44px on ${desc}: ${Math.round(r.width)}px`);
        }
        if (el.matches('input, select, textarea')) {
          const fs = parseFloat(getComputedStyle(el).fontSize);
          if (fs < 16) {
            errors.push(`Mobile input font-size < 16px on ${desc}: ${fs}px`);
          }
        }
      }
    }

    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const ix = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const iy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (ix > 2 && iy > 2) {
          errors.push(`Overlapping controls (${Math.round(ix)}x${Math.round(iy)}px): ${a.desc} vs ${b.desc}`);
        }
      }
    }

    if (mobile) {
      const checkInputs = [...document.querySelectorAll('input[type="checkbox"], input[type="radio"]')].filter((el) => {
        if (el.closest('.hidden')) return false;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' && r.width > 0 && r.height > 0;
      });
      for (const el of checkInputs) {
        const label = el.closest('label') || (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
        const hitEl = label || el;
        const hr = hitEl.getBoundingClientRect();
        const desc = describe(hitEl);
        if (hr.left < -1 || hr.right > iw + 1) {
          errors.push(`Horizontal viewport clip on ${desc}: left=${Math.round(hr.left)}, right=${Math.round(hr.right)}, innerWidth=${iw}`);
        }
        if (hr.height < 44) {
          errors.push(`Mobile touch target height < 44px on ${desc}: ${Math.round(hr.height)}px`);
        }
        if (hr.width < 44) {
          errors.push(`Mobile touch target width < 44px on ${desc}: ${Math.round(hr.width)}px`);
        }
      }
    }

    const header = document.querySelector('header');
    const headerHeight = header ? Math.round(header.getBoundingClientRect().height) : 0;

    return { errors, checkedCount: rects.length, headerHeight };
  }, { mobile });
}

// ---------------------------------------------------------------------------
// Page Session & Error Collector
// ---------------------------------------------------------------------------

async function openTrackedPage(browser, url, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(2500);
  page.setDefaultNavigationTimeout(6000);

  const pageErrors = [];
  const serverErrors = [];
  const unexpectedConsoleErrors = [];
  const unexpectedHttpErrors = [];
  let expectingClientError = false;

  page.on('pageerror', (err) => {
    pageErrors.push(String(err?.message || err));
  });

  page.on('response', (res) => {
    const status = res.status();
    if (status >= 500) {
      serverErrors.push(`${status} ${res.url()}`);
    } else if (status >= 400 && !expectingClientError) {
      unexpectedHttpErrors.push(`${status} ${res.url()}`);
    }
  });

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const txt = msg.text();
      if (expectingClientError && /Failed to load resource: the server responded with a status of 4\d\d/.test(txt)) {
        return;
      }
      unexpectedConsoleErrors.push(txt);
    }
  });

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#statDriver');

  return {
    context,
    page,
    async withExpectedClientError(fn) {
      expectingClientError = true;
      try {
        return await fn();
      } finally {
        await page.waitForTimeout(50).catch(() => {});
        expectingClientError = false;
      }
    },
    assertCleanRuntime() {
      assert.deepEqual(pageErrors, [], `Uncaught pageerror(s): ${pageErrors.join('; ')}`);
      assert.deepEqual(serverErrors, [], `HTTP 5xx response(s): ${serverErrors.join('; ')}`);
      assert.deepEqual(unexpectedHttpErrors, [], `Unexpected HTTP 4xx response(s): ${unexpectedHttpErrors.join('; ')}`);
      assert.deepEqual(unexpectedConsoleErrors, [], `Console error(s): ${unexpectedConsoleErrors.join('; ')}`);
    },
    async close() {
      await context.close();
    }
  };
}

// ---------------------------------------------------------------------------
// Isolated App Lifecycle Helper
// ---------------------------------------------------------------------------

async function withApp({
  devices = DEFAULT_DEVICES,
  setupCompleted = true,
  enableDns = true,
  enableDaemon = false,
  adapter = null,
  seedState = null,
  useMockUpstream = false,
  realTestConnection = false
} = {}, fn) {
  const homeDir = makeTempDir('curfewd-home-');
  const mockAdapter = adapter || createMockAdapter(devices);
  const mockUpstream = useMockUpstream ? await startMockDnsUpstream() : null;

  // Pre-seed state.json before server starts
  {
    const { StateStore } = await import('../src/state.js');
    const store = new StateStore(homeDir);
    const st = store.load();
    st.setupCompleted = setupCompleted;
    if (seedState) seedState(st);
    store.save(st);
  }

  const srv = await startServer({
    homeDir,
    port: 0,
    dnsPort: 0,
    enableDns,
    enableDaemon,
    host: '127.0.0.1',
    adapter: mockAdapter
  });

  if (realTestConnection) {
    const origGetAdapter = srv.engine.getAdapter.bind(srv.engine);
    srv.engine.getAdapter = (state = srv.engine.store.load()) => {
      const base = origGetAdapter(state);
      if (state?.router?.driver && state.router.driver !== 'universal') {
        return Object.create(base, {
          testConnection: {
            value: () => createAdapter(state.router).testConnection()
          }
        });
      }
      return base;
    };
  }

  if (mockUpstream && srv.dnsSinkhole) {
    srv.dnsSinkhole.upstreamHost = '127.0.0.1';
    srv.dnsSinkhole.upstreamPort = mockUpstream.port;
  }

  try {
    return await fn({ srv, adapter: mockAdapter, homeDir, mockUpstream });
  } finally {
    await srv.close().catch(() => {});
    await srv.engine._tickQueue?.catch(() => {});
    if (mockUpstream) await mockUpstream.close().catch(() => {});
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

async function apiJson(baseUrl, pathname, { method = 'GET', body = undefined, rawBody = undefined } = {}) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(5000)
  };
  if (rawBody !== undefined) opts.body = rawBody;
  else if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${baseUrl}${pathname}`, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

function todayDayName() {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date().getDay()];
}

function currentActiveWindow() {
  const now = new Date();
  const prev = new Date(now.getTime() - 60 * 60_000);
  const next = new Date(now.getTime() + 60 * 60_000);
  const fmt = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return { startTime: fmt(prev), endTime: fmt(next) };
}

// ---------------------------------------------------------------------------
// Opaque-Box UI Helpers (avoiding overfitting to internal JS or M2 implementation choices)
// ---------------------------------------------------------------------------

async function switchTab(page, tabId) {
  const tab = page.locator(`[data-tab="${tabId}"]`);
  await tab.click();
  await page.locator(`#tab-${tabId}`).waitFor({ state: 'visible' });
}

async function findDeviceRow(page, textOrMac) {
  return page.locator('#devicesList .row').filter({ hasText: textOrMac }).first();
}

async function setDeviceAliasAndPin(page, targetText, { alias = null, togglePin = false } = {}) {
  const row = await findDeviceRow(page, targetText);
  if (alias !== null) {
    const inlineInput = row.locator('input[type="text"], input:not([type])').first();
    if (await inlineInput.count() > 0 && await inlineInput.isVisible()) {
      await inlineInput.fill(alias);
      const saveBtn = row.getByRole('button', { name: /save|apply|rename/i }).first();
      await saveBtn.click();
    } else {
      const editBtn = row.getByRole('button', { name: /alias|rename|edit/i }).first();
      await editBtn.click();
      const input = row.locator('input').or(page.locator('#deviceAliasInput, input[name="alias"]')).first();
      await input.fill(alias);
      const saveBtn = row.getByRole('button', { name: /save|apply/i }).or(page.getByRole('button', { name: /save alias/i })).first();
      await saveBtn.click();
    }
  }
  if (togglePin) {
    const refreshedRow = await findDeviceRow(page, alias || targetText);
    const pinBtn = refreshedRow.getByRole('button', { name: /pin|unpin/i }).first();
    await pinBtn.click();
  }
}

async function pauseDeviceInUi(page, targetText, durationChoice = '1h') {
  const row = await findDeviceRow(page, targetText);
  const select = row.locator('select').first();
  if (await select.count() > 0 && await select.isVisible()) {
    const opts = await select.locator('option').allTextContents();
    const match = durationChoice === 'indefinite'
      ? opts.find((o) => /indef|always|until/i.test(o))
      : opts.find((o) => new RegExp(durationChoice, 'i').test(o));
    if (match) await select.selectOption({ label: match });
    await row.getByRole('button', { name: /pause/i }).first().click();
  } else if (durationChoice === '1h') {
    await row.getByRole('button', { name: /pause 1h/i }).first().click();
  } else {
    await row.getByRole('button', { name: /^pause$/i }).first().click();
  }
}

async function selectScheduleDaysInUi(page, dayNames) {
  const schedTab = page.locator('#tab-schedules');
  for (const day of dayNames) {
    const pill = schedTab.getByRole('button', { name: new RegExp(`^${day}$`, 'i') }).first();
    if (await pill.count() > 0) {
      const pressed = await pill.getAttribute('aria-pressed');
      const cls = (await pill.getAttribute('class')) || '';
      const isActive = pressed === 'true' || /\b(on|active|selected)\b/.test(cls);
      if (!isActive) await pill.click();
    } else {
      const cb = schedTab.getByLabel(new RegExp(`^${day}$`, 'i')).first();
      if (!(await cb.isChecked())) await cb.check();
    }
  }
  // Unselect any day NOT in dayNames if day picker exists
  const allDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (const day of allDays) {
    if (dayNames.includes(day)) continue;
    const pill = schedTab.getByRole('button', { name: new RegExp(`^${day}$`, 'i') }).first();
    if (await pill.count() > 0) {
      const pressed = await pill.getAttribute('aria-pressed');
      const cls = (await pill.getAttribute('class')) || '';
      const isActive = pressed === 'true' || /\b(on|active|selected)\b/.test(cls);
      if (isActive) await pill.click();
    } else {
      const cb = schedTab.getByLabel(new RegExp(`^${day}$`, 'i')).first();
      if (await cb.count() > 0 && await cb.isChecked()) await cb.uncheck();
    }
  }
}

async function createScheduleInUi(page, { name, macs, days = null, startTime = '21:30', endTime = '06:45' }) {
  await switchTab(page, 'schedules');
  await page.fill('#sName', name);
  await page.fill('#sMacs', macs);
  if (days) {
    await selectScheduleDaysInUi(page, days);
  }
  await page.fill('#sStart', startTime);
  await page.fill('#sEnd', endTime);
  await page.click('#addSchedBtn');
}

async function findAuditSection(page) {
  const byId = page.locator('#auditLogList, #auditList, [data-testid="audit-log"]').first();
  if (await byId.count() > 0) return byId;
  // Fallback: locate card with Audit/Activity heading
  return page.locator('.card').filter({ hasText: /audit log|activity log/i }).first();
}

const CUSTOM_DOMAIN_CONTAINER_SELECTOR =
  '#customDomainsList > *, #customBlockedList > *, #blockedDomainsList > *, ' +
  '#tab-dns [data-domain], #tab-dns .domain-item, #tab-dns .domain-row, ' +
  '#tab-dns tr, #tab-dns .row, #tab-dns li, #tab-dns .chip';

async function waitForValidationFeedback(page, { toastOnly = false, prevToast = null } = {}) {
  await page.waitForFunction(
    ({ toastOnly, prevToast }) => {
      const rx = /required|invalid|error|fail|must|valid|missing|enter/i;
      const candidates = [];
      const toast = document.querySelector('#toast');
      if (toast) {
        const tcs = getComputedStyle(toast);
        const toastVisible = toast.classList.contains('show') || (tcs.display !== 'none' && tcs.visibility !== 'hidden' && parseFloat(tcs.opacity) > 0);
        const tTxt = (toast.textContent || '').trim();
        if (toastVisible && tTxt.length > 0 && (prevToast === null || tTxt !== prevToast.trim())) {
          candidates.push(tTxt);
        }
      }
      if (!toastOnly) {
        const errNodes = document.querySelectorAll('[role="alert"], .error, .banner-error, .alert-error, .form-error, #quotaError, #schedError, [data-error]');
        for (const el of errNodes) {
          if (el.closest('.hidden')) continue;
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
          if (!(r.width > 0 && r.height > 0)) continue;
          const txt = (el.textContent || '').trim();
          if (txt.length > 0) candidates.push(txt);
        }
      }
      return candidates.some((t) => rx.test(t));
    },
    { toastOnly, prevToast }
  );
}

// ---------------------------------------------------------------------------
// Test Runner Registry (Tiers 1–4)
// ---------------------------------------------------------------------------

const tests = [];
function register(tier, id, name, fn, { requiresInProcess = true } = {}) {
  tests.push({ tier, id, name, fn, requiresInProcess });
}

// ===========================================================================
// TIER 1: FEATURE COVERAGE (>= 5 per area E1–E8 & E7b)
// ===========================================================================

// --- E1: Shell, Navigation & Aesthetic ---
register('Tier 1', 'T1-E1-01', 'Initial configured load & semantic shell', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      const h1Count = await sess.page.locator('h1').count();
      assert.equal(h1Count, 1, 'Expected exactly one <h1> landmark');
      const tablistCount = await sess.page.locator('nav[role="tablist"]').count();
      assert.equal(tablistCount, 1, 'Expected semantic <nav role="tablist">');
      const tabCount = await sess.page.locator('[role="tab"]').count();
      assert.equal(tabCount, 4, 'Expected 4 role="tab" controls');
      assert.equal(await sess.page.locator('[data-tab="overview"]').getAttribute('aria-selected'), 'true');
      assert.equal(await sess.page.locator('#tab-overview').isVisible(), true);
      for (const hiddenTab of ['schedules', 'dns', 'setup']) {
        assert.equal(await sess.page.locator(`#tab-${hiddenTab}`).isVisible(), false);
      }
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
}, { requiresInProcess: true });

register('Tier 1', 'T1-E1-02', 'Unconfigured redirect to Setup tab', async (browser) => {
  await withApp({ setupCompleted: false }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await sess.page.locator('#tab-setup').waitFor({ state: 'visible' });
      assert.equal(await sess.page.locator('[data-tab="setup"]').getAttribute('aria-selected'), 'true');
      assert.equal(await sess.page.locator('#tab-overview').isVisible(), false);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 1', 'T1-E1-03', 'Tab switching across all 4 tabs updates panels and aria-selected', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      for (const tab of ['schedules', 'dns', 'setup', 'overview']) {
        await switchTab(sess.page, tab);
        assert.equal(await sess.page.locator(`[data-tab="${tab}"]`).getAttribute('aria-selected'), 'true');
        assert.equal(await sess.page.locator(`#tab-${tab}`).isVisible(), true);
        for (const other of TABS.filter((t) => t !== tab)) {
          assert.equal(await sess.page.locator(`[data-tab="${other}"]`).getAttribute('aria-selected'), 'false');
          assert.equal(await sess.page.locator(`#tab-${other}`).isVisible(), false);
        }
      }
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 1', 'T1-E1-04', 'Explicit button types and inline SVG icons', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      const missingType = await sess.page.locator('button:not([type])').count();
      assert.equal(missingType, 0, 'Every <button> must specify an explicit type attribute');
      const svgCount = await sess.page.locator('svg').count();
      assert.ok(svgCount >= 1, 'Expected inline <svg> icon(s) in studio chrome');
      const brokenImgs = await sess.page.evaluate(() =>
        [...document.querySelectorAll('img')].filter((img) => !img.complete || img.naturalWidth === 0).length
      );
      assert.equal(brokenImgs, 0, 'Zero broken <img> elements allowed');
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 1', 'T1-E1-05', 'Tactile light-paper theme & zero purple vibe colors', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      for (const tab of TABS) {
        await switchTab(sess.page, tab);
        const res = await auditColors(sess.page);
        assert.equal(res.bodyBg, 'rgb(251, 250, 247)', 'Body background must remain #fbfaf7');
        assert.deepEqual(res.violations, [], `Purple color violations on tab ${tab}: ${res.violations.join(', ')}`);
      }
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

// --- E2: Overview KPIs & Device Management ---
register('Tier 1', 'T1-E2-01', '4 KPI summary cards display accurate live state', async (browser) => {
  await withApp({
    setupCompleted: true,
    seedState: (st) => {
      st.quotas.push({
        id: 'study-quota',
        name: 'Study Quota',
        macs: [SYNTHETIC_MACS[0]],
        dailyLimitSeconds: 5400,
        enabled: true,
        usageByDate: {}
      });
      st.blockedDomains.push(
        { domain: 'one.example', category: 'custom', enabled: true },
        { domain: 'two.example', category: 'custom', enabled: true }
      );
    }
  }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await sess.page.locator('#devicesList .row').first().waitFor();
      assert.equal((await sess.page.locator('#statDriver').textContent()).trim(), 'universal');
      assert.equal((await sess.page.locator('#statDevices').textContent()).trim(), '3');
      assert.match(await sess.page.locator('#statOnline').textContent(), /2\s+online/i);
      assert.equal((await sess.page.locator('#statQuotas').textContent()).trim(), '1');
      assert.match(await sess.page.locator('#statDns').textContent(), new RegExp(`UDP\\s*:${srv.dnsPort}`, 'i'));
      assert.match(await sess.page.locator('#statDomains').textContent(), /2\s+domains?/i);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 1', 'T1-E2-02', 'Device list sorting (pinned -> online -> offline) & metadata display', async (browser) => {
  await withApp({
    setupCompleted: true,
    seedState: (st) => {
      st.pinnedMacs = [SYNTHETIC_MACS[2]]; // Offline TV pinned should sort first!
    }
  }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      const rows = sess.page.locator('#devicesList .row');
      await rows.nth(2).waitFor();
      const firstRowText = await rows.nth(0).textContent();
      assert.match(firstRowText, /Living-Room-TV/, 'Pinned offline device must sort first');
      assert.match(firstRowText, new RegExp(SYNTHETIC_MACS[2]));
      const secondRowText = await rows.nth(1).textContent();
      assert.match(secondRowText, /Kids-Gaming-PC/, 'Alphabetically first online device sorts second');
      assert.match(secondRowText, /192\.0\.2\.10/);
      assert.match(secondRowText, /ONLINE/);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 1', 'T1-E2-03', 'Device alias rename & pin/unpin persistence across reload', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await sess.page.locator('#devicesList .row').first().waitFor();
      await setDeviceAliasAndPin(sess.page, 'Study-iPad', { alias: 'Maya Study Tablet', togglePin: true });
      await sess.page.locator('#devicesList .row').first().filter({ hasText: 'Maya Study Tablet' }).waitFor();

      await sess.page.reload({ waitUntil: 'domcontentloaded' });
      const topRowText = await sess.page.locator('#devicesList .row').first().textContent();
      assert.match(topRowText, /Maya Study Tablet/, 'Pinned alias should persist and sort to top after reload');
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 1', 'T1-E2-04', 'Pause device (1h) & Resume syncs adapter block state', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv, adapter }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await sess.page.locator('#devicesList .row').first().waitFor();
      await pauseDeviceInUi(sess.page, 'Kids-Gaming-PC', '1h');
      const row = await findDeviceRow(sess.page, 'Kids-Gaming-PC');
      await row.getByRole('button', { name: /resume/i }).waitFor({ state: 'visible' });
      assert.match(await row.textContent(), /BLOCKED/i);
      assert.equal(adapter.blocked.has(SYNTHETIC_MACS[0]), true, 'Adapter must block MAC on pause');

      await row.getByRole('button', { name: /resume/i }).click();
      await row.getByRole('button', { name: /pause/i }).first().waitFor({ state: 'visible' });
      assert.match(await row.textContent(), /ONLINE/i);
      assert.equal(adapter.blocked.has(SYNTHETIC_MACS[0]), false, 'Adapter must unblock MAC on resume');
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 1', 'T1-E2-05', 'Indefinite pause + Refresh preserves BLOCKED & updates statBlocked', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv, adapter }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await sess.page.locator('#devicesList .row').first().waitFor();
      await pauseDeviceInUi(sess.page, 'Study-iPad', 'indefinite');
      const row = await findDeviceRow(sess.page, 'Study-iPad');
      await row.getByRole('button', { name: /resume/i }).waitFor({ state: 'visible' });
      assert.equal(adapter.blocked.has(SYNTHETIC_MACS[1]), true);

      await sess.page.click('#refreshBtn');
      await sess.page.waitForFunction(() => /1\s+blocked/i.test(document.querySelector('#statBlocked')?.textContent || ''));
      assert.match(await (await findDeviceRow(sess.page, 'Study-iPad')).textContent(), /BLOCKED/i);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

// --- E3: Daily Quotas CRUD & Enforcement ---
register('Tier 1', 'T1-E3-01', 'Create daily quota via Set Quota prefill and form submit', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      const row = await findDeviceRow(sess.page, 'Kids-Gaming-PC');
      await row.getByRole('button', { name: /set quota/i }).click();
      assert.equal(await sess.page.inputValue('#qMacs'), SYNTHETIC_MACS[0]);
      await sess.page.fill('#qName', 'Alex Gaming Quota');
      await sess.page.fill('#qLimit', '1h30m');
      await sess.page.click('#addQuotaBtn');

      const quotaRow = sess.page.locator('#quotasList .row').filter({ hasText: 'Alex Gaming Quota' }).first();
      await quotaRow.waitFor({ state: 'visible' });
      assert.match(await quotaRow.textContent(), /1h 30m/);
      // Launch video selector contract: first button in #quotasList must be +30m
      const firstBtnText = await sess.page.locator('#quotasList button:first-of-type').first().textContent();
      assert.match(firstBtnText, /\+30m/);
      assert.equal(await sess.page.inputValue('#qName'), '', 'Quota name input should clear after save');
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 1', 'T1-E3-02', 'Grant +30m bonus on quota via first button', async (browser) => {
  await withApp({
    setupCompleted: true,
    seedState: (st) => {
      st.quotas.push({
        id: 'alex-quota',
        name: 'Alex Quota',
        macs: [SYNTHETIC_MACS[0]],
        dailyLimitSeconds: 5400,
        enabled: true,
        usageByDate: {}
      });
    }
  }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await sess.page.locator('#quotasList button:first-of-type').click();
      await sess.page.waitForFunction(() => /2h/.test(document.querySelector('#quotasList')?.textContent || ''));
      await sess.page.reload({ waitUntil: 'domcontentloaded' });
      assert.match(await sess.page.locator('#quotasList').textContent(), /2h/);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 1', 'T1-E3-03', 'Reset today usage to 0m clears LOCKED state', async (browser) => {
  const { todayKey } = await import('../src/state.js');
  await withApp({
    setupCompleted: true,
    seedState: (st) => {
      st.quotas.push({
        id: 'study-q',
        name: 'Study Q',
        macs: [SYNTHETIC_MACS[1]],
        dailyLimitSeconds: 3600,
        enabled: true,
        usageByDate: { [todayKey()]: { usedSeconds: 3600, bonusSeconds: 0, blockedToday: true } }
      });
    }
  }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      const qRow = sess.page.locator('#quotasList .row').filter({ hasText: 'Study Q' }).first();
      await qRow.waitFor();
      assert.match(await qRow.textContent(), /LOCKED/);
      await qRow.getByRole('button', { name: /reset/i }).click();
      await sess.page.waitForFunction(() => /1h\s+left/i.test(document.querySelector('#quotasList')?.textContent || ''));
      assert.doesNotMatch(await qRow.textContent(), /LOCKED/);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 1', 'T1-E3-04', 'Edit existing quota updates in place without duplicating', async (browser) => {
  await withApp({
    setupCompleted: true,
    seedState: (st) => {
      st.quotas.push({
        id: 'edit-q',
        name: 'Edit Me Quota',
        macs: [SYNTHETIC_MACS[0]],
        dailyLimitSeconds: 5400,
        enabled: true,
        usageByDate: {}
      });
    }
  }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      const qRow = sess.page.locator('#quotasList .row').filter({ hasText: 'Edit Me Quota' }).first();
      await qRow.getByRole('button', { name: /edit/i }).click();
      await sess.page.fill('#qName', 'Edited Quota Name');
      await sess.page.fill('#qLimit', '2h');
      await sess.page.click('#addQuotaBtn');

      await sess.page.locator('#quotasList .row').filter({ hasText: 'Edited Quota Name' }).waitFor();
      assert.equal(await sess.page.locator('#quotasList .row').count(), 1, 'Editing quota must update in place');
      assert.match(await sess.page.locator('#quotasList').textContent(), /2h/);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 1', 'T1-E3-05', 'Delete quota removes card and decrements statQuotas', async (browser) => {
  await withApp({
    setupCompleted: true,
    seedState: (st) => {
      st.quotas.push({
        id: 'del-q',
        name: 'Delete Me Quota',
        macs: [SYNTHETIC_MACS[0]],
        dailyLimitSeconds: 3600,
        enabled: true,
        usageByDate: {}
      });
    }
  }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      const qRow = sess.page.locator('#quotasList .row').filter({ hasText: 'Delete Me Quota' }).first();
      await qRow.getByRole('button', { name: /delete/i }).click();
      await sess.page.waitForFunction(() => document.querySelector('#statQuotas')?.textContent?.trim() === '0');
      assert.equal(await sess.page.locator('#quotasList .row').count(), 0);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

// --- E4: Bedtime Schedules CRUD & Day Picker ---
register('Tier 1', 'T1-E4-01', 'Create bedtime schedule with custom Mon-Fri day pills', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await createScheduleInUi(sess.page, {
        name: 'Weeknight Sleep',
        macs: SYNTHETIC_MACS[0],
        days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
        startTime: '21:30',
        endTime: '06:45'
      });
      const row = sess.page.locator('#schedulesList .row').filter({ hasText: 'Weeknight Sleep' }).first();
      await row.waitFor({ state: 'visible' });
      const txt = await row.textContent();
      assert.match(txt, /ENABLED/i);
      assert.match(txt, /21:30.*06:45/);
      assert.match(txt, /Mon.*Fri/);
      assert.match(txt, new RegExp(SYNTHETIC_MACS[0]));
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 1', 'T1-E4-02', 'Edit existing schedule updates in place and persists', async (browser) => {
  await withApp({
    setupCompleted: true,
    seedState: (st) => {
      st.schedules.push({
        id: 'weeknight',
        name: 'Weeknight',
        days: ['Mon', 'Tue'],
        startTime: '21:00',
        endTime: '06:30',
        enabled: true,
        targetMacs: [SYNTHETIC_MACS[0]]
      });
    }
  }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await switchTab(sess.page, 'schedules');
      const row = sess.page.locator('#schedulesList .row').filter({ hasText: 'Weeknight' }).first();
      await row.getByRole('button', { name: /edit/i }).click();
      await selectScheduleDaysInUi(sess.page, ['Mon', 'Tue', 'Sun']);
      await sess.page.fill('#sEnd', '07:30');
      await sess.page.click('#addSchedBtn');

      await sess.page.waitForFunction(() => /07:30/.test(document.querySelector('#schedulesList')?.textContent || ''));
      assert.equal(await sess.page.locator('#schedulesList .row').count(), 1);
      assert.match(await sess.page.locator('#schedulesList').textContent(), /Sun/);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 1', 'T1-E4-03', 'Toggle schedule disabled and re-enabled persists across reload', async (browser) => {
  await withApp({
    setupCompleted: true,
    seedState: (st) => {
      st.schedules.push({
        id: 'bed-toggle',
        name: 'Toggle Bedtime',
        days: ['Mon', 'Tue', 'Wed'],
        startTime: '21:00',
        endTime: '07:00',
        enabled: true,
        targetMacs: [SYNTHETIC_MACS[0]]
      });
    }
  }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await switchTab(sess.page, 'schedules');
      const row = sess.page.locator('#schedulesList .row').filter({ hasText: 'Toggle Bedtime' }).first();
      await row.getByRole('button', { name: /\b(disable|off|toggle)\b/i }).first().click();
      await sess.page.waitForFunction(() => /\b(OFF|DISABLED)\b/i.test(document.querySelector('#schedulesList')?.textContent || ''));

      await sess.page.reload({ waitUntil: 'domcontentloaded' });
      await switchTab(sess.page, 'schedules');
      assert.match(await sess.page.locator('#schedulesList').textContent(), /\b(OFF|DISABLED)\b/i);

      await row.getByRole('button', { name: /\b(enable|on|toggle)\b/i }).first().click();
      await sess.page.waitForFunction(() => /\b(ENABLED|ACTIVE)\b/i.test(document.querySelector('#schedulesList')?.textContent || ''));
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 1', 'T1-E4-04', 'Delete schedule removes card permanently', async (browser) => {
  await withApp({
    setupCompleted: true,
    seedState: (st) => {
      st.schedules.push({
        id: 'bed-delete',
        name: 'Delete Bedtime',
        days: ['Mon'],
        startTime: '21:00',
        endTime: '07:00',
        enabled: true,
        targetMacs: [SYNTHETIC_MACS[0]]
      });
    }
  }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await switchTab(sess.page, 'schedules');
      const row = sess.page.locator('#schedulesList .row').filter({ hasText: 'Delete Bedtime' }).first();
      await row.getByRole('button', { name: /delete/i }).click();
      await sess.page.waitForFunction(() => !/Delete Bedtime/.test(document.querySelector('#schedulesList')?.textContent || ''));
      await sess.page.reload({ waitUntil: 'domcontentloaded' });
      await switchTab(sess.page, 'schedules');
      assert.equal(await sess.page.locator('#schedulesList .row').count(), 0);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 1', 'T1-E4-05', 'Active bedtime schedule shows BLOCKED + schedule reason on Overview', async (browser) => {
  const win = currentActiveWindow();
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await createScheduleInUi(sess.page, {
        name: 'Active Bedtime Window',
        macs: SYNTHETIC_MACS[0],
        days: [todayDayName()],
        startTime: win.startTime,
        endTime: win.endTime
      });
      await switchTab(sess.page, 'overview');
      const row = await findDeviceRow(sess.page, 'Kids-Gaming-PC');
      const txt = await row.textContent();
      assert.match(txt, /BLOCKED/i);
      assert.match(txt, /Active Bedtime Window|Schedule/i);
      assert.match(await sess.page.locator('#statBlocked').textContent(), /1\s+blocked/i);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

// --- E5: DNS Sinkhole & Custom Blocklist ---
register('Tier 1', 'T1-E5-01', 'Toggle category preset chips (YouTube, TikTok, Roblox)', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await switchTab(sess.page, 'dns');
      for (const idx of [1, 2, 4]) {
        await sess.page.click(`#catChips .chip:nth-child(${idx})`);
        await sess.page.waitForFunction((i) => document.querySelector(`#catChips .chip:nth-child(${i})`)?.classList.contains('on'), idx);
      }
      await sess.page.waitForFunction(() => {
        const chips = document.querySelectorAll('#catChips .chip.on');
        return chips.length === 3;
      });
      const expectedCount =
        CATEGORY_PRESETS.youtube.domains.length +
        CATEGORY_PRESETS.tiktok.domains.length +
        CATEGORY_PRESETS.roblox.domains.length;
      assert.match(await sess.page.locator('#statDomains').textContent(), new RegExp(`${expectedCount}\\s+domains?`, 'i'));
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 1', 'T1-E5-02', 'Live UDP DNS test for blocked domain returns 0.0.0.0 BLOCKED', async (browser) => {
  await withApp({
    setupCompleted: true,
    seedState: (st) => {
      st.blockedCategories = ['roblox'];
      st.blockedDomains = CATEGORY_PRESETS.roblox.domains.map((d) => ({ domain: d, category: 'roblox', enabled: true }));
    }
  }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await switchTab(sess.page, 'dns');
      await sess.page.fill('#testDomain', 'roblox.com');
      await sess.page.click('#testDnsBtn');
      await sess.page.waitForFunction(() => /0\.0\.0\.0/.test(document.querySelector('#dnsTestOut')?.textContent || ''));
      assert.match(await sess.page.locator('#dnsTestOut').textContent(), /BLOCKED/i);
      assert.match(await sess.page.locator('#dnsLogList').textContent(), /roblox\.com/);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 1', 'T1-E5-03', 'Block custom domain and view in custom blocklist', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await switchTab(sess.page, 'dns');
      await sess.page.fill('#customDomain', 'distraction-test.example');
      await sess.page.click('#blockDomainBtn');
      await sess.page.waitForFunction(() => /1\s+domains?/i.test(document.querySelector('#statDomains')?.textContent || ''));
      assert.equal(await sess.page.inputValue('#customDomain'), '');
      // Custom blocked domains list must show the domain and an Unblock button
      const customItem = sess.page.locator(CUSTOM_DOMAIN_CONTAINER_SELECTOR)
        .filter({ hasText: 'distraction-test.example' })
        .filter({ has: sess.page.getByRole('button', { name: /unblock|remove|delete/i }) })
        .first();
      await customItem.waitFor({ state: 'visible' });
      await customItem.getByRole('button', { name: /unblock|remove|delete/i }).waitFor({ state: 'visible' });
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 1', 'T1-E5-04', 'Unblock custom domain via UI removes it and persists', async (browser) => {
  await withApp({
    setupCompleted: true,
    seedState: (st) => {
      st.blockedDomains = [{ domain: 'remove-me.example', category: 'custom', enabled: true }];
    }
  }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await switchTab(sess.page, 'dns');
      const customItem = sess.page.locator(CUSTOM_DOMAIN_CONTAINER_SELECTOR)
        .filter({ hasText: 'remove-me.example' })
        .filter({ has: sess.page.getByRole('button', { name: /unblock|remove|delete/i }) })
        .first();
      await customItem.getByRole('button', { name: /unblock|remove|delete/i }).click();
      await sess.page.waitForFunction(() => /0\s+domains?/i.test(document.querySelector('#statDomains')?.textContent || ''));
      await sess.page.reload({ waitUntil: 'domcontentloaded' });
      await switchTab(sess.page, 'dns');
      assert.doesNotMatch(await sess.page.locator('#tab-dns').textContent(), /remove-me\.example/);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 1', 'T1-E5-05', 'Recent DNS queries log displays policy reason for BLOCKED and ALLOWED', async (browser) => {
  await withApp({
    setupCompleted: true,
    useMockUpstream: true,
    seedState: (st) => {
      st.blockedDomains = [{ domain: 'blocked-site.example', category: 'custom', enabled: true }];
    }
  }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await switchTab(sess.page, 'dns');
      await sess.page.fill('#testDomain', 'blocked-site.example');
      await sess.page.click('#testDnsBtn');
      await sess.page.waitForFunction(() => /blocked-site\.example/.test(document.querySelector('#dnsLogList')?.textContent || ''));

      await sess.page.fill('#testDomain', 'allowed-site.example');
      await sess.page.click('#testDnsBtn');
      await sess.page.waitForFunction(() => /allowed-site\.example/.test(document.querySelector('#dnsLogList')?.textContent || ''));

      const blockedRow = sess.page.locator('#dnsLogList .row').filter({ hasText: 'blocked-site.example' }).first();
      const blockedText = await blockedRow.textContent();
      assert.match(blockedText, /\bBLOCKED\b/);
      assert.match(blockedText, /Blocked domain\s*\(blocked-site\.example\)/i);

      const allowedRow = sess.page.locator('#dnsLogList .row').filter({ hasText: 'allowed-site.example' }).first();
      const allowedText = await allowedRow.textContent();
      assert.match(allowedText, /\bALLOWED\b/);
      const allowedNonPillText = await allowedRow.evaluate((el) => {
        const clone = el.cloneNode(true);
        clone.querySelectorAll('.pill').forEach((p) => {
          if (/^(BLOCKED|ALLOWED)$/i.test((p.textContent || '').trim())) p.remove();
        });
        return clone.textContent || '';
      });
      assert.match(allowedNonPillText, /Allowed|Forwarded/i, 'Allowed DNS log row must display q.reason outside status pill');
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

// --- E6: Router Setup & Adapter Catalog Matrix ---
register('Tier 1', 'T1-E6-01', 'Auto-Detect router updates driver, gateway, and conditional fields', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await switchTab(sess.page, 'setup');
      const waitDetect = sess.page.waitForResponse((r) => r.url().includes('/api/router/detect'), { timeout: 7000 });
      await sess.page.click('#detectBtn');
      const detectRes = await waitDetect;
      const detected = await detectRes.json();

      await sess.page.waitForFunction(() => /Detected:/i.test(document.querySelector('#detectHint')?.textContent || ''), null, { timeout: 7000 });
      assert.equal(await sess.page.inputValue('#setupDriver'), detected.matchedDriver);
      assert.equal(await sess.page.inputValue('#setupGateway'), detected.gatewayUrl);
      assert.equal(await sess.page.locator('#universalGuide').isVisible(), detected.matchedDriver === 'universal');
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 1', 'T1-E6-02', 'Adapter catalog matrix — all 7 drivers render exact metadata & fields', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await switchTab(sess.page, 'setup');
      const drivers = Object.values(ADAPTER_CATALOG);
      assert.equal(drivers.length, 7);

      for (const meta of drivers) {
        await sess.page.selectOption('#setupDriver', meta.id);
        const setupText = await sess.page.locator('#tab-setup').textContent();
        assert.ok(setupText.includes(meta.capabilities.discovery) || setupText.includes(meta.capabilities.pause), `Capabilities missing for ${meta.id}`);

        assert.equal(await sess.page.locator('#universalGuide').isVisible(), meta.id === 'universal', `universalGuide visibility mismatch for ${meta.id}`);
        assert.equal(await sess.page.locator('#customHooksBox').isVisible(), meta.id === 'custom', `customHooksBox visibility mismatch for ${meta.id}`);

        if (meta.id !== 'universal' && meta.id !== 'custom') {
          const placeholder = (await sess.page.locator('#setupGateway').getAttribute('placeholder')) || '';
          const inputVal = (await sess.page.locator('#setupGateway').inputValue()) || '';
          assert.ok(`${placeholder} ${inputVal}`.includes('http'), `Expected gateway default/placeholder for ${meta.id}`);
        }
        const hasUserField = meta.authFields.some((f) => f.key === 'username');
        const hasPassField = meta.authFields.some((f) => f.key === 'password');
        if (meta.id === 'universal') {
          assert.equal(await sess.page.locator('#setupUser').isVisible(), false, 'Universal mode must hide username field');
          assert.equal(await sess.page.locator('#setupPass').isVisible(), false, 'Universal mode must hide password field');
        } else if (meta.id === 'att-bgw') {
          assert.equal(await sess.page.locator('#setupUser').isVisible(), false, 'att-bgw must hide username field');
          assert.equal(await sess.page.locator('#setupPass').isVisible(), true, 'att-bgw must show password field');
        } else if (meta.id === 'custom') {
          assert.equal(await sess.page.locator('#setupBlockCmd').isVisible(), true);
          assert.equal(await sess.page.locator('#setupUnblockCmd').isVisible(), true);
        } else {
          assert.equal(await sess.page.locator('#setupUser').isVisible(), hasUserField);
          assert.equal(await sess.page.locator('#setupPass').isVisible(), hasPassField);
        }
      }
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 1', 'T1-E6-03', 'Save universal setup with pollIntervalSec=30 persists across reload', async (browser) => {
  await withApp({ setupCompleted: false }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await sess.page.locator('#tab-setup').waitFor({ state: 'visible' });
      await sess.page.selectOption('#setupDriver', 'universal');
      const pollInput = sess.page.locator('#setupPollInterval, #setupPoll, input[name="pollIntervalSec"]').first();
      await pollInput.fill('30');
      await sess.page.click('#saveSetupBtn');
      await sess.page.waitForFunction(() => {
        const t = document.querySelector('#setupResult')?.textContent || '';
        return /\b(OK|Connected|Saved|Ready)\b/i.test(t) && !/\b(WARN|fail|failed|error|refused)\b/i.test(t);
      });
      assert.equal((await sess.page.locator('#adapterBadge').textContent()).trim(), 'universal');

      await sess.page.reload({ waitUntil: 'domcontentloaded' });
      await switchTab(sess.page, 'setup');
      assert.equal(await pollInput.inputValue(), '30');
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 1', 'T1-E6-04', 'Save custom hooks (blockCmd, unblockCmd, listCmd) persists across reload', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await switchTab(sess.page, 'setup');
      await sess.page.selectOption('#setupDriver', 'custom');
      await sess.page.fill('#setupGateway', 'http://127.0.0.1');
      await sess.page.fill('#setupBlockCmd', 'echo block {{mac}}');
      await sess.page.fill('#setupUnblockCmd', 'echo unblock {{mac}}');
      const listInput = sess.page.locator('#setupListCmd, input[name="listCmd"]').first();
      await listInput.fill('echo []');
      await sess.page.click('#saveSetupBtn');
      await sess.page.waitForFunction(() => /\b(OK|WARN|Connected|Saved)\b/i.test(document.querySelector('#setupResult')?.textContent || ''));

      await sess.page.reload({ waitUntil: 'domcontentloaded' });
      await switchTab(sess.page, 'setup');
      assert.equal(await sess.page.inputValue('#setupBlockCmd'), 'echo block {{mac}}');
      assert.equal(await sess.page.inputValue('#setupUnblockCmd'), 'echo unblock {{mac}}');
      assert.equal(await listInput.inputValue(), 'echo []');
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 1', 'T1-E6-05', 'Password preservation when saving masked placeholder against local mock router', async (browser) => {
  const mockRouter = await startMockRouterHttp();
  try {
    await withApp({
      setupCompleted: true,
      realTestConnection: true,
      seedState: (st) => {
        st.router.driver = 'openwrt';
        st.router.gatewayUrl = mockRouter.url;
        st.router.username = 'root';
        st.router.password = 'super-secret-pw';
      }
    }, async ({ srv }) => {
      const sess = await openTrackedPage(browser, srv.url);
      try {
        await switchTab(sess.page, 'setup');
        const passInput = sess.page.locator('#setupPass');
        const passVal = await passInput.inputValue();
        const passPlaceholder = (await passInput.getAttribute('placeholder')) || '';
        assert.ok(
          passVal === '••••••••' || (passVal === '' && /saved|configured|keep|unchanged|••••/i.test(passPlaceholder)),
          `Expected masked password or saved-password placeholder, got value="${passVal}", placeholder="${passPlaceholder}"`
        );
        const pollInput = sess.page.locator('#setupPollInterval, #setupPoll, input[name="pollIntervalSec"]').first();
        await pollInput.fill('45');
        await sess.page.click('#saveSetupBtn');
        await sess.page.waitForFunction(() => {
          const t = document.querySelector('#setupResult')?.textContent || '';
          return /\b(OK|Connected|Saved|Ready)\b/i.test(t) && !/\b(WARN|fail|failed|error|refused)\b/i.test(t);
        });

        const ubusReqs = mockRouter.requests.filter((r) => r.url === '/ubus');
        assert.ok(ubusReqs.length >= 2, `Expected OpenWrtAdapter to hit mockRouter /ubus, got ${ubusReqs.length} requests`);
        const loginReq = ubusReqs.find((r) => r.body.includes('"login"'));
        assert.ok(loginReq && JSON.parse(loginReq.body).params?.[3]?.password === 'super-secret-pw', 'Expected /ubus login with preserved password');

        const saved = srv.engine.store.load();
        assert.equal(saved.router.password, 'super-secret-pw', 'Masked password placeholder must NOT overwrite stored password');
        assert.equal(saved.router.pollIntervalSec, 45);
        sess.assertCleanRuntime();
      } finally {
        await sess.close();
      }
    });
  } finally {
    await mockRouter.close();
  }
});

// --- E7: Audit Log & Auto-Refresh ---
register('Tier 1', 'T1-E7-01', 'Audit log records device pause & resume newest-first', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await pauseDeviceInUi(sess.page, 'Kids-Gaming-PC', '1h');
      const row = await findDeviceRow(sess.page, 'Kids-Gaming-PC');
      await row.getByRole('button', { name: /resume/i }).waitFor();
      await row.getByRole('button', { name: /resume/i }).click();
      await row.getByRole('button', { name: /pause/i }).first().waitFor();

      const audit = await findAuditSection(sess.page);
      const txt = await audit.textContent();
      assert.match(txt, /RESUME/);
      assert.match(txt, /PAUSE/);
      assert.ok(txt.indexOf('RESUME') < txt.indexOf('PAUSE'), 'Newest audit entry RESUME must precede PAUSE');
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 1', 'T1-E7-02', 'Audit log records quota lifecycle mutations', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await sess.page.fill('#qName', 'Audit Q');
      await sess.page.fill('#qMacs', SYNTHETIC_MACS[0]);
      await sess.page.fill('#qLimit', '1h');
      await sess.page.click('#addQuotaBtn');
      const qRow = sess.page.locator('#quotasList .row').filter({ hasText: 'Audit Q' }).first();
      await qRow.waitFor();
      await qRow.locator('button').first().click(); // +30m
      await sess.page.waitForFunction(() => /1h\s*30m/i.test(document.querySelector('#quotasList')?.textContent || ''));
      await qRow.getByRole('button', { name: /reset/i }).click();
      await sess.page.waitForFunction(() => /1h\s+left/i.test(document.querySelector('#quotasList')?.textContent || ''));
      await qRow.getByRole('button', { name: /delete/i }).click();
      await sess.page.waitForFunction(() => !/Audit Q/.test(document.querySelector('#quotasList')?.textContent || ''));

      const audit = await findAuditSection(sess.page);
      const txt = await audit.textContent();
      for (const act of ['QUOTA_DELETE', 'QUOTA_RESET', 'QUOTA_BONUS', 'QUOTA_SET']) {
        assert.match(txt, new RegExp(act), `Audit log missing ${act}`);
      }
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 1', 'T1-E7-03', 'Audit log records schedule & DNS mutations', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await createScheduleInUi(sess.page, { name: 'Audit Sleep', macs: SYNTHETIC_MACS[0], days: ['Mon'], startTime: '22:00', endTime: '06:00' });
      await switchTab(sess.page, 'dns');
      await sess.page.click('#catChips .chip:nth-child(4)'); // roblox
      await sess.page.waitForFunction(() => document.querySelector('#catChips .chip:nth-child(4)')?.classList.contains('on'));
      await sess.page.fill('#customDomain', 'audit-domain.example');
      await sess.page.click('#blockDomainBtn');
      await sess.page.waitForFunction(() => /audit-domain\.example/.test(document.querySelector('#tab-dns')?.textContent || ''));
      await switchTab(sess.page, 'overview');

      const audit = await findAuditSection(sess.page);
      const txt = await audit.textContent();
      assert.match(txt, /SCHEDULE_SET/);
      assert.match(txt, /CATEGORY_BLOCK/);
      assert.match(txt, /DOMAIN_BLOCK/);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 1', 'T1-E7-04', 'Audit log records router setup updates', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await switchTab(sess.page, 'setup');
      await sess.page.selectOption('#setupDriver', 'universal');
      await sess.page.click('#saveSetupBtn');
      await sess.page.waitForFunction(() => {
        const t = document.querySelector('#setupResult')?.textContent || '';
        return /\b(OK|Connected|Saved|Ready)\b/i.test(t) && !/\b(WARN|fail|failed|error|refused)\b/i.test(t);
      });
      await switchTab(sess.page, 'overview');

      const audit = await findAuditSection(sess.page);
      assert.match(await audit.textContent(), /SETUP/);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 1', 'T1-E7-05', 'Auto-refresh toggle switches cleanly without errors', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      const toggle = sess.page.locator('#autoRefreshToggle, #autoRefreshBtn').first()
        .or(sess.page.getByRole('button', { name: /auto.?refresh/i }).first())
        .or(sess.page.getByRole('checkbox', { name: /auto.?refresh/i }).first());
      await toggle.waitFor({ state: 'visible' });
      const readToggle = () => toggle.evaluate((el) => JSON.stringify({
        checked: typeof el.checked === 'boolean' ? el.checked : null,
        ariaPressed: el.getAttribute('aria-pressed'),
        ariaChecked: el.getAttribute('aria-checked'),
        cls: el.className || '',
        text: (el.textContent || '').trim()
      }));
      const before = await readToggle();
      await toggle.click();
      await sess.page.waitForFunction(
        (prev) => {
          const el = document.querySelector('#autoRefreshToggle, #autoRefreshBtn')
            || [...document.querySelectorAll('button, input[type="checkbox"]')].find((n) =>
              /auto.?refresh/i.test(n.textContent || n.getAttribute('aria-label') || n.closest('label')?.textContent || '')
            );
          if (!el) return false;
          const cur = JSON.stringify({
            checked: typeof el.checked === 'boolean' ? el.checked : null,
            ariaPressed: el.getAttribute('aria-pressed'),
            ariaChecked: el.getAttribute('aria-checked'),
            cls: el.className || '',
            text: (el.textContent || '').trim()
          });
          return cur !== prev;
        },
        before
      );
      const afterFirst = await readToggle();
      assert.notEqual(afterFirst, before, 'Auto-refresh toggle must change observable state on click');
      await toggle.click();
      await sess.page.waitForFunction(
        (prev) => {
          const el = document.querySelector('#autoRefreshToggle, #autoRefreshBtn')
            || [...document.querySelectorAll('button, input[type="checkbox"]')].find((n) =>
              /auto.?refresh/i.test(n.textContent || n.getAttribute('aria-label') || n.closest('label')?.textContent || '')
            );
          if (!el) return false;
          const cur = JSON.stringify({
            checked: typeof el.checked === 'boolean' ? el.checked : null,
            ariaPressed: el.getAttribute('aria-pressed'),
            ariaChecked: el.getAttribute('aria-checked'),
            cls: el.className || '',
            text: (el.textContent || '').trim()
          });
          return cur === prev;
        },
        before
      );
      assert.equal(await readToggle(), before, 'Second click must restore auto-refresh toggle state');
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

// --- E7b: Security, Loading States, Error Envelopes ---
register('Tier 1', 'T1-E7b-01', 'Safe HTML special characters rendered literally without breaking buttons', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await setDeviceAliasAndPin(sess.page, 'Kids-Gaming-PC', { alias: 'Kids & "Pro" <Box>' });
      const row = await findDeviceRow(sess.page, 'Kids & "Pro" <Box>');
      await row.waitFor({ state: 'visible' });
      await row.getByRole('button', { name: /set quota/i }).click();
      assert.equal(await sess.page.inputValue('#qMacs'), SYNTHETIC_MACS[0]);

      await sess.page.fill('#qName', `A & B's "Quota" <1>`);
      await sess.page.fill('#qLimit', '45m');
      await sess.page.click('#addQuotaBtn');
      await sess.page.locator('#quotasList .row').filter({ hasText: `A & B's "Quota" <1>` }).waitFor();
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 1', 'T1-E7b-02', 'Async actions disable button during flight and restore on completion', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await sess.page.route('**/api/router/detect', async (route) => {
        await new Promise((r) => setTimeout(r, 350));
        await route.continue();
      });
      await switchTab(sess.page, 'setup');
      const clickPromise = sess.page.click('#detectBtn');
      await sess.page.waitForFunction(() => document.querySelector('#detectBtn')?.disabled === true, null, { timeout: 1000 });
      await clickPromise;
      await sess.page.waitForFunction(() => document.querySelector('#detectBtn')?.disabled === false, null, { timeout: 8000 });
      await sess.page.unroute('**/api/router/detect');
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 1', 'T1-E7b-03', 'Accessible toast (aria-live) updates on success and error', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      const toast = sess.page.locator('#toast');
      assert.equal(await toast.getAttribute('aria-live'), 'polite');
      await sess.page.fill('#qName', 'Toast Test');
      await sess.page.fill('#qMacs', SYNTHETIC_MACS[0]);
      await sess.page.fill('#qLimit', '30m');
      await sess.page.click('#addQuotaBtn');
      await sess.page.waitForFunction(() => (document.querySelector('#toast')?.textContent || '').trim().length > 0);
      const prevToast = (await toast.textContent()) || '';

      await sess.withExpectedClientError(async () => {
        await sess.page.fill('#qName', '');
        await sess.page.fill('#qMacs', '');
        await sess.page.click('#addQuotaBtn');
        await waitForValidationFeedback(sess.page, { toastOnly: true, prevToast });
      });
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 1', 'T1-E7b-04', 'API returns 400 { ok: false, error } on invalid payloads', async () => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const cases = [
      ['/api/quotas', { name: '', macs: [], limit: '0m' }],
      ['/api/schedules', { name: '', targetMacs: [], startTime: '99:00', endTime: '07:00' }],
      ['/api/setup', { driver: 'unknown-driver-id' }],
      ['/api/dns/category', { category: 'nonexistent-category', enabled: true }]
    ];
    for (const [ep, body] of cases) {
      const res = await apiJson(srv.url, ep, { method: 'POST', body });
      assert.equal(res.status, 400, `${ep} should return 400, got ${res.status}`);
      assert.equal(res.json?.ok, false, `${ep} error envelope must include ok: false`);
      assert.ok(typeof res.json?.error === 'string' && res.json.error.length > 0, `${ep} must include non-empty error`);
    }
  });
});

register('Tier 1', 'T1-E7b-05', 'API returns 404 { ok: false, error } on missing quota/schedule IDs', async () => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const cases = [
      ['DELETE', '/api/quotas/does-not-exist', undefined],
      ['DELETE', '/api/schedules/does-not-exist', undefined],
      ['POST', '/api/quotas/bonus', { id: 'does-not-exist', minutes: '30m' }],
      ['POST', '/api/schedules/toggle', { id: 'does-not-exist', enabled: false }]
    ];
    for (const [method, ep, body] of cases) {
      const res = await apiJson(srv.url, ep, { method, body });
      assert.equal(res.status, 404, `${method} ${ep} should return 404, got ${res.status}`);
      assert.equal(res.json?.ok, false, `${method} ${ep} must include ok: false`);
      assert.ok(typeof res.json?.error === 'string' && res.json.error.length > 0);
    }
  });
});

// --- E8: Responsive Layout across Desktop/Tablet/Phone ---
for (const [idx, vp] of VIEWPORTS.entries()) {
  register('Tier 1', `T1-E8-0${idx + 1}`, `Viewport ${vp.name} (${vp.width}x${vp.height}) layout & geometry`, async (browser) => {
    await withApp({
      setupCompleted: true,
      seedState: (st) => {
        st.quotas.push({
          id: 'vp-q',
          name: 'Viewport Quota',
          macs: [SYNTHETIC_MACS[0]],
          dailyLimitSeconds: 5400,
          enabled: true,
          usageByDate: {}
        });
        st.schedules.push({
          id: 'vp-s',
          name: 'Viewport Bedtime',
          days: ['Mon', 'Tue', 'Wed'],
          startTime: '21:00',
          endTime: '07:00',
          enabled: true,
          targetMacs: [SYNTHETIC_MACS[1]]
        });
      }
    }, async ({ srv }) => {
      const sess = await openTrackedPage(browser, srv.url, { width: vp.width, height: vp.height });
      try {
        for (const tab of TABS) {
          await switchTab(sess.page, tab);
          const ov = await auditOverflow(sess.page, { checkTabletStats2x2: vp.tablet && tab === 'overview' });
          assert.deepEqual(ov.errors, [], `Overflow errors on ${vp.name}/${tab}: ${ov.errors.join('; ')}`);
          const geo = await auditGeometry(sess.page, { mobile: vp.mobile });
          assert.deepEqual(geo.errors, [], `Geometry errors on ${vp.name}/${tab}: ${geo.errors.join('; ')}`);
        }
        sess.assertCleanRuntime();
      } finally {
        await sess.close();
      }
    });
  });
}

register('Tier 1', 'T1-E8-05', 'Long gateway URL and device name wrap cleanly at 375x812', async (browser) => {
  await withApp({
    setupCompleted: true,
    devices: [
      { mac: SYNTHETIC_MACS[0], name: 'SuperLongChildBedroomStreamingConsoleHostname2026', ipv4: '192.0.2.99', ipv6List: [], status: 'online', band: 'Wi-Fi 5GHz' }
    ],
    seedState: (st) => {
      st.router.gatewayUrl = 'http://192.0.2.254:8443/very/long/gateway/management/path/status';
    }
  }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url, { width: 375, height: 812 });
    try {
      await sess.page.locator('#devicesList .row').first().waitFor();
      const ov = await auditOverflow(sess.page);
      assert.deepEqual(ov.errors, [], `Long-string overflow errors: ${ov.errors.join('; ')}`);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

// ===========================================================================
// TIER 2: BOUNDARY, CORNER & NEGATIVE CASES (>= 5 per area E1–E8 & E7b)
// ===========================================================================

// --- E1 Boundaries ---
register('Tier 2', 'T2-E1-01', 'Unknown API route returns 404 { ok: false, error }', async () => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const res = await apiJson(srv.url, '/api/does-not-exist');
    assert.equal(res.status, 404);
    assert.equal(res.json?.ok, false);
    assert.ok(res.json?.error);
  });
});

register('Tier 2', 'T2-E1-02', 'Rapid tab switching leaves final panel active without errors', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      for (const t of ['setup', 'dns', 'schedules', 'overview', 'dns', 'overview']) {
        await sess.page.click(`[data-tab="${t}"]`);
      }
      assert.equal(await sess.page.locator('#tab-overview').isVisible(), true);
      assert.equal(await sess.page.locator('[data-tab="overview"]').getAttribute('aria-selected'), 'true');
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 2', 'T2-E1-03', 'Empty household renders clean empty states across all tabs', async (browser) => {
  await withApp({ setupCompleted: true, devices: [] }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      assert.equal((await sess.page.locator('#statDevices').textContent()).trim(), '0');
      assert.equal((await sess.page.locator('#statBlocked').textContent()).trim().startsWith('0'), true);
      assert.doesNotMatch(await sess.page.locator('main').textContent(), /undefined|NaN/i);
      await switchTab(sess.page, 'schedules');
      assert.match(await sess.page.locator('#schedulesList').textContent(), /no.*schedule/i);
      await switchTab(sess.page, 'dns');
      assert.match(await sess.page.locator('#dnsLogList').textContent(), /no dns/i);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 2', 'T2-E1-04', 'Degraded DNS sinkhole (enableDns: false) shows inactive KPI cleanly', async (browser) => {
  await withApp({ setupCompleted: true, enableDns: false }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      assert.match(await sess.page.locator('#statDns').textContent(), /off|inactive|disabled/i);
      await switchTab(sess.page, 'dns');
      assert.match(await sess.page.locator('#dnsEndpoint').textContent(), /inactive|off|disabled/i);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 2', 'T2-E1-05', 'Zero purple regression across active/selected states', async (browser) => {
  await withApp({
    setupCompleted: true,
    seedState: (st) => {
      st.blockedCategories = ['youtube'];
      st.blockedDomains = CATEGORY_PRESETS.youtube.domains.map((d) => ({ domain: d, category: 'youtube', enabled: true }));
    }
  }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await switchTab(sess.page, 'dns');
      const res = await auditColors(sess.page);
      assert.deepEqual(res.violations, [], `Purple hues detected in active chip/tab state: ${res.violations.join(', ')}`);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

// --- E2 Boundaries ---
register('Tier 2', 'T2-E2-01', 'Device discovery failure surfaces deviceError warning banner in UI', async (browser) => {
  const adapter = createMockAdapter();
  adapter.failListDevices = 'Router auth failed (401)';
  await withApp({ setupCompleted: true, adapter }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await sess.page.waitForFunction(() => /401|auth failed|error/i.test(document.querySelector('#tab-overview')?.textContent || ''));
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 2', 'T2-E2-02', 'Pause sync failure (sync.ok === false) surfaces warning rather than false success', async (browser) => {
  const adapter = createMockAdapter();
  adapter.failNextBlock = 'Router firewall timeout';
  await withApp({ setupCompleted: true, adapter }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await pauseDeviceInUi(sess.page, 'Kids-Gaming-PC', '1h');
      await sess.page.waitForFunction(() => /warn|fail|timeout|sync/i.test(
        (document.querySelector('#toast')?.textContent || '') + ' ' + (document.querySelector('#tab-overview')?.textContent || '')
      ));
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 2', 'T2-E2-03', 'Invalid MAC rejected with 400 on POST /api/devices/alias', async () => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    for (const payload of [{ mac: 'not-a-mac', name: 'Bad', alias: 'Bad' }, {}]) {
      const res = await apiJson(srv.url, '/api/devices/alias', { method: 'POST', body: payload });
      assert.equal(res.status, 400);
      assert.equal(res.json?.ok, false);
    }
  });
});

register('Tier 2', 'T2-E2-04', 'Invalid pause duration rejected with 400 and does not pause device', async () => {
  await withApp({ setupCompleted: true }, async ({ srv, adapter }) => {
    for (const payload of [
      { mac: SYNTHETIC_MACS[0], target: SYNTHETIC_MACS[0], duration: 'invalid-dur' },
      { mac: SYNTHETIC_MACS[0], target: SYNTHETIC_MACS[0], duration: '0m' },
      {}
    ]) {
      const res = await apiJson(srv.url, '/api/devices/pause', { method: 'POST', body: payload });
      assert.equal(res.status, 400, `Expected 400 for ${JSON.stringify(payload)}, got ${res.status}`);
      assert.equal(res.json?.ok, false);
    }
    assert.equal(adapter.blocked.has(SYNTHETIC_MACS[0]), false);
  });
});

register('Tier 2', 'T2-E2-05', 'IPv6-only device with uppercase dashed MAC normalizes cleanly without null/undefined', async (browser) => {
  await withApp({
    setupCompleted: true,
    devices: [{ mac: 'AA-BB-CC-11-22-09', name: 'IPv6-Phone', ipv4: null, ipv6List: ['fd00::9'], status: 'online', band: 'Wi-Fi' }]
  }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      const row = sess.page.locator('#devicesList .row').first();
      await row.waitFor();
      const txt = await row.textContent();
      assert.match(txt, /aa:bb:cc:11:22:09/);
      assert.doesNotMatch(txt, /\bundefined\b|\bnull\b/i);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

// --- E3 Boundaries ---
register('Tier 2', 'T2-E3-01', 'Empty quota UI submit shows validation error without ghost quota', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await sess.withExpectedClientError(async () => {
        await sess.page.fill('#qName', '');
        await sess.page.fill('#qMacs', '');
        await sess.page.click('#addQuotaBtn');
        await waitForValidationFeedback(sess.page);
      });
      assert.equal(await sess.page.locator('#quotasList .row').count(), 0);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 2', 'T2-E3-02', 'Zero/negative/non-numeric quota limits rejected with 400', async () => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    for (const limit of ['0m', '-30m', 'abc', 0, -10]) {
      const res = await apiJson(srv.url, '/api/quotas', {
        method: 'POST',
        body: { name: 'Bad Limit', macs: [SYNTHETIC_MACS[0]], targetMacs: [SYNTHETIC_MACS[0]], limit, dailyLimitMinutes: limit }
      });
      assert.equal(res.status, 400, `Expected 400 for limit=${limit}, got ${res.status}`);
      assert.equal(res.json?.ok, false);
    }
  });
});

register('Tier 2', 'T2-E3-03', 'Invalid MAC in quota input rejected (400 / UI validation)', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const apiRes = await apiJson(srv.url, '/api/quotas', {
      method: 'POST',
      body: { name: 'Bad MAC', macs: ['not-a-mac'], targetMacs: ['not-a-mac'], limit: '30m', dailyLimitMinutes: 30 }
    });
    assert.equal(apiRes.status, 400);
    assert.equal(apiRes.json?.ok, false);

    const sess = await openTrackedPage(browser, srv.url);
    try {
      await sess.withExpectedClientError(async () => {
        await sess.page.fill('#qName', 'Bad MAC UI');
        await sess.page.fill('#qMacs', 'not-a-mac');
        await sess.page.fill('#qLimit', '30m');
        await sess.page.click('#addQuotaBtn');
        await waitForValidationFeedback(sess.page);
      });
      assert.equal(await sess.page.locator('#quotasList .row').count(), 0);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 2', 'T2-E3-04', 'Quota bonus/reset error handling (404 missing ID, 400 invalid minutes)', async () => {
  await withApp({
    setupCompleted: true,
    seedState: (st) => {
      st.quotas.push({ id: 'valid-q', name: 'Valid', macs: [SYNTHETIC_MACS[0]], dailyLimitSeconds: 3600, enabled: true, usageByDate: {} });
    }
  }, async ({ srv }) => {
    const missBonus = await apiJson(srv.url, '/api/quotas/bonus', { method: 'POST', body: { id: 'missing', minutes: '30m' } });
    assert.equal(missBonus.status, 404);
    assert.equal(missBonus.json?.ok, false);

    const badBonus = await apiJson(srv.url, '/api/quotas/bonus', { method: 'POST', body: { id: 'valid-q', minutes: '0m' } });
    assert.equal(badBonus.status, 400);
    assert.equal(badBonus.json?.ok, false);

    const missReset = await apiJson(srv.url, '/api/quotas/reset', { method: 'POST', body: { id: 'missing' } });
    assert.equal(missReset.status, 404);
    assert.equal(missReset.json?.ok, false);
  });
});

register('Tier 2', 'T2-E3-05', 'Multi-MAC comma-separated quota + >100% usage progress bar clamps at 100%', async (browser) => {
  const { todayKey } = await import('../src/state.js');
  await withApp({
    setupCompleted: true,
    seedState: (st) => {
      st.quotas.push({
        id: 'multi-mac',
        name: 'Shared Kids Devices',
        macs: [SYNTHETIC_MACS[0], SYNTHETIC_MACS[1]],
        dailyLimitSeconds: 1800,
        enabled: true,
        usageByDate: { [todayKey()]: { usedSeconds: 2400, bonusSeconds: 0, blockedToday: true } }
      });
    }
  }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      const row = sess.page.locator('#quotasList .row').first();
      await row.waitFor();
      const txt = await row.textContent();
      assert.match(txt, new RegExp(SYNTHETIC_MACS[0]));
      assert.match(txt, new RegExp(SYNTHETIC_MACS[1]));
      assert.match(txt, /LOCKED/);
      const barWidthPct = await row.locator('.bar-fill').evaluate((el) => parseFloat(el.style.width || '0'));
      assert.ok(barWidthPct <= 100, `Bar width must clamp <= 100%, got ${barWidthPct}%`);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

// --- E4 Boundaries ---
register('Tier 2', 'T2-E4-01', 'Empty schedule UI submit rejected cleanly without ghost schedule', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await switchTab(sess.page, 'schedules');
      await sess.withExpectedClientError(async () => {
        await sess.page.fill('#sName', '');
        await sess.page.fill('#sMacs', '');
        await sess.page.click('#addSchedBtn');
        await waitForValidationFeedback(sess.page);
      });
      assert.equal(await sess.page.locator('#schedulesList .row').count(), 0);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 2', 'T2-E4-02', 'Invalid HH:MM schedule times rejected with 400', async () => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    for (const [startTime, endTime] of [['25:00', '07:00'], ['21:00', '12:99'], ['bad', '07:00']]) {
      const res = await apiJson(srv.url, '/api/schedules', {
        method: 'POST',
        body: { name: 'Bad Time', targetMacs: [SYNTHETIC_MACS[0]], days: ['Mon'], startTime, endTime }
      });
      assert.equal(res.status, 400, `Expected 400 for ${startTime}-${endTime}, got ${res.status}`);
      assert.equal(res.json?.ok, false);
    }
  });
});

register('Tier 2', 'T2-E4-03', 'Invalid or empty schedule days array rejected with 400', async () => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    for (const days of [['Funday'], [9], []]) {
      const res = await apiJson(srv.url, '/api/schedules', {
        method: 'POST',
        body: { name: 'Bad Days', targetMacs: [SYNTHETIC_MACS[0]], days, startTime: '21:00', endTime: '07:00' }
      });
      assert.equal(res.status, 400, `Expected 400 for days=${JSON.stringify(days)}, got ${res.status}`);
      assert.equal(res.json?.ok, false);
    }
  });
});

register('Tier 2', 'T2-E4-04', 'Same-day (15:00->17:00) and overnight (21:00->07:00) schedules both save accurately', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await createScheduleInUi(sess.page, { name: 'Afternoon Focus', macs: SYNTHETIC_MACS[0], days: ['Mon'], startTime: '15:00', endTime: '17:00' });
      await createScheduleInUi(sess.page, { name: 'Overnight Rest', macs: SYNTHETIC_MACS[1], days: ['Mon'], startTime: '21:00', endTime: '07:00' });
      const txt = await sess.page.locator('#schedulesList').textContent();
      assert.match(txt, /15:00.*17:00/);
      assert.match(txt, /21:00.*07:00/);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 2', 'T2-E4-05', 'Missing schedule ID on toggle and delete returns 404 { ok: false, error }', async () => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const tRes = await apiJson(srv.url, '/api/schedules/toggle', { method: 'POST', body: { id: 'missing-sched', enabled: false } });
    assert.equal(tRes.status, 404);
    assert.equal(tRes.json?.ok, false);

    const dRes = await apiJson(srv.url, '/api/schedules/missing-sched', { method: 'DELETE' });
    assert.equal(dRes.status, 404);
    assert.equal(dRes.json?.ok, false);
  });
});

// --- E5 Boundaries ---
register('Tier 2', 'T2-E5-01', 'Unknown DNS category rejected with 400 { ok: false, error }', async () => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const res = await apiJson(srv.url, '/api/dns/category', { method: 'POST', body: { category: 'nonexistent', enabled: true } });
    assert.equal(res.status, 400);
    assert.equal(res.json?.ok, false);
  });
});

register('Tier 2', 'T2-E5-02', 'Empty custom domain block and empty DNS test rejected cleanly', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const dRes = await apiJson(srv.url, '/api/dns/domain', { method: 'POST', body: { domain: '   ', action: 'block' } });
    assert.equal(dRes.status, 400);
    assert.equal(dRes.json?.ok, false);

    const tRes = await apiJson(srv.url, '/api/dns/test', { method: 'POST', body: { domain: '' } });
    assert.equal(tRes.status, 400);
    assert.equal(tRes.json?.ok, false);

    const sess = await openTrackedPage(browser, srv.url);
    try {
      await switchTab(sess.page, 'dns');
      await sess.withExpectedClientError(async () => {
        await sess.page.fill('#customDomain', '');
        await sess.page.click('#blockDomainBtn');
        await sess.page.fill('#testDomain', '');
        await sess.page.click('#testDnsBtn');
        await sess.page.waitForTimeout(150);
      });
      assert.match(await sess.page.locator('#statDomains').textContent(), /0\s+domains?/i);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 2', 'T2-E5-03', 'URL/whitespace normalization on custom blocked domain', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await switchTab(sess.page, 'dns');
      await sess.page.fill('#customDomain', '   https://WWW.Example.COM/watch?v=1  ');
      await sess.page.click('#blockDomainBtn');
      await sess.page.waitForFunction(() => /www\.example\.com/.test(document.querySelector('#tab-dns')?.textContent || ''));

      await sess.page.fill('#testDomain', 'www.example.com');
      await sess.page.click('#testDnsBtn');
      await sess.page.waitForFunction(() => /0\.0\.0\.0/.test(document.querySelector('#dnsTestOut')?.textContent || ''));
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 2', 'T2-E5-04', 'Wildcard subdomain sinkholes sub.roblox.com without false-positiving notroblox.com', async () => {
  await withApp({
    setupCompleted: true,
    useMockUpstream: true,
    seedState: (st) => {
      st.blockedDomains = [{ domain: 'roblox.com', category: 'custom', enabled: true }];
    }
  }, async ({ srv }) => {
    const sub = await srv.dnsSinkhole.testQuery('web.roblox.com');
    assert.equal(sub.ok, true);
    assert.equal(sub.sinkholed, true);
    assert.equal(sub.resolvedIp, '0.0.0.0');

    const lookalike = await srv.dnsSinkhole.testQuery('notroblox.com');
    assert.equal(lookalike.ok, true);
    assert.equal(lookalike.sinkholed, false);
    assert.notEqual(lookalike.resolvedIp, '0.0.0.0');
  });
});

register('Tier 2', 'T2-E5-05', 'Stopped DNS sinkhole responds immediately (<500ms) without 2.5s timeout hang', async (browser) => {
  await withApp({ setupCompleted: true, enableDns: false }, async ({ srv }) => {
    const t0 = Date.now();
    const res = await apiJson(srv.url, '/api/dns/test', { method: 'POST', body: { domain: 'roblox.com' } });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 500, `Expected immediate non-hanging response (<500ms), took ${elapsed}ms`);
    const resultObj = res.json?.result || res.json;
    assert.equal(resultObj?.ok, false);
    assert.ok(resultObj?.error);

    const sess = await openTrackedPage(browser, srv.url);
    try {
      await switchTab(sess.page, 'dns');
      await sess.page.fill('#testDomain', 'roblox.com');
      await sess.page.click('#testDnsBtn');
      await sess.page.waitForFunction(() => /error|not running|inactive|stopped/i.test(document.querySelector('#dnsTestOut')?.textContent || ''));
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

// --- E6 Boundaries ---
register('Tier 2', 'T2-E6-01', 'Unknown router driver rejected with 400 { ok: false, error }', async () => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const res = await apiJson(srv.url, '/api/setup', { method: 'POST', body: { driver: 'bogus-driver' } });
    assert.equal(res.status, 400);
    assert.equal(res.json?.ok, false);
    assert.equal(srv.engine.store.load().router.driver, 'universal');
  });
});

register('Tier 2', 'T2-E6-02', 'Invalid gatewayUrl scheme (ftp://, javascript:) rejected with 400', async () => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    for (const gatewayUrl of ['ftp://192.0.2.1', 'javascript:alert(1)', 'not-a-url']) {
      const res = await apiJson(srv.url, '/api/setup', {
        method: 'POST',
        body: { driver: 'openwrt', gatewayUrl }
      });
      assert.equal(res.status, 400, `Expected 400 for gatewayUrl="${gatewayUrl}", got ${res.status}`);
      assert.equal(res.json?.ok, false);
    }
  });
});

register('Tier 2', 'T2-E6-03', 'pollIntervalSec boundary validation (4, 0, -1, 3601 -> 400; 5, 3600 -> 200)', async () => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    for (const bad of [4, 0, -10, 3601, 'abc', 15.5]) {
      const res = await apiJson(srv.url, '/api/setup', {
        method: 'POST',
        body: { driver: 'universal', pollIntervalSec: bad }
      });
      assert.equal(res.status, 400, `Expected 400 for pollIntervalSec=${bad}, got ${res.status}`);
      assert.equal(res.json?.ok, false);
    }
    for (const okVal of [5, 3600]) {
      const res = await apiJson(srv.url, '/api/setup', {
        method: 'POST',
        body: { driver: 'universal', pollIntervalSec: okVal }
      });
      assert.equal(res.status, 200, `Expected 200 for pollIntervalSec=${okVal}, got ${res.status}`);
    }
  });
});

register('Tier 2', 'T2-E6-04', 'Clearing optional custom hook / username fields persists empty string', async (browser) => {
  await withApp({
    setupCompleted: true,
    seedState: (st) => {
      st.router.driver = 'custom';
      st.router.blockCmd = 'echo old-block {{mac}}';
      st.router.unblockCmd = 'echo old-unblock {{mac}}';
      st.router.listCmd = 'echo []';
    }
  }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await switchTab(sess.page, 'setup');
      await sess.page.fill('#setupBlockCmd', '');
      await sess.page.fill('#setupUnblockCmd', '');
      const listInput = sess.page.locator('#setupListCmd, input[name="listCmd"]').first();
      await listInput.fill('');
      await sess.page.click('#saveSetupBtn');
      await sess.page.waitForFunction(() => /\b(OK|WARN|Connected|Saved)\b/i.test(document.querySelector('#setupResult')?.textContent || ''));

      const saved = srv.engine.store.load();
      assert.equal(saved.router.blockCmd || '', '', 'Clearing blockCmd must persist empty string');
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 2', 'T2-E6-05', 'Unreachable router connection failure surfaces WARN banner honestly', async (browser) => {
  const closedPort = await getClosedLocalPort();
  await withApp({ setupCompleted: true, realTestConnection: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await switchTab(sess.page, 'setup');
      await sess.page.selectOption('#setupDriver', 'openwrt');
      await sess.page.fill('#setupGateway', `http://127.0.0.1:${closedPort}`);
      await sess.page.fill('#setupPass', 'test-pw');
      await sess.page.click('#saveSetupBtn');
      await sess.page.waitForFunction(() => /WARN|fail|refused|error/i.test(document.querySelector('#setupResult')?.textContent || ''));
      assert.doesNotMatch(await sess.page.locator('#setupResult').textContent(), /^(OK:|Connected\b)/i);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

// --- E7 Boundaries ---
register('Tier 2', 'T2-E7-01', 'Audit log capped at <= 100 entries with newest first', async (browser) => {
  await withApp({
    setupCompleted: true,
    seedState: (st) => {
      for (let i = 0; i < 105; i++) {
        st.auditLog.push({ ts: new Date(Date.now() - i * 1000).toISOString(), action: 'TICK', target: `dev-${i}`, detail: `entry ${i}` });
      }
    }
  }, async ({ srv }) => {
    await apiJson(srv.url, '/api/dns/domain', { method: 'POST', body: { domain: 'cap-check.example', action: 'block' } });
    const saved = srv.engine.store.load();
    assert.ok(saved.auditLog.length <= 100, `Expected <= 100 audit entries, got ${saved.auditLog.length}`);
    assert.equal(saved.auditLog[0].action, 'DOMAIN_BLOCK');

    const sess = await openTrackedPage(browser, srv.url);
    try {
      const ov = await auditOverflow(sess.page);
      assert.deepEqual(ov.errors, []);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 2', 'T2-E7-02', 'Audit log empty state renders gracefully', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      const audit = await findAuditSection(sess.page);
      await audit.waitFor({ state: 'visible' });
      assert.doesNotMatch(await audit.textContent(), /undefined|null/i);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 2', 'T2-E7-03', 'Audit log escapes special characters in detail and target', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      const payload = `Audit <img src=x onerror="window.__xss=9"> & "quote"`;
      await sess.page.fill('#qName', payload);
      await sess.page.fill('#qMacs', SYNTHETIC_MACS[0]);
      await sess.page.fill('#qLimit', '30m');
      await sess.page.click('#addQuotaBtn');
      const audit = await findAuditSection(sess.page);
      await audit.waitFor();
      assert.equal(await sess.page.evaluate(() => window.__xss), undefined);
      assert.match(await audit.textContent(), /<img/);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 2', 'T2-E7-04', 'Background refresh does not wipe typed unsaved form input', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await sess.page.fill('#qName', 'In-Progress Typing');
      await sess.page.click('#refreshBtn');
      await sess.page.waitForTimeout(200);
      assert.equal(await sess.page.inputValue('#qName'), 'In-Progress Typing');
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 2', 'T2-E7-05', 'Rapid concurrent StateStore mutations persist valid JSON without ENOENT', async () => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const results = await Promise.all([
      apiJson(srv.url, '/api/quotas', { method: 'POST', body: { name: 'Concurrent Q1', macs: [SYNTHETIC_MACS[0]], targetMacs: [SYNTHETIC_MACS[0]], limit: '1h', dailyLimitMinutes: 60 } }),
      apiJson(srv.url, '/api/dns/domain', { method: 'POST', body: { domain: 'c1.example', action: 'block' } }),
      apiJson(srv.url, '/api/dns/domain', { method: 'POST', body: { domain: 'c2.example', action: 'block' } }),
      apiJson(srv.url, '/api/devices/alias', { method: 'POST', body: { mac: SYNTHETIC_MACS[0], name: 'Concurrent Alias', alias: 'Concurrent Alias', pinned: true } })
    ]);
    for (const r of results) {
      assert.equal(r.status, 200, `Concurrent request failed with ${r.status}: ${r.text}`);
    }
    const loaded = srv.engine.store.load();
    assert.ok(loaded.quotas.some((q) => q.name === 'Concurrent Q1' && q.macs.includes(SYNTHETIC_MACS[0])), 'Concurrent quota Q1 must persist');
    assert.ok(loaded.blockedDomains.some((d) => d.domain === 'c1.example' && d.enabled), 'Concurrent domain c1.example must persist');
    assert.ok(loaded.blockedDomains.some((d) => d.domain === 'c2.example' && d.enabled), 'Concurrent domain c2.example must persist');
    assert.equal(loaded.aliases[SYNTHETIC_MACS[0]], 'Concurrent Alias', 'Concurrent device alias must persist');
    assert.ok(loaded.pinnedMacs.includes(SYNTHETIC_MACS[0]), 'Concurrent device pin must persist');
  });
});

// --- E7b Boundaries (XSS & HTTP Parsing) ---
register('Tier 2', 'T2-E7b-01', 'XSS payload in router device hostname never executes and buttons work', async (browser) => {
  const xssName = `<img src=x onerror="window.__xss=(window.__xss||0)+1">Evil'Dev"1`;
  await withApp({
    setupCompleted: true,
    devices: [{ mac: SYNTHETIC_MACS[0], name: xssName, ipv4: '192.0.2.10', ipv6List: [], status: 'online', band: 'Wi-Fi' }]
  }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      const row = sess.page.locator('#devicesList .row').first();
      await row.waitFor();
      assert.equal(await sess.page.evaluate(() => window.__xss), undefined, 'XSS executed from device hostname!');
      assert.ok((await row.textContent()).includes(xssName));
      await row.getByRole('button', { name: /set quota/i }).click();
      assert.equal(await sess.page.inputValue('#qMacs'), SYNTHETIC_MACS[0]);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 2', 'T2-E7b-02', 'XSS payloads in quota name and schedule name render escaped', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      const qPayload = `<svg onload="window.__xss=1">Q"test`;
      await sess.page.fill('#qName', qPayload);
      await sess.page.fill('#qMacs', SYNTHETIC_MACS[0]);
      await sess.page.fill('#qLimit', '1h');
      await sess.page.click('#addQuotaBtn');
      await sess.page.locator('#quotasList .row').first().waitFor();
      assert.equal(await sess.page.evaluate(() => window.__xss), undefined);
      assert.ok((await sess.page.locator('#quotasList').textContent()).includes(qPayload));

      const sPayload = `<script>window.__xss=2</script>Bed'Time`;
      await createScheduleInUi(sess.page, { name: sPayload, macs: SYNTHETIC_MACS[0], days: ['Mon'], startTime: '21:00', endTime: '07:00' });
      await sess.page.locator('#schedulesList .row').first().waitFor();
      assert.equal(await sess.page.evaluate(() => window.__xss), undefined);
      assert.ok((await sess.page.locator('#schedulesList').textContent()).includes(sPayload));
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 2', 'T2-E7b-03', 'XSS payload in custom domain and DNS log renders escaped', async (browser) => {
  const domPayload = `"><img src=x onerror=window.__xss=3>.example`;
  const seededCustomPayload = `"><img src=x onerror=window.__xss=6>.example`;
  const logDomPayload = `<img src=x onerror="window.__xss=4">.test`;
  const logReasonPayload = `Reason <script>window.__xss=5</script>`;

  await withApp({
    setupCompleted: true,
    seedState: (st) => {
      st.customBlockedDomains.push(seededCustomPayload);
    }
  }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await switchTab(sess.page, 'dns');

      // (a) Submitting HTML/XSS payload to #blockDomainBtn must return HTTP 400 + UI error feedback
      await sess.withExpectedClientError(async () => {
        const resPromise = sess.page.waitForResponse(
          (r) => r.url().includes('/api/dns/domain') && r.request().method() === 'POST'
        );
        await sess.page.fill('#customDomain', domPayload);
        await sess.page.click('#blockDomainBtn');
        const res = await resPromise;
        assert.equal(res.status(), 400, `Expected 400 for invalid XSS domain, got ${res.status()}`);
        const body = await res.json();
        assert.equal(body?.ok, false);
        await waitForValidationFeedback(sess.page);
      });
      assert.match(await sess.page.locator('#dnsFormError').textContent(), /valid domain/i);
      assert.match(await sess.page.locator('#toast').textContent(), /valid domain/i);
      assert.match(await sess.page.locator('#statDomains').textContent(), /0\s+domains?/i);
      assert.equal(await sess.page.evaluate(() => window.__xss), undefined);

      // (b) Seeded customBlockedDomains & recentQueries render inertly in #customDomainsList and #dnsLogList
      const customText = await sess.page.locator('#customDomainsList').textContent();
      assert.ok(customText.includes(seededCustomPayload), 'Seeded customBlockedDomains XSS payload must appear literally in #customDomainsList');
      assert.ok(!customText.includes(domPayload), 'Rejected #blockDomainBtn payload must not be added to #customDomainsList');
      assert.equal(await sess.page.locator('#customDomainsList img, #customDomainsList script').count(), 0);
      assert.equal(
        await sess.page.locator('#customDomainsList [data-action="unblock-domain"]').first().getAttribute('data-domain'),
        seededCustomPayload
      );

      // Inject log entry directly and reload to verify #dnsLogList escaping
      srv.dnsSinkhole.queryLog.unshift({
        id: 'xss-log-1',
        ts: new Date().toISOString(),
        clientIp: '192.0.2.10',
        domain: logDomPayload,
        qtype: 'A',
        action: 'BLOCKED',
        reason: logReasonPayload
      });
      await sess.page.reload({ waitUntil: 'domcontentloaded' });
      await switchTab(sess.page, 'dns');

      const logText = await sess.page.locator('#dnsLogList').textContent();
      assert.ok(logText.includes(logDomPayload), 'Seeded recentQueries domain XSS payload must appear literally in #dnsLogList');
      assert.ok(logText.includes(logReasonPayload), 'Seeded recentQueries reason XSS payload must appear literally in #dnsLogList');
      assert.equal(await sess.page.locator('#dnsLogList img, #dnsLogList script').count(), 0);

      // Verify data-domain unblock works safely without executing XSS
      await sess.page.locator('#customDomainsList [data-action="unblock-domain"]').first().click();
      await sess.page.waitForFunction(
        (payload) => !(document.querySelector('#customDomainsList')?.textContent || '').includes(payload),
        seededCustomPayload
      );
      assert.equal(await sess.page.evaluate(() => window.__xss), undefined);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 2', 'T2-E7b-04', 'Malformed JSON body returns 400 { ok: false, error }', async () => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const res = await apiJson(srv.url, '/api/quotas', { method: 'POST', rawBody: '{bad json' });
    assert.equal(res.status, 400);
    assert.equal(res.json?.ok, false);
    assert.ok(res.json?.error);
  });
});

register('Tier 2', 'T2-E7b-05', 'Oversized >1MB JSON body returns 413 { ok: false, error } cleanly', async () => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const big = JSON.stringify({ driver: 'universal', pad: 'x'.repeat(1_200_000) });
    const res = await apiJson(srv.url, '/api/setup', { method: 'POST', rawBody: big });
    assert.equal(res.status, 413, `Expected 413 Payload Too Large, got ${res.status}`);
    assert.equal(res.json?.ok, false);
  });
});

// --- E8 Boundaries ---
register('Tier 2', 'T2-E8-01', 'Narrow 375x812 wraps long DNS query domain without horizontal overflow', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    srv.dnsSinkhole.queryLog.unshift({
      id: 'long-dom-1',
      ts: new Date().toISOString(),
      clientIp: '192.0.2.10',
      domain: 'very-long-subdomain-name-that-could-overflow-mobile-cards-in-narrow-viewports.example.com',
      qtype: 'A',
      action: 'BLOCKED',
      reason: 'Blocked domain (example.com)'
    });
    const sess = await openTrackedPage(browser, srv.url, { width: 375, height: 812 });
    try {
      await switchTab(sess.page, 'dns');
      const ov = await auditOverflow(sess.page);
      assert.deepEqual(ov.errors, [], `Long DNS domain overflow at 375px: ${ov.errors.join('; ')}`);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 2', 'T2-E8-02', '375x812 custom hooks form stacks cleanly with >=44px targets and >=16px inputs', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url, { width: 375, height: 812 });
    try {
      await switchTab(sess.page, 'setup');
      await sess.page.selectOption('#setupDriver', 'custom');
      const ov = await auditOverflow(sess.page);
      assert.deepEqual(ov.errors, []);
      const geo = await auditGeometry(sess.page, { mobile: true });
      assert.deepEqual(geo.errors, [], `Custom setup mobile geometry errors: ${geo.errors.join('; ')}`);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 2', 'T2-E8-03', '375x812 device & quota action buttons wrap cleanly without clip or overlap', async (browser) => {
  await withApp({
    setupCompleted: true,
    seedState: (st) => {
      st.quotas.push({ id: 'wrap-q', name: 'Long Device Quota Name', macs: [SYNTHETIC_MACS[0]], dailyLimitSeconds: 5400, enabled: true, usageByDate: {} });
    }
  }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url, { width: 375, height: 812 });
    try {
      const geo = await auditGeometry(sess.page, { mobile: true });
      assert.deepEqual(geo.errors, [], `375px action wrapping errors: ${geo.errors.join('; ')}`);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 2', 'T2-E8-04', 'Schedule day-of-week pills wrap cleanly at 375px, 430px, and 768px', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    for (const vp of [{ width: 375, height: 812, mobile: true }, { width: 430, height: 932, mobile: true }, { width: 768, height: 1024, mobile: false }]) {
      const sess = await openTrackedPage(browser, srv.url, { width: vp.width, height: vp.height });
      try {
        await switchTab(sess.page, 'schedules');
        const ov = await auditOverflow(sess.page);
        assert.deepEqual(ov.errors, []);
        const geo = await auditGeometry(sess.page, { mobile: vp.mobile });
        assert.deepEqual(geo.errors, [], `Schedule day pills geometry at ${vp.width}px: ${geo.errors.join('; ')}`);
        sess.assertCleanRuntime();
      } finally {
        await sess.close();
      }
    }
  });
});

register('Tier 2', 'T2-E8-05', 'Compact header height on 375x812 does not dominate viewport', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url, { width: 375, height: 812 });
    try {
      const geo = await auditGeometry(sess.page, { mobile: true });
      assert.ok(geo.headerHeight > 0 && geo.headerHeight <= 190, `Mobile header too tall: ${geo.headerHeight}px`);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

// ===========================================================================
// TIER 3: CROSS-FEATURE COMBINATIONS (10 Pairwise Interactions)
// ===========================================================================

register('Tier 3', 'T3-01', 'Quota delete unblocks exhausted device on router and Overview', async (browser) => {
  const { todayKey } = await import('../src/state.js');
  await withApp({
    setupCompleted: true,
    seedState: (st) => {
      st.quotas.push({
        id: 'exhausted-q',
        name: 'Exhausted Quota',
        macs: [SYNTHETIC_MACS[0]],
        dailyLimitSeconds: 1800,
        enabled: true,
        usageByDate: { [todayKey()]: { usedSeconds: 1800, bonusSeconds: 0, blockedToday: true } }
      });
    }
  }, async ({ srv, adapter }) => {
    await srv.engine.tick();
    assert.equal(adapter.blocked.has(SYNTHETIC_MACS[0]), true);

    const sess = await openTrackedPage(browser, srv.url);
    try {
      const qRow = sess.page.locator('#quotasList .row').filter({ hasText: 'Exhausted Quota' }).first();
      await qRow.getByRole('button', { name: /delete/i }).click();
      await sess.page.waitForFunction(() => document.querySelector('#statQuotas')?.textContent?.trim() === '0');
      assert.equal(adapter.blocked.has(SYNTHETIC_MACS[0]), false, 'Deleting exhausted quota must unblock MAC on router');
      assert.match(await (await findDeviceRow(sess.page, 'Kids-Gaming-PC')).textContent(), /ONLINE/i);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 3', 'T3-02', 'Quota delete while manually paused keeps device blocked until Resume', async (browser) => {
  const { todayKey } = await import('../src/state.js');
  await withApp({
    setupCompleted: true,
    seedState: (st) => {
      st.quotas.push({
        id: 'both-q',
        name: 'Both Blocked Q',
        macs: [SYNTHETIC_MACS[0]],
        dailyLimitSeconds: 1800,
        enabled: true,
        usageByDate: { [todayKey()]: { usedSeconds: 1800, bonusSeconds: 0, blockedToday: true } }
      });
    }
  }, async ({ srv, adapter }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await pauseDeviceInUi(sess.page, 'Kids-Gaming-PC', '1h');
      const qRow = sess.page.locator('#quotasList .row').filter({ hasText: 'Both Blocked Q' }).first();
      await qRow.getByRole('button', { name: /delete/i }).click();
      await sess.page.waitForFunction(() => document.querySelector('#statQuotas')?.textContent?.trim() === '0');
      assert.equal(adapter.blocked.has(SYNTHETIC_MACS[0]), true, 'Manual pause must keep device blocked after quota deletion');

      const devRow = await findDeviceRow(sess.page, 'Kids-Gaming-PC');
      await devRow.getByRole('button', { name: /resume/i }).click();
      await devRow.getByRole('button', { name: /pause/i }).first().waitFor();
      assert.equal(adapter.blocked.has(SYNTHETIC_MACS[0]), false);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 3', 'T3-03', 'Schedule disable unblocks device immediately on router and Overview', async (browser) => {
  const win = currentActiveWindow();
  await withApp({
    setupCompleted: true,
    seedState: (st) => {
      st.schedules.push({
        id: 'active-s',
        name: 'Active Disable Test',
        days: [todayDayName()],
        startTime: win.startTime,
        endTime: win.endTime,
        enabled: true,
        targetMacs: [SYNTHETIC_MACS[1]]
      });
    }
  }, async ({ srv, adapter }) => {
    await srv.engine.tick();
    assert.equal(adapter.blocked.has(SYNTHETIC_MACS[1]), true);

    const sess = await openTrackedPage(browser, srv.url);
    try {
      await switchTab(sess.page, 'schedules');
      const sRow = sess.page.locator('#schedulesList .row').filter({ hasText: 'Active Disable Test' }).first();
      await sRow.getByRole('button', { name: /\b(disable|off|toggle)\b/i }).first().click();
      await sess.page.waitForFunction(() => /\b(OFF|DISABLED)\b/i.test(document.querySelector('#schedulesList')?.textContent || ''));
      assert.equal(adapter.blocked.has(SYNTHETIC_MACS[1]), false, 'Disabling active schedule must unblock MAC');

      await switchTab(sess.page, 'overview');
      assert.match(await (await findDeviceRow(sess.page, 'Study-iPad')).textContent(), /ONLINE/i);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 3', 'T3-04', 'Quota edit shrinking targetMacs unblocks freed MAC while keeping remaining MAC blocked', async (browser) => {
  const { todayKey } = await import('../src/state.js');
  await withApp({
    setupCompleted: true,
    seedState: (st) => {
      st.quotas.push({
        id: 'shrink-q',
        name: 'Two Device Quota',
        macs: [SYNTHETIC_MACS[0], SYNTHETIC_MACS[1]],
        dailyLimitSeconds: 1800,
        enabled: true,
        usageByDate: { [todayKey()]: { usedSeconds: 1800, bonusSeconds: 0, blockedToday: true } }
      });
    }
  }, async ({ srv, adapter }) => {
    await srv.engine.tick();
    assert.equal(adapter.blocked.has(SYNTHETIC_MACS[0]), true);
    assert.equal(adapter.blocked.has(SYNTHETIC_MACS[1]), true);

    const sess = await openTrackedPage(browser, srv.url);
    try {
      const qRow = sess.page.locator('#quotasList .row').filter({ hasText: 'Two Device Quota' }).first();
      await qRow.getByRole('button', { name: /edit/i }).click();
      await sess.page.fill('#qMacs', SYNTHETIC_MACS[0]);
      await sess.page.click('#addQuotaBtn');
      await sess.page.waitForFunction((m2) => !document.querySelector('#quotasList')?.textContent?.includes(m2), SYNTHETIC_MACS[1]);

      assert.equal(adapter.blocked.has(SYNTHETIC_MACS[0]), true, 'Remaining MAC must stay blocked');
      assert.equal(adapter.blocked.has(SYNTHETIC_MACS[1]), false, 'Freed MAC must be unblocked on router');
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 3', 'T3-05', 'setupDirty anti-clobber preserves unsaved Setup edits across tab switch and Refresh', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await switchTab(sess.page, 'setup');
      await sess.page.selectOption('#setupDriver', 'att-bgw');
      await sess.page.fill('#setupGateway', 'http://192.0.2.254');

      await switchTab(sess.page, 'overview');
      await sess.page.click('#refreshBtn');
      await sess.page.waitForTimeout(200);
      await switchTab(sess.page, 'setup');

      assert.equal(await sess.page.inputValue('#setupDriver'), 'att-bgw', 'Refresh must not clobber dirty setupDriver');
      assert.equal(await sess.page.inputValue('#setupGateway'), 'http://192.0.2.254', 'Refresh must not clobber dirty setupGateway');
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 3', 'T3-06', 'Custom domain preserved when overlapping category preset is toggled off', async (browser) => {
  await withApp({ setupCompleted: true, useMockUpstream: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await switchTab(sess.page, 'dns');
      await sess.page.fill('#customDomain', 'youtube.com');
      await sess.page.click('#blockDomainBtn');
      await sess.page.waitForFunction(() => /1\s+domains?/i.test(document.querySelector('#statDomains')?.textContent || ''));

      // Toggle YouTube category ON then OFF
      await sess.page.click('#catChips .chip:nth-child(1)');
      await sess.page.waitForFunction(() => document.querySelector('#catChips .chip:nth-child(1)')?.classList.contains('on'));
      await sess.page.click('#catChips .chip:nth-child(1)');
      await sess.page.waitForFunction(() => !document.querySelector('#catChips .chip:nth-child(1)')?.classList.contains('on'));

      const yt = await srv.dnsSinkhole.testQuery('youtube.com');
      assert.equal(yt.sinkholed, true, 'Explicitly custom-blocked youtube.com must remain blocked after category off');
      const ytShort = await srv.dnsSinkhole.testQuery('youtu.be');
      assert.equal(ytShort.sinkholed, false, 'Other youtube category domains should be unblocked');
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 3', 'T3-07', 'Paused device DNS sinkhole client attribution blocks allowed domains', async () => {
  await withApp({ setupCompleted: true, useMockUpstream: true }, async ({ srv }) => {
    await srv.engine.listDevices();
    await srv.engine.pauseDevice(SYNTHETIC_MACS[0], 60, 'Homework pause');

    const pausedVerdict = srv.engine.evaluateDnsQuery('example.org', '192.0.2.10');
    assert.equal(pausedVerdict.blocked, true);
    assert.match(pausedVerdict.reason, /paused/i);

    const unpausedVerdict = srv.engine.evaluateDnsQuery('example.org', '192.0.2.11');
    assert.equal(unpausedVerdict.blocked, false);
  });
});

register('Tier 3', 'T3-08', 'Device alias/pin propagates to Quota/Schedule MAC picker and DNS pause reason', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await setDeviceAliasAndPin(sess.page, 'Study-iPad', { alias: 'Maya Tablet', togglePin: true });
      await sess.page.locator('#devicesList .row').first().filter({ hasText: 'Maya Tablet' }).waitFor();

      // Verify alias appears in Quota or Schedule MAC picker (scoped away from #devicesList)
      const pickerOption = sess.page.locator(
        '#tab-overview .card:has(#qMacs) select option, ' +
        '#tab-overview form:has(#qMacs) select option, ' +
        '#qMacPicker option, #qMacPicker button, #qMacPicker .chip, ' +
        '#tab-overview [data-mac-picker] *, #tab-overview .mac-picker *, ' +
        '#tab-schedules .card:has(#sMacs) select option, ' +
        '#tab-schedules form:has(#sMacs) select option, ' +
        '#sMacPicker option, #sMacPicker button, #sMacPicker .chip, ' +
        '#tab-schedules [data-mac-picker] *, #tab-schedules .mac-picker *, ' +
        'datalist option'
      ).filter({ hasText: 'Maya Tablet' });
      assert.ok((await pickerOption.count()) >= 1, 'Expected renamed device alias "Maya Tablet" in Quota/Schedule MAC picker');

      await srv.engine.listDevices();
      await srv.engine.pauseDevice(SYNTHETIC_MACS[1], 30, 'Check reason');
      const verdict = srv.engine.evaluateDnsQuery('example.org', '192.0.2.11');
      assert.equal(verdict.blocked, true);
      assert.match(verdict.reason, /Maya Tablet/);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 3', 'T3-09', 'Exhausted quota +30m bonus unblocks device on router and Overview', async (browser) => {
  const { todayKey } = await import('../src/state.js');
  await withApp({
    setupCompleted: true,
    seedState: (st) => {
      st.quotas.push({
        id: 'bonus-unblock',
        name: 'Bonus Unblock Q',
        macs: [SYNTHETIC_MACS[0]],
        dailyLimitSeconds: 5400,
        enabled: true,
        usageByDate: { [todayKey()]: { usedSeconds: 5400, bonusSeconds: 0, blockedToday: true } }
      });
    }
  }, async ({ srv, adapter }) => {
    await srv.engine.tick();
    assert.equal(adapter.blocked.has(SYNTHETIC_MACS[0]), true);

    const sess = await openTrackedPage(browser, srv.url);
    try {
      await sess.page.locator('#quotasList button:first-of-type').click();
      await sess.page.waitForFunction(() => /30m\s+left/i.test(document.querySelector('#quotasList')?.textContent || ''));
      assert.equal(adapter.blocked.has(SYNTHETIC_MACS[0]), false, '+30m bonus must unblock device on router');
      assert.match(await (await findDeviceRow(sess.page, 'Kids-Gaming-PC')).textContent(), /ONLINE/i);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 3', 'T3-10', 'Setup pollIntervalSec change restarts daemon interval cleanly (enableDaemon: true)', async (browser) => {
  await withApp({ setupCompleted: true, enableDaemon: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await switchTab(sess.page, 'setup');
      const pollInput = sess.page.locator('#setupPollInterval, #setupPoll, input[name="pollIntervalSec"]').first();
      await pollInput.fill('15');
      const prevTimer = srv.engine._daemonTimer;
      await sess.page.click('#saveSetupBtn');
      await sess.page.waitForFunction(() => {
        const t = document.querySelector('#setupResult')?.textContent || '';
        return /\b(OK|Connected|Saved|Ready)\b/i.test(t) && !/\b(WARN|fail|failed|error|refused)\b/i.test(t);
      });
      assert.equal(srv.engine.store.load().router.pollIntervalSec, 15);
      assert.ok(srv.engine._daemonTimer && srv.engine._daemonTimer !== prevTimer, 'Expected daemon timer to restart with updated interval');
      const stateRes = await apiJson(srv.url, '/api/state');
      assert.equal(stateRes.status, 200);
      assert.equal(stateRes.json?.daemon?.pollIntervalSec, 15, 'Expected GET /api/state daemon.pollIntervalSec === 15');
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

// ===========================================================================
// TIER 4: REAL-WORLD HOUSEHOLD WORKFLOWS + 4x4 VISUAL/LAYOUT MATRIX
// ===========================================================================

register('Tier 4', 'T4-01', 'New parent first-run onboarding (Desktop 1440x900)', async (browser) => {
  await withApp({ setupCompleted: false }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url, { width: 1440, height: 900 });
    try {
      await sess.page.locator('#tab-setup').waitFor({ state: 'visible' });
      const waitDetect = sess.page.waitForResponse((r) => r.url().includes('/api/router/detect'), { timeout: 7000 });
      await sess.page.click('#detectBtn');
      await waitDetect;

      await sess.page.selectOption('#setupDriver', 'att-bgw');
      assert.equal(await sess.page.locator('#setupPass').isVisible(), true);
      assert.equal(await sess.page.locator('#setupUser').isVisible(), false);

      await sess.page.selectOption('#setupDriver', 'universal');
      const pollInput = sess.page.locator('#setupPollInterval, #setupPoll, input[name="pollIntervalSec"]').first();
      await pollInput.fill('30');
      await sess.page.click('#saveSetupBtn');
      await sess.page.waitForFunction(() => {
        const t = document.querySelector('#setupResult')?.textContent || '';
        return /\b(OK|Connected|Saved|Ready)\b/i.test(t) && !/\b(WARN|fail|failed|error|refused)\b/i.test(t);
      });

      await switchTab(sess.page, 'overview');
      await setDeviceAliasAndPin(sess.page, 'Kids-Gaming-PC', { alias: 'Alex Desktop', togglePin: true });
      await sess.page.reload({ waitUntil: 'domcontentloaded' });
      const topRow = sess.page.locator('#devicesList .row').first();
      await topRow.filter({ hasText: 'Alex Desktop' }).waitFor();

      await topRow.getByRole('button', { name: /set quota/i }).click();
      await sess.page.fill('#qName', 'Alex Weekday Quota');
      await sess.page.fill('#qLimit', '1h30m');
      await sess.page.click('#addQuotaBtn');
      await sess.page.locator('#quotasList .row').filter({ hasText: 'Alex Weekday Quota' }).waitFor();

      const audit = await findAuditSection(sess.page);
      const auditTxt = await audit.textContent();
      assert.match(auditTxt, /SETUP/);
      assert.match(auditTxt, /QUOTA_SET/);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 4', 'T4-02', 'School night bedtime & homework reward loop (Desktop 1440x900)', async (browser) => {
  const win = currentActiveWindow();
  const { todayKey } = await import('../src/state.js');
  await withApp({
    setupCompleted: true,
    seedState: (st) => {
      st.quotas.push({
        id: 'homework-q',
        name: 'Study iPad Quota',
        macs: [SYNTHETIC_MACS[1]],
        dailyLimitSeconds: 3600,
        enabled: true,
        usageByDate: { [todayKey()]: { usedSeconds: 3600, bonusSeconds: 0, blockedToday: true } }
      });
    }
  }, async ({ srv, adapter }) => {
    const sess = await openTrackedPage(browser, srv.url, { width: 1440, height: 900 });
    try {
      await createScheduleInUi(sess.page, {
        name: 'School Night',
        macs: SYNTHETIC_MACS[1],
        days: [todayDayName()],
        startTime: win.startTime,
        endTime: win.endTime
      });
      await switchTab(sess.page, 'overview');
      assert.match(await (await findDeviceRow(sess.page, 'Study-iPad')).textContent(), /BLOCKED/i);
      assert.equal(adapter.blocked.has(SYNTHETIC_MACS[1]), true);

      // Homework +30m reward clears quota lock, still blocked by schedule until schedule disabled
      await sess.page.locator('#quotasList button:first-of-type').click();
      await sess.page.waitForFunction(() => /30m\s+left/i.test(document.querySelector('#quotasList')?.textContent || ''));
      assert.equal(adapter.blocked.has(SYNTHETIC_MACS[1]), true);

      await switchTab(sess.page, 'schedules');
      const sRow = sess.page.locator('#schedulesList .row').filter({ hasText: 'School Night' }).first();
      await sRow.getByRole('button', { name: /\b(disable|off|toggle)\b/i }).first().click();
      await sess.page.waitForFunction(() => /\b(OFF|DISABLED)\b/i.test(document.querySelector('#schedulesList')?.textContent || ''));
      assert.equal(adapter.blocked.has(SYNTHETIC_MACS[1]), false);

      await sRow.getByRole('button', { name: /delete/i }).click();
      await sess.page.waitForFunction(() => !/School Night/.test(document.querySelector('#schedulesList')?.textContent || ''));
      assert.equal(adapter.blocked.has(SYNTHETIC_MACS[1]), false);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 4', 'T4-03', 'Distraction-free study mode via DNS Sinkhole on Tablet 768x1024', async (browser) => {
  await withApp({ setupCompleted: true, useMockUpstream: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url, { width: 768, height: 1024 });
    try {
      const ov1 = await auditOverflow(sess.page, { checkTabletStats2x2: true });
      assert.deepEqual(ov1.errors, []);

      await switchTab(sess.page, 'dns');
      for (const idx of [1, 2, 4]) {
        await sess.page.click(`#catChips .chip:nth-child(${idx})`);
        await sess.page.waitForFunction((i) => document.querySelector(`#catChips .chip:nth-child(${i})`)?.classList.contains('on'), idx);
      }
      await sess.page.fill('#customDomain', 'custom-distraction.example');
      await sess.page.click('#blockDomainBtn');
      await sess.page.waitForFunction(() => /custom-distraction\.example/.test(document.querySelector('#tab-dns')?.textContent || ''));

      await sess.page.fill('#testDomain', 'roblox.com');
      await sess.page.click('#testDnsBtn');
      await sess.page.waitForFunction(() => /0\.0\.0\.0/.test(document.querySelector('#dnsTestOut')?.textContent || ''));
      assert.match(await sess.page.locator('#dnsLogList').textContent(), /roblox\.com/);

      const customItem = sess.page.locator(CUSTOM_DOMAIN_CONTAINER_SELECTOR)
        .filter({ hasText: 'custom-distraction.example' })
        .filter({ has: sess.page.getByRole('button', { name: /unblock|remove|delete/i }) })
        .first();
      await customItem.getByRole('button', { name: /unblock|remove|delete/i }).click();
      await sess.page.waitForFunction(() => !/custom-distraction\.example/.test(document.querySelector('#tab-dns')?.textContent || ''));
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 4', 'T4-04', 'Quick dinner-time phone intervention (375x812)', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv, adapter }) => {
    const sess = await openTrackedPage(browser, srv.url, { width: 375, height: 812 });
    try {
      await pauseDeviceInUi(sess.page, 'Living-Room-TV', '1h');
      await pauseDeviceInUi(sess.page, 'Kids-Gaming-PC', '1h');
      await sess.page.waitForFunction(() => /2\s+blocked/i.test(document.querySelector('#statBlocked')?.textContent || ''));
      assert.equal(adapter.blocked.has(SYNTHETIC_MACS[2]), true);
      assert.equal(adapter.blocked.has(SYNTHETIC_MACS[0]), true);

      await createScheduleInUi(sess.page, { name: 'Weekend Bedtime', macs: SYNTHETIC_MACS[0], days: ['Fri', 'Sat'], startTime: '22:30', endTime: '08:00' });
      await switchTab(sess.page, 'overview');
      const tvRow = await findDeviceRow(sess.page, 'Living-Room-TV');
      await tvRow.getByRole('button', { name: /resume/i }).click();
      await tvRow.getByRole('button', { name: /pause/i }).first().waitFor({ state: 'visible' });
      assert.equal(adapter.blocked.has(SYNTHETIC_MACS[2]), false);

      const audit = await findAuditSection(sess.page);
      const auditTxt = await audit.textContent();
      assert.match(auditTxt, /RESUME/);
      assert.match(auditTxt, /PAUSE/);
      assert.match(auditTxt, /SCHEDULE_SET/);

      const geo = await auditGeometry(sess.page, { mobile: true });
      assert.deepEqual(geo.errors, []);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 4', 'T4-05', 'Power-user custom router hook migration + error recovery', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url, { width: 1440, height: 900 });
    try {
      await switchTab(sess.page, 'setup');
      await sess.page.selectOption('#setupDriver', 'custom');
      await sess.page.fill('#setupGateway', 'not-a-url');
      await sess.page.fill('#setupBlockCmd', 'echo block {{mac}}');

      await sess.withExpectedClientError(async () => {
        await sess.page.click('#saveSetupBtn');
        await sess.page.waitForFunction(() => /invalid|error|http|url/i.test(
          (document.querySelector('#setupResult')?.textContent || '') + ' ' + (document.querySelector('#toast')?.textContent || '')
        ));
      });
      // Form input must NOT be wiped on 400 validation error
      assert.equal(await sess.page.inputValue('#setupBlockCmd'), 'echo block {{mac}}');

      await sess.page.fill('#setupGateway', 'http://127.0.0.1');
      await sess.page.fill('#setupUnblockCmd', 'echo unblock {{mac}}');
      const listInput = sess.page.locator('#setupListCmd, input[name="listCmd"]').first();
      await listInput.fill('echo []');
      const pollInput = sess.page.locator('#setupPollInterval, #setupPoll, input[name="pollIntervalSec"]').first();
      await pollInput.fill('20');
      await sess.page.click('#saveSetupBtn');
      await sess.page.waitForFunction(() => /\b(OK|WARN|Connected|Saved)\b/i.test(document.querySelector('#setupResult')?.textContent || ''));

      await sess.page.reload({ waitUntil: 'domcontentloaded' });
      await switchTab(sess.page, 'setup');
      assert.equal(await sess.page.inputValue('#setupBlockCmd'), 'echo block {{mac}}');
      assert.equal(await sess.page.inputValue('#setupUnblockCmd'), 'echo unblock {{mac}}');
      assert.equal(await listInput.inputValue(), 'echo []');
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 4', 'T4-MATRIX', 'Full 4-tab x 4-viewport visual/layout capture matrix (16 screenshots)', async (browser, { screenshotDir }) => {
  const { todayKey } = await import('../src/state.js');
  const runMatrix = async (baseUrl) => {
    for (const vp of VIEWPORTS) {
      const sess = await openTrackedPage(browser, baseUrl, { width: vp.width, height: vp.height });
      try {
        for (const tab of TABS) {
          await switchTab(sess.page, tab);
          await sess.page.waitForTimeout(100);
          const col = await auditColors(sess.page);
          assert.deepEqual(col.violations, [], `Color violation (${vp.name}/${tab}): ${col.violations.join('; ')}`);
          const ov = await auditOverflow(sess.page, { checkTabletStats2x2: vp.tablet && tab === 'overview' });
          assert.deepEqual(ov.errors, [], `Overflow (${vp.name}/${tab}): ${ov.errors.join('; ')}`);
          const geo = await auditGeometry(sess.page, { mobile: vp.mobile });
          assert.deepEqual(geo.errors, [], `Geometry (${vp.name}/${tab}): ${geo.errors.join('; ')}`);

          const shotPath = path.join(screenshotDir, `${vp.name}-${tab}.png`);
          await sess.page.screenshot({ path: shotPath, fullPage: true });
          assert.ok(fs.statSync(shotPath).size > 1000, `Screenshot empty: ${shotPath}`);
        }
        sess.assertCleanRuntime();
      } finally {
        await sess.close();
      }
    }
  };

  if (EXTERNAL_BASE_URL) {
    await runMatrix(EXTERNAL_BASE_URL);
    return;
  }

  await withApp({
    setupCompleted: true,
    seedState: (st) => {
      st.quotas.push({
        id: 'matrix-q',
        name: 'Kids Weekday Quota',
        macs: [SYNTHETIC_MACS[0]],
        dailyLimitSeconds: 5400,
        enabled: true,
        usageByDate: { [todayKey()]: { usedSeconds: 1800, bonusSeconds: 0, blockedToday: false } }
      });
      st.schedules.push({
        id: 'matrix-s',
        name: 'School Night Bedtime',
        days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu'],
        startTime: '21:00',
        endTime: '07:00',
        enabled: true,
        targetMacs: [SYNTHETIC_MACS[0], SYNTHETIC_MACS[1]]
      });
      st.blockedCategories = ['youtube', 'roblox'];
      st.blockedDomains = [
        ...CATEGORY_PRESETS.youtube.domains.map((d) => ({ domain: d, category: 'youtube', enabled: true })),
        ...CATEGORY_PRESETS.roblox.domains.map((d) => ({ domain: d, category: 'roblox', enabled: true })),
        { domain: 'custom-focus.example', category: 'custom', enabled: true }
      ];
    }
  }, async ({ srv }) => {
    srv.dnsSinkhole.queryLog.unshift({
      id: 'matrix-dns-1',
      ts: new Date().toISOString(),
      clientIp: '192.0.2.10',
      domain: 'roblox.com',
      qtype: 'A',
      action: 'BLOCKED',
      reason: 'Blocked domain (roblox.com)'
    });
    await runMatrix(srv.url);
  });
}, { requiresInProcess: false });

// ===========================================================================
// TIER 5: ADVERSARIAL HARDENING REGRESSIONS
// ===========================================================================

register('Tier 5', 'T5-01', 'Coalescing reload queue + mutationSeq prevents stale GET /api/state from reverting pause or stranding pending-* quota', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      // Wait for initial load() to finish before intercepting subsequent /api/state calls
      await sess.page.waitForFunction(() => document.querySelectorAll('#devicesList .row').length === 3);

      let stateCallCount = 0;
      let heldStateReachedResolve = null;
      const heldStateReached = new Promise((r) => { heldStateReachedResolve = r; });
      let releaseHeldState = null;

      await sess.page.route('**/api/state', async (route) => {
        stateCallCount++;
        if (stateCallCount === 1) {
          const response = await route.fetch();
          const body = await response.text();
          heldStateReachedResolve();
          await new Promise((r) => { releaseHeldState = r; });
          await route.fulfill({ response, body });
          return;
        }
        await route.continue();
      });

      // Start slow refresh GET /api/state (intercepted #1)
      await sess.page.click('#refreshBtn');
      await heldStateReached;

      // Mutate 1: Pause Kids-Gaming-PC while GET #2 is in flight
      const pauseRespP = sess.page.waitForResponse((r) => r.url().includes('/api/devices/pause') && r.status() === 200);
      const pcRow = await findDeviceRow(sess.page, 'Kids-Gaming-PC');
      await pcRow.getByRole('button', { name: /pause/i }).click();
      await pauseRespP;

      // Mutate 2: Add Daily Quota while GET #2 is still in flight
      const quotaRespP = sess.page.waitForResponse((r) => r.url().includes('/api/quotas') && r.request().method() === 'POST' && r.status() === 200);
      await sess.page.fill('#qName', 'Race Quota');
      await sess.page.fill('#qMacs', SYNTHETIC_MACS[1]);
      await sess.page.fill('#qLimit', '30m');
      await sess.page.click('#addQuotaBtn');
      await quotaRespP;

      // Release stale pre-mutation GET #2
      releaseHeldState();

      // Verify coalesced fresh GET rendered real state: Kids-Gaming-PC stays paused, Race Quota gets real server ID
      await sess.page.waitForFunction(() => {
        const qRow = document.querySelector('#quotasList .row[data-quota-id="race-quota"]');
        const blocked = document.querySelector('#statBlocked')?.textContent || '';
        return Boolean(qRow) && /1\s+blocked\s+now/i.test(blocked);
      });

      const pcRowAfter = await findDeviceRow(sess.page, 'Kids-Gaming-PC');
      assert.match(await pcRowAfter.textContent(), /BLOCKED/i);
      await pcRowAfter.getByRole('button', { name: /resume/i }).waitFor({ state: 'visible' });

      assert.equal(await sess.page.locator('#quotasList .row[data-quota-id^="pending-"]').count(), 0);
      const raceCard = sess.page.locator('#quotasList .row[data-quota-id="race-quota"]');
      assert.equal(await raceCard.count(), 1);

      // Deleting Race Quota must succeed with HTTP 200 (not 404 on pending-*)
      const delRespP = sess.page.waitForResponse((r) => r.url().includes('/api/quotas/race-quota') && r.request().method() === 'DELETE');
      await raceCard.getByRole('button', { name: /delete/i }).click();
      const delResp = await delRespP;
      assert.equal(delResp.status(), 200);
      await sess.page.waitForFunction(() => document.querySelectorAll('#quotasList .row').length === 0);

      await sess.page.unroute('**/api/state');
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 5', 'T5-02', 'Open inline Rename editor preserves draft while Pausing another device updates #devicesList immediately', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      const pcRow = await findDeviceRow(sess.page, 'Kids-Gaming-PC');
      await pcRow.getByRole('button', { name: /rename/i }).click();
      const aliasInput = pcRow.locator('input[data-role="alias-input"]');
      await aliasInput.fill('Draft Gaming Rig');

      // Pause second device while Rename editor is open on first device
      const ipadRow = await findDeviceRow(sess.page, 'Study-iPad');
      await ipadRow.getByRole('button', { name: /pause/i }).click();

      await ipadRow.getByRole('button', { name: /resume/i }).waitFor({ state: 'visible' });
      assert.match(await ipadRow.textContent(), /BLOCKED/i);
      assert.match(await sess.page.locator('#statBlocked').textContent(), /1\s+blocked\s+now/i);

      // Open Rename draft on device 1 must still be intact
      const preservedInput = (await findDeviceRow(sess.page, 'Kids-Gaming-PC')).locator('input[data-role="alias-input"]');
      assert.equal(await preservedInput.inputValue(), 'Draft Gaming Rig');

      // Save the open Rename draft and verify it persists
      await (await findDeviceRow(sess.page, 'Kids-Gaming-PC')).getByRole('button', { name: /save/i }).click();
      await (await findDeviceRow(sess.page, 'Draft Gaming Rig')).waitFor({ state: 'visible' });
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 5', 'T5-03', 'Duplicate Quota and Schedule names in Add mode create distinct cards without overwriting', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      // Add two quotas with identical name for different MACs
      await sess.page.fill('#qName', 'Kids Screen Time');
      await sess.page.fill('#qMacs', SYNTHETIC_MACS[0]);
      await sess.page.fill('#qLimit', '1h');
      await sess.page.click('#addQuotaBtn');
      await sess.page.waitForFunction(() => document.querySelectorAll('#quotasList .row').length === 1);

      await sess.page.fill('#qName', 'Kids Screen Time');
      await sess.page.fill('#qMacs', SYNTHETIC_MACS[1]);
      await sess.page.fill('#qLimit', '2h');
      await sess.page.click('#addQuotaBtn');
      await sess.page.waitForFunction(() => document.querySelectorAll('#quotasList .row').length === 2);

      const quotaIds = await sess.page.locator('#quotasList .row').evaluateAll((els) => els.map((e) => e.dataset.quotaId));
      assert.equal(new Set(quotaIds).size, 2, 'Duplicate quota names in Add mode must generate distinct IDs');

      // Add two schedules with identical name for different MACs
      await createScheduleInUi(sess.page, {
        name: 'Bedtime',
        macs: SYNTHETIC_MACS[0],
        days: ['Mon', 'Tue'],
        startTime: '21:00',
        endTime: '07:00'
      });
      await sess.page.waitForFunction(() => document.querySelectorAll('#schedulesList .row').length === 1);

      await createScheduleInUi(sess.page, {
        name: 'Bedtime',
        macs: SYNTHETIC_MACS[1],
        days: ['Wed', 'Thu'],
        startTime: '22:00',
        endTime: '07:00'
      });
      await sess.page.waitForFunction(() => document.querySelectorAll('#schedulesList .row').length === 2);

      const schedIds = await sess.page.locator('#schedulesList .row').evaluateAll((els) => els.map((e) => e.dataset.schedId));
      assert.equal(new Set(schedIds).size, 2, 'Duplicate schedule names in Add mode must generate distinct IDs');

      // Reload and confirm all 4 rules persist
      await sess.page.reload({ waitUntil: 'domcontentloaded' });
      assert.equal(await sess.page.locator('#quotasList .row').count(), 2);
      await switchTab(sess.page, 'schedules');
      assert.equal(await sess.page.locator('#schedulesList .row').count(), 2);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 5', 'T5-04', 'Switching #setupDriver clears masked #setupPass from previous driver', async (browser) => {
  await withApp({
    setupCompleted: true,
    seedState: (st) => {
      st.router.driver = 'openwrt';
      st.router.gatewayUrl = 'http://192.0.2.1';
      st.router.username = 'root';
      st.router.password = 'openwrt-secret';
    }
  }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      await switchTab(sess.page, 'setup');
      assert.equal(await sess.page.inputValue('#setupPass'), '••••••••');

      await sess.page.selectOption('#setupDriver', 'att-bgw');
      assert.equal(await sess.page.inputValue('#setupPass'), '', 'Switching to different driver must clear masked password');

      await sess.page.selectOption('#setupDriver', 'openwrt');
      assert.equal(await sess.page.inputValue('#setupPass'), '••••••••', 'Switching back to saved driver restores masked placeholder');

      await sess.page.selectOption('#setupDriver', 'asuswrt');
      assert.equal(await sess.page.inputValue('#setupPass'), '', 'Switching to asuswrt must clear masked password');
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

register('Tier 5', 'T5-05', 'Quick-pick MAC chips normalize uppercase hyphen and Cisco dot MACs without duplicates', async (browser) => {
  await withApp({ setupCompleted: true }, async ({ srv }) => {
    const sess = await openTrackedPage(browser, srv.url);
    try {
      const firstChip = sess.page.locator(`#qDevicePicker .mac-pill[data-mac="${SYNTHETIC_MACS[0]}"]`);
      const secondChip = sess.page.locator(`#qDevicePicker .mac-pill[data-mac="${SYNTHETIC_MACS[1]}"]`);

      // Uppercase hyphenated MAC
      await sess.page.fill('#qMacs', 'AA-BB-CC-11-22-01');
      assert.equal(await firstChip.getAttribute('aria-pressed'), 'true');
      await firstChip.click();
      assert.equal(await sess.page.inputValue('#qMacs'), '');
      assert.equal(await firstChip.getAttribute('aria-pressed'), 'false');

      // Cisco dot MAC
      await sess.page.fill('#qMacs', 'aabb.cc11.2202');
      assert.equal(await secondChip.getAttribute('aria-pressed'), 'true');
      await secondChip.click();
      assert.equal(await sess.page.inputValue('#qMacs'), '');
      assert.equal(await secondChip.getAttribute('aria-pressed'), 'false');

      // Mixed formats stay deduplicated
      await sess.page.fill('#qMacs', 'AA-BB-CC-11-22-01, aabb.cc11.2202');
      assert.equal(await firstChip.getAttribute('aria-pressed'), 'true');
      assert.equal(await secondChip.getAttribute('aria-pressed'), 'true');
      await firstChip.click();
      assert.equal(await sess.page.inputValue('#qMacs'), SYNTHETIC_MACS[1]);
      sess.assertCleanRuntime();
    } finally {
      await sess.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Self-Check Mode (--self-check): Verifies Playwright launch + DOM measurement utilities
// ---------------------------------------------------------------------------

async function runSelfCheck(browser, screenshotDir) {
  console.log('Running --self-check against isolated synthetic fixture...');
  const fixtureHtml = `<!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { margin: 0; background: #fbfaf7; color: #141414; font-family: sans-serif; }
      header { padding: 12px 16px; border-bottom: 1px solid #e4e1d8; }
      main { padding: 16px; }
      .stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-bottom: 16px; }
      .card { background: #ffffff; border: 1px solid #e4e1d8; border-radius: 10px; padding: 14px; }
      .controls { display: flex; flex-wrap: wrap; gap: 8px; }
      button, input { min-height: 44px; min-width: 44px; font-size: 16px; padding: 8px 12px; border: 1px solid #e4e1d8; background: #ffffff; color: #141414; border-radius: 6px; }
      .bad-purple { color: #7c3aed; }
    </style>
  </head>
  <body>
    <header><h1>curfewd self-check</h1></header>
    <main>
      <section class="stats">
        <div class="card">1</div><div class="card">2</div>
        <div class="card">3</div><div class="card">4</div>
      </section>
      <div class="controls">
        <button type="button" id="b1">Action One</button>
        <button type="button" id="b2">Action Two</button>
        <input type="text" id="i1" value="sample" />
      </div>
    </main>
  </body>
  </html>`;

  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fixtureHtml);
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${srv.address().port}`;

  try {
    const context = await browser.newContext({ viewport: { width: 768, height: 1024 } });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const col = await auditColors(page);
    // Notice .bad-purple is in <style>, so auditColors MUST catch it!
    assert.ok(col.violations.some((v) => v.includes('#7c3aed')), 'auditColors must detect purple token');

    const ov = await auditOverflow(page, { checkTabletStats2x2: true });
    assert.deepEqual(ov.errors, [], `Expected clean 2x2 overflow audit, got: ${ov.errors.join('; ')}`);

    await page.setViewportSize({ width: 375, height: 812 });
    const geo = await auditGeometry(page, { mobile: true });
    assert.deepEqual(geo.errors, [], `Expected clean mobile geometry audit, got: ${geo.errors.join('; ')}`);

    const shot = path.join(screenshotDir, 'self-check.png');
    await page.screenshot({ path: shot });
    assert.ok(fs.statSync(shot).size > 500);

    await context.close();
    console.log('PASS --self-check: Playwright launch, auditColors, auditOverflow, auditGeometry, screenshot verified.');
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
}

// ---------------------------------------------------------------------------
// Main Execution
// ---------------------------------------------------------------------------

async function runWithTimeout(fn, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms: ${label}`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const pw = await loadPlaywright();
  const browser = await launchChromium(pw);

  const userShotDir = process.env.SCREENSHOT_DIR ? path.resolve(process.env.SCREENSHOT_DIR) : null;
  const screenshotDir = userShotDir || makeTempDir('curfewd-e2e-shots-');
  fs.mkdirSync(screenshotDir, { recursive: true });

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let preserveShots = Boolean(userShotDir) || process.env.KEEP_SCREENSHOTS === '1';

  try {
    if (SELF_CHECK) {
      await runSelfCheck(browser, screenshotDir);
      return;
    }

    const activeTests = tests.filter((t) => {
      if (EXTERNAL_BASE_URL && t.requiresInProcess) {
        skipped++;
        return false;
      }
      return !(FILTER && !`${t.id} ${t.name}`.toLowerCase().includes(FILTER));
    });

    if (FILTER && activeTests.length === 0) {
      console.error(`No E2E tests matched E2E_FILTER="${process.env.E2E_FILTER}"`);
      process.exitCode = 1;
      return;
    }

    console.log(`Running ${activeTests.length} E2E tests (screenshots -> ${screenshotDir})...`);

    for (const t of activeTests) {
      const t0 = Date.now();
      try {
        await runWithTimeout(() => t.fn(browser, { screenshotDir }), 15000, `${t.id} ${t.name}`);
        passed++;
        console.log(`  PASS [${t.tier}] ${t.id} — ${t.name} (${Date.now() - t0}ms)`);
      } catch (err) {
        failed++;
        const msg = String(err?.message || err).split('\n')[0];
        console.error(`  FAIL [${t.tier}] ${t.id} — ${t.name} (${Date.now() - t0}ms)\n       ${msg}`);
      }
    }

    console.log(`\nSummary: ${passed} passed, ${failed} failed, ${skipped} skipped (total ${activeTests.length})`);
    if (failed > 0) {
      console.log(`Screenshots preserved at: ${screenshotDir}`);
      preserveShots = true;
      process.exitCode = 1;
    }
  } finally {
    if (!preserveShots) {
      fs.rmSync(screenshotDir, { recursive: true, force: true });
    }
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error('Fatal E2E runner error:', err);
  process.exit(1);
});
