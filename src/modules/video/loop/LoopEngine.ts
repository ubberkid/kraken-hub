/**
 * A-B loop: validation and crossing prediction (design-videoEngine.md §3.1–3.4).
 *
 * Everything here is PURE. `HtmlVideoLoop` and `PolledLoop` are thin DOM
 * wrappers around these functions, which is what lets the tricky parts — the
 * predictive crossing, the pending-duration state, the adaptive silent-seek
 * promotion — be tested without a media element.
 */

import { clamp } from '../../../lib/clamp';
import { CROSSFADE_MAX_MS, CROSSFADE_MIN_MS, LOOP_DEFAULTS } from '../types';

import type { LoopConfig } from '../types';

/**
 * What the display host drives, whichever loop implementation it got.
 *
 * `HtmlVideoLoop` (rAF-predictive `currentTime` reset, §3.3) and `PolledLoop`
 * (lookahead + `seekTo`, §3.4) are completely different machines, but the host
 * treats them identically: validate a span, hand it over, start it. That is what
 * keeps `display.ts` free of `if (provider === 'youtube')`.
 */
export interface AbLoop {
  /** `end` of `NaN` (or a span that is not finite) disables the loop. */
  setSpan(start: number, end: number): void;
  disable(): void;
  start(): void;
  stop(): void;
  crossings(): number;
  isActive(): boolean;
}

// ---------------------------------------------------------------------------
// Validation (§3.2)
// ---------------------------------------------------------------------------

export type LoopStatus =
  /** Turned off by the user, or off because it cannot work here. */
  | 'disabled'
  /** Duration is not known yet. Playback proceeds unlooped; re-validate later. */
  | 'pending'
  | 'active';

export type LoopIssue =
  'loop-span-too-short' | 'loop-start-past-duration' | 'loop-unavailable-live';

export interface LoopValidation {
  status: LoopStatus;
  start: number;
  /** `NaN` while `pending`. */
  end: number;
  issue: LoopIssue | null;
  /** Non-fatal observations, in the order they were made. */
  notes: LoopIssue[];
}

export interface LoopValidateOptions {
  /** Live sources are NEVER looped (§3.2). */
  isLive?: boolean;
  minSpanSec?: number;
  endGuardSec?: number;
}

/** `NaN`, `0` and `Infinity` all mean "the adapter does not know yet". */
export function isDurationKnown(duration: number): boolean {
  return Number.isFinite(duration) && duration > 0;
}

/** §2.6, §3.2 — playback must never reach `duration` (YouTube's end screen). */
export function effectiveEnd(duration: number, end: number | null, endGuardSec: number): number {
  const guarded = duration - endGuardSec;
  return end === null ? guarded : Math.min(end, guarded);
}

/**
 * §2.6 — with no A-B loop configured we still install an implicit one, so the
 * player never lands on the end screen or the suggested-video grid.
 */
export const IMPLICIT_LOOP_START_SEC = 0.05;

export function implicitLoop(
  duration: number,
  endGuardSec: number = LOOP_DEFAULTS.endGuardSec,
): { start: number; end: number } {
  return { start: IMPLICIT_LOOP_START_SEC, end: duration - endGuardSec };
}

/**
 * §3.2, in order:
 *  1. `start = max(0, start)`
 *  2. `endResolved = end ?? duration - endGuardSec` (NaN when duration unknown)
 *  3. clamp `endResolved` to `duration - endGuardSec`, then `start` to
 *     `endResolved - minSpanSec`
 *  4. span below `minSpanSec` → loop disabled with `loop-span-too-short`
 *     (a warning to telemetry, NOT an error card — playback continues unlooped)
 *  5. `start >= duration` → clamp to 0 and warn `loop-start-past-duration`
 */
