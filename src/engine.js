import {
  StateStore,
  normalizeMac,
  todayKey,
  parseDurationMinutes,
  formatDuration
} from './state.js';
import { createAdapter } from './adapters/index.js';
import { CATEGORY_PRESETS } from './dns-sinkhole.js';

const MAX_TICK_CREDIT_SEC = 120;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function isScheduleActiveNow(schedule, now = new Date()) {
  if (!schedule || !schedule.enabled) return false;
  const days = schedule.days || [];
  const curDay = DAY_NAMES[now.getDay()];
  const prevDay = DAY_NAMES[(now.getDay() + 6) % 7];

  const [sh, sm] = String(schedule.startTime || '21:00').split(':').map(Number);
  const [eh, em] = String(schedule.endTime || '07:00').split(':').map(Number);
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
  }

  getAdapter(state = this.store.load()) {
    if (this._customAdapter) return this._customAdapter;
    return createAdapter(state.router);
  }

  async listDevices() {
    const state = this.store.load();
    const adapter = this.getAdapter(state);
    const rawDevices = await adapter.listDevices();
    this._lastDevices = rawDevices;

    const dateStr = todayKey();
    const now = new Date();
    const devices = rawDevices.map((d) => {
      const mac = normalizeMac(d.mac);
      const alias = state.aliases?.[mac] || null;
      const pause = state.pausedDevices?.[mac] || null;
      const quota = (state.quotas || []).find((q) => (q.macs || []).includes(mac)) || null;
      const activeSchedule = (state.schedules || []).find(
        (s) => (s.targetMacs || []).includes(mac) && isScheduleActiveNow(s, now)
      ) || null;

      let quotaSummary = null;
      if (quota) {
        const entry = quota.usageByDate?.[dateStr] || { usedSeconds: 0, bonusSeconds: 0, blockedToday: false };
        const limitSec = quota.dailyLimitSeconds + (entry.bonusSeconds || 0);
        quotaSummary = {
          id: quota.id,
          name: quota.name,
          usedSeconds: entry.usedSeconds || 0,
          limitSeconds: limitSec,
          remainingSeconds: Math.max(0, limitSec - (entry.usedSeconds || 0)),
          blockedToday: Boolean(entry.blockedToday),
          usedFormatted: formatDuration(entry.usedSeconds || 0),
          limitFormatted: formatDuration(limitSec),
          remainingFormatted: formatDuration(Math.max(0, limitSec - (entry.usedSeconds || 0)))
        };
      }

      const isBlocked = Boolean(pause || activeSchedule || quotaSummary?.blockedToday);
      return {
        ...d,
        mac,
        alias,
        displayName: alias || d.name,
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

  resolveTargetMac(query, devices) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return null;
    if (/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(q)) return normalizeMac(q);
    const hit = devices.find(
      (d) =>
        d.mac === q ||
        d.displayName.toLowerCase().includes(q) ||
        d.name.toLowerCase().includes(q) ||
        (d.ipv4 && d.ipv4 === q)
    );
    return hit ? hit.mac : null;
  }

  async pauseDevice(target, durationInput = null, reason = 'Manual pause') {
    const state = this.store.load();
    const devices = await this.listDevices().catch(() => this._lastDevices);
    const mac = this.resolveTargetMac(target, devices) || normalizeMac(target);
    const dev = devices.find((d) => d.mac === mac);
    const mins = durationInput != null ? parseDurationMinutes(durationInput) : null;
    const now = Date.now();
    const expiresAt = mins && mins > 0 ? now + mins * 60_000 : null;

    const adapter = this.getAdapter(state);
    const sync = await adapter.blockDevice({
      mac,
      ipv4: dev?.ipv4 || null,
      ipv6List: dev?.ipv6List || []
    });

    state.pausedDevices[mac] = {
      mac,
      ipv4: dev?.ipv4 || null,
      ipv6List: dev?.ipv6List || [],
      pausedAt: new Date(now).toISOString(),
      expiresAt,
      durationMinutes: mins,
      reason,
      sync
    };
    this.store.appendAudit(state, 'PAUSE', mac, `${reason}${mins ? ` (${mins}m)` : ''}`);
    this.store.save(state);
    return state.pausedDevices[mac];
  }

  async resumeDevice(target, reason = 'Manual resume') {
    const state = this.store.load();
    const devices = await this.listDevices().catch(() => this._lastDevices);
    const mac = this.resolveTargetMac(target, devices) || normalizeMac(target);
    const prev = state.pausedDevices[mac];
    const dev = devices.find((d) => d.mac === mac);
    delete state.pausedDevices[mac];

    const adapter = this.getAdapter(state);
    const sync = await adapter.unblockDevice({
      mac,
      ipv4: prev?.ipv4 || dev?.ipv4 || null,
      ipv6List: prev?.ipv6List || dev?.ipv6List || []
    });
    this.store.appendAudit(state, 'RESUME', mac, reason);
    this.store.save(state);
    return { mac, sync };
  }

  setQuota({ id, name, macs, limit }) {
    const mins = parseDurationMinutes(limit);
    if (mins === null) throw new Error(`Invalid duration: "${limit}" (use e.g. 90, 90m, 1h30m, 1:30)`);
    const cleanMacs = (Array.isArray(macs) ? macs : [macs]).map(normalizeMac).filter(Boolean);
    if (cleanMacs.length === 0) throw new Error('At least one MAC address is required');

    const state = this.store.load();
    const quotaId = id || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `quota-${Date.now()}`;
    const existing = state.quotas.find((q) => q.id === quotaId);
    if (existing) {
      existing.name = name || existing.name;
      existing.macs = cleanMacs;
      existing.dailyLimitSeconds = mins * 60;
      existing.enabled = true;
    } else {
      state.quotas.push({
        id: quotaId,
        name: name || quotaId,
        macs: cleanMacs,
        dailyLimitSeconds: mins * 60,
        enabled: true,
        usageByDate: {}
      });
    }
    this.store.appendAudit(state, 'QUOTA_SET', quotaId, `${name || quotaId}: ${formatDuration(mins * 60)}/day`);
    this.store.save(state);
    return state.quotas.find((q) => q.id === quotaId);
  }

  addQuotaBonus(quotaIdOrName, bonusInput) {
    const mins = parseDurationMinutes(bonusInput);
    if (!mins || mins <= 0) throw new Error(`Invalid bonus duration: "${bonusInput}"`);
    const state = this.store.load();
    const q = state.quotas.find(
      (x) => x.id === quotaIdOrName || x.name.toLowerCase().includes(String(quotaIdOrName).toLowerCase())
    );
    if (!q) throw new Error(`Quota "${quotaIdOrName}" not found`);
    const key = todayKey();
    q.usageByDate = q.usageByDate || {};
    q.usageByDate[key] = q.usageByDate[key] || { usedSeconds: 0, bonusSeconds: 0, blockedToday: false };
    q.usageByDate[key].bonusSeconds = (q.usageByDate[key].bonusSeconds || 0) + mins * 60;
    this.store.appendAudit(state, 'QUOTA_BONUS', q.id, `+${mins}m for ${key}`);
    this.store.save(state);
    return q;
  }

  resetQuotaToday(quotaIdOrName) {
    const state = this.store.load();
    const q = state.quotas.find(
      (x) => x.id === quotaIdOrName || x.name.toLowerCase().includes(String(quotaIdOrName).toLowerCase())
    );
    if (!q) throw new Error(`Quota "${quotaIdOrName}" not found`);
    const key = todayKey();
    q.usageByDate = q.usageByDate || {};
    q.usageByDate[key] = { usedSeconds: 0, bonusSeconds: 0, blockedToday: false, lastPollAt: Date.now() };
    this.store.appendAudit(state, 'QUOTA_RESET', q.id, `Reset ${key} usage to 0s`);
    this.store.save(state);
    return q;
  }

  removeQuota(quotaId) {
    const state = this.store.load();
    state.quotas = state.quotas.filter((q) => q.id !== quotaId);
    this.store.appendAudit(state, 'QUOTA_DELETE', quotaId, 'Removed daily quota');
    this.store.save(state);
  }

  setSchedule(schedule) {
    const state = this.store.load();
    const id = schedule.id || schedule.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `sched-${Date.now()}`;
    const entry = {
      id,
      name: schedule.name || id,
      days: schedule.days || ['Sun', 'Mon', 'Tue', 'Wed', 'Thu'],
      startTime: schedule.startTime || '21:00',
      endTime: schedule.endTime || '07:00',
      enabled: schedule.enabled !== false,
      targetMacs: (schedule.targetMacs || []).map(normalizeMac).filter(Boolean)
    };
    const idx = state.schedules.findIndex((s) => s.id === id);
    if (idx >= 0) state.schedules[idx] = entry;
    else state.schedules.push(entry);
    this.store.appendAudit(state, 'SCHEDULE_SET', id, `${entry.name} (${entry.startTime}-${entry.endTime})`);
    this.store.save(state);
    return entry;
  }

  toggleCategory(categoryId, enabled) {
    const preset = CATEGORY_PRESETS[categoryId];
    if (!preset) throw new Error(`Unknown category: ${categoryId}`);
    const state = this.store.load();
    const set = new Set(state.blockedCategories || []);
    if (enabled) {
      set.add(categoryId);
      for (const domain of preset.domains) {
        if (!state.blockedDomains.some((d) => d.domain === domain)) {
          state.blockedDomains.push({ domain, category: categoryId, enabled: true, addedAt: new Date().toISOString() });
        }
      }
    } else {
      set.delete(categoryId);
      state.blockedDomains = state.blockedDomains.filter((d) => d.category !== categoryId);
    }
    state.blockedCategories = [...set];
    this.store.appendAudit(state, enabled ? 'CATEGORY_BLOCK' : 'CATEGORY_UNBLOCK', categoryId, preset.label);
    this.store.save(state);
    return state;
  }

  blockDomain(domain) {
    const clean = String(domain || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!clean) throw new Error('Domain is required');
    const state = this.store.load();
    const existing = state.blockedDomains.find((d) => d.domain === clean);
    if (existing) existing.enabled = true;
    else state.blockedDomains.unshift({ domain: clean, category: 'custom', enabled: true, addedAt: new Date().toISOString() });
    this.store.appendAudit(state, 'DOMAIN_BLOCK', clean, `Blocked *.${clean}`);
    this.store.save(state);
    return clean;
  }

  unblockDomain(domain) {
    const clean = String(domain || '').toLowerCase().trim();
    const state = this.store.load();
    state.blockedDomains = state.blockedDomains.filter((d) => d.domain !== clean);
    this.store.appendAudit(state, 'DOMAIN_UNBLOCK', clean, `Unblocked ${clean}`);
    this.store.save(state);
  }

  /**
   * Checks whether a DNS query from clientIp for domain should be sinkholed.
   */
  evaluateDnsQuery(domain, clientIp) {
    const state = this.store.load();
    const clean = domain.toLowerCase().replace(/\.$/, '');
    const now = new Date();
    const dateStr = todayKey(now);

    const dev = this._lastDevices.find((d) => d.ipv4 === clientIp);
    if (dev) {
      const mac = normalizeMac(dev.mac);
      if (state.pausedDevices?.[mac]) {
        return { blocked: true, reason: `Device paused (${state.aliases?.[mac] || dev.name})` };
      }
      const sched = (state.schedules || []).find((s) => (s.targetMacs || []).includes(mac) && isScheduleActiveNow(s, now));
      if (sched) {
        return { blocked: true, reason: `Curfew schedule (${sched.name})` };
      }
      const quota = (state.quotas || []).find((q) => (q.macs || []).includes(mac) && q.enabled);
      if (quota?.usageByDate?.[dateStr]?.blockedToday) {
        return { blocked: true, reason: `Daily quota reached (${quota.name})` };
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
  async tick({ now = new Date() } = {}) {
    const state = this.store.load();
    const adapter = this.getAdapter(state);
    const devices = await adapter.listDevices();
    this._lastDevices = devices;

    const nowMs = now.getTime();
    const dateStr = todayKey(now);
    const shouldBlockMacs = new Map(); // mac -> reason

    // 1. Expire timed pauses & collect active manual pauses
    for (const [mac, info] of Object.entries(state.pausedDevices || {})) {
      if (info.expiresAt && info.expiresAt <= nowMs) {
        delete state.pausedDevices[mac];
        this.store.appendAudit(state, 'AUTO_RESUME', mac, 'Timed pause expired');
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

    // 3. Evaluate daily quotas
    for (const q of state.quotas || []) {
      if (!q.enabled) continue;
      q.usageByDate = q.usageByDate || {};
      const entry = q.usageByDate[dateStr] || (q.usageByDate[dateStr] = {
        usedSeconds: 0,
        bonusSeconds: 0,
        blockedToday: false,
        lastPollAt: null,
        lastOnlineAt: null
      });
      const limitSec = q.dailyLimitSeconds + (entry.bonusSeconds || 0);
      const online = (q.macs || []).some((m) => devices.some((d) => normalizeMac(d.mac) === m && d.status === 'online'));

      if (online && !entry.blockedToday) {
        const delta = entry.lastPollAt
          ? Math.min(MAX_TICK_CREDIT_SEC, Math.max(0, Math.round((nowMs - entry.lastPollAt) / 1000)))
          : 0;
        entry.usedSeconds += delta;
        entry.lastOnlineAt = new Date(nowMs).toISOString();
      }
      entry.lastPollAt = nowMs;

      if (entry.usedSeconds >= limitSec) {
        entry.blockedToday = true;
        for (const mac of q.macs || []) {
          shouldBlockMacs.set(mac, `Daily quota reached (${formatDuration(entry.usedSeconds)} / ${formatDuration(limitSec)})`);
        }
      } else {
        entry.blockedToday = false;
      }
    }

    // 4. Sync all managed MACs (quotas + schedules + recently paused) against router adapter
    const managedMacs = new Set([
      ...shouldBlockMacs.keys(),
      ...(state.quotas || []).flatMap((q) => q.macs || []),
      ...(state.schedules || []).flatMap((s) => s.targetMacs || [])
    ]);

    const actions = [];
    for (const mac of managedMacs) {
      const dev = devices.find((d) => normalizeMac(d.mac) === mac);
      const targetBlocked = shouldBlockMacs.has(mac);
      const routerBlocked = await adapter.isDeviceBlocked({ mac }).catch(() => null);

      if (targetBlocked && routerBlocked !== true) {
        const res = await adapter.blockDevice({ mac, ipv4: dev?.ipv4 || null, ipv6List: dev?.ipv6List || [] });
        actions.push({ mac, action: 'block', reason: shouldBlockMacs.get(mac), res });
      } else if (!targetBlocked && routerBlocked === true) {
        const res = await adapter.unblockDevice({ mac, ipv4: dev?.ipv4 || null, ipv6List: dev?.ipv6List || [] });
        actions.push({ mac, action: 'unblock', reason: 'Allowed by policy', res });
      }
    }

    this.store.save(state);
    return { date: dateStr, devicesCount: devices.length, blockedCount: shouldBlockMacs.size, actions };
  }

  startDaemon(intervalSec) {
    const state = this.store.load();
    const ms = Math.max(15, Number(intervalSec || state.router.pollIntervalSec || 60)) * 1000;
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
