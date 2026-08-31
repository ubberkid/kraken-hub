/**
 * A-B looping for the `<video>` family (design-videoEngine.md §3.3).
 *
 * `timeupdate` alone fires at roughly 4 Hz, i.e. up to 250 ms of overshoot past
 * the loop point — visible as a stutter at the seam. So the primary tick is rAF
 * with a predictive crossing test.
 *
 * **Why the hybrid exists:** the Kraken Browser is a *hidden window*. Chromium
 * throttles `requestAnimationFrame` in hidden/occluded windows — in the worst
 * case to nothing at all — so an rAF-only loop would simply stop looping on the
 * one device this whole project targets. The `timeupdate` listener is therefore
 * a REDUNDANT SAFETY NET, not an optimisation, and it shares the exact same
 * predicate so the two paths can never disagree about where the seam is.
 */

import {
  SEEK_GUARD_TIMEOUT_MS,
  READY_STATE_MASK_DELAY_MS,
  predictHtmlCrossing,
} from './LoopEngine';

import type { AbLoop } from './LoopEngine';

/** `HAVE_FUTURE_DATA`; below this after a loop seek we are about to show a stall. */
const READY_STATE_FUTURE_DATA = 2;
/** `timeupdate` fires at roughly 4 Hz, so that is the step the net predicts with. */
const TIMEUPDATE_DT_SEC = 0.25;
const MS_PER_SEC = 1000;

export interface HtmlVideoLoopOptions {
  video: HTMLVideoElement;
  /** Called after each successful crossing, with the running count. */
  onCrossing?: (crossings: number) => void;
  /** The seek landed on an unbuffered region: raise the mask (§3.3). */
  onSlowResume?: () => void;
  /** Data is flowing again after an `onSlowResume`. */
  onResumed?: () => void;
}

export type HtmlVideoLoop = AbLoop;

export function createHtmlVideoLoop(opts: HtmlVideoLoopOptions): HtmlVideoLoop {
  const video = opts.video;
  let start = 0;
  let end = Number.NaN;
  let active = false;
  let running = false;
  let seeking = false;
  let crossings = 0;
  let lastTickMs = 0;
  let rafId: number | null = null;
  let seekGuard: ReturnType<typeof setTimeout> | null = null;
  let readyStateTimer: ReturnType<typeof setTimeout> | null = null;
  let maskRaised = false;

  const clearSeekGuard = (): void => {
    if (seekGuard !== null) {
      clearTimeout(seekGuard);
      seekGuard = null;
    }
  };

  const clearReadyStateTimer = (): void => {
    if (readyStateTimer !== null) {
      clearTimeout(readyStateTimer);
      readyStateTimer = null;
    }
  };

  const onSeeked = (): void => {
    seeking = false;
    clearSeekGuard();
    // §3.3 — a seek that lands outside the buffered range takes a visible
    // moment; the mask hides that, but only if it is actually slow.
    clearReadyStateTimer();
    readyStateTimer = setTimeout(() => {
      if (video.readyState < READY_STATE_FUTURE_DATA) {
        maskRaised = true;
        opts.onSlowResume?.();
      }
    }, READY_STATE_MASK_DELAY_MS);
  };

  const onPlaying = (): void => {
    clearReadyStateTimer();
    if (maskRaised) {
      maskRaised = false;
      opts.onResumed?.();
    }
  };

  function doLoop(): void {
    if (seeking) return;
    seeking = true;
    crossings += 1;
    video.currentTime = start;
    opts.onCrossing?.(crossings);
    // The guard stops a seek storm if `seeked` never arrives (it does happen
    // on a stalled network) — without it the predicate would fire every tick.
    clearSeekGuard();
    seekGuard = setTimeout(() => {
      seeking = false;
      seekGuard = null;
    }, SEEK_GUARD_TIMEOUT_MS);
  }

  function check(dtSec: number): void {
    if (!active || !running) return;
    if (!Number.isFinite(end)) return;
    if (
      predictHtmlCrossing({
        currentTime: video.currentTime,
        rate: video.playbackRate,
        dtSec,
        end,
        seeking: seeking || video.seeking,
      })
    ) {
      doLoop();
    }
  }

  const tick = (nowMs: number): void => {
    rafId = null;
    if (!running) return;
    const dtSec = lastTickMs === 0 ? 0 : (nowMs - lastTickMs) / MS_PER_SEC;
    lastTickMs = nowMs;
    check(dtSec);
    rafId = requestAnimationFrame(tick);
  };

  const onTimeUpdate = (): void => {
    // The safety net. Uses the same predicate with the observed `timeupdate`
    // cadence as `dt`, so a throttled rAF still loops — a little later, never
    // never.
    check(TIMEUPDATE_DT_SEC);
  };

  video.addEventListener('seeked', onSeeked);
  video.addEventListener('playing', onPlaying);
  video.addEventListener('timeupdate', onTimeUpdate);

  return {
    setSpan(nextStart, nextEnd) {
      start = Math.max(0, nextStart);
      end = nextEnd;
      active = Number.isFinite(nextEnd) && nextEnd > start;
    },

    disable() {
      active = false;
      end = Number.NaN;
    },

    start() {
      if (running) return;
      running = true;
      lastTickMs = 0;
      rafId = requestAnimationFrame(tick);
    },

    stop() {
      running = false;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
      clearSeekGuard();
      clearReadyStateTimer();
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('timeupdate', onTimeUpdate);
    },

    crossings() {
      return crossings;
    },

    isActive() {
      return active;
    },
  };
}
