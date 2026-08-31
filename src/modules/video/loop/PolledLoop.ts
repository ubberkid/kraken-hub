/**
 * A-B looping for polled providers — youtube-embed today, twitch/vimeo later
 * (design-videoEngine.md §3.4).
 *
 * A cross-origin player gives us no `timeupdate` and no `seeked`. Everything is
 * a poll of `getCurrentTime()`, which for YouTube is *locally interpolated* —
 * smooth on rAF, so rAF is the right poll — and the loop point has to be
 * predicted rather than observed:
 *
 *  - **Lookahead.** Cross when `(end − t) / rate <= LOOKAHEAD_S`, where
 *    `LOOKAHEAD_S = max(0.08, 2 × pollInterval)`. Waiting for `t >= end` means
 *    overshooting by up to one poll, which on a polled provider is visible.
 *  - **Sub-poll precision.** Inside 0.35 s of the crossing, a `setTimeout` is
 *    scheduled at the predicted instant, so the seam does not quantise to the
 *    frame clock — which on this device may be running at 1 FPS.
 *  - **Buffer priming.** The first pass plays `[start, end]` uninterrupted so
 *    the span sits in ONE buffered region. A backward seek inside a buffered
 *    range typically does not spin; a backward seek into an unbuffered one
 *    always does, which is exactly the spinner the mask exists to hide.
 *  - **Adaptive `canSeekSilently`.** Three consecutive crossings with no
 *    BUFFERING within 600 ms promote the provider, cutting the mask flash from
 *    "wait for PLAYING" to a 100 ms cap. One dirty crossing demotes it again.
 *    The observed value is published so the config UI can honestly say whether
 *    the loop is seamless.
 *
 * The clock, the frame callback and the timers are all injected, so every rule
 * above is unit-testable with no DOM and no wall-clock waiting.
 */

import {
  BUFFERING_ATTRIBUTION_MS,
  SilentSeekPromoter,
  computeLookahead,
  crossingDelayMs,
  isPrimed,
  predictPolledCrossing,
  remainingSec,
  shouldScheduleTimer,
} from './LoopEngine';

import type { AbLoop } from './LoopEngine';

const NOMINAL_FPS = 60;
/** §3.4 — rAF is the poll, so one frame at 60 Hz is the nominal interval. */
const DEFAULT_POLL_INTERVAL_SEC = 1 / NOMINAL_FPS;
/** The crossing is settled once the clock is this far past `start`. */
export const CROSSING_SETTLE_EPS_SEC = 0.05;
/**
 * A crossing that never settles (a seek the player silently dropped) must not
 * wedge the loop forever. After this the crossing is force-settled and counted
 * as dirty, which also demotes `canSeekSilently` — the honest outcome.
 */
