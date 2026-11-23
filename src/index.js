import { CurfewEngine, isScheduleActiveNow } from './engine.js';
import { startServer } from './server.js';
import { ADAPTER_CATALOG, autoDetectRouter, createAdapter } from './adapters/index.js';
import { LocalDnsSinkhole, CATEGORY_PRESETS } from './dns-sinkhole.js';
import { parseDurationMinutes, formatDuration, normalizeMac, todayKey } from './state.js';

export default function curfewd(options = {}) {
  const engine = new CurfewEngine(options);
  return {
    engine,
    detect: () => autoDetectRouter(),
    devices: () => engine.listDevices(),
    pause: (target, duration, reason) => engine.pauseDevice(target, duration, reason),
    resume: (target, reason) => engine.resumeDevice(target, reason),
    tick: (opts) => engine.tick(opts),
    daemon: (intervalSec) => engine.startDaemon(intervalSec),
    serve: (serveOpts = {}) => startServer({ ...options, ...serveOpts }),
    quota: {
      set: (opts) => engine.setQuota(opts),
      bonus: (id, duration) => engine.addQuotaBonus(id, duration),
      reset: (id) => engine.resetQuotaToday(id),
      remove: (id) => engine.removeQuota(id)
    },
    schedule: {
      set: (sched) => engine.setSchedule(sched)
    },
    dns: {
      block: (domain) => engine.blockDomain(domain),
      unblock: (domain) => engine.unblockDomain(domain),
      category: (id, enabled) => engine.toggleCategory(id, enabled)
    }
  };
}

export {
  CurfewEngine,
  LocalDnsSinkhole,
  ADAPTER_CATALOG,
  CATEGORY_PRESETS,
  autoDetectRouter,
  createAdapter,
  startServer,
  isScheduleActiveNow,
  parseDurationMinutes,
  formatDuration,
  normalizeMac,
  todayKey
};
