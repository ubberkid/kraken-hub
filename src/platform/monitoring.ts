/**
 * The 1 Hz CAM monitoring feed: one handler installed, fanned out to N
 * subscribers, normalised into a shape modules can render without guessing.
 *
 * Every numeric field in the official types is `number | undefined`, and that
 * optionality is preserved deliberately — a module must render an em-dash, not
 * `NaN`, when CAM has nothing to report. There is NO pump-RPM field; the cooler
 * exposes `kraken.liquidTemperature` and nothing else.
 */

import { createLogger } from '../lib/log';

import { rearmMonitoringHandler, setMonitoringHandler } from './nzxt';

const log = createLogger('platform/monitoring');

/** No sample for this long means the feed is stale (the watchdog escalates). */
export const MONITORING_STALE_MS = 8000;

export interface NormalizedMonitoring {
  cpu: {
    name?: string;
    load?: number;
    tempC?: number;
    freqMhz?: number;
    powerW?: number;
    cores?: number;
    fanRpm?: number;
  };
  gpu: { name?: string; load?: number; tempC?: number; freqMhz?: number; powerW?: number };
  ram: { usedMiB?: number; totalMiB?: number; pct?: number };
  /** The only cooler field CAM exposes. */
  kraken: { liquidTempC?: number };
  at: number;
  simulated: boolean;
}

export interface MonitoringSource {
  latest(): { norm: NormalizedMonitoring; raw: NzxtV1.MonitoringData } | null;
  subscribe(cb: (n: NormalizedMonitoring, raw: NzxtV1.MonitoringData) => void): () => void;
  lastUpdateAt(): number;
  isStale(): boolean;
  isSimulated(): boolean;
  /** Sample intervals in ms, newest last — feeds the H04 histogram. */
  intervals(): readonly number[];
  rearm(): void;
  dispose(): void;
}

function put<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

export function normalizeMonitoring(
  raw: NzxtV1.MonitoringData,
  opts: { simulated: boolean; at?: number },
): NormalizedMonitoring {
  const cpu0 = raw.cpus?.[0];
  const gpu0 = raw.gpus?.[0];
  const norm: NormalizedMonitoring = {
    cpu: {},
    gpu: {},
    ram: {},
    kraken: {},
    at: opts.at ?? Date.now(),
    simulated: opts.simulated,
  };

  if (cpu0 !== undefined) {
    put(norm.cpu, 'name', cpu0.name);
    put(norm.cpu, 'load', cpu0.load);
    put(norm.cpu, 'tempC', cpu0.temperature);
    put(norm.cpu, 'freqMhz', cpu0.frequency);
    put(norm.cpu, 'powerW', cpu0.power);
    put(norm.cpu, 'cores', cpu0.numCores);
    put(norm.cpu, 'fanRpm', cpu0.fanSpeed);
  }
  if (gpu0 !== undefined) {
    put(norm.gpu, 'name', gpu0.name);
    put(norm.gpu, 'load', gpu0.load);
    put(norm.gpu, 'tempC', gpu0.temperature);
    put(norm.gpu, 'freqMhz', gpu0.frequency);
    put(norm.gpu, 'powerW', gpu0.power);
  }
  const ram = raw.ram;
  if (ram !== undefined) {
    put(norm.ram, 'usedMiB', ram.inUse);
    put(norm.ram, 'totalMiB', ram.totalSize);
    if (ram.inUse !== undefined && ram.totalSize !== undefined && ram.totalSize > 0) {
      norm.ram.pct = ram.inUse / ram.totalSize;
    }
  }
  put(norm.kraken, 'liquidTempC', raw.kraken?.liquidTemperature);
  return norm;
}

const MAX_INTERVALS = 120;

export function createMonitoringSource(opts: { simulated: boolean }): MonitoringSource {
  const subs = new Set<(n: NormalizedMonitoring, raw: NzxtV1.MonitoringData) => void>();
  const gaps: number[] = [];
  let last: { norm: NormalizedMonitoring; raw: NzxtV1.MonitoringData } | null = null;
  let lastAt = 0;

  const handler = (raw: NzxtV1.MonitoringData): void => {
    const at = Date.now();
    if (lastAt !== 0) {
      gaps.push(at - lastAt);
      if (gaps.length > MAX_INTERVALS) gaps.shift();
    }
    lastAt = at;
    const norm = normalizeMonitoring(raw, { simulated: opts.simulated, at });
    last = { norm, raw };
    for (const cb of subs) {
      try {
        cb(norm, raw);
      } catch (err) {
        log.error('monitoring subscriber threw', err);
      }
    }
  };

  const detach = setMonitoringHandler(handler);

  return {
    latest: () => last,
    subscribe(cb) {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    lastUpdateAt: () => lastAt,
    isStale: () => lastAt !== 0 && Date.now() - lastAt > MONITORING_STALE_MS,
    isSimulated: () => opts.simulated,
    intervals: () => gaps.slice(),
    rearm: rearmMonitoringHandler,
    dispose() {
      subs.clear();
      detach();
    },
  };
}
