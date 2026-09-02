/**
 * What the editor's stats layers read — and what the app is allowed to say
 * about it.
 *
 * The halo runs the real stats renderer, so it needs a real `MonitoringSource`.
 * There are exactly two honest ones on the configuration window:
 *
 *  - **Live**, when the display is publishing telemetry: the 0.5 Hz monitoring
 *    snapshot off the wire, converted by `snapshotToMonitoring` — the same path
 *    the phone's replica ring already uses, so the dial in the editor and the
 *    dial on the phone cannot disagree.
 *  - **Sample data**, otherwise: the simulator's own generator
 *    (`platform/simulator.ts`), shared rather than reimplemented so the fiction
 *    in the editor is the same fiction `?sim=` shows on the display.
 *
 * The second one is a claim, and it is labelled: `isSimulated()` is `true`, and
 * the editor prints "sample data" next to it through the claims registry. A
 * temperature gauge that shows made-up numbers without saying so is the single
 * most dishonest thing a cooler app can do — somebody will read 82 °C off it and
 * go looking for a fan.
 */

import { normalizeMonitoring, MONITORING_STALE_MS } from '../../../platform/monitoring';
import { createMonitoringGenerator } from '../../../platform/simulator';
import { snapshotToMonitoring, type MonitorSnapshot } from '../../../sync/monitorSnapshot';

import type { MonitoringSource, NormalizedMonitoring } from '../../../platform/monitoring';

/** 1 Hz, like the CAM feed it stands in for. Never faster on this window. */
export const PREVIEW_TICK_MS = 1000;

export interface PreviewMonitoringInput {
  /** The latest wire snapshot, or `null` when nothing is publishing. */
  snapshot: MonitorSnapshot | null;
  /** When it was sampled, on the DISPLAY's clock. */
  at: number;
}

export interface PreviewMonitoring {
  source: MonitoringSource;
  /** Hand it a newer wire snapshot. Cheap and idempotent. */
  push: (input: PreviewMonitoringInput) => void;
  stop: () => void;
}

/**
 * Is this window about to invent the numbers? — round 10's F8.
 *
 * The same test `createPreviewMonitoring`'s `isSimulated()` answers, lifted out
 * as a pure function so a SURFACE can ask it before it draws. The halo runs the
 * real stats renderer against this source, so on a window with no telemetry the
 * dials read `41 °C · CPU · 16 % load` — plausible, useful for arranging a face,
 * and entirely made up — and nothing anywhere on the editor said so. Saying so
 * requires knowing, and knowing required this, because the source itself is
 * created inside the compositor's effect and never handed back out.
 *
 * One definition, used by both: the constructor's `live()` calls it.
 */
export function monitoringIsSimulated(
  input: PreviewMonitoringInput,
  now: number = Date.now(),
): boolean {
  return !(input.snapshot !== null && now - input.at < MONITORING_STALE_MS);
}

/**
 * A monitoring source that prefers the wire and falls back to sample data.
 *
 * The fallback runs on a timer rather than on demand because the stats
 * renderers subscribe: a source that only answered `latest()` would leave the
 * dials on "Waiting for CAM data…" forever, which is the honest state for a
 * source with nothing — and this one HAS something to show, it is simply not
 * the user's machine.
 */
export function createPreviewMonitoring(initial: PreviewMonitoringInput): PreviewMonitoring {
  const subs = new Set<(n: NormalizedMonitoring, raw: NzxtV1.MonitoringData) => void>();
  const nextSample = createMonitoringGenerator('idle');

  let wire = initial;
  let latest: { norm: NormalizedMonitoring; raw: NzxtV1.MonitoringData } | null = null;
  let lastAt = 0;

  const live = (): boolean => !monitoringIsSimulated(wire);

  const emit = (norm: NormalizedMonitoring, raw: NzxtV1.MonitoringData): void => {
    latest = { norm, raw };
    lastAt = Date.now();
    for (const cb of subs) cb(norm, raw);
  };

  const tick = (): void => {
    // A hidden tab costs nothing, exactly as the replica ring does.
    if (document.hidden) return;
    if (live() && wire.snapshot !== null) {
      // No raw payload crosses the wire; an empty object is the honest
      // stand-in for what was not sent.
      emit(snapshotToMonitoring(wire.snapshot, wire.at), {});
      return;
    }
    const raw = nextSample();
    emit(normalizeMonitoring(raw, { simulated: true, at: Date.now() }), raw);
  };

  tick();
  const timer = setInterval(tick, PREVIEW_TICK_MS);

  return {
    source: {
      latest: () => latest,
      subscribe(cb) {
        subs.add(cb);
        return () => {
          subs.delete(cb);
        };
      },
      lastUpdateAt: () => lastAt,
      isStale: () => lastAt !== 0 && Date.now() - lastAt > MONITORING_STALE_MS,
      /** The whole point of the label: this window says which of the two it is. */
      isSimulated: () => !live(),
      intervals: () => [],
      rearm: () => undefined,
      dispose: () => {
        subs.clear();
      },
    },
    push(next) {
      wire = next;
    },
    stop() {
      clearInterval(timer);
      subs.clear();
    },
  };
}
