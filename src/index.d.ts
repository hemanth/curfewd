export interface CurfewdOptions {
  homeDir?: string;
}

export interface QuotaInput {
  id?: string;
  name: string;
  macs: string | string[];
  limit: number | string;
}

export interface ScheduleInput {
  id?: string;
  name: string;
  days?: string[];
  startTime: string;
  endTime: string;
  enabled?: boolean;
  targetMacs: string[];
}

export interface CurfewdInstance {
  detect(): Promise<Record<string, unknown>>;
  devices(): Promise<Array<Record<string, unknown>>>;
  pause(target: string, duration?: number | string | null, reason?: string): Promise<Record<string, unknown>>;
  resume(target: string, reason?: string): Promise<Record<string, unknown>>;
  tick(opts?: { now?: Date }): Promise<Record<string, unknown>>;
  daemon(intervalSec?: number): () => void;
  serve(opts?: { port?: number; dnsPort?: number; host?: string; enableDns?: boolean; enableDaemon?: boolean }): Promise<{ url: string; port: number; close(): Promise<void> }>;
  quota: {
    set(opts: QuotaInput): Record<string, unknown>;
    bonus(id: string, duration: number | string): Record<string, unknown>;
    reset(id: string): Record<string, unknown>;
    remove(id: string): void;
  };
  schedule: {
    set(sched: ScheduleInput): Record<string, unknown>;
  };
  dns: {
    block(domain: string): string;
    unblock(domain: string): void;
    category(id: string, enabled: boolean): Record<string, unknown>;
  };
}

export default function curfewd(options?: CurfewdOptions): CurfewdInstance;
export function parseDurationMinutes(input: number | string): number | null;
export function formatDuration(seconds: number): string;
export function normalizeMac(mac: string): string;
export function autoDetectRouter(): Promise<Record<string, unknown>>;
