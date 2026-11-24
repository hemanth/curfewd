import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function resolveHomeDir(overrideDir) {
  return path.resolve(
    overrideDir ||
      process.env.CURFEWD_HOME ||
      path.join(os.homedir(), '.curfewd')
  );
}

export function normalizeMac(mac) {
  if (!mac || typeof mac !== 'string') return '';
  const trimmed = mac.trim().toLowerCase();
  if (/^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/.test(trimmed)) {
    return trimmed.replace(/\./g, '').match(/.{2}/g).join(':');
  }
  if (/^([0-9a-f]{1,2})([:-])(?:[0-9a-f]{1,2}\2){4}[0-9a-f]{1,2}$/.test(trimmed)) {
    return trimmed.replace(/-/g, ':').split(':').map((p) => p.padStart(2, '0')).join(':');
  }
  return '';
}

export function isValidMac(mac) {
  return normalizeMac(mac) !== '';
}

export function todayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function parseDurationMinutes(input) {
  if (typeof input === 'number' && Number.isFinite(input) && input >= 0) {
    return Math.round(input);
  }
  const str = String(input || '').trim().toLowerCase();
  if (!str) return null;
  if (/^\d+$/.test(str)) return Number(str);
  const hhmm = str.match(/^(\d+):(\d{1,2})$/);
  if (hhmm) return Number(hhmm[1]) * 60 + Number(hhmm[2]);
  const hm = str.match(/^(?:(\d+(?:\.\d+)?)h)?\s*(?:(\d+(?:\.\d+)?)m)?$/);
  if (hm && (hm[1] || hm[2])) {
    return Math.round((Number(hm[1] || 0) * 60) + Number(hm[2] || 0));
  }
  return null;
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  if (m > 0) return `${m}m`;
  return `${rem}s`;
}

export function createInitialState() {
  return {
    version: 1,
    setupCompleted: false,
    router: {
      driver: 'universal',
      gatewayUrl: 'http://192.168.1.1',
      username: '',
      password: '',
      blockCmd: '',
      unblockCmd: '',
      listCmd: '',
      pollIntervalSec: 60
    },
    dns: {
      enabled: true,
      port: 5354,
      upstream: '1.1.1.1'
    },
    web: {
      port: 4320
    },
    aliases: {},
    pinnedMacs: [],
    pausedDevices: {},
    quotas: [],
    schedules: [],
    blockedCategories: [],
    blockedDomains: [],
    customBlockedDomains: [],
    enforcedBlocks: [],
    pendingUnblockMacs: [],
    auditLog: []
  };
}

export class StateStore {
  constructor(homeDir) {
    this.homeDir = resolveHomeDir(homeDir);
    this.stateFile = path.join(this.homeDir, 'state.json');
  }

