/**
 * The YouTube geometry engine (design-videoEngine.md §2, all of it).
 *
 * The problem, stated exactly: CSS cannot hide a cross-origin player's chrome,
 * and a `transform: scale()` on a parent does not change the size the player
 * measures for itself — so the official NZXT integration's 640×640 iframe both
 * gets served ~360p *and* has YouTube's spinner, pause overlay and watermark
 * painted right across the picture.
 *
 * One move fixes both: make the iframe large and shaped so the player
 * **letterboxes** the video, then crop the centre. The chrome lands on the black
 * bars and is cropped away; the large measured width is what makes YouTube serve
 * 1080p. All the arithmetic lives in `youtube/geometry.ts` (pure, unit-tested
 * against the doc's worked examples) and all the *transform writing* lives in
 * `RenderController` — this adapter only reports a `SourceRect`.
 *
 * What is left over is everything that is not arithmetic, and it is all here:
 *
 *  - the exact embed URL and iframe attributes (§2.5) — the width/height
 *    ATTRIBUTES are what the player measures, so they and the CSS must agree;
 *  - the overlay mask state machine (§2.6, `youtube/maskController.ts`);
 *  - `hold()` as a micro-loop, because `pauseVideo()` raises the suggested-video
 *    grid *inside* the video rect where the crop cannot reach it (§2.6);
 *  - the implicit end-guard loop, because reaching `duration` raises the end
 *    screen for the same reason (§2.6);
 *  - the quality watchdog and its one ladder step (§2.7,
 *    `youtube/qualityWatch.ts`).
 *
 * Honest limitation, restated here where an implementer will read it: **ads
 * render inside the video rect**, so the crop cannot remove them, and the embed
 * API gives no reliable ad signal, so the mask stays down through one. The
 * ad-free, chrome-free path is a local clip or the resolver companion (§2.8).
 */

import { ytEmbedPath, ytPosterUrls } from '../../../config/knownHosts';
import { clamp } from '../../../lib/clamp';
import { IMPLICIT_LOOP_START_SEC } from '../loop/LoopEngine';
import { publish } from '../telemetry/videoTelemetry';
import {
  LOOP_DEFAULTS,
  QUALITY_FLOOR_PX_PERFORMANCE,
  YT_LADDER,
  ZOOM_MAX,
  ZOOM_MAX_PERFORMANCE,
  ZOOM_MIN,
  perfProfile,
  resolveSourceAspect,
} from '../types';
import { computeGeometry, geometryToSourceRect } from '../youtube/geometry';
import { YT_STATE, createMaskController, type MaskController } from '../youtube/maskController';
import { createQualityWatch, readLadderOverride } from '../youtube/qualityWatch';
import { loadYtApi } from '../youtube/ytApiLoader';

import { fail, videoError } from './VideoAdapter';

import type { AdapterEvent, MountContext, SeekOptions, VideoAdapter } from './VideoAdapter';
import type { ProviderCapabilities, SourceRect } from '../types';
import type { GeomResult } from '../youtube/geometry';

/**
 * §2.5, measured finding kept as a named constant so it stays discoverable:
 * the `vq` parameter is echoed back in `client.originalUrl` and is **never
 * parsed into PLAYER_VARS**. It does nothing. Setting it anyway would look like
 * quality control and would quietly mislead the next reader into believing the
 * ladder in `qualityWatch.ts` is redundant. It is not: element width is the only
 * lever an embed actually responds to.
 */
export const YT_INCLUDE_INERT_VQ = false;

/** §2.6 — `hold()` micro-loops over this span rather than pausing. */
export const MICRO_LOOP_SPAN_SEC = 0.3;
/** §2.6 — the slowest rate the player offers, typically 0.25. */
const MICRO_LOOP_FALLBACK_RATE = 0.25;
const NORMAL_RATE = 1;
/** `timeupdate` is emitted at roughly the HTML `<video>` cadence, ~4 Hz. */
const TIMEUPDATE_INTERVAL_MS = 250;
/** Two frames, per §2.6's `maskedPause` recipe. */
const MASKED_PAUSE_FRAMES = 2;
/** A backward drift larger than this means something reset the clock, not us. */
const MICRO_LOOP_BACK_TOLERANCE_SEC = 1;
const RATE_MIN = 0.25;
const RATE_MAX = 2;

