/**
 * Config type, defaults and validator for the `image` module.
 *
 * Eager (the registry imports it), so: no DOM, no storage, no fetch. The URL
 * validation that produces user-facing messages lives in `imageUrl.ts`, which
 * is pure too but is only needed once something is about to be displayed.
 */

import { clamp, isFiniteNumber, isPlainObject } from '../../lib/clamp';
import { MAX_URL_LEN } from '../../lib/mediaUrl';
import { PAN_LIMIT, ZOOM_MAX, ZOOM_MIN } from '../../render/types';

import type { RenderSettings } from '../../state/schema';

/** `kraken-hub-image:<id>` — the mirror of the video module's clip scheme. */
export const LOCAL_IMAGE_SCHEME = 'kraken-hub-image:';
export const LOCAL_IMAGE_RE = /^kraken-hub-image:([A-Za-z0-9-]{1,64})$/;

/**
 * `auto` downloads the bytes into the library and paints the local copy from
 * then on; `stream-only` always points `<img>` at the remote URL. Same policy,
 * and the same default, as the video module — a display that has been running
 * for a week should not need the network to repaint.
 */
export type ImageDownloadMode = 'auto' | 'stream-only';

/** Borrowed from `RenderSettings` so the module and app state cannot drift. */
export interface ImageRenderConfig {
  fit: RenderSettings['fit'];
  zoom: number;
  offsetX: number;
  offsetY: number;
  rotate: RenderSettings['rotate'];
}

export interface ImageSlideshowConfig {
  enabled: boolean;
  /**
   * Seconds between advances. Floored at 10 on purpose: every advance decodes a
   * new full-panel image and hands CAM's compressor a frame with nothing in
   * common with the last one, which is the single most expensive thing this
   * module can do. Below ~10 s that cost is continuous.
   */
  intervalSec: number;
}

export interface ImageModuleConfig {
  /** An https URL, or `kraken-hub-image:<id>`. Empty means "nothing chosen yet". */
  url: string;
  downloadMode: ImageDownloadMode;
  /** Painted behind the picture, and visible wherever `contain` letterboxes. */
  background: string;
  render: ImageRenderConfig;
  slideshow: ImageSlideshowConfig;
}

export const SLIDESHOW_MIN_INTERVAL_SEC = 10;
export const SLIDESHOW_MAX_INTERVAL_SEC = 3600;
export const SLIDESHOW_DEFAULT_INTERVAL_SEC = 30;

const MAX_COLOR_LEN = 32;

export const DEFAULT_IMAGE_RENDER: ImageRenderConfig = {
  fit: 'cover',
  zoom: ZOOM_MIN,
  offsetX: 0,
  offsetY: 0,
  rotate: 0,
};

export const IMAGE_DEFAULTS: ImageModuleConfig = {
  url: '',
  downloadMode: 'auto',
  background: '#000000',
  render: { ...DEFAULT_IMAGE_RENDER },
  slideshow: { enabled: false, intervalSec: SLIDESHOW_DEFAULT_INTERVAL_SEC },
};

function pickString(raw: unknown, def: string, maxLen: number): string {
  return typeof raw === 'string' && raw.length <= maxLen ? raw : def;
}

function pickNum(raw: unknown, def: number, min: number, max: number): number {
  return isFiniteNumber(raw) ? clamp(raw, min, max) : def;
}

function pickFit(raw: unknown, def: RenderSettings['fit']): RenderSettings['fit'] {
  return raw === 'cover' || raw === 'contain' || raw === 'contain-circle' || raw === 'fill'
    ? raw
    : def;
}

const ROT_90 = 90;
const ROT_180 = 180;
const ROT_270 = 270;

function pickRotate(raw: unknown, def: RenderSettings['rotate']): RenderSettings['rotate'] {
  return raw === 0 || raw === ROT_90 || raw === ROT_180 || raw === ROT_270 ? raw : def;
}

function validateRender(raw: unknown): ImageRenderConfig {
  const o = isPlainObject(raw) ? raw : {};
  return {
    fit: pickFit(o['fit'], DEFAULT_IMAGE_RENDER.fit),
    zoom: pickNum(o['zoom'], DEFAULT_IMAGE_RENDER.zoom, ZOOM_MIN, ZOOM_MAX),
    offsetX: pickNum(o['offsetX'], DEFAULT_IMAGE_RENDER.offsetX, -PAN_LIMIT, PAN_LIMIT),
    offsetY: pickNum(o['offsetY'], DEFAULT_IMAGE_RENDER.offsetY, -PAN_LIMIT, PAN_LIMIT),
    rotate: pickRotate(o['rotate'], DEFAULT_IMAGE_RENDER.rotate),
  };
}

function validateSlideshow(raw: unknown): ImageSlideshowConfig {
  const o = isPlainObject(raw) ? raw : {};
  return {
    enabled: typeof o['enabled'] === 'boolean' ? o['enabled'] : false,
    // Rounded before clamping: `9.9` is a request for 10, not for 9.
    intervalSec: Math.round(
      pickNum(
        o['intervalSec'],
        SLIDESHOW_DEFAULT_INTERVAL_SEC,
        SLIDESHOW_MIN_INTERVAL_SEC,
        SLIDESHOW_MAX_INTERVAL_SEC,
      ),
    ),
  };
}

/** Never throws. Coerces, clamps, drops unknown keys, fills from defaults. */
export function validateImageConfig(raw: unknown): ImageModuleConfig {
  const o = isPlainObject(raw) ? raw : {};
  return {
    url: pickString(o['url'], IMAGE_DEFAULTS.url, MAX_URL_LEN),
    downloadMode: o['downloadMode'] === 'stream-only' ? 'stream-only' : 'auto',
    background: pickString(o['background'], IMAGE_DEFAULTS.background, MAX_COLOR_LEN),
    render: validateRender(o['render']),
    slideshow: validateSlideshow(o['slideshow']),
  };
}

export function localImageId(url: string): string | null {
  return LOCAL_IMAGE_RE.exec(url)?.[1] ?? null;
}

export function localImageUrl(id: string): string {
  return `${LOCAL_IMAGE_SCHEME}${id}`;
}
