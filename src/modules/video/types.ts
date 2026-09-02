/**
 * The video module's public config surface (design-videoEngine.md §0, §1.1,
 * §3.1, §4, §8.3).
 *
 * Everything here is a *type* or a pure constant/validator: this file is
 * imported by the display path, the config panel, the remote page and the unit
 * tests, so it must never reach for the DOM.
 *
 * Two canonical conventions from the plan override the design doc:
 *  - the local clip URI scheme is `kraken-hub-clip:<id>` (not `krakenhub-clip:`)
 *  - storage keys are prefixed `kraken-hub:v1:`, the IndexedDB db is
 *    `kraken-hub.v1`
 */

import { clamp, isFiniteNumber, isPlainObject } from '../../lib/clamp';
import { MAX_URL_LEN } from '../../lib/mediaUrl';
import { PAN_LIMIT, ZOOM_MAX, ZOOM_MIN } from '../../render/types';

import { DEFAULT_QUALITY, type QualityConfig } from './quality';

import type { Rect } from '../../render/types';
import type { RenderSettings } from '../../state/schema';

/**
 * `Rect`, and the zoom/pan limits, are shared with every other module that
 * places a rectangular source on the panel — they live in `src/render/types.ts`
 * since M3 (the image module reuses the same fit math). Re-exported here under
 * their original names so the video engine's ~30 import sites did not move.
 */
export { PAN_LIMIT, ZOOM_MAX, ZOOM_MIN, type Rect };

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * `reddit` is a *routing* provider only: it resolves at mount to `direct-file`
 * on the `DASH_<h>.mp4` ladder, or to `dash` when audio is wanted (§1.5).
 */
export type ProviderId =
  | 'youtube-embed'
  | 'local-file'
  | 'direct-file'
  | 'hls'
  | 'dash'
  | 'twitch'
  | 'vimeo'
  | 'streamable'
  | 'reddit'
  | 'resolver';

/** §1.1 — what the render/loop layers are allowed to assume about a provider. */
export interface ProviderCapabilities {
  /** Backward seek inside the buffered range with no visible spinner/flash. */
  canSeekSilently: boolean;
  canSetQuality: boolean;
  canReadQuality: boolean;
  /** Provider paints UI over the media; must be hidden GEOMETRICALLY, not by CSS. */
  hasOwnChrome: boolean;
  needsMuteForAutoplay: boolean;
  /** True pause with no visual side effect (YouTube = false: pause overlay). */
  canTruePause: boolean;
  canSetRate: boolean;
  canSeek: boolean;
  reportsDuration: boolean;
  /** Pixels live in our DOM (transformable) vs an opaque cross-origin iframe. */
  pixelSource: 'video-element' | 'cross-origin-iframe';
}

/**
 * §1.1 — everything the render layer needs from an adapter. One shape for
 * `<iframe>` and `<video>` alike, which is what keeps `render/fit.ts` free of
 * per-provider branches.
 */