export function validateLoop(
  cfg: LoopConfig,
  duration: number,
  opts: LoopValidateOptions = {},
): LoopValidation {
  const minSpanSec = opts.minSpanSec ?? LOOP_DEFAULTS.minSpanSec;
  const endGuardSec = opts.endGuardSec ?? LOOP_DEFAULTS.endGuardSec;
  const notes: LoopIssue[] = [];

  if (opts.isLive === true) {
    return {
      status: 'disabled',
      start: 0,
      end: Number.NaN,
      issue: 'loop-unavailable-live',
      notes: ['loop-unavailable-live'],
    };
  }

  if (!cfg.enabled) {
    return {
      status: 'disabled',
      start: Math.max(0, cfg.start),
      end: Number.NaN,
      issue: null,
      notes,
    };
  }

  let start = Math.max(0, cfg.start);

  if (!isDurationKnown(duration)) {
    // PENDING: play unlooped, subscribe to durationchange / onReady, re-validate.
    return { status: 'pending', start, end: Number.NaN, issue: null, notes };
  }

  // Step 5 is checked against the ORIGINAL start: once step 3 has clamped it,
  // "past the end of the video" is no longer observable.
  if (start >= duration) {
    start = 0;
    notes.push('loop-start-past-duration');
  }

  let end = effectiveEnd(duration, cfg.end, endGuardSec);
  end = Math.min(end, duration - endGuardSec);
  start = Math.min(start, end - minSpanSec);
  start = Math.max(0, start);

  if (end - start < minSpanSec) {
    notes.push('loop-span-too-short');
    return { status: 'disabled', start, end, issue: 'loop-span-too-short', notes };
  }

  return { status: 'active', start, end, issue: null, notes };
}

/** §3.2 — a live HLS/Twitch channel never reports a duration. Give up after 10 s. */
export const LOOP_PENDING_TIMEOUT_MS = 10_000;

