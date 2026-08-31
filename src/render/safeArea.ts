/**
 * Circular safe-area helpers (design-videoEngine.md §4.3), shared by every
 * module that puts readable text on a round panel.
 *
 * The inset math itself lives in `src/platform/geometry.ts` (invariant I3: one
 * owner for every geometry constant) — this file adds only the *overlay box*
 * cards, dials and labels are laid out against.
 *
 * `shape === 'circle'` affects overlays ONLY. Full-bleed content (a video, a
 * photo) is meant to reach the bezel.
 *
 * Lifted out of `src/modules/video/render/safeArea.ts` in M3 so the clock,
 * image and stats modules can use it without importing the video module.
 */

import { circleSafeInsetPx } from '../platform/geometry';

import type { Rect } from './types';

/** §4.3 — 22 px is the floor at which text survives CAM's frame compression. */
export const MIN_OVERLAY_FONT_PX = 22;
export const TITLE_FONT_PX = 30;
export const DETAIL_FONT_PX = 18;

export interface PanelShape {
  width: number;
  height: number;
  shape: 'circle' | 'square';
}

export interface SafeAreaOptions {
  /** Fraction of the radius treated as visible on a round panel. */
  safeRadiusPct: number;
  /** Fraction of the short edge used as inset on a square panel. */
  safeAreaPct: number;
}

const SQUARE_INSET_MAX = 0.2;
const HALF = 0.5;

/**
 * The box overlays must stay inside.
 *
 * Round panel, `D = 640`, `safeRadiusPct = 0.88` → inset ≈ 120.9 px, box
 * ≈ 398×398 centred — the number every on-LCD card is laid out against.
 */
export function safeAreaBox(panel: PanelShape, opts: SafeAreaOptions): Rect & { insetPx: number } {
  const short = Math.min(panel.width, panel.height);
  const insetPx =
    panel.shape === 'circle'
      ? circleSafeInsetPx(short, opts.safeRadiusPct)
      : short * Math.min(Math.max(opts.safeAreaPct, 0), SQUARE_INSET_MAX);
  const side = short - 2 * insetPx;
  return {
    x: (panel.width - side) * HALF,
    y: (panel.height - side) * HALF,
    w: side,
    h: side,
    insetPx,
  };
}

/**
 * Is a point inside the visible disc? Used by the diagnostics ring target and
 * by overlay layout assertions — never per frame.
 */
export function isInsideSafeCircle(
  panel: PanelShape,
  safeRadiusPct: number,
  x: number,
  y: number,
): boolean {
  if (panel.shape !== 'circle') {
    return x >= 0 && y >= 0 && x <= panel.width && y <= panel.height;
  }
  const cx = panel.width * HALF;
  const cy = panel.height * HALF;
  const r = Math.min(panel.width, panel.height) * HALF * safeRadiusPct;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

export { circleSafeInsetPx };