export const CROSSING_TIMEOUT_MS = 4000;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface PolledScheduler {
  now(): number;
  raf(cb: () => void): number;
  cancelRaf(id: number): void;
  setTimer(fn: () => void, ms: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
}

export interface PolledLoopHost {
  getCurrentTime(): number;
  getRate(): number;
  getDuration(): number;
  /** `getVideoLoadedFraction()`; `0` when unknown. */
  getLoadedFraction(): number;
  /** `seekTo(start, true)` for YouTube. `silentExpected` drives the mask flash cap. */
  seek(t: number, silentExpected: boolean): void;
}

export interface PolledLoopOptions {
  host: PolledLoopHost;
  /** Called the instant a crossing begins, before the seek. */
  onCrossingStart?: (silentExpected: boolean) => void;
  /** The seek landed and playback resumed. `silent` is the promoted value. */
  onCrossingSettled?: (silent: boolean, crossings: number) => void;
  /** §3.4 — publish the observed value so the UI can describe the seam honestly. */
  onSilentSeekChange?: (canSeekSilently: boolean) => void;
  pollIntervalSec?: number;
  scheduler?: PolledScheduler;
}

export interface PolledLoop extends AbLoop {
  /** Feed the provider's PLAYING state in; settles a crossing early. */
  notePlaying(): void;
  /** Feed BUFFERING in; within 600 ms of a crossing it marks that crossing dirty. */
  noteBuffering(): void;
  canSeekSilently(): boolean;
  /** One poll pass. `start()` calls it on rAF; tests call it directly. */
  poll(): void;
  primed(): boolean;
}

const realScheduler: PolledScheduler = {
  now: () => performance.now(),
  raf: (cb) =>
    requestAnimationFrame(() => {
      cb();
    }),
  cancelRaf: (id) => {
    cancelAnimationFrame(id);
  },
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => {
    clearTimeout(handle);
  },
};

export function createPolledLoop(opts: PolledLoopOptions): PolledLoop {
  const sched = opts.scheduler ?? realScheduler;
  const host = opts.host;
  const lookaheadSec = computeLookahead(opts.pollIntervalSec ?? DEFAULT_POLL_INTERVAL_SEC);
  const promoter = new SilentSeekPromoter();

  let start = 0;
  let end = Number.NaN;
  let active = false;
  let running = false;
  let crossings = 0;
  let rafId: number | null = null;
  let subPollTimer: TimerHandle | null = null;
  let crossing = false;
  let crossingAt = 0;
  let crossingDirty = false;
  let lastSilent = false;

  function clearSubPoll(): void {
    if (subPollTimer !== null) {
      sched.clearTimer(subPollTimer);
      subPollTimer = null;
    }
  }

  function primed(): boolean {
    return isPrimed({
      loadedFraction: host.getLoadedFraction(),
      duration: host.getDuration(),
      end,
      crossings,
    });
  }

  function settle(): void {
    if (!crossing) return;
    crossing = false;
    const silent = promoter.record(crossingDirty);
    if (silent !== lastSilent) {
      lastSilent = silent;
      opts.onSilentSeekChange?.(silent);
    }
    opts.onCrossingSettled?.(silent, crossings);
  }

  function doCross(): void {
    if (crossing || !active) return;
    clearSubPoll();
    crossing = true;
    crossingAt = sched.now();
    crossingDirty = false;
    crossings += 1;
    // A crossing is only *expected* to be silent once the span has been played
    // through once — before that the backward seek lands outside the buffer.
    const silentExpected = promoter.canSeekSilently && primed();
    opts.onCrossingStart?.(silentExpected);
    host.seek(start, silentExpected);
  }

  function poll(): void {
    if (!active || !Number.isFinite(end)) return;

    const t = host.getCurrentTime();
    const rate = host.getRate();

    if (crossing) {
      // Settle on the clock rather than on a state event: `PLAYING` may already
      // have been the state before the seek, so it is not by itself evidence
      // that the seek landed.
      if (t >= start + CROSSING_SETTLE_EPS_SEC && t < end) {
        settle();
      } else if (sched.now() - crossingAt > CROSSING_TIMEOUT_MS) {
        crossingDirty = true;
        settle();
      }
      return;
    }

    if (predictPolledCrossing({ currentTime: t, rate, end, lookaheadSec })) {
      doCross();
      return;
    }

    const remaining = remainingSec(t, end, rate);
    if (subPollTimer === null && shouldScheduleTimer(remaining)) {
      // §3.4 — inside 0.35 s, stop trusting the frame clock's granularity.
      subPollTimer = sched.setTimer(
        () => {
          subPollTimer = null;
          if (running && active && !crossing) doCross();
        },
        crossingDelayMs(t, end, rate),
      );
    }
  }

  function tick(): void {
    rafId = null;
    if (!running) return;
    poll();
    rafId = sched.raf(tick);
  }

  return {
    setSpan(nextStart, nextEnd) {
      const changed = nextStart !== start || nextEnd !== end;
      start = Math.max(0, nextStart);
      end = nextEnd;
      active = Number.isFinite(nextEnd) && nextEnd > start;
      if (changed) {
        clearSubPoll();
        // A new span is a new buffered region: nothing observed about the old
        // seam predicts the new one.
        promoter.reset();
        crossings = 0;
        lastSilent = false;
      }
    },

    disable() {
      active = false;
      end = Number.NaN;
      clearSubPoll();
    },

    start() {
      if (running) return;
      running = true;
      rafId = sched.raf(tick);
    },

    stop() {
      running = false;
      if (rafId !== null) sched.cancelRaf(rafId);
      rafId = null;
      clearSubPoll();
    },

    crossings() {
      return crossings;
    },

    isActive() {
      return active;
    },

    notePlaying() {
      if (crossing && host.getCurrentTime() >= start + CROSSING_SETTLE_EPS_SEC) settle();
    },

    noteBuffering() {
      if (crossing || sched.now() - crossingAt <= BUFFERING_ATTRIBUTION_MS) crossingDirty = true;
    },

    canSeekSilently() {
      return promoter.canSeekSilently;
    },

    poll,
    primed,
  };
}
