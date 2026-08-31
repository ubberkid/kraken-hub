/**
 * YouTube geometry engine — ALL of the crop math (design-videoEngine.md §2.2,
 * §2.3). Pure functions, no DOM, no globals.
 *
 * The principle (§2.1): CSS cannot hide cross-origin YouTube chrome, and a
 * `transform: scale()` on a parent does not change the size the player measures
 * for itself. Both problems fall to one move — make the iframe big and shaped so
 * the player letterboxes the video, then crop the centre square. The chrome
 * lands on the bars, and the large measured width is what makes YouTube serve
 * 1080p instead of the 360p the official integration gets.
 */

import { clamp } from '../../../lib/clamp';
import { ASPECT_16_9, PORTRAIT_WIDTH_DEFAULT, QUALITY_FLOOR_PX, YT_LADDER } from '../types';

import type { GeometryMode, SourceRect } from '../types';

/** §2.2 */
export interface GeomInput {
  /** `window.nzxt.v1.width/height`. Never hardcode 640 (invariant I3). */
  displayW: number;
  displayH: number;
  /**
   * `clamp(devicePixelRatio || 1, 1, 3)`. H02, confirmed as 1 on CAM 4.76.5
   * (see the hardware-checklist known results); other devices may differ.
   */
  dpr: number;
  /** >= 1 for cover. */
  zoom: number;
  sourceAspect: number;
  mode: GeometryMode;
  qualityFloorPx: number;
  ladder: readonly number[];
  /** Portrait sources use a fixed element width, not the ladder (§2.3). */
  portraitWidth?: number;
  /** Normalized pan, [-0.5, 0.5]. */
  panX?: number;
  panY?: number;
  /**
   * Baked-in bars (a 2.39:1 film inside a 16:9 upload) trimmed as fractions of
   * the video rect, applied BEFORE the crop math (§2.3).
   */
  sourceInset?: { top: number; bottom: number; left: number; right: number };
  /**
   * Where the crop sits inside a portrait video rect. `'top'` reproduces the
   * §2.3 Shorts worked example (`sy0 = 240`) and frames the upper half, where a
   * Shorts subject normally is; `'center'` applies the same centring rule the
   * landscape cases get. Landscape is always centred (there is no vertical
   * slack there — the video rect height *is* the crop side).
   */
  portraitAnchor?: 'top' | 'center';
}

export interface GeomResult {
  /** `width`/`height` ATTRIBUTES on the iframe — this is what the player measures. */
  elementW: number;
  elementH: number;
  /** The video rect inside the element, after `sourceInset`. */
  videoX: number;
  videoY: number;
  videoW: number;
  videoH: number;
  /** Letterbox/pillarbox bar thickness before the inset, px. */
  barPx: number;
  /** Largest square crop available inside the video rect. */
  cropSide: number;
  /** The crop actually taken, `cropSide / zoom`. */
  cropEffective: number;
  cropX: number;
  cropY: number;
  scale: number;
  translateX: number;
  translateY: number;
  orientation: 'landscape' | 'portrait';
  /** No ladder rung satisfied both the crop need and the quality floor (§2.2 step 3). */
  undersized: boolean;
  /** `ceil(cropSide)` — what the §2.7 watchdog compares the served height to. */
  targetQualityHeight: number;
  /**
   * The zoom at which the crop stops supersampling: beyond it the panel is
   * upscaling. 1.6875 at N=1920/640, 2.25 at N=2560/640 (§2.3).
   */
  pixelParityZoomLimit: number;
  /**
   * A 1080-wide portrait element may not elicit 1080p from YouTube's size
   * heuristic. Unverified on hardware (H05/H11); telemetry flag
   * `geometry-portrait-unverified`.
   */
  portraitUnverified: boolean;
}

const DPR_MIN = 1;
const DPR_MAX = 3;
const ZOOM_MIN = 1;
const ZOOM_MAX = 4;
const HALF = 0.5;
const PAN_LIMIT = 0.5;
const NO_INSET = { top: 0, bottom: 0, left: 0, right: 0 } as const;

/** §2.2 step 4 — the black margin kept outside the video so chrome has somewhere to land. */
const BAR_SAFE_LANDSCAPE_MIN = 180;
const BAR_SAFE_LANDSCAPE_FRACTION = 0.12;
// device-size-ok: a margin inside the 1920 iframe, measured in iframe px.
const BAR_SAFE_PORTRAIT_MIN = 240;
const BAR_SAFE_PORTRAIT_FRACTION = 0.125;

