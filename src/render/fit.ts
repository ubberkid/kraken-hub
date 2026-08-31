/**
 * Fit math (design-videoEngine.md §4.1). Pure, no DOM.
 *
 * One math path for cross-origin iframes, `<video>` elements and `<img>`
 * elements alike: each reports a rect in its own surface coordinates, and this
 * file never branches on what produced it. That is the whole reason the rect
 * abstraction exists — and, since M3, why the image module gets `cover`,
 * `contain`, `contain-circle`, `fill`, zoom and pan for free.
 *
 * Lifted out of `src/modules/video/render/fit.ts` unchanged; that file now
 * re-exports these and keeps only the two provider-aware helpers
 * (`pickSourceRect`, `effectiveFit`) that genuinely belong to the video engine.
 */

import { clamp } from '../lib/clamp';

import { PAN_LIMIT, ZOOM_MAX, ZOOM_MIN } from './types';

import type { Rect } from './types';
import type { RenderSettings } from '../state/schema';

export interface FitInput {
  /** The viewport, i.e. the panel. */
  viewportW: number;
  viewportH: number;
  /** The source rect being placed, in surface coordinates. */
  rect: Rect;
  fit: RenderSettings['fit'];
  zoom: number;
  offsetX: number;
  offsetY: number;
}

export interface FitResult {
  scaleX: number;
  scaleY: number;
  translateX: number;
  translateY: number;
  /** The window of the source rect that ends up on screen, in source px. */
  visibleW: number;
  visibleH: number;
  /** Pan headroom left over, in source px. Zero means the pan does nothing. */
  slackX: number;
  slackY: number;
  /** Letterbox padding inside the viewport, px. Non-zero only for `contain*`. */
  letterboxX: number;
  letterboxY: number;
}

const HALF = 0.5;

/**
 * The largest rect of aspect `a` inscribed in a circle of diameter `D`:
 * `h = D / √(1 + a²)`, `w = a·h`. Used by `fit: 'contain-circle'` so nothing is
 * clipped by the round bezel.
 */
export function inscribeInCircle(aspect: number, diameter: number): { w: number; h: number } {
  const h = diameter / Math.sqrt(1 + aspect * aspect);
  return { w: aspect * h, h };
}

function uniformScale(input: FitInput): number {
  const { viewportW: W, viewportH: H, rect, zoom } = input;
  switch (input.fit) {
    case 'cover':
      return Math.max(W / rect.w, H / rect.h) * zoom;
    case 'contain':
      return Math.min(W / rect.w, H / rect.h) * zoom;
    case 'contain-circle': {
      const { w } = inscribeInCircle(rect.w / rect.h, Math.min(W, H));
      return (w / rect.w) * zoom;
    }
    case 'fill':
      // Unreachable: `fill` is non-uniform and handled in computeFit.
      return Math.max(W / rect.w, H / rect.h) * zoom;
  }
}

/** §4.1 — the whole transform, in one pass. */
export function computeFit(input: FitInput): FitResult {
  const { viewportW: W, viewportH: H, rect } = input;
  const zoom = clamp(input.zoom, ZOOM_MIN, ZOOM_MAX);
  const offsetX = clamp(input.offsetX, -PAN_LIMIT, PAN_LIMIT);
  const offsetY = clamp(input.offsetY, -PAN_LIMIT, PAN_LIMIT);

  const scaleX = input.fit === 'fill' ? (W / rect.w) * zoom : uniformScale({ ...input, zoom });
  const scaleY = input.fit === 'fill' ? (H / rect.h) * zoom : scaleX;

  const visibleW = W / scaleX;
  const visibleH = H / scaleY;

  // Slack is clamped at zero on purpose. When the visible window is WIDER than
  // the source rect (every `contain` case), the extra space is letterboxing —
  // it belongs in `letterbox*`, centred in the viewport, not in a negative
  // recentring of the source origin. Getting this wrong is what turns the §4.1
  // worked check into a 140 px vertical offset.
  const slackX = Math.max(0, rect.w - visibleW);
  const slackY = Math.max(0, rect.h - visibleH);

  const sx0 = rect.x + slackX * HALF + offsetX * slackX;
  const sy0 = rect.y + slackY * HALF + offsetY * slackY;

  const letterboxX = Math.max(0, (W - rect.w * scaleX) * HALF);
  const letterboxY = Math.max(0, (H - rect.h * scaleY) * HALF);

  return {
    scaleX,
    scaleY,
    translateX: letterboxX - sx0 * scaleX,
    translateY: letterboxY - sy0 * scaleY,
    visibleW,
    visibleH,
    slackX,
    slackY,
    letterboxX,
    letterboxY,
  };
}

export const FIT_DECIMALS = 3;

/** §4.4 — 3 decimals, and `scale(x, y)` only when the two differ. */
export function toTransformCss(f: FitResult): string {
  const tx = f.translateX.toFixed(FIT_DECIMALS);
  const ty = f.translateY.toFixed(FIT_DECIMALS);
  const sx = f.scaleX.toFixed(FIT_DECIMALS + FIT_DECIMALS);
  const sy = f.scaleY.toFixed(FIT_DECIMALS + FIT_DECIMALS);
  const scale = sx === sy ? `scale(${sx})` : `scale(${sx}, ${sy})`;
  return `translate(${tx}px, ${ty}px) ${scale}`;
}
