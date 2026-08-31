/**
 * Panel geometry and safe-area math (invariant I3: no geometry constant is
 * hardcoded outside this file and `devicePresets.ts`).
 *
 * Everything visual reads `Geometry`, so the same code is correct on a 640
 * round Elite, a 320 round Z and a 240 square Kraken 2023.
 */

import { clamp } from '../lib/clamp';
import { createLogger } from '../lib/log';

import {
  DEFAULT_SAFE_RADIUS_PCT,
  FALLBACK_HEIGHT,
  FALLBACK_WIDTH,
  type Shape,
} from './devicePresets';
import { getDisplayInfo, subscribeDisplayInfo, type DisplayInfo } from './nzxt';

const log = createLogger('platform/geometry');

export interface Geometry {
  width: number;
  height: number;
  shape: Shape;
  targetFps: number;
  /** `window.devicePixelRatio`. UNVERIFIED on hardware (H02) — reported, never assumed. */
  dpr: number;
  source: 'nzxt' | 'sim' | 'url' | 'fallback';
  /** Practical inset for text and UI. Content inside it is safe to read. */
  safeInsetPx: number;
  /** Side of the largest square that fits the panel: `min(w,h) / √2` on a circle. */
  inscribedSquarePx: number;
  radiusPx: number;
}

export interface GeometryPrefs {
  /** Used only when `window.nzxt` was never injected. */
  fallbackTargetFps: number;
}

export interface GeometryRender {
  /** Fraction of the radius treated as visible on a round panel (default 0.88). */
  safeRadiusPct: number;
  /** Fraction of the short edge used as inset on a square panel (default 0.08). */
  safeAreaPct: number;
}

export const DEFAULT_GEOMETRY_RENDER: GeometryRender = {
  safeRadiusPct: DEFAULT_SAFE_RADIUS_PCT,
  safeAreaPct: 0.08,
};

/**
 * Inset from the panel edge to the largest axis-aligned square that fits inside
 * a circle of radius `safeRadiusPct · D/2`:
 *
 *   insetPx = (D / 2) · (1 − safeRadiusPct / √2)
 *
 * At D = 640 and safeRadiusPct = 0.88 this is ≈ 120.9 px, leaving a ≈ 398 px
 * box — the number the overlay cards, the low-FPS banner and the error card are
 * laid out against.
 */
export function circleSafeInsetPx(diameterPx: number, safeRadiusPct: number): number {
  const pct = clamp(safeRadiusPct, 0.1, 1);
  return (diameterPx / 2) * (1 - pct / Math.SQRT2);
}

/** Pure geometry derivation — no DOM, no globals. This is the unit-tested seam. */
export function deriveGeometry(
  info: DisplayInfo,
  prefs: GeometryPrefs,
  render: GeometryRender = DEFAULT_GEOMETRY_RENDER,
): Geometry {
  const width = info.width > 0 ? info.width : FALLBACK_WIDTH;
  const height = info.height > 0 ? info.height : FALLBACK_HEIGHT;
  // Anything that is not explicitly a circle is treated as square: no mask,
  // no inset loss, nothing cropped away that the user expected to see.
  const shape: Shape = info.shape === 'circle' ? 'circle' : 'square';
  const short = Math.min(width, height);

  // An absent nzxt object tells us nothing about the slider; assuming CAM's
  // 1 FPS default would cripple a display whose injection merely arrived late.
  const targetFps =
    info.source === 'fallback'
      ? clamp(Math.round(prefs.fallbackTargetFps), 1, 60)
      : clamp(Math.round(info.targetFps), 1, 60);

  const safeInsetPx =
    shape === 'circle'
      ? Math.round(circleSafeInsetPx(short, render.safeRadiusPct))
      : Math.round(short * clamp(render.safeAreaPct, 0, 0.2));

  return {
    width,
    height,
    shape,
    targetFps,
    dpr: info.dpr > 0 ? info.dpr : 1,
    source: info.source,
    safeInsetPx,
    inscribedSquarePx: shape === 'circle' ? Math.round(short / Math.SQRT2) : short,
    radiusPx: short / 2,
  };
}

/** Reads live platform geometry. Never throws; falls back to 640 round. */
export function readGeometry(prefs: GeometryPrefs, render?: GeometryRender): Geometry {
  const g = deriveGeometry(getDisplayInfo(), prefs, render);
  if (g.source === 'fallback') {
    log.debug(`no window.nzxt — fallback geometry ${String(g.width)}x${String(g.height)}`);
  }
  return g;
}

/** Re-derives geometry every 2 s and reports genuine changes only. */
export function watchGeometry(
  cb: (g: Geometry) => void,
  prefs: GeometryPrefs,
  render?: GeometryRender,
): () => void {
  return subscribeDisplayInfo((info) => {
    cb(deriveGeometry(info, prefs, render));
  });
}

/**
 * Publishes geometry as CSS custom properties on `:root` plus
 * `data-shape` / `data-source` attributes, so stylesheets never need JS values.
 */
export function applyGeometryToDom(g: Geometry, background = '#000'): void {
  const root = document.documentElement;
  const px = (n: number): string => `${String(n)}px`;
  root.style.setProperty('--kh-w', px(g.width));
  root.style.setProperty('--kh-h', px(g.height));
  root.style.setProperty('--kh-r', px(g.radiusPx));
  root.style.setProperty('--kh-safe', px(g.safeInsetPx));
  root.style.setProperty('--kh-inscribed', px(g.inscribedSquarePx));
  root.style.setProperty('--kh-target-fps', String(g.targetFps));
  root.style.setProperty('--kh-bg', background);
  root.dataset['shape'] = g.shape;
  root.dataset['geometrySource'] = g.source;
}