export function loopPendingExpired(pendingSinceMs: number, nowMs: number): boolean {
  return nowMs - pendingSinceMs >= LOOP_PENDING_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Crossing prediction (§3.3, §3.4)
// ---------------------------------------------------------------------------

const FPS_60 = 60;
/** One frame at 60 Hz — the floor on the predictive step. */
export const MIN_FRAME_DT_SEC = 1 / FPS_60;

export interface HtmlCrossingInput {
  currentTime: number;
  /** `video.playbackRate || 1`. */
  rate: number;
  /** Seconds since the previous rAF tick. */
  dtSec: number;
  end: number;
  epsSec?: number;
  seeking: boolean;
}

/**
 * §3.3 — rAF-predictive crossing for `<video>` adapters.
 *
 * `timeupdate` alone fires at ~4 Hz, i.e. up to 250 ms of overshoot past the
 * loop point. The rAF tick is the primary; the `timeupdate` listener that
 * shares this predicate is a REDUNDANT SAFETY NET for when rAF is throttled —
 * the Kraken Browser is a hidden window. That is the reason for the hybrid, not
 * an optimization.
 */
export function predictHtmlCrossing(input: HtmlCrossingInput): boolean {
  if (input.seeking) return false;
  const eps = input.epsSec ?? LOOP_DEFAULTS.epsSec;
  const rate = input.rate === 0 ? 1 : input.rate;
  const step = rate * Math.max(input.dtSec, MIN_FRAME_DT_SEC);
  return input.currentTime + step >= input.end - eps;
}

/** §3.4 — `LOOKAHEAD_S = max(0.08, 2 × pollIntervalS)`. */
export const MIN_LOOKAHEAD_SEC = 0.08;
const LOOKAHEAD_POLL_MULTIPLE = 2;

export function computeLookahead(pollIntervalSec: number): number {
  return Math.max(MIN_LOOKAHEAD_SEC, LOOKAHEAD_POLL_MULTIPLE * pollIntervalSec);
}

export interface PolledCrossingInput {
  currentTime: number;
  rate: number;
  end: number;
  lookaheadSec: number;
}

/** §3.4 — crossing when `(end − t) / rate <= LOOKAHEAD_S`. */
export function predictPolledCrossing(input: PolledCrossingInput): boolean {
  const rate = input.rate === 0 ? 1 : input.rate;
  return (input.end - input.currentTime) / rate <= input.lookaheadSec;
}

/** §3.4 — below this, schedule a `setTimeout` for sub-poll precision. */
export const SUB_POLL_SCHEDULE_SEC = 0.35;
const MS_PER_SEC = 1000;

export function remainingSec(currentTime: number, end: number, rate: number): number {
  const r = rate === 0 ? 1 : rate;
  return (end - currentTime) / r;
}

export function shouldScheduleTimer(remaining: number): boolean {
  return remaining > 0 && remaining < SUB_POLL_SCHEDULE_SEC;
}

export function crossingDelayMs(currentTime: number, end: number, rate: number): number {
  return Math.max(0, remainingSec(currentTime, end, rate) * MS_PER_SEC);
}

/**
 * §3.4 — buffer priming. The first pass plays `[start, end]` uninterrupted so
 * the span sits in ONE buffered region; a backward seek inside a buffered range
 * typically does not spin.
 */
export function isPrimed(args: {
  loadedFraction: number;
  duration: number;
  end: number;
  crossings: number;
}): boolean {
  if (args.crossings >= 1) return true;
  if (!isDurationKnown(args.duration)) return false;
  return args.loadedFraction * args.duration >= args.end;
}

/** §3.3 — after a loop seek, a slow `readyState` means raise the mask. */
export const READY_STATE_MASK_DELAY_MS = 300;
export const SEEK_GUARD_TIMEOUT_MS = 500;

// ---------------------------------------------------------------------------
// Adaptive `canSeekSilently` (§3.4)
// ---------------------------------------------------------------------------

export const SILENT_SEEK_PROMOTION_CROSSINGS = 3;
/** A BUFFERING state within this window of a crossing is attributed to it. */
export const BUFFERING_ATTRIBUTION_MS = 600;
/** Mask flash once seeks are known to be silent. */
export const SILENT_SEEK_MASK_MS = 100;

/**
 * Counts consecutive clean loop crossings. Three in a row promote the adapter
 * to `canSeekSilently`; a single buffering crossing demotes it again. Published
 * as telemetry so the config UI can honestly say "loop is seamless" or "loop
 * shows a brief flash".
 */
export class SilentSeekPromoter {
  private clean = 0;
  private promoted = false;

  /** @returns the current `canSeekSilently` value. */
  record(crossingHadBuffering: boolean): boolean {
    if (crossingHadBuffering) {
      this.clean = 0;
      this.promoted = false;
    } else {
      this.clean += 1;
      if (this.clean >= SILENT_SEEK_PROMOTION_CROSSINGS) this.promoted = true;
    }
    return this.promoted;
  }

  get canSeekSilently(): boolean {
    return this.promoted;
  }

  get cleanCrossings(): number {
    return this.clean;
  }

  reset(): void {
    this.clean = 0;
    this.promoted = false;
  }
}

// ---------------------------------------------------------------------------
// Crossfade (§3.6)
// ---------------------------------------------------------------------------

export function clampCrossfadeMs(ms: number): number {
  return clamp(ms, CROSSFADE_MIN_MS, CROSSFADE_MAX_MS);
}

const LOW_FPS_NO_CROSSFADE = 10;

/**
 * §3.6 — two simultaneous decoders. Hard-disabled in performance mode and at
 * low target FPS, and only ever available to same-origin/CORS-clean progressive
 * files.
 */
export function crossfadeAllowed(args: {
  mode: LoopConfig['mode'];
  provider: string;
  perf: 'quality' | 'performance';
  targetFps: number;
}): boolean {
  if (args.mode !== 'crossfade') return false;
  if (args.perf === 'performance') return false;
  if (args.targetFps <= LOW_FPS_NO_CROSSFADE) return false;
  return ['local-file', 'direct-file', 'resolver'].includes(args.provider);
}