/** §1.2 — the youtube-embed row. `canSeekSilently` is promoted at runtime (§3.4). */
export const YOUTUBE_CAPS: ProviderCapabilities = {
  canSeekSilently: false,
  // `setPlaybackQuality` has been a documented no-op for years. Element width
  // is the lever; see qualityWatch.ts.
  canSetQuality: false,
  canReadQuality: true,
  hasOwnChrome: true,
  needsMuteForAutoplay: true,
  // `pauseVideo()` raises the pause overlay, so there is no true pause here.
  canTruePause: false,
  canSetRate: true,
  canSeek: true,
  reportsDuration: true,
  pixelSource: 'cross-origin-iframe',
};

/**
 * §2.5 — the embed URL, exactly.
 *
 * `loop` is deliberately `0`: the A-B loop is ours (`PolledLoop`), and YouTube's
 * own `loop=1` requires a `playlist` parameter, re-cues the video (which flashes
 * the poster) and cannot express a span.
 */
export function buildEmbedUrl(id: string, startSec: number, origin: string | null): string {
  const p = new URLSearchParams({
    enablejsapi: '1',
    autoplay: '1',
    mute: '1',
    playsinline: '1',
    controls: '0',
    rel: '0',
    iv_load_policy: '3',
    disablekb: '1',
    fs: '0',
    cc_load_policy: '0',
    color: 'white',
    loop: '0',
  });
  // A `null` origin (a sandboxed or `file:` document) must not be sent as the
  // literal string "null" — the API rejects it and the handshake never completes.
  if (origin !== null && origin !== 'null') p.set('origin', origin);
  if (startSec > 0) p.set('start', String(Math.floor(startSec)));
  return `${ytEmbedPath(id)}?${p.toString()}`;
}

function pageOrigin(): string | null {
  try {
    return window.location.origin;
  } catch {
    return null;
  }
}

/**
 * §2.5 — attributes AND inline style both carry the size, because the ATTRIBUTE
 * is what the player measures while the STYLE is what the compositor lays out.
 * Never `sandbox` (it breaks the postMessage handshake the API needs) and never
 * `modestbranding` (deprecated years ago, and it never did anything here).
 */
function applyIframeGeometry(iframe: HTMLIFrameElement, w: number, h: number): void {
  iframe.width = String(w);
  iframe.height = String(h);
  iframe.style.width = `${String(w)}px`;
  iframe.style.height = `${String(h)}px`;
}

function createIframe(src: string, w: number, h: number): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.className = 'kh-video__yt';
  iframe.src = src;
  iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  iframe.setAttribute('frameborder', '0');
  iframe.setAttribute('scrolling', 'no');
  iframe.tabIndex = -1;
  iframe.title = 'video';
  iframe.loading = 'eager';
  iframe.style.border = '0';
  iframe.style.display = 'block';
  applyIframeGeometry(iframe, w, h);
  return iframe;
}

