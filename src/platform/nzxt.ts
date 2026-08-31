/**
 * The ONE file allowed to write to `window.nzxt` (invariant I2).
 *
 * The official NZXT sample code does `window.nzxt = { v1: { onMonitoringDataUpdate } }`,
 * which destroys the `width`/`height`/`shape`/`targetFps` CAM injected — the
 * single most damaging footgun on this platform. We only ever assign a leaf
 * property, and we only create the containers when they are genuinely absent.
 *
 * Injection timing is not guaranteed: CAM may inject before script evaluation,
 * after `load`, or (after a sleep/wake cycle) inject a *second* object over the
 * first. Hence the retry ladder, the 2 s re-read, and `rearmMonitoringHandler`.
 */

import { createLogger } from '../lib/log';

import {
  FALLBACK_HEIGHT,
  FALLBACK_SHAPE,
  FALLBACK_TARGET_FPS,
  FALLBACK_WIDTH,
  type Shape,
} from './devicePresets';

const log = createLogger('platform/nzxt');

/** Retry ladder: an immediate attempt, then every 200 ms, 10 attempts total. */
export const NZXT_RETRY_INTERVAL_MS = 200;
export const NZXT_RETRY_ATTEMPTS = 10;
/** `targetFps` is re-read on this cadence: CAM may move the slider under us. */
export const DISPLAY_INFO_POLL_MS = 2000;

export interface DisplayInfo {
  width: number;
  height: number;
  shape: Shape;
  targetFps: number;
  dpr: number;
  /** Where the numbers came from. Surfaced in diagnostics and telemetry. */
  source: 'nzxt' | 'fallback';
}

interface InjectionRecord {
  /** ms from `performance.timeOrigin` to the first successful read, or null. */
  firstSeenMs: number | null;
  attempts: number;
  /** How many times a *different* object appeared at `window.nzxt`. */
  reinjections: number;
}

const injection: InjectionRecord = { firstSeenMs: null, attempts: 0, reinjections: 0 };
let lastSeenApi: NzxtV1.Api | null = null;

/** Read-only peek. Never mutates, never creates. */
export function peekNzxt(): NzxtV1.Api | null {
  const api = window.nzxt?.v1 ?? null;
  if (api !== null && api !== lastSeenApi) {
    if (lastSeenApi !== null) injection.reinjections += 1;
    injection.firstSeenMs ??= Math.round(performance.now());
    lastSeenApi = api;
  }
  return api;
}

/** Timing/retry facts for the diagnostics report (H03). */
export function injectionReport(): Readonly<InjectionRecord> {
  return { ...injection };
}

function coerceShape(raw: unknown): Shape {
  if (raw === 'circle') return 'circle';
  // A community bug report shows CAM emitting 'rectangle'. Anything unknown is
  // treated as square: no mask, no inset loss, nothing cropped away.
  if (raw !== 'square') log.warn(`unknown shape ${String(raw)} — treating as square`);
  return 'square';
}

function coerceDimension(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.round(raw) : fallback;
}

/**
 * Panel facts as the platform reports them, with defaults when CAM is absent.
 *
 * `targetFps` falls back to CAM's own factory default (1) so diagnostics never
 * misreport what the platform said. `geometry.readGeometry()` substitutes
 * `PlatformPrefs.fallbackTargetFps` when `source === 'fallback'`.
 */
export function getDisplayInfo(): DisplayInfo {
  const api = peekNzxt();
  const dpr = Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio : 1;
  if (api === null) {
    return {
      width: FALLBACK_WIDTH,
      height: FALLBACK_HEIGHT,
      shape: FALLBACK_SHAPE,
      targetFps: FALLBACK_TARGET_FPS,
      dpr,
      source: 'fallback',
    };
  }
  const fps = coerceDimension(api.targetFps, FALLBACK_TARGET_FPS);
  return {
    width: coerceDimension(api.width, FALLBACK_WIDTH),
    height: coerceDimension(api.height, FALLBACK_HEIGHT),
    shape: coerceShape(api.shape),
    targetFps: Math.min(Math.max(fps, 1), 60),
    dpr,
    source: 'nzxt',
  };
}

function sameInfo(a: DisplayInfo, b: DisplayInfo): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.shape === b.shape &&
    a.targetFps === b.targetFps &&
    a.dpr === b.dpr &&
    a.source === b.source
  );
}