/** §4.4 — transforms are rounded so sub-pixel churn never re-rasters a layer. */
export const TRANSLATE_DECIMALS = 3;
export const SCALE_DECIMALS = 7;

export const DEFAULT_GEOM_INPUT: Omit<GeomInput, 'displayW' | 'displayH'> = {
  dpr: 1,
  zoom: 1,
  sourceAspect: ASPECT_16_9,
  mode: 'square',
  qualityFloorPx: QUALITY_FLOOR_PX,
  ladder: YT_LADDER,
  portraitWidth: PORTRAIT_WIDTH_DEFAULT,
};

/** §2.2 step 1 — the crop side the panel actually needs, in device pixels. */
export function requiredCropSide(input: GeomInput): number {
  const dpr = clamp(input.dpr, DPR_MIN, DPR_MAX);
  const zoom = clamp(input.zoom, ZOOM_MIN, ZOOM_MAX);
  return Math.ceil(Math.max(input.displayW, input.displayH) * dpr * zoom);
}

/**
 * §2.2 step 2 — the largest square crop a letterboxing element of width `w`
 * yields for aspect `a`.
 *
 * Landscape (`a >= 1`) in a square element: the video is `w × w/a`, so the crop
 * is bounded by its height. Portrait (`a < 1`) needs a *tall* element (a square
 * one pillarboxes, which puts chrome over the video), so the crop is bounded by
 * the width.
 */
export function cropSideForWidth(w: number, sourceAspect: number): number {
  return sourceAspect >= 1 ? w / sourceAspect : w;
}

/** §2.2 step 3 — smallest rung meeting both the crop need and the quality floor. */
export function selectElementWidth(
  needed: number,
  input: Pick<GeomInput, 'sourceAspect' | 'qualityFloorPx' | 'ladder'>,
): { width: number; undersized: boolean } {
  const rungs = [...input.ladder].sort((a, b) => a - b);
  for (const n of rungs) {
    if (cropSideForWidth(n, input.sourceAspect) >= needed && n >= input.qualityFloorPx) {
      return { width: n, undersized: false };
    }
  }
  const widest = rungs.at(-1) ?? input.qualityFloorPx;
  return { width: widest, undersized: true };
}

/** §2.2 step 4 */
export function barSafePx(videoHeight: number, orientation: 'landscape' | 'portrait'): number {
  return orientation === 'portrait'
    ? Math.round(Math.max(BAR_SAFE_PORTRAIT_MIN, BAR_SAFE_PORTRAIT_FRACTION * videoHeight))
    : Math.round(Math.max(BAR_SAFE_LANDSCAPE_MIN, BAR_SAFE_LANDSCAPE_FRACTION * videoHeight));
}

/**
 * The whole engine, steps 1–5.
 *
 * Step 5 in the doc is written for the landscape square case, where the crop is
 * centred in the *element*. That is the same thing as centring it in the *video
 * rect* there (the bars are symmetric and the video height equals the crop
 * side), which is why this implementation is expressed in video-rect terms: it
 * reproduces every landscape worked example unchanged and is the only form that
 * also handles a portrait element, where the two are not the same thing.
 */
