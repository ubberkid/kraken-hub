/**
 * Optional dual-`<video>` loop crossfade (design-videoEngine.md §3.6).
 *
 * Two elements share one `src`/blob URL; the idle one pre-seeks to `start` and
 * waits paused, and at `end − crossfadeMs` it plays while the pair CSS-fade
 * their opacity, then the roles swap.
 *
 * **Cost: two simultaneous decoders.** That is why this is `false` by default,
 * hard-disabled in performance mode and at `targetFps <= 10` (`crossfadeAllowed`
 * in `LoopEngine.ts` is the single decision point), and offered only for
 * same-origin or CORS-clean progressive files — `local-file`, `direct-file`,
 * `resolver`. The config UI states the cost next to the switch.
 */

import { clampCrossfadeMs, crossfadeAllowed } from './LoopEngine';

import type { AbLoop } from './LoopEngine';

const MS_PER_SEC = 1000;

export interface CrossfadeOptions {
  /** The element already mounted and playing. Stays element "A". */
  primary: HTMLVideoElement;
  /** Media source shared by both elements (an https url or a blob url). */
  src: string;
  start: number;
  end: number;
  crossfadeMs: number;
  /** Fired once per seam, at the moment the fade begins. */
  onCrossing?: () => void;
}

export interface Crossfade {
  /** The second element, appended next to the primary by the caller. */
  readonly secondary: HTMLVideoElement;
  setSpan(start: number, end: number): void;
  /** Drive from the same rAF tick the loop uses; returns true while fading. */
  tick(): boolean;
  destroy(): void;
}

function cloneForCrossfade(primary: HTMLVideoElement, src: string): HTMLVideoElement {
  const el = document.createElement('video');
  el.muted = true;
  el.defaultMuted = true;
  el.playsInline = true;
  el.controls = false;
  el.preload = 'auto';
  el.className = 'kh-video__media kh-video__media--crossfade';
  el.style.position = 'absolute';
  el.style.top = '0';
  el.style.left = '0';
  el.style.display = 'block';
  el.style.opacity = '0';
  el.style.width = primary.style.width;
  el.style.height = primary.style.height;
  el.src = src;
  return el;
}

export function createCrossfade(opts: CrossfadeOptions): Crossfade {
  const fadeMs = clampCrossfadeMs(opts.crossfadeMs);
  const fadeSec = fadeMs / MS_PER_SEC;
  let start = opts.start;
  let end = opts.end;
  let a = opts.primary;
  let b = cloneForCrossfade(opts.primary, opts.src);
  let fading = false;

  const arm = (el: HTMLVideoElement): void => {
    el.pause();
    try {
      el.currentTime = start;
    } catch {
      /* seeking before metadata throws; the next arm() call gets it */
    }
  };

  const onLoaded = (): void => {
    arm(b);
  };
  b.addEventListener('loadedmetadata', onLoaded);

  /**
   * The idle element is a clone, but the LAYOUT box is written onto the primary
   * by the adapter's `measure()` when metadata (and later `resize`) arrives —
   * which can be after this pair was built. Copying it on every tick is two
   * string compares, and it is the difference between a crossfade that lines up
   * and one that jumps size at the seam.
   */
  const syncBox = (): void => {
    if (b.style.width !== a.style.width) b.style.width = a.style.width;
    if (b.style.height !== a.style.height) b.style.height = a.style.height;
  };

  function beginFade(): void {
    fading = true;
    opts.onCrossing?.();
    b.style.transition = `opacity ${String(fadeMs)}ms linear`;
    a.style.transition = `opacity ${String(fadeMs)}ms linear`;
    b.style.opacity = '1';
    a.style.opacity = '0';
    void b.play().catch(() => {
      /* a refused play here just means the fade shows the old element longer */
    });
    setTimeout(() => {
      const previous = a;
      a = b;
      b = previous;
      arm(b);
      fading = false;
    }, fadeMs);
  }

  return {
    get secondary() {
      return b;
    },

    setSpan(nextStart, nextEnd) {
      start = nextStart;
      end = nextEnd;
      arm(b);
    },

    tick() {
      syncBox();
      if (fading) return true;
      if (!Number.isFinite(end)) return false;
      const rate = a.playbackRate === 0 ? 1 : a.playbackRate;
      if ((end - a.currentTime) / rate <= fadeSec) beginFade();
      return fading;
    },

    destroy() {
      b.removeEventListener('loadedmetadata', onLoaded);
      b.pause();
      b.removeAttribute('src');
      b.load();
      b.remove();
      a.style.opacity = '1';
      a.style.transition = 'none';
    },
  };
}

// ---------------------------------------------------------------------------
// The `AbLoop` the display host actually installs
// ---------------------------------------------------------------------------

export interface CrossfadeLoopOptions {
  primary: HTMLVideoElement;
  src: string;
  crossfadeMs: number;
  onCrossing?: (crossings: number) => void;
}

export interface CrossfadeLoop extends AbLoop {
  /** The idle element of the pair, for the caller to append next to `primary`. */
  readonly secondary: HTMLVideoElement;
}

/**
 * Wraps a `Crossfade` in the same `AbLoop` shape `HtmlVideoLoop` and
 * `PolledLoop` expose, so `display.ts` installs it with one branch and never
 * learns that there are two elements on the stage.
 *
 * It replaces `HtmlVideoLoop` rather than layering on top of it: the hard loop
 * seeks element A back to `start` AT the seam, which is exactly the frame the
 * crossfade is trying to keep on screen. Two machines aiming at the same instant
 * is how you get a seek and a fade fighting each other, so only one runs.
 *
 * The rAF tick here is *only* the fade driver — unlike the hard loop it has no
 * `timeupdate` safety net, because a throttled rAF cannot make a crossfade look
 * right anyway. That is one more reason `crossfadeAllowed` refuses at low
 * `targetFps`.
 */
export function createCrossfadeLoop(opts: CrossfadeLoopOptions): CrossfadeLoop {
  let crossings = 0;
  let active = false;
  let running = false;
  let rafId: number | null = null;

  const cf = createCrossfade({
    primary: opts.primary,
    src: opts.src,
    start: 0,
    end: Number.NaN,
    crossfadeMs: opts.crossfadeMs,
    onCrossing: () => {
      crossings += 1;
      opts.onCrossing?.(crossings);
    },
  });

  const tick = (): void => {
    rafId = null;
    if (!running) return;
    if (active) cf.tick();
    rafId = requestAnimationFrame(tick);
  };

  return {
    get secondary() {
      return cf.secondary;
    },

    setSpan(start, end) {
      active = Number.isFinite(end) && end > start;
      cf.setSpan(Math.max(0, start), active ? end : Number.NaN);
    },

    disable() {
      active = false;
      cf.setSpan(0, Number.NaN);
    },

    start() {
      if (running) return;
      running = true;
      rafId = requestAnimationFrame(tick);
    },

    stop() {
      running = false;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
      cf.destroy();
    },

    crossings() {
      return crossings;
    },

    isActive() {
      return active;
    },
  };
}

export { crossfadeAllowed };
