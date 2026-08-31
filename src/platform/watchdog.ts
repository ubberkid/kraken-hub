/**
 * Liveness watchdog for a page that runs unattended for weeks.
 *
 * Driven by `setInterval`, deliberately NOT by rAF — rAF is exactly the thing
 * that may have stalled (documented freeze-after-Windows-sleep failure mode),
 * and browsers throttle rAF hard in a hidden window, which the Kraken Browser
 * always is.
 *
 * M0 implements detection plus the soft re-init step. Remount and the
 * rate-limited `location.reload()` escalations land with the video module (M1),
 * where there is finally something worth remounting.
 */

import { createLogger } from '../lib/log';

import { type FrameClock } from './fpsGovernor';
import { MONITORING_STALE_MS, type MonitoringSource } from './monitoring';
import { rearmMonitoringHandler } from './nzxt';

const log = createLogger('platform/watchdog');

export type ReinitReason =
  'resume' | 'raf-stall' | 'monitoring-stall' | 'media-stall' | 'geometry-change' | 'manual';

export const WATCHDOG_INTERVAL_MS = 2000;
const MIN_RAF_STALL_MS = 3000;

export interface WatchdogEvent {
  at: number;
  reason: ReinitReason;
  detail: string;
}

export interface Watchdog {
  start(): void;
  stop(): void;
  /** Ring buffer of every trip, surfaced in `?diag=1` and telemetry. */
  report(): readonly WatchdogEvent[];
  trip(reason: ReinitReason, detail?: string): void;
}

export interface WatchdogOptions {
  frameClock: FrameClock;
  monitoring: MonitoringSource;
  /** True in the hidden Kraken Browser: monitoring staleness only matters there. */
  isKraken: boolean;
  onSoftReinit: (reason: ReinitReason) => void;
}

const RING = 64;

export function createWatchdog(o: WatchdogOptions): Watchdog {
  const events: WatchdogEvent[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastTripAt = 0;
  let listenersAttached = false;

  const trip = (reason: ReinitReason, detail = ''): void => {
    const now = Date.now();
    // One recovery attempt per watchdog interval, whatever the detector count.
    if (now - lastTripAt < WATCHDOG_INTERVAL_MS) return;
    lastTripAt = now;
    events.push({ at: now, reason, detail });
    if (events.length > RING) events.shift();
    log.warn(`soft re-init: ${reason} ${detail}`);
    rearmMonitoringHandler();
    o.onSoftReinit(reason);
  };

  const check = (): void => {
    const stats = o.frameClock.stats();
    if (!stats.paused && stats.lastTickAt !== 0) {
      const stalledFor = performance.now() - stats.lastTickAt;
      const limit = Math.max(MIN_RAF_STALL_MS, 5 * (1000 / Math.max(stats.achievedFps, 1)));
      if (stalledFor > limit) {
        trip('raf-stall', `${String(Math.round(stalledFor))}ms without a frame`);
        return;
      }
    }
    if (o.isKraken && o.monitoring.lastUpdateAt() !== 0 && o.monitoring.isStale()) {
      trip('monitoring-stall', `no CAM sample for >${String(MONITORING_STALE_MS)}ms`);
    }
  };

  const onVisible = (): void => {
    if (document.visibilityState !== 'visible') return;
    o.frameClock.resume('visibilitychange');
    trip('resume', 'visibilitychange');
  };
  const onPageShow = (e: PageTransitionEvent): void => {
    o.frameClock.resume('pageshow');
    trip('resume', e.persisted ? 'pageshow(bfcache)' : 'pageshow');
  };

  return {
    start() {
      if (timer !== null) return;
      timer = setInterval(check, WATCHDOG_INTERVAL_MS);
      if (!listenersAttached) {
        listenersAttached = true;
        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('pageshow', onPageShow);
      }
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      if (listenersAttached) {
        listenersAttached = false;
        document.removeEventListener('visibilitychange', onVisible);
        window.removeEventListener('pageshow', onPageShow);
      }
    },
    report: () => events.slice(),
    trip,
  };
}
