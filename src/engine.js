import {
  StateStore,
  normalizeMac,
  isValidMac,
  todayKey,
  parseDurationMinutes,
  formatDuration
} from './state.js';
import { createAdapter } from './adapters/index.js';
import { CATEGORY_PRESETS } from './dns-sinkhole.js';

const MAX_TICK_CREDIT_SEC = 120;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAME_MAP = {
  sun: 'Sun',
  sunday: 'Sun',
  mon: 'Mon',
  monday: 'Mon',
  tue: 'Tue',
  tuesday: 'Tue',
  wed: 'Wed',
  wednesday: 'Wed',
  thu: 'Thu',
  thursday: 'Thu',
  fri: 'Fri',
  friday: 'Fri',
  sat: 'Sat',
  saturday: 'Sat'
};

function engineError(status, message) {
  return Object.assign(new Error(message), { status });
}

function parseMacList(input) {
  if (input === undefined || input === null) {
    throw engineError(400, 'At least one valid MAC address is required');
  }
  const rawList = Array.isArray(input) ? input : String(input).split(',');
  const tokens = rawList.map((x) => String(x ?? '').trim()).filter(Boolean);
  if (tokens.length === 0) {
    throw engineError(400, 'At least one valid MAC address is required');
  }
  const macs = [];
  for (const tok of tokens) {
    const mac = normalizeMac(tok);
    if (!mac) throw engineError(400, `Invalid MAC address: "${tok}"`);
    if (!macs.includes(mac)) macs.push(mac);
  }
  return macs;
}

function isValidTimeHHMM(value) {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(value ?? '').trim());
}

function normalizeDayToken(day) {
  if (typeof day === 'number' || /^\d+$/.test(String(day ?? '').trim())) {
    const idx = Number(day);
    if (Number.isInteger(idx) && idx >= 0 && idx <= 6) return DAY_NAMES[idx];
    return null;
  }
  const token = String(day ?? '').trim().toLowerCase();
  return Object.hasOwn(DAY_NAME_MAP, token) ? DAY_NAME_MAP[token] : null;
}

function normalizeScheduleDays(days) {
  if (days === undefined || days === null) {
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu'];
  }
  if (!Array.isArray(days) || days.length === 0) {
    throw engineError(400, 'Schedule days must be a non-empty array of days (0-6 or Sun-Sat)');
  }
  const out = [];
  for (const item of days) {
    const norm = normalizeDayToken(item);
    if (!norm) {
      throw engineError(400, `Invalid schedule day: "${item}" (use 0-6 or Sun-Sat)`);
    }
    if (!out.includes(norm)) out.push(norm);
  }
  return out;
}

function addUniqueMacs(arr, macs) {
  const set = new Set((arr || []).map(normalizeMac).filter(Boolean));
  for (const m of macs || []) {
    const nm = normalizeMac(m);
    if (nm) set.add(nm);
  }
  return [...set];
}

function isQuotaBlockedOnDate(q, dateStr) {
  if (!q || q.enabled === false) return false;
  const entry = q.usageByDate?.[dateStr];
  if (!entry) return false;
  const limitSec = (q.dailyLimitSeconds || 0) + (entry.bonusSeconds || 0);
  return Boolean(entry.blockedToday || (entry.usedSeconds || 0) >= limitSec);
}

export function isScheduleActiveNow(schedule, now = new Date()) {
  if (!schedule || !schedule.enabled) return false;
  const rawDays = Array.isArray(schedule.days) ? schedule.days : [];
  const days = rawDays.map(normalizeDayToken).filter(Boolean);
  const curDay = DAY_NAMES[now.getDay()];
  const prevDay = DAY_NAMES[(now.getDay() + 6) % 7];

  const startStr = String(schedule.startTime ?? '21:00').trim();
  const endStr = String(schedule.endTime ?? '07:00').trim();
  if (!isValidTimeHHMM(startStr) || !isValidTimeHHMM(endStr)) return false;

  const [sh, sm] = startStr.split(':').map(Number);
  const [eh, em] = endStr.split(':').map(Number);
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  const curMin = now.getHours() * 60 + now.getMinutes();

  if (startMin === endMin) return false;
  if (startMin < endMin) {
    return days.includes(curDay) && curMin >= startMin && curMin < endMin;
  }
  // Overnight window (e.g. 21:00 -> 07:00)
  return (days.includes(curDay) && curMin >= startMin) || (days.includes(prevDay) && curMin < endMin);
}

export class CurfewEngine {
  constructor({ homeDir, adapter } = {}) {
    this.store = new StateStore(homeDir);
    this._customAdapter = adapter || null;
    this._lastDevices = [];
    this._daemonTimer = null;
    this.lastDeviceError = null;
    this._lastTickAt = null;
    this._lastSyncSummary = null;
    this._previouslyBlockedMacs = new Set();
    this._tickQueue = Promise.resolve();
    this._stateWriteChain = Promise.resolve();
    this._macSyncQueues = new Map();
    this._macOpSeq = new Map();
  }

  runStateWrite(fn) {
    const next = this._stateWriteChain.then(fn, fn);
    this._stateWriteChain = next.catch(() => {});
    return next;
  }