export interface SourceRect {
  /** Adapter surface layout box, CSS px. */
  surfaceW: number;
  surfaceH: number;
  /** Chrome-free, bar-free rect inside the surface — used for `fit:'cover'`. */
  safe: Rect;
  /** Full media rect inside the surface (chrome may overlap) — `fit:'contain'`. */
  full: Rect;
  mediaAspect: number;
  /** True decoded pixels behind `full.w` — telemetry only (supersample ratio). */
  nativeW?: number;
  nativeH?: number;
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

/** §3.1 */
export interface LoopConfig {
  enabled: boolean;
  /** Seconds, >= 0. */
  start: number;
  /** `null` => `duration - endGuardSec`. */
  end: number | null;
  /** `crossfade` is HTML-video adapters only. */
  mode: 'hard' | 'crossfade';
  crossfadeMs: number;
}

const MIN_SPAN_SEC = 0.25;
const END_GUARD_SEC = 1;
const EPS_SEC = 0.02;

/** §3.1 — the three numbers every loop rule in §3.2 is written against. */
export const LOOP_DEFAULTS = {
  minSpanSec: MIN_SPAN_SEC,
  endGuardSec: END_GUARD_SEC,
  epsSec: EPS_SEC,
} as const;

export const CROSSFADE_DEFAULT_MS = 250;
export const CROSSFADE_MIN_MS = 60;
export const CROSSFADE_MAX_MS = 1000;

export const DEFAULT_LOOP: LoopConfig = {
  enabled: false,
  start: 0,
  end: null,
  mode: 'hard',
  crossfadeMs: CROSSFADE_DEFAULT_MS,
};

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/**
 * §4 — `fit` and `rotate` are borrowed from `RenderSettings` rather than
 * re-declared, so the module and the app state can never drift apart (and so
 * this file contains no bare numeric literal types, which invariant I5 bans).
 */
export interface RenderConfig {
  fit: RenderSettings['fit'];
  /** >= 1 for cover; clamped [1, 4] (perf mode [1, 1.5]). */
  zoom: number;
  /** [-0.5, 0.5] normalized pan within the available slack. */
  offsetX: number;
  offsetY: number;
  rotate: RenderSettings['rotate'];
  /** Required to use `fit:'contain'` on `hasOwnChrome` providers. */
  allowChrome: boolean;
}

export const ZOOM_MAX_PERFORMANCE = 1.5;

export const DEFAULT_RENDER_CONFIG: RenderConfig = {
  fit: 'cover',
  zoom: ZOOM_MIN,
  offsetX: 0,
  offsetY: 0,
  rotate: 0,
  allowChrome: false,
};

// ---------------------------------------------------------------------------
// YouTube / geometry
// ---------------------------------------------------------------------------

/**
 * §2.7, §8.3 — the iframe width ladder the quality watchdog walks.
 *
 * The rungs are named individually because invariant I5 (`no-magic-numbers`)
 * exempts object properties and `const` initialisers, but not array elements.
 */
const LADDER_1280 = 1280;
const LADDER_1600 = 1600;
const LADDER_1920 = 1920;
const LADDER_2560 = 2560;
export const YT_LADDER: readonly number[] = [LADDER_1280, LADDER_1600, LADDER_1920, LADDER_2560];
/** §8.4 — 1920 until the on-hardware decode/composite table (H-ids) says otherwise. */
export const QUALITY_FLOOR_PX = LADDER_1920;
export const QUALITY_FLOOR_PX_PERFORMANCE = LADDER_1280;
/** §2.3 — portrait sources use a fixed element width, not the ladder. */
export const PORTRAIT_WIDTH_DEFAULT = 1080;

const ASPECT_PARTS = { wide: { w: 16, h: 9 }, tall: { w: 9, h: 16 } } as const;
export const ASPECT_16_9 = ASPECT_PARTS.wide.w / ASPECT_PARTS.wide.h;
export const ASPECT_9_16 = ASPECT_PARTS.tall.w / ASPECT_PARTS.tall.h;

/*
 * The seven-row `SOURCE_ASPECT_PRESETS` table used to live here, with a
 * `sourceAspectKey()` that mapped a stored number back to one of its keys.
 * Nothing rendered its labels: the shape control is a three-way Segmented
 * (Auto · Wide · Tall) that owns its own words, and the four extra rows —
 * 4:3, 1:1, 21:9, 2.39:1 — could only ever produce a key the control does not
 * offer, which it then discarded for `'auto'`. So the table was ~0.5 kB of
 * copy nobody could read, in the ONE video file the eager manifest imports
 * (`module-video` excludes `types.ts`, so it rides `core` — the LCD's first
 * download). The three-way match it existed to serve is now derived from the
 * control's own rows, in `VideoConfigPanel.tsx`, where the control is.
 *
 * `validateSourceAspect` is unchanged: a stored 4:3 (or any ratio in
 * [0.2, 5]) still survives the round trip through storage and still drives
 * the geometry — it just no longer has a label nothing shows.
 */

/**
 * §2.4 — `'auto'` means 9:16 for a `/shorts/` URL and 16:9 for everything else.
 * That is the only inference available without reading the opaque iframe.
 */
export function resolveSourceAspect(value: SourceAspect, isShorts: boolean): number {
  if (value === 'auto') return isShorts ? ASPECT_9_16 : ASPECT_16_9;
  return value;
}

export type GeometryMode = 'square' | 'tight';
export type PauseStrategy = 'microloop' | 'maskedPause';
export type SourceAspect = number | 'auto';

export interface YouTubeConfig {
  /** No cross-origin way to read the true aspect — this is a manual step (§2.4). */
  sourceAspect: SourceAspect;
  mode: GeometryMode;
  qualityFloorPx: number;
  portraitWidth: number;
  /** Default `microloop`: `pauseVideo()` raises the suggested-video grid (§2.6). */
  pauseStrategy: PauseStrategy;
  /** Fractions of the video rect to trim — baked-in bars, not letterbox (§2.3). */
  sourceInset: { top: number; bottom: number; left: number; right: number };
  maskColor: string;
}

export const DEFAULT_YOUTUBE: YouTubeConfig = {
  sourceAspect: 'auto',
  mode: 'square',
  qualityFloorPx: QUALITY_FLOOR_PX,
  portraitWidth: PORTRAIT_WIDTH_DEFAULT,
  pauseStrategy: 'microloop',
  sourceInset: { top: 0, bottom: 0, left: 0, right: 0 },
  maskColor: '#000000',
};

// ---------------------------------------------------------------------------
// Download / resolver / performance
// ---------------------------------------------------------------------------

/**
 * The featured ingestion path: paste a URL, the app downloads the bytes into
 * its own clip library and plays the local copy from then on. `stream-only`
 * keeps the remote URL as the source of truth.
 */
export type DownloadMode = 'auto' | 'stream-only';

/*
 * `PROXY_PRESETS` used to live here: a two-entry table whose labels were the
 * `<select>` options the round-1 census counted among its 171 words of prose
 * inside `<option>` elements ("None (recommended)", "allorigins.win — public,
 * best-effort, sees every URL you play"). The control became a Switch plus a
 * text field in round 1 and the table has had no reader since — dead copy for
 * two rounds, carrying the wording the redesign deleted.
 *
 * The proxy FIELD stays exactly as it is. Whether to ship a public proxy at all
 * is one of the design audit's §6 product decisions, and it is not this round's
 * to make; `ALLORIGINS_PROXY_BASE` is still what `VideoConfigPanel`'s switch
 * writes.
 */

/** §1.4 — the resolver is a policy layer, never a URL pattern. */
export type ResolverPolicy = 'off' | 'youtube-only' | 'preferred' | 'fallback';

export const RESOLVER_DEFAULT_PORT = 8976;
const PORT_MIN = 1;
const PORT_MAX = 65_535;

export interface ResolverConfig {
  policy: ResolverPolicy;
  port: number;
  /** Optional shared token (`?token=` / `X-Krakenhub-Token`), frozen in v1. */
  token: string;
}

export const DEFAULT_RESOLVER: ResolverConfig = {
  policy: 'youtube-only',
  port: RESOLVER_DEFAULT_PORT,
  token: '',
};

/** §8.3 */
export type PerfMode = 'auto' | 'quality' | 'performance';

export interface VideoModuleConfig {
  /** A remote URL, or `kraken-hub-clip:<id>` for a clip in the local library. */
  url: string;
  downloadMode: DownloadMode;
  /**
   * §7.3 step 4 — an optional CORS proxy, tried only after every direct attempt
   * has failed. Ships EMPTY and stays empty unless a user opts in: a proxy sees
   * every URL the display plays, and a plain passthrough proxy is *insufficient
   * for HLS* (the variant and segment URLs inside a manifest resolve back to the
   * origin host and re-fail CORS). See docs/providers.md.
   */
  proxyBase: string;
  loop: LoopConfig;
  render: RenderConfig;
  youtube: YouTubeConfig;
  resolver: ResolverConfig;
  perf: PerfMode;
  /**
   * What resolution to ask for (`./quality.ts`).
   *
   * Distinct from `perf`, which is about how much *compositor* work the panel
   * can afford, and from `youtube.qualityFloorPx`, which is the mechanism this
   * setting drives on one provider. This is the user-facing "what am I getting,
   * and can I change it" lever, and it means different things per provider on
   * purpose — see `qualityControlFor()`.
   */
  quality: QualityConfig;
  /** The LCD is always muted; this only opts *audio-capable* paths in. */
  audioEnabled: boolean;
  /** Play the bundled low-entropy clip when `url` is empty (§ plan: demo mode). */
  demoWhenEmpty: boolean;
}

export const VIDEO_DEFAULTS: VideoModuleConfig = {
  url: '',
  downloadMode: 'auto',
  proxyBase: '',
  loop: DEFAULT_LOOP,
  render: DEFAULT_RENDER_CONFIG,
  youtube: DEFAULT_YOUTUBE,
  resolver: DEFAULT_RESOLVER,
  perf: 'auto',
  quality: DEFAULT_QUALITY,
  audioEnabled: false,
  demoWhenEmpty: true,
};

// ---------------------------------------------------------------------------
// Validation (never throws — see KrakenModule.validate)
// ---------------------------------------------------------------------------

/** §7.1 — anything longer will not survive the sync channel. Shared with the image module. */
export { MAX_URL_LEN };
const MAX_SECONDS = 86_400;
const MAX_COLOR_LEN = 32;
const MAX_TOKEN_LEN = 128;
const MAX_INSET_FRACTION = 0.45;
const MIN_ASPECT = 0.2;
const MAX_ASPECT = 5;
// device-size-ok: the floor on the YouTube ELEMENT ladder (iframe px), not a panel.
const MIN_LADDER_PX = 640;
const MAX_LADDER_PX = 4096;

function pickString(raw: unknown, def: string, maxLen: number): string {
  return typeof raw === 'string' && raw.length <= maxLen ? raw : def;
}

function pickBool(raw: unknown, def: boolean): boolean {
  return typeof raw === 'boolean' ? raw : def;
}

function pickNum(raw: unknown, def: number, min: number, max: number): number {
  return isFiniteNumber(raw) ? clamp(raw, min, max) : def;
}

function pickEnum<T extends string>(raw: unknown, def: T, allowed: readonly T[]): T {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : def;
}

function obj(raw: unknown): Record<string, unknown> {
  return isPlainObject(raw) ? raw : {};
}

const ROT = { quarter: 90, half: 180, threeQuarter: 270 } as const;
const ROTATIONS: readonly RenderSettings['rotate'][] = [0, ROT.quarter, ROT.half, ROT.threeQuarter];

function pickRotation(raw: unknown, def: RenderSettings['rotate']): RenderSettings['rotate'] {
  return ROTATIONS.includes(raw as RenderSettings['rotate'])
    ? (raw as RenderSettings['rotate'])
    : def;
}

function validateLoopConfig(raw: unknown): LoopConfig {
  const o = obj(raw);
  const end = o['end'];
  return {
    enabled: pickBool(o['enabled'], DEFAULT_LOOP.enabled),
    start: pickNum(o['start'], DEFAULT_LOOP.start, 0, MAX_SECONDS),
    end: end === null || end === undefined ? null : pickNum(end, 0, 0, MAX_SECONDS),
    mode: pickEnum(o['mode'], DEFAULT_LOOP.mode, ['hard', 'crossfade']),
    crossfadeMs: pickNum(
      o['crossfadeMs'],
      DEFAULT_LOOP.crossfadeMs,
      CROSSFADE_MIN_MS,
      CROSSFADE_MAX_MS,
    ),
  };
}

function validateRenderConfig(raw: unknown): RenderConfig {
  const o = obj(raw);
  return {
    fit: pickEnum(o['fit'], DEFAULT_RENDER_CONFIG.fit, [
      'cover',
      'contain',
      'contain-circle',
      'fill',
    ]),
    zoom: pickNum(o['zoom'], DEFAULT_RENDER_CONFIG.zoom, ZOOM_MIN, ZOOM_MAX),
    offsetX: pickNum(o['offsetX'], DEFAULT_RENDER_CONFIG.offsetX, -PAN_LIMIT, PAN_LIMIT),
    offsetY: pickNum(o['offsetY'], DEFAULT_RENDER_CONFIG.offsetY, -PAN_LIMIT, PAN_LIMIT),
    rotate: pickRotation(o['rotate'], DEFAULT_RENDER_CONFIG.rotate),
    allowChrome: pickBool(o['allowChrome'], DEFAULT_RENDER_CONFIG.allowChrome),
  };
}

function validateSourceAspect(raw: unknown): SourceAspect {
  if (raw === 'auto') return 'auto';
  if (isFiniteNumber(raw)) return clamp(raw, MIN_ASPECT, MAX_ASPECT);
  return DEFAULT_YOUTUBE.sourceAspect;
}

function validateInset(raw: unknown): YouTubeConfig['sourceInset'] {
  const o = obj(raw);
  const side = (k: string): number => pickNum(o[k], 0, 0, MAX_INSET_FRACTION);
  return { top: side('top'), bottom: side('bottom'), left: side('left'), right: side('right') };
}

function validateYouTube(raw: unknown): YouTubeConfig {
  const o = obj(raw);
  return {
    sourceAspect: validateSourceAspect(o['sourceAspect']),
    mode: pickEnum(o['mode'], DEFAULT_YOUTUBE.mode, ['square', 'tight']),
    qualityFloorPx: Math.round(
      pickNum(o['qualityFloorPx'], DEFAULT_YOUTUBE.qualityFloorPx, MIN_LADDER_PX, MAX_LADDER_PX),
    ),
    portraitWidth: Math.round(
      pickNum(o['portraitWidth'], DEFAULT_YOUTUBE.portraitWidth, MIN_LADDER_PX, MAX_LADDER_PX),
    ),
    pauseStrategy: pickEnum(o['pauseStrategy'], DEFAULT_YOUTUBE.pauseStrategy, [
      'microloop',
      'maskedPause',
    ]),
    sourceInset: validateInset(o['sourceInset']),
    maskColor: pickString(o['maskColor'], DEFAULT_YOUTUBE.maskColor, MAX_COLOR_LEN),
  };
}

/**
 * The pinned height is clamped to a sane video range rather than to the ladder:
 * a provider may genuinely offer 900p or 4320p, and a value that came from a
 * real level list must survive the round trip through storage.
 */
const MIN_QUALITY_HEIGHT = 144;
const MAX_QUALITY_HEIGHT = 4320;

function validateQuality(raw: unknown): QualityConfig {
  const o = obj(raw);
  const height = o['height'];
  return {
    mode: pickEnum(o['mode'], DEFAULT_QUALITY.mode, ['auto', 'fixed']),
    // Anything that is not a usable number becomes "no pin", NOT the floor.
    // Clamping a `"1080"` string up from the minimum would silently give
    // somebody 144p and look like a bug in the picker rather than in the
    // document that produced it.
    height: isFiniteNumber(height)
      ? Math.round(clamp(height, MIN_QUALITY_HEIGHT, MAX_QUALITY_HEIGHT))
      : null,
  };
}

function validateResolver(raw: unknown): ResolverConfig {
  const o = obj(raw);
  return {
    policy: pickEnum(o['policy'], DEFAULT_RESOLVER.policy, [
      'off',
      'youtube-only',
      'preferred',
      'fallback',
    ]),
    port: Math.round(pickNum(o['port'], DEFAULT_RESOLVER.port, PORT_MIN, PORT_MAX)),
    token: pickString(o['token'], DEFAULT_RESOLVER.token, MAX_TOKEN_LEN),
  };
}

/**
 * MUST NOT throw. Coerce, clamp, drop unknown keys, fill from defaults — this
 * runs against whatever is in localStorage, including a config written by a
 * fork or by a future version of this module.
 */
export function validateVideoConfig(raw: unknown): VideoModuleConfig {
  const o = obj(raw);
  return {
    url: pickString(o['url'], VIDEO_DEFAULTS.url, MAX_URL_LEN),
    downloadMode: pickEnum(o['downloadMode'], VIDEO_DEFAULTS.downloadMode, ['auto', 'stream-only']),
    proxyBase: pickString(o['proxyBase'], VIDEO_DEFAULTS.proxyBase, MAX_URL_LEN),
    loop: validateLoopConfig(o['loop']),
    render: validateRenderConfig(o['render']),
    youtube: validateYouTube(o['youtube']),
    resolver: validateResolver(o['resolver']),
    perf: pickEnum(o['perf'], VIDEO_DEFAULTS.perf, ['auto', 'quality', 'performance']),
    quality: validateQuality(o['quality']),
    audioEnabled: pickBool(o['audioEnabled'], VIDEO_DEFAULTS.audioEnabled),
    demoWhenEmpty: pickBool(o['demoWhenEmpty'], VIDEO_DEFAULTS.demoWhenEmpty),
  };
}

/** §8.3 — the levers `perf: 'performance'` pulls, as data rather than `if`s. */
export interface PerfProfile {
  qualityFloorPx: number;
  geometryMode: GeometryMode;
  zoomMax: number;
  allowCrossfade: boolean;
  posterMask: boolean;
  telemetryHz: number;
}

const TELEMETRY_HZ_QUALITY = 0.5;
const TELEMETRY_HZ_PERFORMANCE = 0.2;

export function perfProfile(mode: Exclude<PerfMode, 'auto'>): PerfProfile {
  return mode === 'performance'
    ? {
        qualityFloorPx: QUALITY_FLOOR_PX_PERFORMANCE,
        geometryMode: 'tight',
        zoomMax: ZOOM_MAX_PERFORMANCE,
        allowCrossfade: false,
        posterMask: false,
        telemetryHz: TELEMETRY_HZ_PERFORMANCE,
      }
    : {
        qualityFloorPx: QUALITY_FLOOR_PX,
        geometryMode: 'square',
        zoomMax: ZOOM_MAX,
        allowCrossfade: true,
        posterMask: true,
        telemetryHz: TELEMETRY_HZ_QUALITY,
      };
}

const LOW_FPS_FOR_PERFORMANCE = 10;
const ACHIEVED_FPS_RATIO = 0.6;

/** §8.3 — `auto` promotes to `performance`; the caller owns the 10 s hysteresis. */
export function resolvePerfMode(
  mode: PerfMode,
  signals: { targetFps: number; achievedFps: number },
): Exclude<PerfMode, 'auto'> {
  if (mode !== 'auto') return mode;
  if (signals.targetFps <= LOW_FPS_FOR_PERFORMANCE) return 'performance';
  if (signals.achievedFps < signals.targetFps * ACHIEVED_FPS_RATIO) return 'performance';
  return 'quality';
}

/** §8.3 — `auto` needs a sustained observation, not a single bad frame. */
export const PERF_HYSTERESIS_MS = 10_000;

export interface PerfPromoter {
  /** Feed it every frame; returns the mode that should currently be in force. */
  update(
    mode: PerfMode,
    signals: { targetFps: number; achievedFps: number },
  ): Exclude<PerfMode, 'auto'>;
  current(): Exclude<PerfMode, 'auto'>;
}

/**
 * §8.3's promotion rule with the hysteresis the doc requires.
 *
 * Two clauses, and they behave differently on purpose:
 *  - `targetFps <= 10` is a **setting**, not a measurement. It is true the
 *    instant CAM's slider moves, so it promotes immediately — waiting ten
 *    seconds to react to a deliberate user action would just look broken.
 *  - `achievedFps < targetFps * 0.6` is a **measurement**, and a noisy one: one
 *    stalled frame during a seek must not flip the whole render path. It has to
 *    hold for ten continuous seconds, and so does the recovery back to quality.
 */
export function createPerfPromoter(opts: { now?: () => number } = {}): PerfPromoter {
  const now = opts.now ?? Date.now;
  let current: Exclude<PerfMode, 'auto'> = 'quality';
  let candidate: Exclude<PerfMode, 'auto'> | null = null;
  let candidateSince = 0;

  return {
    update(mode, signals) {
      if (mode !== 'auto') {
        candidate = null;
        current = mode;
        return current;
      }
      if (signals.targetFps <= LOW_FPS_FOR_PERFORMANCE) {
        candidate = null;
        current = 'performance';
        return current;
      }
      const wanted = resolvePerfMode('auto', signals);
      if (wanted === current) {
        candidate = null;
        return current;
      }
      if (candidate !== wanted) {
        candidate = wanted;
        candidateSince = now();
        return current;
      }
      if (now() - candidateSince >= PERF_HYSTERESIS_MS) {
        current = wanted;
        candidate = null;
      }
      return current;
    },
    current() {
      return current;
    },
  };
}