  ensure() {
    if (!fs.existsSync(this.homeDir)) {
      fs.mkdirSync(this.homeDir, { recursive: true, mode: 0o700 });
    }
    if (!fs.existsSync(this.stateFile)) {
      const initial = createInitialState();
      const tmp = `${this.stateFile}.${process.pid}.init.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(initial, null, 2), { mode: 0o600 });
        if (!fs.existsSync(this.stateFile)) {
          fs.renameSync(tmp, this.stateFile);
        } else {
          try { fs.unlinkSync(tmp); } catch {}
        }
      } catch (err) {
        try { fs.unlinkSync(tmp); } catch {}
        if (!fs.existsSync(this.stateFile)) throw err;
      }
    }
  }

  load() {
    this.ensure();
    const text = fs.readFileSync(this.stateFile, 'utf8');
    let raw;
    let corrupt = false;
    try {
      raw = JSON.parse(text);
    } catch {
      corrupt = true;
    }
    if (!corrupt && (!raw || typeof raw !== 'object' || Array.isArray(raw))) {
      corrupt = true;
    }
    if (corrupt) {
      if (text.trim().length > 0) {
        const backupPath = `${this.stateFile}.corrupt.${Date.now()}`;
        try {
          fs.writeFileSync(backupPath, text, { mode: 0o600 });
        } catch {}
      }
      console.warn('[curfewd] Corrupt or invalid state.json detected; resetting to initial state');
      const initial = createInitialState();
      this.save(initial);
      return initial;
    }

    const base = createInitialState();
    const rawAliases = raw.aliases && typeof raw.aliases === 'object' && !Array.isArray(raw.aliases) ? raw.aliases : {};
    const aliases = {};
    for (const [k, v] of Object.entries(rawAliases)) {
      const nk = normalizeMac(k);
      if (nk && v) aliases[nk] = String(v);
    }
    const rawPaused = raw.pausedDevices && typeof raw.pausedDevices === 'object' && !Array.isArray(raw.pausedDevices) ? raw.pausedDevices : {};
    const pausedDevices = {};
    for (const [k, v] of Object.entries(rawPaused)) {
      const nk = normalizeMac(k);
      if (nk && v && typeof v === 'object') {
        pausedDevices[nk] = { ...v, mac: nk };
      }
    }
    const blockedDomains = Array.isArray(raw.blockedDomains) ? raw.blockedDomains : [];
    const customFromRaw = Array.isArray(raw.customBlockedDomains)
      ? raw.customBlockedDomains.map((d) => String(d).toLowerCase().trim()).filter(Boolean)
      : [];
    const customFromBlocked = blockedDomains
      .filter((d) => d && (d.category === 'custom' || d.custom) && d.domain)
      .map((d) => String(d.domain).toLowerCase().trim())
      .filter(Boolean);
    const customBlockedDomains = [...new Set([...customFromRaw, ...customFromBlocked])];

    const rawRouter = raw.router && typeof raw.router === 'object' && !Array.isArray(raw.router) ? raw.router : {};
    const rawDns = raw.dns && typeof raw.dns === 'object' && !Array.isArray(raw.dns) ? raw.dns : {};
    const rawWeb = raw.web && typeof raw.web === 'object' && !Array.isArray(raw.web) ? raw.web : {};

    const state = {
      ...base,
      ...raw,
      router: { ...base.router, ...rawRouter },
      dns: { ...base.dns, ...rawDns },
      web: { ...base.web, ...rawWeb },
      aliases,
      pinnedMacs: Array.isArray(raw.pinnedMacs) ? [...new Set(raw.pinnedMacs.map(normalizeMac).filter(Boolean))] : [],
      pausedDevices,
      quotas: Array.isArray(raw.quotas) ? raw.quotas : [],
      schedules: Array.isArray(raw.schedules) ? raw.schedules : [],
      blockedCategories: Array.isArray(raw.blockedCategories) ? [...new Set(raw.blockedCategories)] : [],
      blockedDomains,
      customBlockedDomains,
      enforcedBlocks: Array.isArray(raw.enforcedBlocks) ? [...new Set(raw.enforcedBlocks.map(normalizeMac).filter(Boolean))] : [],
      pendingUnblockMacs: Array.isArray(raw.pendingUnblockMacs) ? [...new Set(raw.pendingUnblockMacs.map(normalizeMac).filter(Boolean))] : [],
      auditLog: Array.isArray(raw.auditLog) ? raw.auditLog : []
    };
    return state;
  }

  save(state) {
    this.ensure();
    state.auditLog = (state.auditLog || []).slice(0, 100);
    for (const q of state.quotas || []) {
      const keys = Object.keys(q.usageByDate || {}).sort();
      if (keys.length > 30) {
        for (const oldKey of keys.slice(0, keys.length - 30)) {
          delete q.usageByDate[oldKey];
        }
      }
    }
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.stateFile);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch {}
      throw err;
    }
    return state;
  }

  appendAudit(state, action, target, detail) {
    state.auditLog.unshift({
      ts: new Date().toISOString(),
      action,
      target: target || 'system',
      detail: detail || ''
    });
    return state;
  }

  redactForClient(state) {
    return {
      ...state,
      router: {
        ...state.router,
        password: state.router?.password ? '••••••••' : '',
        passwordConfigured: Boolean(state.router?.password)
      }
    };
  }
}
