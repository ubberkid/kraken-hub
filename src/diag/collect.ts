/**
 * The quick probe set — what a display runs when a paired remote asks for a
 * hardware report, as opposed to what `?diag=1` runs while somebody watches.
 *
 * `DiagOverlay` can take its time: it is on screen, it republishes every five
 * seconds, and nobody is waiting on a phone. This path is the opposite — a
 * person tapped a button on another machine and is looking at a spinner — so it
 * is BUDGETED. Everything synchronous runs immediately, the one probe that
 * genuinely needs a window (the 3 s rAF sampler, H12) gets that window, and the
 * whole thing is capped: a probe that hangs produces a report with a null field,
 * never a request that never answers.
 *
 * Nothing here is on the display's critical path. It is reached through a
 * dynamic `import()` from `src/app/display/sync.ts` — the same lazy pattern
 * `DiagOverlay` uses — so the LCD downloads the probes only if a report is
 * actually requested.
 */

import { probeApiSurface, probeDevice, probeInjection, probeStorage, sampleRafFps } from './probes';
import { newReport, type DiagReport } from './report';

import type { StorageProbe } from './probes';
import type { Geometry } from '../platform/geometry';

/** H12's sampling window. The same 3 s the on-LCD overlay uses. */
export const QUICK_RAF_SAMPLE_MS = 3000;

/** The whole collection's ceiling, rAF window included. */
export const QUICK_BUDGET_MS = 5000;

export interface QuickProbeInput {
  geometry: Geometry;
  /** `FrameClock.stats()`, read by the caller so this file stays runtime-free. */
  achievedFps: number | null;
  longFrames: number | null;
}

/** What a storage probe that never resolved contributes: honest emptiness. */
const UNMEASURED_STORAGE: StorageProbe = {
  usageBytes: null,
  quotaBytes: null,
  persisted: null,
  localStorageAvailable: false,
  localStorageDegraded: false,
  delivery: { viaEvent: 0, viaPoll: 0, viaMem: 0 },
};

/** Resolves to `null` rather than hanging. The timer never keeps the page alive. */
function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => {
      resolve(null);
    }, ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * Run the quick set and build a `DiagReport`.
 *
 * Never rejects: a diagnostics pull that throws would leave the remote showing
 * "the display did not answer", which is a lie about a display that is plainly
 * running. A field that could not be measured is `null`, and `null` already
 * means "not measured" everywhere a report is read.
 */
export async function collectQuickReport(input: QuickProbeInput): Promise<DiagReport> {
  // Concurrent, not sequential: the storage estimate is I/O and has no reason
  // to wait behind three seconds of frame sampling.
  const [rafFps, storage] = await Promise.all([
    within(sampleRafFps(QUICK_RAF_SAMPLE_MS), QUICK_BUDGET_MS),
    within(probeStorage(), QUICK_BUDGET_MS),
  ]);

  return newReport({
    mode: 'display',
    device: probeDevice(input.geometry),
    injection: probeInjection(),
    capabilities: probeApiSurface(),
    storage: storage ?? UNMEASURED_STORAGE,
    timings: {
      rafFps,
      // H04 needs a CAM monitoring feed sampled over a minute; this path is
      // budgeted at five seconds, so it is honestly absent rather than wrong.
      monitoringIntervalMs: null,
      achievedFps: input.achievedFps,
      longFrames: input.longFrames,
    },
  });
}