/**
 * Re-reads `window.nzxt.v1` every 2 s and reports changes. It is UNVERIFIED
 * whether CAM mutates `targetFps` live when the user drags the slider (H16),
 * so we poll rather than assume either way.
 */
export function subscribeDisplayInfo(
  cb: (info: DisplayInfo) => void,
  intervalMs = DISPLAY_INFO_POLL_MS,
): () => void {
  let previous = getDisplayInfo();
  const timer = setInterval(() => {
    const next = getDisplayInfo();
    if (sameInfo(previous, next)) return;
    previous = next;
    cb(next);
  }, intervalMs);
  return () => {
    clearInterval(timer);
  };
}

/**
 * Resolves with the injected API, or `null` after the retry ladder is spent.
 * Callers must not await this before painting — kick it and react on resolve.
 */
export function whenNzxt(
  timeoutMs = NZXT_RETRY_INTERVAL_MS * NZXT_RETRY_ATTEMPTS,
): Promise<NzxtV1.Api | null> {
  const immediate = peekNzxt();
  injection.attempts += 1;
  if (immediate !== null) return Promise.resolve(immediate);

  return new Promise((resolve) => {
    const deadline = performance.now() + timeoutMs;
    const timer = setInterval(() => {
      injection.attempts += 1;
      const api = peekNzxt();
      if (api !== null) {
        clearInterval(timer);
        log.info(`window.nzxt appeared after ${String(injection.attempts)} attempts`);
        resolve(api);
        return;
      }
      if (performance.now() >= deadline) {
        clearInterval(timer);
        log.warn('window.nzxt never appeared — running on fallback geometry');
        resolve(null);
      }
    }, NZXT_RETRY_INTERVAL_MS);
  });
}

let currentHandler: ((d: NzxtV1.MonitoringData) => void) | null = null;

/**
 * Installs the 1 Hz monitoring handler by LEAF PROPERTY ASSIGNMENT.
 * Containers are created only when absent, never replaced.
 */
export function setMonitoringHandler(handler: (d: NzxtV1.MonitoringData) => void): () => void {
  currentHandler = handler;
  bindHandler();
  return () => {
    if (currentHandler !== handler) return;
    currentHandler = null;
    const api = window.nzxt?.v1;
    // `delete`, not `= undefined`: the property is declared optional without an
    // explicit `| undefined`, and we must not widen CAM's own object shape.
    if (api?.onMonitoringDataUpdate === handler) delete api.onMonitoringDataUpdate;
  };
}

function bindHandler(): void {
  if (currentHandler === null) return;
  const w = window;
  w.nzxt ??= {};
  w.nzxt.v1 ??= {
    width: FALLBACK_WIDTH,
    height: FALLBACK_HEIGHT,
    shape: FALLBACK_SHAPE,
    targetFps: FALLBACK_TARGET_FPS,
  };
  w.nzxt.v1.onMonitoringDataUpdate = currentHandler;
}

/**
 * Re-attach after a suspected re-injection (pageshow, visibilitychange, the
 * watchdog). CAM can swap the whole `window.nzxt` object after a sleep/wake,
 * silently orphaning our handler.
 */
export function rearmMonitoringHandler(): void {
  peekNzxt();
  bindHandler();
}

let tripwireInstalled = false;

/**
 * DEV-only tripwire for invariant I2: logs a stack trace when anything replaces
 * `window.nzxt` wholesale, while still letting the assignment through so real
 * CAM injection is never broken by our own diagnostics.
 */
export function installNzxtTripwire(): void {
  if (tripwireInstalled || !import.meta.env.DEV) return;
  tripwireInstalled = true;
  let stored: Window['nzxt'] = window.nzxt;
  Object.defineProperty(window, 'nzxt', {
    configurable: true,
    get: () => stored,
    set: (value: Window['nzxt']) => {
      if (stored !== undefined && stored !== value) {
        log.error(
          'window.nzxt was REPLACED — CAM geometry is destroyed by this. ' +
            'Assign leaf properties via src/platform/nzxt.ts instead.',
          new Error('window.nzxt reassignment').stack,
        );
      }
      stored = value;
    },
  });
}