export function createAdapter(): VideoAdapter {
  const capabilities: ProviderCapabilities = { ...YOUTUBE_CAPS };

  let ctx: MountContext | null = null;
  let iframe: HTMLIFrameElement | null = null;
  let player: YtApi.Player | null = null;
  let mask: MaskController | null = null;
  let watch: ReturnType<typeof createQualityWatch> | null = null;
  let rect: SourceRect | null = null;
  let videoId = '';
  let startSec = 0;
  let sourceAspect = 0;
  let duration = Number.NaN;
  let lastTime = 0;
  let lastQuality: { height: number | null; label: string | null } = { height: null, label: null };
  let held = false;
  let microAnchor = Number.NaN;
  let rafId: number | null = null;
  let lastTimeUpdate = 0;
  let tornDown = false;
  let remounting = false;
  /**
   * §2.5, and a production bug (CAM 4.76.5, Electron 32.1.0 / Chromium 128).
   *
   * `new YT.Player(el, …)` returns IMMEDIATELY, but the IFrame API only grafts
   * `mute`, `playVideo`, `seekTo`, `getCurrentTime` … onto that object once the
   * postMessage handshake with the embed completes and `onReady` fires. Before
   * then the object is a bare shell: `player.mute` is `undefined`, and `?.`
   * does NOT help — optional chaining guards a null receiver, not a missing
   * method.
   *
   * `display.ts` calls `adapter.setMuted(true)` and `adapter.play()` the
   * instant `mount()` resolves, which is long before the handshake on a slow
   * webview. On hardware that produced
   * `TypeError: r?.mute is not a function` → `source-unplayable`, i.e. YouTube
   * never played at all on the device the whole engine exists for.
   *
   * The rule this flag enforces: **no player API method may be invoked until
   * `onReady` has fired.** Anything issued earlier is queued in `pending` and
   * replayed, in order, from the `onReady` handler.
   */
  let ready = false;
  const pending: ((p: YtApi.Player) => void)[] = [];

  const emit = (e: AdapterEvent): void => {
    if (!tornDown) ctx?.emit(e);
  };

  /** The player, but only once its methods actually exist. */
  function live(): YtApi.Player | null {
    return ready ? player : null;
  }

  /** Run now if the handshake is done, otherwise queue it for `onReady`. */
  function whenReady(fn: (p: YtApi.Player) => void): void {
    if (tornDown) return;
    const p = live();
    if (p !== null) {
      fn(p);
      return;
    }
    pending.push(fn);
  }

  function flushPending(p: YtApi.Player): void {
    const queued = pending.splice(0, pending.length);
    for (const fn of queued) {
      if (tornDown) return;
      fn(p);
    }
  }

  // -------------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------------

  /**
   * §8.3 — the four performance levers this adapter owns: a 1280 element floor,
   * `tight` geometry, a 1.5 zoom clamp, and a flat mask instead of a poster.
   */
  function computeForWidth(widthOverride: number | null): GeomResult {
    const c = ctx;
    if (c === null) throw new Error('kraken-hub/video: geometry before mount');
    const yt = c.config.youtube;
    const zoomMax = c.perf === 'performance' ? ZOOM_MAX_PERFORMANCE : ZOOM_MAX;
    const floor =
      c.perf === 'performance'
        ? Math.min(yt.qualityFloorPx, QUALITY_FLOOR_PX_PERFORMANCE)
        : yt.qualityFloorPx;
    return computeGeometry({
      displayW: c.display.width,
      displayH: c.display.height,
      dpr: c.display.dpr,
      zoom: clamp(c.config.render.zoom, ZOOM_MIN, zoomMax),
      sourceAspect,
      mode: c.perf === 'performance' ? 'tight' : yt.mode,
      // A ladder step is an override, not a floor to be negotiated with: it is
      // the width the watchdog proved (or feared) is right for this machine.
      qualityFloorPx: widthOverride ?? floor,
      ladder: YT_LADDER,
      portraitWidth: yt.portraitWidth,
      sourceInset: yt.sourceInset,
      panX: 0,
      panY: 0,
    });
  }

  function publishGeometry(g: GeomResult): void {
    rect = geometryToSourceRect(g, sourceAspect, true);
    if (iframe !== null) applyIframeGeometry(iframe, g.elementW, g.elementH);
    emit({ type: 'sourcerect', rect });
    if (g.undersized) {
      // §2.2 step 3 — no ladder rung satisfied both the crop need and the
      // quality floor, so the panel is being fed fewer source pixels than it
      // has. Not an error: a smaller, softer picture still plays.
      publish({
        code: 'geometry-undersized',
        severity: 'warn',
        provider: 'youtube-embed',
        message: `crop ${String(Math.round(g.cropSide))} px for a ${String(
          Math.max(ctx?.display.width ?? 0, ctx?.display.height ?? 0),
        )} px panel`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Player lifecycle
  // -------------------------------------------------------------------------

  function destroyPlayer(): void {
    try {
      // `destroy` is grafted on with the rest of the API, so a player that
      // never reached `onReady` does not have one. Removing the iframe is the
      // whole teardown in that case.
      live()?.destroy();
    } catch {
      /* a player whose iframe already went away throws; that is not a failure */
    }
    ready = false;
    // A queued call belongs to the player that is going away. Replaying it
    // against the next one would re-issue a stale seek after a ladder step.
    pending.length = 0;
    player = null;
    iframe?.remove();
    iframe = null;
  }

  async function buildPlayer(resumeAt: number, widthOverride: number | null): Promise<void> {
    const c = ctx;
    if (c === null) return;
    const g = computeForWidth(widthOverride);
    const el = createIframe(buildEmbedUrl(videoId, resumeAt, pageOrigin()), g.elementW, g.elementH);
    iframe = el;
    c.container.append(el);
    publishGeometry(g);

    const api = await loadYtApi();
    if (tornDown || c.signal.aborted) return;

    // §2.5 — attach to the PRE-EXISTING iframe. Letting the API build its own
    // would hand it ownership of the width/height attributes, which are the
    // entire quality mechanism.
    player = new api.Player(el, {
      events: {
        onReady: (ev) => {
          if (tornDown) return;
          // `ev.target` is the same object, but taking it from the event means
          // this never depends on the assignment below having run yet.
          const p = player ?? ev.target;
          player = p;
          // The gate opens HERE and nowhere else. Everything below this line —
          // including the queue flush — is the first legal API traffic.
          ready = true;
          // The embed URL already carries `mute=1`; this is the belt to that
          // brace, and it is now issued at the only moment it is callable.
          p.mute();
          duration = p.getDuration();
          if (resumeAt > 0) p.seekTo(resumeAt, true);
          p.playVideo();
          emit({ type: 'durationchange', duration });
          emit({ type: 'ready', duration, caps: capabilities });
          flushPending(p);
        },
        onStateChange: (e) => {
          if (tornDown) return;
          const t = live()?.getCurrentTime() ?? lastTime;
          mask?.onPlayerState(e.data, t);
          switch (e.data) {
            case YT_STATE.playing:
              watch?.notePlaying();
              emit({ type: 'playing' });
              break;
            case YT_STATE.buffering:
              watch?.noteBuffering();
              emit({ type: 'buffering' });
              break;
            case YT_STATE.ended:
              // The end guard should have prevented this; if it fires anyway,
              // going back to the start beats leaving the end screen up.
              whenReady((p) => {
                p.seekTo(IMPLICIT_LOOP_START_SEC, true);
                p.playVideo();
              });
              emit({ type: 'ended' });
              break;
            case YT_STATE.paused:
              emit({ type: 'held' });
              break;
            default:
              break;
          }
        },
        onPlaybackQualityChange: (e) => {
          if (tornDown) return;
          watch?.noteQuality(e.data);
        },
        onError: () => {
          if (tornDown) return;
          emit({
            type: 'error',
            err: videoError(
              'source-unplayable',
              'YouTube refused to play this video here — it may be private, removed, or embedding-disabled.',
              'youtube-embed',
              c.url,
            ),
          });
        },
      },
    });
  }

  /** §2.7 — a ladder step: rebuild at the new width, keeping the playhead. */
  function remountAtWidth(width: number): void {
    if (remounting || tornDown) return;
    remounting = true;
    const resumeAt = live()?.getCurrentTime() ?? lastTime;
    destroyPlayer();
    void buildPlayer(Math.max(0, Math.floor(resumeAt)), width)
      .catch(() => {
        emit({
          type: 'error',
          err: videoError(
            'yt-api-unavailable',
            'The player did not come back after a quality change.',
            'youtube-embed',
            ctx?.url,
          ),
        });
      })
      .finally(() => {
        remounting = false;
      });
  }

  // -------------------------------------------------------------------------
  // The tick: mask failsafes, quality watchdog, end guard, micro-loop
  // -------------------------------------------------------------------------

  function tick(): void {
    rafId = null;
    if (tornDown) return;
    // Pre-ready the player has no methods at all, so the whole body below is
    // gated on `live()` rather than on `player !== null`.
    const p = live();
    if (p !== null) {
      const t = p.getCurrentTime();
      if (Number.isFinite(t)) lastTime = t;
      mask?.onTime(lastTime);

      if (!Number.isFinite(duration) || duration <= 0) {
        const d = p.getDuration();
        if (Number.isFinite(d) && d > 0) {
          duration = d;
          emit({ type: 'durationchange', duration });
        }
      }

      if (held && Number.isFinite(microAnchor)) {
        // §2.6 — the micro-loop. NEVER `pauseVideo()`: the pause overlay paints
        // a suggested-video grid inside the video rect, where the crop cannot
        // reach it. Creeping forward at 0.25× and snapping back is invisible.
        if (
          lastTime > microAnchor + MICRO_LOOP_SPAN_SEC ||
          lastTime < microAnchor - MICRO_LOOP_BACK_TOLERANCE_SEC
        ) {
          p.seekTo(microAnchor, true);
        }
      } else if (Number.isFinite(duration) && duration > 0) {
        // §2.6 — the implicit end guard is ALWAYS installed, A-B loop or not.
        // Reaching `duration` raises the end screen, and no crop can hide it.
        const guard = duration - LOOP_DEFAULTS.endGuardSec;
        if (guard > IMPLICIT_LOOP_START_SEC && lastTime >= guard) {
          mask?.onLoopCrossing(IMPLICIT_LOOP_START_SEC, false);
          p.seekTo(IMPLICIT_LOOP_START_SEC, true);
        }
      }

      const now = Date.now();
      if (now - lastTimeUpdate >= TIMEUPDATE_INTERVAL_MS) {
        lastTimeUpdate = now;
        emit({ type: 'timeupdate', t: lastTime });
      }
    }
    mask?.tick();
    watch?.tick();
    rafId = requestAnimationFrame(tick);
  }

  // -------------------------------------------------------------------------

  const adapter: VideoAdapter = {
    id: 'youtube-embed',
    capabilities,
    ownsMask: true,

    async mount(next) {
      ctx = next;
      videoId = next.match.id ?? '';
      if (videoId === '') {
        throw fail(
          'source-unplayable',
          'That YouTube link has no video id in it.',
          'youtube-embed',
          next.url,
        );
      }
      startSec = next.match.meta.start ?? 0;
      sourceAspect = resolveSourceAspect(
        next.config.youtube.sourceAspect,
        next.match.meta.portrait === true,
      );

      const profile = perfProfile(next.perf);
      mask = createMaskController({
        surface: next.mask,
        posterUrls: ytPosterUrls(videoId),
        usePoster: profile.posterMask,
        flatColor: next.config.youtube.maskColor,
        onStalled: (visibleMs) => {
          emit({ type: 'stalled', sinceMs: visibleMs });
          emit({
            type: 'error',
            err: videoError(
              'stall',
              'YouTube has not produced a frame for 15 seconds.',
              'youtube-embed',
              next.url,
            ),
          });
        },
      });
      mask.mount();
      mask.setBoundaryA(startSec);

      const ladderOverride = readLadderOverride();
      watch = createQualityWatch({
        initialWidth: computeForWidth(ladderOverride).elementW,
        perf: next.config.perf,
        getSignals: () => ({
          loadedFraction: live()?.getVideoLoadedFraction() ?? 0,
          duration,
          currentTime: lastTime,
        }),
        onStep: (width) => {
          remountAtWidth(width);
        },
        onTelemetry: (kind, detail) => {
          if (kind === null) return;
          // The served height goes in `message` so the config UI — and the
          // live e2e — can read the number off the ring buffer without
          // parsing prose. §7.5: this is the zero-network diagnostic path.
          publish({
            code: kind,
            severity: kind === 'quality' ? 'info' : 'warn',
            provider: 'youtube-embed',
            message: detail.observedHeight === null ? '' : String(detail.observedHeight),
            detail: { reason: detail.reason, elementW: watch?.currentWidth() ?? 0 },
          });
        },
        onQuality: (height, label) => {
          lastQuality = { height, label };
          emit({ type: 'quality', height, label });
        },
      });

      await buildPlayer(startSec, ladderOverride);
      if (tornDown) return;
      rafId = requestAnimationFrame(tick);
    },

    async play() {
      held = false;
      microAnchor = Number.NaN;
      whenReady((p) => {
        p.setPlaybackRate(NORMAL_RATE);
        p.playVideo();
      });
      return Promise.resolve();
    },

    async hold() {
      const p = live();
      if (p === null) {
        // Nothing to hold yet. Re-enter once the handshake lands, so whichever
        // strategy the config asks for runs against a real player.
        if (player !== null) whenReady(() => void adapter.hold());
        return Promise.resolve();
      }

      if (ctx?.config.youtube.pauseStrategy === 'maskedPause') {
        // §2.6's documented alternative: the overlay is still raised, we just
        // hide it behind our own fully opaque DOM first. Lower power for a long
        // hold; still never the default, because a dropped mask reveals it.
        mask?.onSeekIssued(p.getCurrentTime());
        await new Promise<void>((resolve) => {
          let frames = MASKED_PAUSE_FRAMES;
          const step = (): void => {
            frames -= 1;
            if (frames <= 0) resolve();
            else requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        });
        if (!tornDown) live()?.pauseVideo();
        held = true;
        emit({ type: 'held' });
        return;
      }

      // Default: the micro-loop. Slowest available rate plus a 0.3 s span.
      const rates = p.getAvailablePlaybackRates();
      const slowest = rates.length > 0 ? Math.min(...rates) : MICRO_LOOP_FALLBACK_RATE;
      microAnchor = p.getCurrentTime();
      p.setPlaybackRate(slowest);
      held = true;
      emit({ type: 'held' });
    },

    isHeld() {
      return held;
    },

    async seek(t, opts?: SeekOptions) {
      const target = Math.max(0, t);
      if (opts?.loopSeek === true) {
        mask?.onLoopCrossing(target, opts.silentExpected === true);
      } else {
        mask?.onSeekIssued(target);
      }
      whenReady((p) => {
        p.seekTo(target, true);
      });
      return Promise.resolve();
    },

    async setRate(r) {
      whenReady((p) => {
        p.setPlaybackRate(clamp(r, RATE_MIN, RATE_MAX));
      });
      return Promise.resolve();
    },

    getCurrentTime() {
      return lastTime;
    },

    getDuration() {
      return duration;
    },

    getBufferedEnd() {
      const fraction = live()?.getVideoLoadedFraction() ?? 0;
      return Number.isFinite(duration) && duration > 0 ? fraction * duration : 0;
    },

    setMuted(m) {
      // display.ts calls this the instant `mount()` resolves — routinely
      // BEFORE `onReady`. That call is what crashed on hardware.
      whenReady((p) => {
        if (m) p.mute();
        else p.unMute();
      });
    },

    getQuality() {
      return lastQuality;
    },

    getSurface() {
      if (iframe === null) throw new Error('kraken-hub/video: YouTube surface before mount');
      return iframe;
    },

    getSourceRect() {
      if (rect === null) throw new Error('kraken-hub/video: source rect before mount');
      return rect;
    },

    async teardown() {
      if (tornDown) return Promise.resolve();
      tornDown = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
      mask?.dispose();
      mask = null;
      watch?.dispose();
      watch = null;
      destroyPlayer();
      rect = null;
      ctx = null;
      return Promise.resolve();
    },
  };

  return adapter;
}