  _runMacSync(mac, fn) {
    const key = normalizeMac(mac) || String(mac);
    const prev = this._macSyncQueues.get(key) || Promise.resolve();
    const run = prev.then(() => fn(), () => fn());
    const tail = run.catch(() => {});
    this._macSyncQueues.set(key, tail);
    tail.finally(() => {
      if (this._macSyncQueues.get(key) === tail) {
        this._macSyncQueues.delete(key);
      }
    });
    return run;
  }

  getAdapter(state = this.store.load()) {
    if (this._customAdapter) return this._customAdapter;
    return createAdapter(state.router);
  }

  async listDevices() {
    const state = this.store.load();
    const adapter = this.getAdapter(state);
    let rawDevices;
    try {
      rawDevices = await adapter.listDevices();
      this.lastDeviceError = null;
    } catch (err) {
      this.lastDeviceError = err.message || 'Device discovery failed';
      throw err;
    }

    const validRaw = (rawDevices || [])
      .map((d) => ({ ...d, mac: normalizeMac(d.mac) }))
      .filter((d) => Boolean(d.mac));
    this._lastDevices = validRaw;

    const dateStr = todayKey();
    const now = new Date();
    const nowMs = now.getTime();
    const devices = validRaw.map((d) => {
      const mac = d.mac;
      const alias = state.aliases?.[mac] || null;
      const rawPause = state.pausedDevices?.[mac] || null;
      const pause = rawPause && (!rawPause.expiresAt || rawPause.expiresAt > nowMs) ? rawPause : null;
      const matchingQuotas = (state.quotas || []).filter((q) => (q.macs || []).includes(mac));
      const blockedQuota = matchingQuotas.find((q) => isQuotaBlockedOnDate(q, dateStr)) || null;
      const quota = blockedQuota || matchingQuotas.find((q) => q.enabled !== false) || matchingQuotas[0] || null;
      const activeSchedule = (state.schedules || []).find(
        (s) => (s.targetMacs || []).includes(mac) && isScheduleActiveNow(s, now)
      ) || null;

      let quotaSummary = null;
      if (quota) {
        const entry = quota.usageByDate?.[dateStr] || { usedSeconds: 0, bonusSeconds: 0, blockedToday: false };
        const limitSec = quota.dailyLimitSeconds + (entry.bonusSeconds || 0);
        const blockedToday = isQuotaBlockedOnDate(quota, dateStr);
        quotaSummary = {
          id: quota.id,
          name: quota.name,
          enabled: quota.enabled !== false,
          usedSeconds: entry.usedSeconds || 0,
          limitSeconds: limitSec,
          remainingSeconds: Math.max(0, limitSec - (entry.usedSeconds || 0)),
          blockedToday,
          usedFormatted: formatDuration(entry.usedSeconds || 0),
          limitFormatted: formatDuration(limitSec),
          remainingFormatted: formatDuration(Math.max(0, limitSec - (entry.usedSeconds || 0)))
        };
      }

      const isBlocked = Boolean(pause || activeSchedule || blockedQuota);
      const baseName = d.name || d.ipv4 || mac;
      return {
        ...d,
        mac,
        name: baseName,
        alias,
        displayName: alias || baseName,
        isPinned: (state.pinnedMacs || []).includes(mac),
        isPaused: Boolean(pause),
        pauseInfo: pause,
        activeSchedule: activeSchedule ? { id: activeSchedule.id, name: activeSchedule.name } : null,
        quota: quotaSummary,
        isBlocked
      };
    });

    devices.sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      if ((a.status === 'online') !== (b.status === 'online')) return a.status === 'online' ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });
    return devices;
  }

  resolveTargetMac(query, devices = this._lastDevices) {
    const raw = String(query ?? '').trim();
    if (!raw) return null;
    if (isValidMac(raw)) return normalizeMac(raw);
    const q = raw.toLowerCase();
    const list = devices || [];
    const exact = list.find(
      (d) =>
        normalizeMac(d.mac) === q ||
        (d.ipv4 && d.ipv4.toLowerCase() === q) ||
        (d.displayName && d.displayName.toLowerCase() === q) ||
        (d.name && d.name.toLowerCase() === q)
    );
    if (exact) return normalizeMac(exact.mac);
    const partial = list.find(
      (d) =>
        (d.displayName && d.displayName.toLowerCase().includes(q)) ||
        (d.name && d.name.toLowerCase().includes(q))
    );
    return partial ? normalizeMac(partial.mac) : null;
  }

  async pauseDevice(target, durationInput = null, reason = 'Manual pause') {
    const devices = await this.listDevices().catch(() => this._lastDevices);
    const mac = this.resolveTargetMac(target, devices);
    if (!mac) {
      throw engineError(400, `Unknown or invalid device target: "${target}"`);
    }

    let mins = null;
    if (durationInput !== null && durationInput !== undefined && String(durationInput).trim() !== '') {
      mins = parseDurationMinutes(durationInput);
      if (mins === null || !Number.isFinite(mins) || mins <= 0 || mins > 525600 || !Number.isFinite(Date.now() + mins * 60_000)) {
        throw engineError(400, `Invalid pause duration: "${durationInput}"`);
      }
    }

    const dev = devices.find((d) => normalizeMac(d.mac) === mac);

    return await this._runMacSync(mac, async () => {
      const now = Date.now();
      const expiresAt = mins ? now + mins * 60_000 : null;
      if (expiresAt !== null && !Number.isFinite(expiresAt)) {
        throw engineError(400, `Invalid pause duration: "${durationInput}"`);
      }
      const adapter = this.getAdapter(this.store.load());
      let sync;
      try {
        sync = await adapter.blockDevice({
          mac,
          ipv4: dev?.ipv4 || null,
          ipv6List: dev?.ipv6List || []
        });
      } catch (err) {
        sync = { ok: false, mode: adapter.id || 'router', detail: err.message };
      }
      if (!sync || typeof sync.ok !== 'boolean') {
        sync = { ok: true, mode: adapter.id || 'router', detail: sync?.detail || 'Applied' };
      }

      return await this.runStateWrite(() => {
        const fresh = this.store.load();
        fresh.pausedDevices[mac] = {
          mac,
          ipv4: dev?.ipv4 || null,
          ipv6List: dev?.ipv6List || [],
          pausedAt: new Date(now).toISOString(),
          expiresAt,
          durationMinutes: mins,
          reason,
          sync
        };
        if (sync.ok !== false) {
          fresh.enforcedBlocks = addUniqueMacs(fresh.enforcedBlocks, [mac]);
          fresh.pendingUnblockMacs = (fresh.pendingUnblockMacs || []).filter((m) => m !== mac);
          this._previouslyBlockedMacs.add(mac);
        }
        this._macOpSeq.set(mac, (this._macOpSeq.get(mac) || 0) + 1);
        const syncNote = sync.ok === false ? ` [router sync failed: ${sync.detail || 'unknown'}]` : '';
        this.store.appendAudit(fresh, 'PAUSE', mac, `${reason}${mins ? ` (${mins}m)` : ''}${syncNote}`);
        this.store.save(fresh);
        return fresh.pausedDevices[mac];
      });
    });
  }

  async resumeDevice(target, reason = 'Manual resume') {
    const devices = await this.listDevices().catch(() => this._lastDevices);
    const mac = this.resolveTargetMac(target, devices);
    if (!mac) {
      throw engineError(400, `Unknown or invalid device target: "${target}"`);
    }

    const dev = devices.find((d) => normalizeMac(d.mac) === mac);

    return await this._runMacSync(mac, async () => {
      const preState = this.store.load();
      const prev = preState.pausedDevices[mac];
      const adapter = this.getAdapter(preState);
      let sync;
      try {
        sync = await adapter.unblockDevice({
          mac,
          ipv4: prev?.ipv4 || dev?.ipv4 || null,
          ipv6List: prev?.ipv6List || dev?.ipv6List || []
        });
      } catch (err) {
        sync = { ok: false, mode: adapter.id || 'router', detail: err.message };
      }
      if (!sync || typeof sync.ok !== 'boolean') {
        sync = { ok: true, mode: adapter.id || 'router', detail: sync?.detail || 'Applied' };
      }

      return await this.runStateWrite(() => {
        const fresh = this.store.load();
        delete fresh.pausedDevices[mac];

        if (sync.ok === false) {
          fresh.pendingUnblockMacs = addUniqueMacs(fresh.pendingUnblockMacs, [mac]);
        } else {
          fresh.enforcedBlocks = (fresh.enforcedBlocks || []).filter((m) => m !== mac);
          fresh.pendingUnblockMacs = (fresh.pendingUnblockMacs || []).filter((m) => m !== mac);
          this._previouslyBlockedMacs.delete(mac);
        }
        this._macOpSeq.set(mac, (this._macOpSeq.get(mac) || 0) + 1);

        const syncNote = sync.ok === false ? ` [router sync failed: ${sync.detail || 'unknown'}]` : '';
        this.store.appendAudit(fresh, 'RESUME', mac, `${reason}${syncNote}`);
        this.store.save(fresh);
        return { mac, sync };
      });
    });
  }

  setQuota({ id, name, macs, targetMacs, limit, dailyLimitMinutes, enabled } = {}) {
    const cleanName = String(name ?? '').trim();
    if (!cleanName) {
      throw engineError(400, 'Quota name is required');
    }
    const rawLimit = limit !== undefined ? limit : dailyLimitMinutes;
    const mins = parseDurationMinutes(rawLimit);
    if (mins === null || mins <= 0) {
      throw engineError(400, `Invalid duration: "${rawLimit}" (must be > 0, e.g. 90, 90m, 1h30m, 1:30)`);
    }
    const cleanMacs = parseMacList(macs !== undefined ? macs : targetMacs);

    const state = this.store.load();
    const quotaId = String(id ?? '').trim() || cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `quota-${Date.now()}`;
    const nextEnabled = enabled !== undefined ? Boolean(enabled) : true;
    const existing = state.quotas.find((q) => q.id === quotaId);

    if (existing) {
      const removedMacs = (existing.macs || []).filter((m) => !cleanMacs.includes(m));
      const freed = !nextEnabled ? [...(existing.macs || []), ...cleanMacs] : removedMacs;
      if (freed.length > 0) {
        state.pendingUnblockMacs = addUniqueMacs(state.pendingUnblockMacs, freed);
      }
      existing.name = cleanName;
      existing.macs = cleanMacs;
      existing.dailyLimitSeconds = mins * 60;
      existing.enabled = nextEnabled;
      const dateKey = todayKey();
      const entry = existing.usageByDate?.[dateKey];
      if (entry) {
        entry.blockedToday = (entry.usedSeconds || 0) >= (existing.dailyLimitSeconds + (entry.bonusSeconds || 0));
        if (!entry.blockedToday && existing.enabled !== false) {
          state.pendingUnblockMacs = addUniqueMacs(state.pendingUnblockMacs, existing.macs || []);
        }
      }
    } else {
      state.quotas.push({
        id: quotaId,
        name: cleanName,
        macs: cleanMacs,
        dailyLimitSeconds: mins * 60,
        enabled: nextEnabled,
        usageByDate: {}
      });
    }
    this.store.appendAudit(state, 'QUOTA_SET', quotaId, `${cleanName}: ${formatDuration(mins * 60)}/day`);
    this.store.save(state);
    return state.quotas.find((q) => q.id === quotaId);
  }

  addQuotaBonus(quotaIdOrName, bonusInput) {
    const key = String(quotaIdOrName ?? '').trim();
    if (!key) throw engineError(400, 'Quota id or name is required');
    const mins = parseDurationMinutes(bonusInput);
    if (mins === null || mins <= 0) {
      throw engineError(400, `Invalid bonus duration: "${bonusInput}"`);
    }
    const state = this.store.load();
    const lower = key.toLowerCase();
    const q =
      state.quotas.find((x) => x.id === key) ||
      state.quotas.find((x) => x.name.toLowerCase() === lower) ||
      state.quotas.find((x) => x.name.toLowerCase().includes(lower));
    if (!q) throw engineError(404, `Quota "${key}" not found`);
    const dateKey = todayKey();
    q.usageByDate = q.usageByDate || {};
    q.usageByDate[dateKey] = q.usageByDate[dateKey] || { usedSeconds: 0, bonusSeconds: 0, blockedToday: false };
    const entry = q.usageByDate[dateKey];
    entry.bonusSeconds = (entry.bonusSeconds || 0) + mins * 60;
    entry.blockedToday = (entry.usedSeconds || 0) >= ((q.dailyLimitSeconds || 0) + (entry.bonusSeconds || 0));
    if (!entry.blockedToday) {
      state.pendingUnblockMacs = addUniqueMacs(state.pendingUnblockMacs, q.macs || []);
    }
    this.store.appendAudit(state, 'QUOTA_BONUS', q.id, `+${mins}m for ${dateKey}`);
    this.store.save(state);
    return q;
  }

  resetQuotaToday(quotaIdOrName) {
    const key = String(quotaIdOrName ?? '').trim();
    if (!key) throw engineError(400, 'Quota id or name is required');
    const state = this.store.load();
    const lower = key.toLowerCase();
    const q =
      state.quotas.find((x) => x.id === key) ||
      state.quotas.find((x) => x.name.toLowerCase() === lower) ||
      state.quotas.find((x) => x.name.toLowerCase().includes(lower));
    if (!q) throw engineError(404, `Quota "${key}" not found`);
    const dateKey = todayKey();
    q.usageByDate = q.usageByDate || {};
    q.usageByDate[dateKey] = { usedSeconds: 0, bonusSeconds: 0, blockedToday: false, lastPollAt: Date.now() };
    state.pendingUnblockMacs = addUniqueMacs(state.pendingUnblockMacs, q.macs || []);
    this.store.appendAudit(state, 'QUOTA_RESET', q.id, `Reset ${dateKey} usage to 0s`);
    this.store.save(state);
    return q;
  }

  removeQuota(quotaId) {
    const key = String(quotaId ?? '').trim();
    if (!key) throw engineError(400, 'Quota id is required');
    const state = this.store.load();
    const existing = state.quotas.find((q) => q.id === key);
    if (!existing) throw engineError(404, `Quota "${key}" not found`);
    state.pendingUnblockMacs = addUniqueMacs(state.pendingUnblockMacs, existing.macs || []);
    state.quotas = state.quotas.filter((q) => q.id !== key);
    this.store.appendAudit(state, 'QUOTA_DELETE', key, 'Removed daily quota');
    this.store.save(state);
  }

  setSchedule(schedule) {
    if (!schedule || typeof schedule !== 'object') {
      throw engineError(400, 'Schedule payload is required');
    }
    const cleanName = String(schedule.name ?? '').trim();
    if (!cleanName) {
      throw engineError(400, 'Schedule name is required');
    }
    const cleanMacs = parseMacList(schedule.targetMacs !== undefined ? schedule.targetMacs : schedule.macs);
    const days = normalizeScheduleDays(schedule.days);
    const startTime = String(schedule.startTime ?? '21:00').trim();
    const endTime = String(schedule.endTime ?? '07:00').trim();
    if (!isValidTimeHHMM(startTime)) {
      throw engineError(400, `Invalid startTime: "${startTime}" (expected HH:MM 00:00-23:59)`);
    }
    if (!isValidTimeHHMM(endTime)) {
      throw engineError(400, `Invalid endTime: "${endTime}" (expected HH:MM 00:00-23:59)`);
    }
    if (startTime === endTime) {
      throw engineError(400, 'Start time and end time cannot be equal');
    }

    const state = this.store.load();
    const id = String(schedule.id ?? '').trim() || cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `sched-${Date.now()}`;
    const enabled = schedule.enabled !== false;
    const entry = {
      id,
      name: cleanName,
      days,
      startTime,
      endTime,
      enabled,
      targetMacs: cleanMacs
    };

    const idx = state.schedules.findIndex((s) => s.id === id);
    if (idx >= 0) {
      const prev = state.schedules[idx];
      const removedMacs = (prev.targetMacs || []).filter((m) => !cleanMacs.includes(m));
      const freed = !enabled ? [...(prev.targetMacs || []), ...cleanMacs] : removedMacs;
      if (freed.length > 0) {
        state.pendingUnblockMacs = addUniqueMacs(state.pendingUnblockMacs, freed);
      }
      state.schedules[idx] = entry;
    } else {
      state.schedules.push(entry);
    }

    this.store.appendAudit(state, 'SCHEDULE_SET', id, `${entry.name} (${entry.startTime}-${entry.endTime})`);
    this.store.save(state);
    return entry;
  }

  toggleSchedule(scheduleId, enabled) {
    const key = String(scheduleId ?? '').trim();
    if (!key) throw engineError(400, 'Schedule id is required');
    const state = this.store.load();
    const sched = state.schedules.find((s) => s.id === key);
    if (!sched) throw engineError(404, `Schedule "${key}" not found`);
    sched.enabled = typeof enabled === 'boolean' ? enabled : !sched.enabled;
    if (!sched.enabled) {
      state.pendingUnblockMacs = addUniqueMacs(state.pendingUnblockMacs, sched.targetMacs || []);
    }
    this.store.appendAudit(state, sched.enabled ? 'SCHEDULE_ENABLE' : 'SCHEDULE_DISABLE', key, sched.name);
    this.store.save(state);
    return sched;
  }

  removeSchedule(scheduleId) {
    const key = String(scheduleId ?? '').trim();
    if (!key) throw engineError(400, 'Schedule id is required');
    const state = this.store.load();
    const existing = state.schedules.find((s) => s.id === key);
    if (!existing) throw engineError(404, `Schedule "${key}" not found`);
    state.pendingUnblockMacs = addUniqueMacs(state.pendingUnblockMacs, existing.targetMacs || []);
    state.schedules = state.schedules.filter((s) => s.id !== key);
    this.store.appendAudit(state, 'SCHEDULE_DELETE', key, `Removed schedule ${existing.name}`);
    this.store.save(state);
  }

  toggleCategory(categoryId, enabled) {
    const preset = typeof categoryId === 'string' && Object.hasOwn(CATEGORY_PRESETS, categoryId)
      ? CATEGORY_PRESETS[categoryId]
      : null;
    if (!preset) throw engineError(400, `Unknown category: ${categoryId}`);
    const state = this.store.load();
    const set = new Set(state.blockedCategories || []);
    const customSet = new Set(state.customBlockedDomains || []);

    if (enabled) {
      set.add(categoryId);
      for (const domain of preset.domains) {
        if (!state.blockedDomains.some((d) => d.domain === domain)) {
          state.blockedDomains.push({ domain, category: categoryId, enabled: true, addedAt: new Date().toISOString() });
        }
      }
    } else {
      set.delete(categoryId);
      const remainingCategories = [...set];
      const nextDomains = [];
      for (const d of state.blockedDomains || []) {
        if (d.category !== categoryId) {
          nextDomains.push(d);
          continue;
        }
        const otherCat = remainingCategories.find((cid) => Object.hasOwn(CATEGORY_PRESETS, cid) && CATEGORY_PRESETS[cid]?.domains?.includes(d.domain));
        if (otherCat) {
          nextDomains.push({ ...d, category: otherCat });
        } else if (d.custom || customSet.has(d.domain)) {
          nextDomains.push({ ...d, category: 'custom', custom: true, enabled: true });
        }
      }
      state.blockedDomains = nextDomains;
    }
    state.blockedCategories = [...set];
    this.store.appendAudit(state, enabled ? 'CATEGORY_BLOCK' : 'CATEGORY_UNBLOCK', categoryId, preset.label);
    this.store.save(state);
    return state;
  }

  blockDomain(domain) {
    const clean = String(domain ?? '')
      .toLowerCase()
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/^\*\./, '')
      .replace(/\.$/, '');
    if (!clean || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(clean) && !/^[a-z0-9]+$/.test(clean)) {
      throw engineError(400, 'Valid domain is required');
    }
    const state = this.store.load();
    const customSet = new Set(state.customBlockedDomains || []);
    customSet.add(clean);
    state.customBlockedDomains = [...customSet];

    const existing = state.blockedDomains.find((d) => d.domain === clean);
    if (existing) {
      existing.enabled = true;
      existing.custom = true;
    } else {
      state.blockedDomains.unshift({
        domain: clean,
        category: 'custom',
        custom: true,
        enabled: true,
        addedAt: new Date().toISOString()
      });
    }
    this.store.appendAudit(state, 'DOMAIN_BLOCK', clean, `Blocked *.${clean}`);
    this.store.save(state);
    return clean;
  }

  unblockDomain(domain) {
    const clean = String(domain ?? '')
      .toLowerCase()
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/^\*\./, '')
      .replace(/\.$/, '');
    if (!clean) throw engineError(400, 'Domain is required');
    const state = this.store.load();
    state.customBlockedDomains = (state.customBlockedDomains || []).filter((d) => d !== clean);
    state.blockedDomains = state.blockedDomains.filter((d) => d.domain !== clean);
    this.store.appendAudit(state, 'DOMAIN_UNBLOCK', clean, `Unblocked ${clean}`);
    this.store.save(state);
  }

  /**
   * Checks whether a DNS query from clientIp for domain should be sinkholed.
   */
  evaluateDnsQuery(domain, clientIp) {
    const state = this.store.load();
    const clean = String(domain || '').toLowerCase().replace(/\.$/, '');
    const normIp = String(clientIp || '').trim().toLowerCase().replace(/^::ffff:/, '');
    const now = new Date();
    const nowMs = now.getTime();
    const dateStr = todayKey(now);

    let dev = normIp
      ? this._lastDevices.find(
          (d) =>
            (d.ipv4 && d.ipv4.toLowerCase() === normIp) ||
            (d.ipv6 && d.ipv6.toLowerCase() === normIp) ||
            (Array.isArray(d.ipv6List) && d.ipv6List.some((ip) => String(ip).toLowerCase() === normIp))
        )
      : null;

    if (!dev && normIp) {
      const pausedHit = Object.values(state.pausedDevices || {}).find(
        (p) =>
          p &&
          ((p.ipv4 && p.ipv4.toLowerCase() === normIp) ||
            (Array.isArray(p.ipv6List) && p.ipv6List.some((ip) => String(ip).toLowerCase() === normIp)))
      );
      if (pausedHit) {
        dev = { mac: pausedHit.mac, name: state.aliases?.[pausedHit.mac] || pausedHit.mac };
      }
    }

    if (dev) {
      const mac = normalizeMac(dev.mac);
      const pause = state.pausedDevices?.[mac];
      if (pause && (!pause.expiresAt || pause.expiresAt > nowMs)) {
        return { blocked: true, reason: `Device paused (${state.aliases?.[mac] || dev.name || mac})` };
      }
      const sched = (state.schedules || []).find((s) => (s.targetMacs || []).includes(mac) && isScheduleActiveNow(s, now));
      if (sched) {
        return { blocked: true, reason: `Curfew schedule (${sched.name})` };
      }
      const blockedQuota = (state.quotas || []).find(
        (q) => (q.macs || []).includes(mac) && isQuotaBlockedOnDate(q, dateStr)
      );
      if (blockedQuota) {
        return { blocked: true, reason: `Daily quota reached (${blockedQuota.name})` };
      }
    }

    for (const entry of state.blockedDomains || []) {
      if (!entry.enabled) continue;
      const target = entry.domain.toLowerCase().replace(/^\*\./, '');
      if (clean === target || clean.endsWith(`.${target}`)) {
        return { blocked: true, reason: `Blocked domain (${target})` };
      }
    }
    return { blocked: false, reason: 'Allowed' };
  }

  /**
   * Single enforcement tick: expires timed pauses, increments daily quota usage,
   * enforces bedtime schedules and daily limits on the active router adapter.
   */
  tick(opts = {}) {
    const run = this._tickQueue.then(
      () => this._tickImpl(opts),
      () => this._tickImpl(opts)
    );
    this._tickQueue = run.catch(() => {});
    return run;
  }

  async _tickImpl({ now = new Date() } = {}) {
    const initSnapshot = this.store.load();
    const adapter = this.getAdapter(initSnapshot);
    let rawDevices;
    try {
      rawDevices = await adapter.listDevices();
      this.lastDeviceError = null;
    } catch (err) {
      this.lastDeviceError = err.message || 'Device discovery failed';
      throw err;
    }

    const devices = (rawDevices || [])
      .map((d) => ({ ...d, mac: normalizeMac(d.mac) }))
      .filter((d) => Boolean(d.mac));
    this._lastDevices = devices;

    const state = this.store.load();
    const nowMs = now.getTime();
    const dateStr = todayKey(now);
    const shouldBlockMacs = new Map(); // mac -> reason
    const expiredMacs = new Set();

    // 1. Collect expired timed pauses & active manual pauses
    for (const [mac, info] of Object.entries(state.pausedDevices || {})) {
      if (info.expiresAt && info.expiresAt <= nowMs) {
        expiredMacs.add(mac);
      } else {
        shouldBlockMacs.set(mac, info.reason || 'Manual pause');
      }
    }

    // 2. Evaluate bedtime schedules
    for (const sched of state.schedules || []) {
      if (isScheduleActiveNow(sched, now)) {
        for (const mac of sched.targetMacs || []) {
          if (!shouldBlockMacs.has(mac)) shouldBlockMacs.set(mac, `Schedule: ${sched.name}`);
        }
      }
    }

    // 3. Evaluate daily quotas (compute deltas without persisting stale snapshot)
    const quotaUpdates = new Map();
    for (const q of state.quotas || []) {
      if (q.enabled === false) continue;
      const entry = q.usageByDate?.[dateStr] || null;
      const prevUsed = entry?.usedSeconds || 0;
      const bonus = entry?.bonusSeconds || 0;
      const wasBlockedToday = Boolean(entry?.blockedToday);
      const prevLastPollAt = entry?.lastPollAt || null;
      const limitSec = (q.dailyLimitSeconds || 0) + bonus;
      const online = (q.macs || []).some((m) => devices.some((d) => d.mac === m && d.status === 'online'));

      let usageDeltaSec = 0;
      let onlineAndCounted = false;
      if (online && !wasBlockedToday) {
        usageDeltaSec = prevLastPollAt
          ? Math.min(MAX_TICK_CREDIT_SEC, Math.max(0, Math.round((nowMs - prevLastPollAt) / 1000)))
          : 0;
        onlineAndCounted = true;
      }
      const nextUsed = prevUsed + usageDeltaSec;
      if (nextUsed >= limitSec) {
        for (const mac of q.macs || []) {
          shouldBlockMacs.set(mac, `Daily quota reached (${formatDuration(nextUsed)} / ${formatDuration(limitSec)})`);
        }
      }
      quotaUpdates.set(q.id, { usageDeltaSec, prevLastPollAt, onlineAndCounted });
    }

    // 4. Sync all managed MACs (quotas + schedules + previously enforced + pending unblocks) against router adapter
    const previouslyBlocked = new Set([
      ...(state.enforcedBlocks || []).map(normalizeMac).filter(Boolean),
      ...this._previouslyBlockedMacs,
      ...expiredMacs,
      ...(state.pendingUnblockMacs || []).map(normalizeMac).filter(Boolean)
    ]);

    const managedMacs = new Set([
      ...shouldBlockMacs.keys(),
      ...(state.quotas || []).flatMap((q) => q.macs || []),
      ...(state.schedules || []).flatMap((s) => s.targetMacs || []),
      ...previouslyBlocked
    ]);

    const actions = [];
    const blockedThisTick = new Set();
    const failedBlocks = new Set();
    const unblockedThisTick = new Set();
    const failedUnblocks = new Set();
    const finalBlockedMacs = new Set();
    const seqAtMacSync = new Map();
    let syncFailures = 0;

    for (const mac of managedMacs) {
      const dev = devices.find((d) => d.mac === mac);
      await this._runMacSync(mac, async () => {
        const latestState = this.store.load();
        let targetBlocked = false;
        let blockReason = null;

        const curPause = latestState.pausedDevices?.[mac];
        if (curPause && (!curPause.expiresAt || curPause.expiresAt > nowMs)) {
          targetBlocked = true;
          blockReason = curPause.reason || 'Manual pause';
        }

        if (!targetBlocked) {
          for (const sched of latestState.schedules || []) {
            if ((sched.targetMacs || []).includes(mac) && isScheduleActiveNow(sched, now)) {
              targetBlocked = true;
              blockReason = `Schedule: ${sched.name}`;
              break;
            }
          }
        }

        if (!targetBlocked) {
          for (const q of latestState.quotas || []) {
            if (q.enabled === false || !(q.macs || []).includes(mac)) continue;
            const entry = q.usageByDate?.[dateStr] || null;
            const upd = quotaUpdates.get(q.id);
            const concurrentReset = upd ? (entry?.lastPollAt || null) !== upd.prevLastPollAt : false;
            const usedSec = (entry?.usedSeconds || 0) + (upd && !concurrentReset && upd.onlineAndCounted ? upd.usageDeltaSec : 0);
            const limitSec = (q.dailyLimitSeconds || 0) + (entry?.bonusSeconds || 0);
            if (isQuotaBlockedOnDate(q, dateStr) || usedSec >= limitSec) {
              targetBlocked = true;
              blockReason = `Daily quota reached (${formatDuration(usedSec)} / ${formatDuration(limitSec)})`;
              break;
            }
          }
        }

        if (targetBlocked) finalBlockedMacs.add(mac);

        const wasPreviouslyBlocked =
          previouslyBlocked.has(mac) ||
          (latestState.enforcedBlocks || []).map(normalizeMac).filter(Boolean).includes(mac) ||
          (latestState.pendingUnblockMacs || []).map(normalizeMac).filter(Boolean).includes(mac);

        const routerBlocked = await adapter.isDeviceBlocked({ mac }).catch(() => null);

        if (targetBlocked) {
          if (routerBlocked !== true) {
            let res;
            try {
              res = await adapter.blockDevice({ mac, ipv4: dev?.ipv4 || null, ipv6List: dev?.ipv6List || [] });
            } catch (err) {
              res = { ok: false, mode: adapter.id || 'router', detail: err.message };
            }
            if (res?.ok === false) {
              syncFailures++;
              failedBlocks.add(mac);
            } else {
              blockedThisTick.add(mac);
            }
            actions.push({ mac, action: 'block', reason: blockReason, res });
          } else {
            blockedThisTick.add(mac);
          }
        } else if (routerBlocked === true || wasPreviouslyBlocked) {
          let res;
          try {
            res = await adapter.unblockDevice({ mac, ipv4: dev?.ipv4 || null, ipv6List: dev?.ipv6List || [] });
          } catch (err) {
            res = { ok: false, mode: adapter.id || 'router', detail: err.message };
          }
          if (res?.ok === false) {
            syncFailures++;
            failedUnblocks.add(mac);
          } else {
            unblockedThisTick.add(mac);
          }
          actions.push({ mac, action: 'unblock', reason: 'Allowed by policy', res });
        }

        seqAtMacSync.set(mac, this._macOpSeq.get(mac) || 0);
      });
    }

    await this.runStateWrite(() => {
      const fresh = this.store.load();

      for (const mac of expiredMacs) {
        const curPause = fresh.pausedDevices?.[mac];
        if (curPause && curPause.expiresAt && curPause.expiresAt <= nowMs) {
          delete fresh.pausedDevices[mac];
          this.store.appendAudit(fresh, 'AUTO_RESUME', mac, 'Timed pause expired');
        }
      }

      for (const q of fresh.quotas || []) {
        const upd = quotaUpdates.get(q.id);
        if (!upd || q.enabled === false) continue;
        q.usageByDate = q.usageByDate || {};
        const entry = q.usageByDate[dateStr] || (q.usageByDate[dateStr] = {
          usedSeconds: 0,
          bonusSeconds: 0,
          blockedToday: false,
          lastPollAt: null,
          lastOnlineAt: null
        });
        const concurrentReset = entry.lastPollAt !== upd.prevLastPollAt;
        if (!concurrentReset) {
          if (upd.onlineAndCounted) {
            entry.usedSeconds = (entry.usedSeconds || 0) + upd.usageDeltaSec;
            entry.lastOnlineAt = new Date(nowMs).toISOString();
          }
          entry.lastPollAt = nowMs;
        }
        const limitSec = (q.dailyLimitSeconds || 0) + (entry.bonusSeconds || 0);
        entry.blockedToday = (entry.usedSeconds || 0) >= limitSec;
      }

      const macSuperseded = (mac) => (this._macOpSeq.get(mac) || 0) !== seqAtMacSync.get(mac);
      const nextEnforced = new Set((fresh.enforcedBlocks || []).map(normalizeMac).filter(Boolean));
      for (const mac of blockedThisTick) {
        if (!macSuperseded(mac)) nextEnforced.add(mac);
      }
      for (const mac of failedBlocks) {
        if (!macSuperseded(mac)) nextEnforced.add(mac);
      }
      for (const mac of failedUnblocks) {
        if (!macSuperseded(mac)) nextEnforced.add(mac);
      }
      for (const mac of unblockedThisTick) {
        if (macSuperseded(mac)) continue;
        const curPause = fresh.pausedDevices?.[mac];
        const pausedNow = Boolean(curPause && (!curPause.expiresAt || curPause.expiresAt > nowMs));
        if (!pausedNow) nextEnforced.delete(mac);
      }

      const nextPendingUnblock = new Set((fresh.pendingUnblockMacs || []).map(normalizeMac).filter(Boolean));
      for (const mac of unblockedThisTick) {
        if (!macSuperseded(mac)) nextPendingUnblock.delete(mac);
      }
      for (const mac of failedUnblocks) {
        if (!macSuperseded(mac)) nextPendingUnblock.add(mac);
      }

      fresh.enforcedBlocks = [...nextEnforced];
      fresh.pendingUnblockMacs = [...nextPendingUnblock];
      this._previouslyBlockedMacs = nextEnforced;
      this._lastTickAt = new Date(nowMs).toISOString();
      this._lastSyncSummary = {
        ok: syncFailures === 0,
        actionsCount: actions.length,
        failures: syncFailures,
        blockedCount: finalBlockedMacs.size
      };

      this.store.save(fresh);
    });

    return { date: dateStr, devicesCount: devices.length, blockedCount: finalBlockedMacs.size, actions };
  }

  startDaemon(intervalSec) {
    const state = this.store.load();
    const sec = Math.min(3600, Math.max(5, Number(intervalSec || state.router.pollIntervalSec || 60)));
    const ms = sec * 1000;
    const run = async () => {
      try {
        await this.tick();
      } catch (err) {
        console.error('[curfewd] tick error:', err.cause?.code || err.message);
      }
    };
    run();
    this._daemonTimer = setInterval(run, ms);
    return () => {
      if (this._daemonTimer) {
        clearInterval(this._daemonTimer);
        this._daemonTimer = null;
      }
    };
  }
}
