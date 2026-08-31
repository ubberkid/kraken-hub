/**
 * Diagnostic probes.
 *
 * Everything the design docs mark "⚠ not verified on hardware" has a probe
 * here, because we own no Kraken and the CAM webview is a black box. The
 * display page runs them and publishes the result through localStorage; the
 * configuration page reads it back — which is the only way to get text off an
 * LCD you cannot select, copy or scroll.
 */

import { probeCapabilities, type Capabilities } from '../platform/capabilities';
import { probeStorageEstimate, type StorageEstimate2 } from '../platform/idb';
import { injectionReport, peekNzxt } from '../platform/nzxt';
import { isStorageAvailable, isDegraded } from '../platform/storage';
import { deliveryCounters } from '../state/storage';

import type { Geometry } from '../platform/geometry';

export interface DeviceProbe {
  width: number;
  height: number;
  shape: string;
  targetFps: number;
  geometrySource: string;
  dpr: number;
  safeInsetPx: number;
  inscribedSquarePx: number;
  screen: { width: number; height: number; innerWidth: number; innerHeight: number };
  /** H01: exactly what CAM injected, or null when it never did. */
  nzxtRaw: { width: number; height: number; shape: string; targetFps: number } | null;
}

export function probeDevice(geometry: Geometry): DeviceProbe {
  const api = peekNzxt();
  return {
    width: geometry.width,
    height: geometry.height,
    shape: geometry.shape,
    targetFps: geometry.targetFps,
    geometrySource: geometry.source,
    dpr: geometry.dpr,
    safeInsetPx: geometry.safeInsetPx,
    inscribedSquarePx: geometry.inscribedSquarePx,
    screen: {
      width: window.screen.width,
      height: window.screen.height,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    },
    nzxtRaw:
      api === null
        ? null
        : { width: api.width, height: api.height, shape: api.shape, targetFps: api.targetFps },
  };
}

export interface InjectionProbe {
  /** H03: ms from `performance.timeOrigin` to the first successful read. */
  firstSeenMs: number | null;
  attempts: number;
  reinjections: number;
  present: boolean;
}

export function probeInjection(): InjectionProbe {
  return { ...injectionReport(), present: peekNzxt() !== null };
}

export interface Histogram {
  count: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

/** H04/H12: percentile summary of a sample series. Empty input is honest, not zero. */
export function histogram(samples: readonly number[]): Histogram {
  if (samples.length === 0) return { count: 0, p50: null, p95: null, max: null };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] ?? 0 };
}

/**
 * H12: in-page rAF frame rate, which distinguishes "the page is slow" from
 * "CAM captures slowly". Ungated by `targetFps` on purpose — this measures the
 * browser, not our governor.
 */
export function sampleRafFps(durationMs: number): Promise<Histogram> {
  return new Promise((resolve) => {
    const gaps: number[] = [];
    let last = performance.now();
    const deadline = last + durationMs;
    const step = (now: number): void => {
      gaps.push(1000 / Math.max(now - last, 0.001));
      last = now;
      if (now >= deadline) resolve(histogram(gaps));
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

export interface StorageProbe extends StorageEstimate2 {
  localStorageAvailable: boolean;
  localStorageDegraded: boolean;
  /** H14: how state changes actually arrived — `storage` event vs 1 s poll. */
  delivery: { viaEvent: number; viaPoll: number; viaMem: number };
}

export async function probeStorage(): Promise<StorageProbe> {
  const estimate = await probeStorageEstimate();
  return {
    ...estimate,
    localStorageAvailable: isStorageAvailable(),
    localStorageDegraded: isDegraded(),
    delivery: deliveryCounters(),
  };
}

export function probeApiSurface(): Capabilities {
  return probeCapabilities();
}

/**
 * H19: reachability of the sync endpoints from inside the webview. Opt-in only
 * — a diagnostics page must never make network requests nobody asked for.
 * The transports shipped in M2 and report their own live status on the Remote
 * page, which is a real answer for a *paired* room. H19 is the different, still
 * unmeasured question — whether CAM's webview can reach these hosts at all — and
 * answering it needs a deliberate probe that has not been built. The targets are
 * listed here so the diagnostics page can name them honestly meanwhile.
 */
export const NETWORK_TARGETS: readonly { id: string; label: string }[] = [
  { id: 'mqtt', label: 'MQTT over WSS (broker, port 8084)' },
  { id: 'ntfy', label: 'ntfy fallback (HTTPS)' },
];
