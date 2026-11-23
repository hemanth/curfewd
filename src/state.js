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
  const cleaned = mac.trim().toLowerCase().replace(/-/g, ':');
  const parts = cleaned.split(':');
  if (parts.length !== 6) return cleaned;
  return parts.map((p) => p.padStart(2, '0')).join(':');
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
      fs.writeFileSync(this.stateFile, JSON.stringify(initial, null, 2), { mode: 0o600 });
    }
  }

  load() {
    this.ensure();
    const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    const base = createInitialState();
    const state = {
      ...base,
      ...raw,
      router: { ...base.router, ...(raw.router || {}) },
      dns: { ...base.dns, ...(raw.dns || {}) },
      web: { ...base.web, ...(raw.web || {}) },
      aliases: raw.aliases || {},
      pinnedMacs: Array.isArray(raw.pinnedMacs) ? raw.pinnedMacs.map(normalizeMac) : [],
      pausedDevices: raw.pausedDevices || {},
      quotas: Array.isArray(raw.quotas) ? raw.quotas : [],
      schedules: Array.isArray(raw.schedules) ? raw.schedules : [],
      blockedCategories: Array.isArray(raw.blockedCategories) ? raw.blockedCategories : [],
      blockedDomains: Array.isArray(raw.blockedDomains) ? raw.blockedDomains : [],
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
    const tmp = `${this.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.stateFile);
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