export function computeGeometry(input: GeomInput): GeomResult {
  const a = input.sourceAspect;
  const orientation: 'landscape' | 'portrait' = a >= 1 ? 'landscape' : 'portrait';
  const zoom = clamp(input.zoom, ZOOM_MIN, ZOOM_MAX);
  const needed = requiredCropSide(input);
  const maxDisplay = Math.max(input.displayW, input.displayH);

  let elementW: number;
  let undersized: boolean;
  if (orientation === 'portrait') {
    // Portrait sources top out at 1080×1920, so the ladder is not the right
    // tool: a fixed element width is (§2.3). It still has to be wide enough.
    const wanted = input.portraitWidth ?? PORTRAIT_WIDTH_DEFAULT;
    elementW = Math.max(wanted, needed);
    undersized = wanted < needed;
  } else {
    const picked = selectElementWidth(needed, input);
    elementW = picked.width;
    undersized = picked.undersized;
  }

  const videoW0 = elementW;
  const videoH0 = elementW / a;

  let elementH: number;
  if (orientation === 'landscape' && input.mode === 'square') {
    elementH = elementW;
  } else {
    elementH = Math.round(videoH0) + 2 * barSafePx(videoH0, orientation);
  }

  // The video is centred in the element by the player itself, in both axes.
  const inset = input.sourceInset ?? NO_INSET;
  const videoX0 = (elementW - videoW0) * HALF;
  const videoY0 = (elementH - videoH0) * HALF;
  const barPx = videoY0;

  const videoX = videoX0 + inset.left * videoW0;
  const videoY = videoY0 + inset.top * videoH0;
  const videoW = videoW0 * (1 - inset.left - inset.right);
  const videoH = videoH0 * (1 - inset.top - inset.bottom);

  const cropSide = Math.min(videoW, videoH);
  const cropEffective = cropSide / zoom;

  const panX = clamp(input.panX ?? 0, -PAN_LIMIT, PAN_LIMIT);
  const panY = clamp(input.panY ?? 0, -PAN_LIMIT, PAN_LIMIT);
  // Pan slack is `cropSide - cropEffective` per §2.2 step 5 — deliberately the
  // conservative range (the zoomed-in window sliding inside the crop square),
  // not the full width of the video rect.
  const panSlack = cropSide - cropEffective;
  const anchorY =
    orientation === 'portrait' && (input.portraitAnchor ?? 'top') === 'top' ? 0 : HALF;

  const cropX = videoX + (videoW - cropEffective) * HALF + panX * panSlack;
  const cropY = videoY + (videoH - cropEffective) * anchorY + panY * panSlack;

  const scale = maxDisplay / cropEffective;

  return {
    elementW,
    elementH,
    videoX,
    videoY,
    videoW,
    videoH,
    barPx,
    cropSide,
    cropEffective,
    cropX,
    cropY,
    scale,
    translateX: -cropX * scale,
    translateY: -cropY * scale,
    orientation,
    undersized,
    targetQualityHeight: Math.ceil(cropSide),
    pixelParityZoomLimit: cropSide / maxDisplay,
    portraitUnverified: orientation === 'portrait',
  };
}

/** §4.4 — `transform-origin: 0 0` is assumed; the caller sets it once. */
export function toTransformCss(g: Pick<GeomResult, 'translateX' | 'translateY' | 'scale'>): string {
  const tx = g.translateX.toFixed(TRANSLATE_DECIMALS);
  const ty = g.translateY.toFixed(TRANSLATE_DECIMALS);
  const s = g.scale.toFixed(SCALE_DECIMALS);
  return `translate(${tx}px, ${ty}px) scale(${s})`;
}

/**
 * Telemetry only: how many source pixels sit behind one panel pixel. Below 1
 * the panel is upscaling, which is what the §2.7 quality alarm is watching for.
 */
export function supersampleRatio(servedHeightPx: number, panelPx: number): number {
  return servedHeightPx / panelPx;
}

/**
 * §2.7 — a 2560×2560 element is 6.55 Mpx of composited surface on a machine
 * that is probably running a game. Only pay for it when the extra sharpness is
 * real: the crop is genuinely below pixel parity, or the watchdog proved a
 * size cap.
 */
export function shouldStepTo2560(args: {
  zoom: number;
  pixelParityZoomLimit: number;
  sizeCapProven: boolean;
}): boolean {
  return args.sizeCapProven || args.zoom > args.pixelParityZoomLimit;
}

/**
 * §1.1, §2.2 — the geometry result expressed as a `SourceRect`.
 *
 * `safe` is the centre crop square at zoom 1: `RenderController` applies zoom
 * and pan on top, so putting them in here too would apply them twice. Feeding
 * the crop square through `fit: 'cover'` on a square panel reproduces §2.2 step
 * 5 exactly — which is the point of having one math path.
 *
 * `full` is the video band including the region the player may paint chrome
 * over. It is only ever used by `fit: 'contain'` with `allowChrome: true`, i.e.
 * when the user has explicitly asked to see the player's own UI.
 *
 * This lives here rather than in `youtubeEmbed.adapter.ts` because Twitch,
 * Vimeo and Streamable letterbox inside an oversized element exactly the same
 * way, and so use exactly the same crop.
 */
export function geometryToSourceRect(
  g: GeomResult,
  sourceAspect: number,
  portraitAnchorTop: boolean,
): SourceRect {
  const anchorY = g.orientation === 'portrait' && portraitAnchorTop ? 0 : HALF;
  return {
    surfaceW: g.elementW,
    surfaceH: g.elementH,
    safe: {
      x: g.videoX + (g.videoW - g.cropSide) / 2,
      y: g.videoY + (g.videoH - g.cropSide) * anchorY,
      w: g.cropSide,
      h: g.cropSide,
    },
    full: { x: g.videoX, y: g.videoY, w: g.videoW, h: g.videoH },
    mediaAspect: sourceAspect,
  };
}
