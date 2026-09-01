/**
 * The `DiagReport` (design-ossDx.md §3.4) and the localStorage hand-off that
 * carries it off the LCD.
 *
 * Two surfaces, one report: `?kraken=1&diag=1` renders it big enough to
 * photograph AND publishes it; `#/diag` on the configuration page reads it back
 * and offers Copy JSON. That hand-off is the mechanic the entire hardware
 * checklist depends on.
 */

import { buildInfo } from '../buildInfo';
import { logRing, type LogEntry } from '../lib/log';
import { readRaw, writeRaw } from '../platform/storage';

import type { DeviceProbe, Histogram, InjectionProbe, StorageProbe } from './probes';
import type { Capabilities } from '../platform/capabilities';

export const DIAG_SCHEMA_VERSION = 1;

/** `kraken-hub:v1:diag:display` — where the display publishes its report. */
export const DIAG_DISPLAY_SUFFIX = 'diag:display';

/** How often the display republishes while `?diag=1` is on. */
export const DIAG_PUBLISH_INTERVAL_MS = 5000;

export interface DiagReport {
  schemaVersion: number;
  capturedAt: number;
  app: { version: string; gitSha: string; buildTime: string };
  mode: 'display' | 'config';
  device: DeviceProbe;
  injection: InjectionProbe;
  capabilities: Capabilities;
  timings: {
    /** In-page rAF frame rate (H12). */
    rafFps: Histogram | null;
    /** CAM monitoring-feed interval histogram in ms (H04). */
    monitoringIntervalMs: Histogram | null;
    achievedFps: number | null;
    longFrames: number | null;
  };
  storage: StorageProbe;
  /** Anything the user must answer by looking at the panel (H08, H20, H21). */
  manual: Record<string, string | null>;
  notes: LogEntry[];
}

export function newReport(input: {
  mode: 'display' | 'config';
  device: DeviceProbe;
  injection: InjectionProbe;
  capabilities: Capabilities;
  storage: StorageProbe;
  timings: DiagReport['timings'];
  manual?: Record<string, string | null>;
}): DiagReport {
  return {
    schemaVersion: DIAG_SCHEMA_VERSION,
    capturedAt: Date.now(),
    app: buildInfo(),
    mode: input.mode,
    device: input.device,
    injection: input.injection,
    capabilities: input.capabilities,
    timings: input.timings,
    storage: input.storage,
    manual: input.manual ?? { visibleRadiusPct: null, audioAudible: null, dimsWhenIdle: null },
    notes: logRing().slice(-16),
  };
}

/** Display side: hand the report to the configuration browser. */
export function publishDisplayReport(report: DiagReport): void {
  writeRaw(DIAG_DISPLAY_SUFFIX, JSON.stringify(report));
}

/** Config side: read whatever the display last published. Never throws. */
export function readDisplayReport(): DiagReport | null {
  const raw = readRaw(DIAG_DISPLAY_SUFFIX);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const report = parsed as DiagReport;
    return report.schemaVersion === DIAG_SCHEMA_VERSION ? report : null;
  } catch {
    return null;
  }
}

/**
 * The clipboard form of a report — already redacted; nothing private is in it.
 *
 * Takes `unknown` rather than `DiagReport` because the About page's Copy button
 * puts BOTH halves on the clipboard when it has them —
 * `{ config: …, kraken: … }` — and an issue with the config browser's probes
 * beside the panel's own is worth several rounds of questions. The shape is
 * still only ever built here or from a `DiagReport`; the loose parameter is so
 * the pair does not need a wrapper type nobody else would use.
 */
export function toJson(report: unknown): string {
  return JSON.stringify(report, null, 2);
}
