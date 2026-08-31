/**
 * The overlay mask state machine (design-videoEngine.md §2.6).
 *
 * The geometry engine hides YouTube's *static* chrome by cropping it onto the
 * letterbox bars. It cannot hide the chrome that appears **inside the video
 * rect**: the buffering spinner, the poster/title card on an unstarted or cued
 * player, the pause overlay's suggested-video grid, and the end screen. Those
 * are hidden by a flat, poster-backed div over the whole viewport, raised and
 * lowered by this machine.
 *
 * Two asymmetries are deliberate and are the whole design:
 *
 *  - **Fade in is instant, fade out is 180 ms.** A mask that fades UP shows, for
 *    the length of the fade, exactly the frame it exists to hide.
 *  - **Every "show" trigger is a state we know paints chrome; the only "hide"
 *    trigger is proof of playback.** `PLAYING` alone is not proof — the player
 *    reports it while still showing the spinner — so the machine also requires
 *    the clock to be past `A + 0.05` and no seek in flight.
 *
 * The doc names four states (`HIDDEN → SHOWING → VISIBLE → HIDING → HIDDEN`).
 * `SHOWING` is unreachable here *because* fade-in is instant; keeping it in the
 * type would be a lie about the implementation, so it is documented instead.
 *
 * Everything is driven by injected `now`/`schedule`, so the whole machine —
 * including the 2.5 s failsafe and the 15 s stall escalation — is unit-testable
 * on a fake clock with no DOM and no network.
 */

import { SILENT_SEEK_MASK_MS } from '../loop/LoopEngine';

import type { MaskSurface } from '../adapters/VideoAdapter';

/** §2.6 — `opacity 180ms linear` on the way out. */
export const MASK_FADE_MS = 180;
/** §2.6 — how long `PLAYING` must hold before the fade starts. */
export const HOLD_AFTER_PLAYING_MS = 120;
/** §2.6 — never leave a black screen: force the fade after this. */
export const MASK_MAX_MS = 2500;
/** §2.6 — a mask this old is not buffering any more, it is stuck. */
export const MASK_STALL_MS = 15_000;
/** §2.6 — `getCurrentTime() > A + 0.05` before the mask may drop. */
export const PLAYING_EPS_SEC = 0.05;
/**
 * `maxresdefault.jpg` does not 404 for uploads that lack it — YouTube answers
 * with a 120×90 grey placeholder. Anything narrower than this is that
 * placeholder, not a poster.
 */
// device-size-ok: the width of a YouTube poster JPEG, not a panel dimension.
export const MIN_POSTER_WIDTH_PX = 320;

/** The IFrame API's player states, named so the transition table reads like §2.6. */
export const YT_STATE = {
  unstarted: -1,
  ended: 0,
  playing: 1,
  paused: 2,
  buffering: 3,
  cued: 5,
} as const;

export type MaskState = 'hidden' | 'visible' | 'hiding';

type TimerHandle = ReturnType<typeof setTimeout>;

export interface MaskClock {
  now(): number;
  schedule(fn: () => void, ms: number): TimerHandle;
  cancel(handle: TimerHandle): void;
}

export interface MaskControllerOptions {
  surface: MaskSurface;
  /** §2.6 fallback chain: maxresdefault → hqdefault → flat colour. */
  posterUrls: readonly string[];
  /** §8.3 — performance mode uses the flat colour and never fetches a poster. */
  usePoster: boolean;
  flatColor: string;
  holdAfterPlayingMs?: number;
  maskMaxMs?: number;
  maskStallMs?: number;
  /** Injectable for tests; the default probes with an `Image`. */
  loadPoster?: (url: string) => Promise<boolean>;
  clock?: MaskClock;
  /** §2.6 — the mask has been up 15 s. Render an error card and log it. */
  onStalled?: (visibleMs: number) => void;
  onTelemetry?: (code: string, detail?: string) => void;
}

export interface MaskController {
  /** §2.6 row 1: mount ⇒ VISIBLE. */
  mount(): void;
  /** The A of the A-B loop; the fade rule is written against it. */
  setBoundaryA(a: number): void;
  onPlayerState(state: number, currentTime: number): void;
  /** A seek was issued. VISIBLE instant, `seekPending` set (§2.6 row 4). */
  onSeekIssued(target: number): void;
  /** A loop crossing. `silent` caps the flash at 100 ms (§2.6 row 6). */
  onLoopCrossing(target: number, silent: boolean): void;
  /** Called from the adapter's poll: clears `seekPending` once the seek lands. */
  onTime(t: number): void;
  /** Drives the 2.5 s failsafe and the 15 s escalation. Safe to call every frame. */
  tick(): void;
  state(): MaskState;
  visibleMs(): number;
  dispose(): void;
}

const realClock: MaskClock = {
  now: () => Date.now(),
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (handle) => {
    clearTimeout(handle);
  },
};

/** Default poster probe. Resolves false rather than rejecting — this is optional polish. */
function probePoster(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.addEventListener('load', () => {
      resolve(img.naturalWidth >= MIN_POSTER_WIDTH_PX);
    });
    img.addEventListener('error', () => {
      resolve(false);
    });
    img.src = url;
  });
}

