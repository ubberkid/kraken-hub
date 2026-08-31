/**
 * Shared `<video>` plumbing (design-videoEngine.md §1.1, §3.3, §5.4, §8.3).
 *
 * Four adapters sit on top of this one file — `local-file`, `direct-file`, and
 * later `hls`/`dash`/`resolver` — so every rule that is easy to get wrong is
 * written exactly once:
 *
 *  - **muted + playsinline + autoplay**, always: the Kraken Browser gives no
 *    user gesture, and an unmuted `play()` is refused outright.
 *  - **`NotAllowedError` → force `muted = true` and retry ONCE.** If that also
 *    fails it is a real `autoplay-blocked`, not something to loop on.
 *  - **`sourcerect` on `loadedmetadata`**, never per frame.
 *  - **teardown order: clear `src` → `load()` → only then release the blob URL.**
 *    Revoking while the element still references the URL aborts the decode with
 *    a `MEDIA_ELEMENT_ERROR` that looks like a corrupt file (§5.4).
 */

import { HTML_VIDEO_CAPS, videoError } from './VideoAdapter';

import type { AdapterEvent, MountContext, SeekOptions, VideoAdapter } from './VideoAdapter';
import type { ProviderCapabilities, ProviderId, SourceRect } from '../types';

/** §8.3 — performance mode caps the composited `<video>` layout box. */
const PERF_SURFACE_MAX_PX = 1280;
/** A `waiting` that outlives this is reported as a stall, not a hiccup. */
const STALL_REPORT_MS = 4000;
const RATE_MIN = 0.0625;
const RATE_MAX = 4;

export interface HtmlVideoAdapterOptions {
  id: ProviderId;
  caps?: Partial<ProviderCapabilities>;
  /**
   * Resolve the media URL at mount time. May acquire a ref-counted blob URL;
   * whatever it acquires is released by `releaseSrc`, after the element has let
   * go of it.
   *
   * Mutually exclusive with `attach`: a `<video>` either gets a `src` or gets an
   * MSE library bolted onto it, never both.
   */
  resolveSrc?: (ctx: MountContext) => Promise<string>;
  /**
   * MSE path (`hls`, `dash`): the library takes the element and feeds it
   * SourceBuffers itself. Anything created here must be undone in `detach`.
   */
  attach?: (el: HTMLVideoElement, ctx: MountContext) => Promise<void>;
  /** Runs FIRST in teardown, before `src` is cleared — `hls.destroy()` etc. */
  detach?: () => void | Promise<void>;
  releaseSrc?: () => void;
  /** Optional quality control, forwarded to `VideoAdapter.setQuality/getQuality`. */
  quality?: {
    set: (heightHint: number) => Promise<boolean>;
    get: () => { height: number | null; label: string | null };
  };
}

/** A `VideoAdapter` that also hands out its element, so the loop can drive it. */
export interface HtmlVideoAdapter extends VideoAdapter {
  getVideoElement(): HTMLVideoElement | null;
}

function emptyRect(): SourceRect {
  return {
    surfaceW: 0,
    surfaceH: 0,
    safe: { x: 0, y: 0, w: 0, h: 0 },
    full: { x: 0, y: 0, w: 0, h: 0 },
    mediaAspect: 1,
  };
}

