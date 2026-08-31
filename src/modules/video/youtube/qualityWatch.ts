/**
 * The quality watchdog (design-videoEngine.md §2.7) — the runtime around
 * `qualityPolicy.decideQuality`.
 *
 * `onPlaybackQualityChange` is the only readable quality signal an embed gives
 * us, and it reports a LABEL, not a reason. This file's whole job is to turn one
 * label plus buffer health into the right one of two opposite actions:
 *
 *  - **size-limited** (healthy buffer, low label): YouTube thinks the player is
 *    small. Make the element wider — 1920 → 2560 — and remount, preserving the
 *    playhead. Exactly ONCE: if that does not help, the cap is not ours to lift.
 *  - **network-limited** (starved buffer, or repeated buffering): a wider
 *    element would ask for MORE bytes over the same pipe and make it worse. In
 *    `auto` we step down instead, to 1280, cutting decode and composite cost.
 *
 * The step survives a reload through `sessionStorage` — deliberately session
 * scoped, because it is a reaction to *this machine right now*, and restoring a
 * 2560×2560 element next month because the Wi-Fi was bad once would be wrong.
 */

import { readSessionRaw, removeSessionRaw, writeSessionRaw } from '../../../platform/storage';
import { QUALITY_FLOOR_PX_PERFORMANCE, YT_LADDER } from '../types';

import {
  BUFFERING_WINDOW_MS,
  WATCHDOG_ARM_MS,
  YT_LADDER_STORAGE_KEY,
  decideQuality,
  qualityLabelToHeight,
} from './qualityPolicy';

import type { PerfMode } from '../types';
import type { QualityDecision, QualityTelemetry } from './qualityPolicy';

/**
 * §2.7 — the network-limited step-down target is the *performance floor*
 * (1280), not merely the next rung down (1600).
 *
 * `decideQuality` is a generic ladder policy and returns the adjacent rung;
 * §2.7 names 1280 explicitly, because the point of stepping down under network
 * pressure is to reach the cheapest configuration that still supersamples a 640
 * panel, not to shave one rung and re-evaluate 6 s later.
 */
export const NETWORK_LIMITED_WIDTH = QUALITY_FLOOR_PX_PERFORMANCE;

export interface QualityClock {
  now(): number;
}

export interface QualityWatchOptions {
  /** The element width currently mounted. */
  initialWidth: number;
  perf: PerfMode;
  ladder?: readonly number[];
  /** Live buffer signals, read at decision time only. */
  getSignals: () => { loadedFraction: number; duration: number; currentTime: number };
  /** Remount at this width, preserving the playhead. */
  onStep: (width: number, decision: QualityDecision) => void;
  onTelemetry: (
    kind: QualityTelemetry,
    detail: { reason: string; observedHeight: number | null },
  ) => void;
  /** Fires on every `onPlaybackQualityChange`, for the `quality` adapter event. */
  onQuality?: (height: number | null, label: string | null) => void;
  clock?: QualityClock;
  armMs?: number;
}

export interface QualityWatch {
  /** The first `PLAYING` arms the watchdog; later ones are ignored. */
  notePlaying(): void;
  noteBuffering(): void;
  noteQuality(label: string | null): void;
  /** Drives the armed watchdog. Safe to call every frame. */
  tick(): void;
  currentWidth(): number;
  observedHeight(): number | null;
  sizeCapProven(): boolean;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Ladder persistence (§2.7)
// ---------------------------------------------------------------------------

// device-size-ok: the floor on the YouTube ELEMENT ladder (iframe px), not a panel.
const MIN_LADDER_WIDTH = 640;
const MAX_LADDER_WIDTH = 4096;

/** The remembered step for this browser session, or `null`. */
export function readLadderOverride(): number | null {
  const raw = readSessionRaw(YT_LADDER_STORAGE_KEY);
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MIN_LADDER_WIDTH || n > MAX_LADDER_WIDTH) {
    removeSessionRaw(YT_LADDER_STORAGE_KEY);
    return null;
  }
  return Math.round(n);
}

export function writeLadderOverride(width: number): void {
  writeSessionRaw(YT_LADDER_STORAGE_KEY, String(Math.round(width)));
}

export function clearLadderOverride(): void {
  removeSessionRaw(YT_LADDER_STORAGE_KEY);
}

// ---------------------------------------------------------------------------

const realClock: QualityClock = { now: () => Date.now() };

export function createQualityWatch(opts: QualityWatchOptions): QualityWatch {
  const clock = opts.clock ?? realClock;
  const armMs = opts.armMs ?? WATCHDOG_ARM_MS;
  const ladder = opts.ladder ?? YT_LADDER;

  let width = opts.initialWidth;
  let armedAt: number | null = null;
  let decided = false;
  let steppedUp = false;
  let sizeCap = false;
  let height: number | null = null;
  let bufferingAt: number[] = [];
  let disposed = false;

  function bufferingIn30s(now: number): number {
    bufferingAt = bufferingAt.filter((ts) => now - ts <= BUFFERING_WINDOW_MS);
    return bufferingAt.length;
  }

  function evaluate(now: number): void {
    const live = opts.getSignals();
    const decision = decideQuality({
      observedHeight: height,
      loadedFraction: live.loadedFraction,
      duration: live.duration,
      currentTime: live.currentTime,
      bufferingEventsIn30s: bufferingIn30s(now),
      currentWidth: width,
      steppedUp,
      perf: opts.perf,
      ladder,
    });

    if (decision.sizeCapProven) sizeCap = true;

    if (decision.action === 'step-up') {
      steppedUp = true;
      width = decision.nextWidth;
      writeLadderOverride(width);
      // Re-arm: the remounted player needs its own 6 s before we judge it.
      armedAt = null;
      decided = false;
      opts.onStep(width, decision);
      return;
    }

    if (decision.action === 'step-down') {
      const next = Math.min(decision.nextWidth, NETWORK_LIMITED_WIDTH);
      opts.onTelemetry(decision.telemetry, {
        reason: decision.reason,
        observedHeight: height,
      });
      if (next < width) {
        width = next;
        writeLadderOverride(width);
        opts.onStep(width, { ...decision, nextWidth: next });
      }
      decided = true;
      return;
    }

    // 'ok' or 'hold'. Publish what we learned; stop watching only when the
    // answer is final. `quality-unknown` (the label never fired) is not final,
    // so re-arm for another window rather than deciding on no evidence — and
    // rather than re-publishing the same telemetry line every frame.
    opts.onTelemetry(decision.telemetry, { reason: decision.reason, observedHeight: height });
    if (decision.action === 'ok' || decision.telemetry === 'quality-capped') {
      decided = true;
    } else {
      armedAt = now;
    }
  }

  return {
    notePlaying() {
      armedAt ??= clock.now();
    },

    noteBuffering() {
      bufferingAt.push(clock.now());
    },

    noteQuality(label) {
      const h = qualityLabelToHeight(label);
      if (h !== null) height = h;
      opts.onQuality?.(h, label);
    },

    tick() {
      if (disposed || decided || armedAt === null) return;
      const now = clock.now();
      if (now - armedAt < armMs) return;
      evaluate(now);
    },

    currentWidth() {
      return width;
    },

    observedHeight() {
      return height;
    },

    sizeCapProven() {
      return sizeCap;
    },

    dispose() {
      disposed = true;
    },
  };
}
