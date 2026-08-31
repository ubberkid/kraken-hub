/**
 * Shared plumbing for the three *other* cross-origin embed providers — Twitch,
 * Vimeo and Streamable (design-videoEngine.md §1.2, §2.1, §4.1).
 *
 * Everything YouTube taught us applies verbatim to these three: their players
 * are cross-origin, so CSS cannot reach their chrome; a `transform: scale()` on
 * a parent does not change the size they measure for themselves; and all three
 * letterbox a 16:9 stream inside an oversized element, painting their title bar,
 * controls and watermark onto the bars. So they get the same treatment — an
 * oversized element, and a centre crop that throws the chrome away — through the
 * same pure math in `youtube/geometry.ts`.
 *
 * What differs is *quality control*, and that difference is the honest part of
 * `docs/providers.md`: Twitch's `setQuality` genuinely works, Vimeo's is gated
 * behind a paid tier for the *uploader*, and Streamable has no API at all.
 *
 * Nothing here writes a transform. The adapter builds a surface at layout size
 * and reports a `SourceRect`; `RenderController` owns every transform (§1.1).
 */

import { clamp } from '../../../lib/clamp';
import {
  QUALITY_FLOOR_PX_PERFORMANCE,
  ZOOM_MAX,
  ZOOM_MAX_PERFORMANCE,
  ZOOM_MIN,
  YT_LADDER,
} from '../types';
import { computeGeometry, geometryToSourceRect } from '../youtube/geometry';

import type { MountContext } from './VideoAdapter';
import type { SourceRect } from '../types';
import type { GeomResult } from '../youtube/geometry';

/**
 * The geometry for an embed of a given aspect, honouring the same performance
 * levers the YouTube adapter obeys (§8.3): a 1280 element floor, `tight` mode
 * and a 1.5 zoom clamp in performance mode.
 */
export function embedGeometry(ctx: MountContext, sourceAspect: number): GeomResult {
  const yt = ctx.config.youtube;
  const zoomMax = ctx.perf === 'performance' ? ZOOM_MAX_PERFORMANCE : ZOOM_MAX;
  const floor =
    ctx.perf === 'performance'
      ? Math.min(yt.qualityFloorPx, QUALITY_FLOOR_PX_PERFORMANCE)
      : yt.qualityFloorPx;
  return computeGeometry({
    displayW: ctx.display.width,
    displayH: ctx.display.height,
    dpr: ctx.display.dpr,
    zoom: clamp(ctx.config.render.zoom, ZOOM_MIN, zoomMax),
    sourceAspect,
    mode: ctx.perf === 'performance' ? 'tight' : yt.mode,
    qualityFloorPx: floor,
    ladder: YT_LADDER,
    portraitWidth: yt.portraitWidth,
    sourceInset: yt.sourceInset,
    panX: 0,
    panY: 0,
  });
}

export function embedSourceRect(g: GeomResult, sourceAspect: number): SourceRect {
  return geometryToSourceRect(g, sourceAspect, true);
}

export interface EmbedIframeOptions {
  src: string;
  width: number;
  height: number;
  /** Provider-specific feature policy. `autoplay` is mandatory on all of them. */
  allow?: string;
  className: string;
  title: string;
}

/**
 * Attributes AND inline style both carry the size: the ATTRIBUTE is what the
 * embedded player measures, the STYLE is what the compositor lays out. Never
 * `sandbox` — every one of these players talks to us over `postMessage`, and a
 * sandbox without `allow-scripts allow-same-origin` silently kills the handshake
 * (§2.5).
 */
export function createEmbedIframe(opts: EmbedIframeOptions): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.className = opts.className;
  iframe.src = opts.src;
  iframe.allow = opts.allow ?? 'autoplay; encrypted-media; picture-in-picture';
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  iframe.setAttribute('frameborder', '0');
  iframe.setAttribute('scrolling', 'no');
  iframe.tabIndex = -1;
  iframe.title = opts.title;
  iframe.loading = 'eager';
  iframe.style.border = '0';
  iframe.style.display = 'block';
  applyEmbedSize(iframe, opts.width, opts.height);
  return iframe;
}

export function applyEmbedSize(iframe: HTMLIFrameElement, w: number, h: number): void {
  iframe.width = String(w);
  iframe.height = String(h);
  iframe.style.width = `${String(w)}px`;
  iframe.style.height = `${String(h)}px`;
}

/**
 * A `<script src>` loader with single-flight semantics and a timeout, shared by
 * the Twitch and Vimeo SDKs.
 *
 * Invariant I8 bans CDN scripts on the *display critical path*; these load only
 * when a Twitch or Vimeo URL is actually playing, exactly like the YouTube
 * IFrame API, and they are the providers' only supported embedding route.
 */
export function loadEmbedScript(
  src: string,
  ready: () => boolean,
  timeoutMs: number,
): Promise<void> {
  if (ready()) return Promise.resolve();
  const existing = inFlight.get(src);
  if (existing !== undefined) return existing;

  const promise = new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    const timer = setTimeout(() => {
      inFlight.delete(src);
      reject(new Error(`kraken-hub/video: ${src} did not load in ${String(timeoutMs)} ms`));
    }, timeoutMs);
    el.addEventListener('load', () => {
      clearTimeout(timer);
      if (ready()) resolve();
      else reject(new Error(`kraken-hub/video: ${src} loaded but exposed no API`));
    });
    el.addEventListener('error', () => {
      clearTimeout(timer);
      // Forget the failure so §7.4's backoff can genuinely retry it.
      inFlight.delete(src);
      reject(new Error(`kraken-hub/video: ${src} failed to load`));
    });
    document.head.append(el);
  });

  inFlight.set(src, promise);
  return promise;
}

const inFlight = new Map<string, Promise<void>>();

/** Test hook — the module-level single-flight map would leak between cases. */
export function resetEmbedScriptCache(): void {
  inFlight.clear();
}