export function createHtmlVideoAdapter(opts: HtmlVideoAdapterOptions): HtmlVideoAdapter {
  const capabilities: ProviderCapabilities = { ...HTML_VIDEO_CAPS, ...opts.caps };

  let video: HTMLVideoElement | null = null;
  let ctx: MountContext | null = null;
  let rect: SourceRect = emptyRect();
  let held = false;
  let tornDown = false;
  let retriedMuted = false;
  let waitingSince = 0;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  const off: (() => void)[] = [];

  const emit = (e: AdapterEvent): void => {
    if (!tornDown) ctx?.emit(e);
  };

  const on = <K extends keyof HTMLMediaElementEventMap>(
    el: HTMLVideoElement,
    type: K,
    fn: (ev: HTMLMediaElementEventMap[K]) => void,
  ): void => {
    el.addEventListener(type, fn);
    off.push(() => {
      el.removeEventListener(type, fn);
    });
  };

  /**
   * The layout box the element occupies before any transform. Natural pixels in
   * quality mode; capped in performance mode, because the composited surface —
   * not the decode — is what costs frames on a machine already running a game.
   */
  const measure = (el: HTMLVideoElement): void => {
    const nw = el.videoWidth;
    const nh = el.videoHeight;
    if (nw <= 0 || nh <= 0) return;
    const cap = ctx?.perf === 'performance' ? PERF_SURFACE_MAX_PX : Number.POSITIVE_INFINITY;
    const shrink = Math.min(1, cap / Math.max(nw, nh));
    const w = Math.round(nw * shrink);
    const h = Math.round(nh * shrink);
    el.style.width = `${String(w)}px`;
    el.style.height = `${String(h)}px`;
    rect = {
      surfaceW: w,
      surfaceH: h,
      // A bare `<video>` paints no chrome and no bars: safe === full.
      safe: { x: 0, y: 0, w, h },
      full: { x: 0, y: 0, w, h },
      mediaAspect: nw / nh,
      nativeW: nw,
      nativeH: nh,
    };
    emit({ type: 'sourcerect', rect });
  };

  const clearStallTimer = (): void => {
    if (stallTimer !== null) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };

  const adapter: HtmlVideoAdapter = {
    id: opts.id,
    capabilities,

    async mount(next) {
      ctx = next;
      const el = document.createElement('video');
      video = el;
      // The whole autoplay contract, in five lines.
      el.muted = true;
      el.defaultMuted = true;
      el.playsInline = true;
      el.autoplay = true;
      el.controls = false;
      el.preload = 'auto';
      el.setAttribute('disablepictureinpicture', '');
      el.style.display = 'block';
      el.style.transformOrigin = '0 0';
      el.className = 'kh-video__media';

      on(el, 'loadedmetadata', () => {
        measure(el);
        emit({ type: 'durationchange', duration: el.duration });
        emit({ type: 'ready', duration: el.duration, caps: capabilities });
      });
      on(el, 'resize', () => {
        measure(el);
      });
      on(el, 'durationchange', () => {
        emit({ type: 'durationchange', duration: el.duration });
      });
      on(el, 'timeupdate', () => {
        emit({ type: 'timeupdate', t: el.currentTime });
      });
      on(el, 'playing', () => {
        clearStallTimer();
        waitingSince = 0;
        emit({ type: 'playing' });
      });
      on(el, 'waiting', () => {
        waitingSince = Date.now();
        emit({ type: 'buffering' });
        clearStallTimer();
        stallTimer = setTimeout(() => {
          if (waitingSince > 0) emit({ type: 'stalled', sinceMs: Date.now() - waitingSince });
        }, STALL_REPORT_MS);
      });
      on(el, 'ended', () => {
        emit({ type: 'ended' });
      });
      on(el, 'error', () => {
        const mediaErr = el.error;
        emit({
          type: 'error',
          err: videoError(
            'source-unplayable',
            mediaErr === null
              ? 'The browser could not play this source.'
              : `Media error ${String(mediaErr.code)}: ${mediaErr.message || 'no detail'}`,
            opts.id,
            next.url,
          ),
        });
      });

      next.container.append(el);

      if (opts.attach !== undefined) {
        await opts.attach(el, next);
        return;
      }
      const src = await (opts.resolveSrc?.(next) ?? Promise.resolve(next.match.url));
      if (tornDown || next.signal.aborted) return;
      el.src = src;
      el.load();
    },

    async play() {
      const el = video;
      if (el === null) return;
      held = false;
      try {
        await el.play();
      } catch (err) {
        const name = err instanceof Error ? err.name : '';
        if (name === 'NotAllowedError' && !retriedMuted) {
          // §3.3 — force muted and retry exactly once. Never a loop: a second
          // refusal is a real policy block, and the LCD must say so.
          retriedMuted = true;
          el.muted = true;
          try {
            await el.play();
            return;
          } catch {
            /* fall through to the error below */
          }
        }
        if (name === 'AbortError') return;
        emit({
          type: 'error',
          err: videoError(
            'autoplay-blocked',
            'The browser refused to start playback without a user gesture.',
            opts.id,
            ctx?.url,
          ),
        });
      }
    },

    async hold() {
      // §3.5 — the html-video family has a real pause with no visual side effect.
      video?.pause();
      held = true;
      emit({ type: 'held' });
      return Promise.resolve();
    },

    isHeld() {
      return held;
    },

    async seek(t: number, _opts?: SeekOptions) {
      const el = video;
      if (el === null) return Promise.resolve();
      el.currentTime = Math.max(0, t);
      return Promise.resolve();
    },

    async setRate(r: number) {
      const el = video;
      if (el !== null) el.playbackRate = Math.min(RATE_MAX, Math.max(RATE_MIN, r));
      return Promise.resolve();
    },

    getCurrentTime() {
      return video?.currentTime ?? 0;
    },

    getDuration() {
      return video?.duration ?? Number.NaN;
    },

    getBufferedEnd() {
      const el = video;
      if (el === null || el.buffered.length === 0) return 0;
      return el.buffered.end(el.buffered.length - 1);
    },

    setMuted(m: boolean) {
      if (video !== null) video.muted = m;
    },

    ...(opts.quality === undefined
      ? {}
      : {
          setQuality: (heightHint: number) =>
            opts.quality?.set(heightHint) ?? Promise.resolve(false),
          getQuality: () => opts.quality?.get() ?? { height: null, label: null },
        }),

    getSurface() {
      if (video === null)
        throw new Error('kraken-hub/video: adapter surface requested before mount');
      return video;
    },

    getSourceRect() {
      return rect;
    },

    async teardown() {
      if (tornDown) return Promise.resolve();
      tornDown = true;
      clearStallTimer();
      for (const remove of off.splice(0)) remove();
      // §1.1 — the third-party player goes first: `hls.destroy()` / `reset()`
      // while the element still has its MediaSource, never after.
      await opts.detach?.();
      const el = video;
      video = null;
      if (el !== null) {
        try {
          el.pause();
        } catch {
          /* pausing a dead element is not an error worth surfacing */
        }
        // Order matters (§5.4): let the element go of the URL before revoking.
        el.removeAttribute('src');
        el.load();
        el.remove();
      }
      opts.releaseSrc?.();
      ctx = null;
      return Promise.resolve();
    },

    getVideoElement() {
      return video;
    },
  };

  return adapter;
}