export function createMaskController(opts: MaskControllerOptions): MaskController {
  const clock = opts.clock ?? realClock;
  const holdAfterPlayingMs = opts.holdAfterPlayingMs ?? HOLD_AFTER_PLAYING_MS;
  const maskMaxMs = opts.maskMaxMs ?? MASK_MAX_MS;
  const maskStallMs = opts.maskStallMs ?? MASK_STALL_MS;
  const loadPoster = opts.loadPoster ?? probePoster;

  let state: MaskState = 'hidden';
  let visibleSince = 0;
  let boundaryA = 0;
  let seekPending = false;
  let seekTarget = 0;
  let lastPlayerState: number = YT_STATE.unstarted;
  let stalledReported = false;
  let fadeTimer: TimerHandle | null = null;
  let settleTimer: TimerHandle | null = null;
  let disposed = false;

  function clearTimers(): void {
    if (fadeTimer !== null) {
      clock.cancel(fadeTimer);
      fadeTimer = null;
    }
    if (settleTimer !== null) {
      clock.cancel(settleTimer);
      settleTimer = null;
    }
  }

  function show(): void {
    if (disposed) return;
    clearTimers();
    if (state !== 'visible') {
      visibleSince = clock.now();
      stalledReported = false;
    }
    state = 'visible';
    opts.surface.showInstant(opts.flatColor);
  }

  function scheduleHide(delayMs: number, fadeMs = MASK_FADE_MS): void {
    if (disposed || state === 'hidden') return;
    if (fadeTimer !== null) return; // a fade is already queued; do not restart it
    fadeTimer = clock.schedule(() => {
      fadeTimer = null;
      if (disposed || state === 'hidden') return;
      state = 'hiding';
      opts.surface.fadeOut(fadeMs);
      settleTimer = clock.schedule(() => {
        settleTimer = null;
        if (state === 'hiding') state = 'hidden';
      }, fadeMs);
    }, delayMs);
  }

  async function resolvePoster(): Promise<void> {
    if (!opts.usePoster) {
      opts.surface.setPoster(null);
      return;
    }
    for (const url of opts.posterUrls) {
      const ok = await loadPoster(url);
      if (disposed) return;
      if (ok) {
        opts.surface.setPoster(`url("${url}")`);
        return;
      }
    }
    // §2.6 — third fallback: the flat colour, which needs no network at all.
    opts.surface.setPoster(null);
    opts.onTelemetry?.('yt-poster-unavailable');
  }

  return {
    mount() {
      show();
      opts.surface.setPoster(null);
      void resolvePoster();
    },

    setBoundaryA(a) {
      boundaryA = a;
    },

    onPlayerState(playerState, currentTime) {
      lastPlayerState = playerState;
      switch (playerState) {
        case YT_STATE.unstarted:
        case YT_STATE.cued:
        case YT_STATE.paused:
        case YT_STATE.ended:
        case YT_STATE.buffering:
          // Every one of these paints something over the video rect.
          show();
          return;
        case YT_STATE.playing:
          if (seekPending && currentTime >= seekTarget + PLAYING_EPS_SEC) seekPending = false;
          if (!seekPending && currentTime > boundaryA + PLAYING_EPS_SEC) {
            scheduleHide(holdAfterPlayingMs);
          }
          return;
        default:
          return;
      }
    },

    onSeekIssued(target) {
      seekPending = true;
      seekTarget = target;
      show();
    },

    onLoopCrossing(target, silent) {
      seekPending = true;
      seekTarget = target;
      show();
      // §2.6 row 6 — once `canSeekSilently` has been observed, the crossing is
      // known not to spin, so the mask is a 100 ms flash rather than a wait for
      // a `PLAYING` that has already effectively happened.
      if (silent) scheduleHide(SILENT_SEEK_MASK_MS, SILENT_SEEK_MASK_MS);
    },

    onTime(t) {
      if (seekPending && t >= seekTarget + PLAYING_EPS_SEC) {
        seekPending = false;
        if (lastPlayerState === YT_STATE.playing && t > boundaryA + PLAYING_EPS_SEC) {
          scheduleHide(holdAfterPlayingMs);
        }
      }
    },

    tick() {
      if (disposed || state !== 'visible') return;
      const elapsed = clock.now() - visibleSince;
      if (elapsed > maskStallMs) {
        if (!stalledReported) {
          stalledReported = true;
          opts.onTelemetry?.('yt-mask-stalled', `${String(Math.round(elapsed))}ms`);
          opts.onStalled?.(elapsed);
        }
        return;
      }
      // §2.6 failsafe — the player says it is playing and the mask is still up
      // after 2.5 s. Whatever the state machine missed, a black screen is worse.
      if (elapsed > maskMaxMs && lastPlayerState === YT_STATE.playing) {
        seekPending = false;
        scheduleHide(0);
      }
    },

    state() {
      return state;
    },

    visibleMs() {
      return state === 'visible' ? clock.now() - visibleSince : 0;
    },

    dispose() {
      disposed = true;
      clearTimers();
    },
  };
}
