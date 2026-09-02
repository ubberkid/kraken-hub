/**
 * Per-layer geometry: the one place a `Layer` becomes pixels.
 *
 * The compositor (`src/render/compositor.ts`), the phone replica
 * (`src/app/config/replica.ts`) and the editor (`src/app/config/editor/*`) all
 * call THESE functions and nothing else, which is what makes "the halo and the
 * LCD agree" a fact rather than a hope: the editor's handles are drawn from the
 * same `layerBounds()` the display positions the host with, and
 * `replica.test.ts` asserts the two surfaces produce the same `hostStyle()`
 * string. Duplicating the maths on either side is how a drag ends up 4 px off
 * on one screen and nobody can say which one is lying.
 *
 * Coordinates: a look is written in UNITS (`1.0 = Geometry.radiusPx`), so the
 * document contains no pixel to be wrong about. Frames are in DIAMETER units —
 * `w: 2` is the full panel width — so a box's pixel size is `w · R × h · R`.
 *
 * Worked example (the one in the spec, §2.3): a `0.6 × 0.6` square frame at
 * `x = 0.5` on a 640 round panel (`R = 320`) is `192 × 192` px, and its left
 * edge sits at `640/2 + 0.5·320 − 192/2 = 384`.
 *
 * Pure: no DOM, no React, no registry. See docs/design/design-layers-architecture.md §2.3.
 */

import {
  deriveGeometry,
  type Geometry,
  type GeometryRender,
  DEFAULT_GEOMETRY_RENDER,
} from '../platform/geometry';

import type { Rect } from './types';
import type { Layer, Look, LayerId, Transform } from '../state/look/types';

/** A CSS-order affine matrix: `[a, b, c, d, e, f]` maps `(x,y) → (ax+cy+e, bx+dy+f)`. */
export type Mat2x3 = readonly [number, number, number, number, number, number];

export interface Point {
  x: number;
  y: number;
}

export interface LayerBounds {
  /** Axis-aligned bounding box in panel px. */
  rect: Rect;
  /** The four transformed corners in panel px, clockwise from top-left. */
  corners: [number, number][];
}

const DEG = Math.PI / 180;

/** Trim floating-point dust so two surfaces produce byte-identical style strings. */
function px(n: number): string {
  return `${String(Math.round(n * 1000) / 1000)}px`;
}

/** `layers[0]` — the base wears the whole panel and never moves (§0.4). */
export function isPanelLayer(layer: Layer): boolean {
  return layer.frame === 'panel';
}

/**
 * The host element's LAYOUT box, before `transform`.
 *
 * `t.s` is deliberately NOT applied here: scale is a compositor transform (one
 * style write, no re-layout), so the box stays the size the frame asked for.
 */
export function hostBox(layer: Layer, panel: Geometry): Rect {
  if (layer.frame === 'panel') {
    return { x: 0, y: 0, w: panel.width, h: panel.height };
  }
  const r = panel.radiusPx;
  const w = layer.frame.w * r;
  const h = layer.frame.h * r;
  return {
    x: panel.width / 2 + layer.t.x * r - w / 2,
    y: panel.height / 2 + layer.t.y * r - h / 2,
    w,
    h,
  };
}

/**
 * The `Geometry` a layer's renderer sees: its own box, its own safe inset.
 *
 * The base returns the panel's geometry BY IDENTITY — `LayerHost.fastPath` and
 * the module contract both depend on `ctx.geometry() === runtime.geometry.get()`
 * for a one-layer look, so the fast path stays byte-identical to what shipped.
 */
export function layerGeometry(
  layer: Layer,
  panel: Geometry,
  render: GeometryRender = DEFAULT_GEOMETRY_RENDER,
): Geometry {
  if (layer.frame === 'panel') return panel;
  const box = hostBox(layer, panel);
  const derived = deriveGeometry(
    {
      width: box.w,
      height: box.h,
      shape: layer.frame.shape,
      targetFps: panel.targetFps,
      dpr: panel.dpr,
      // `DisplayInfo.source` has two values, `Geometry.source` four; the panel's
      // provenance is restored below rather than laundered into 'nzxt'.
      source: panel.source === 'nzxt' ? 'nzxt' : 'fallback',
    },
    { fallbackTargetFps: panel.targetFps },
    render,
  );
  return { ...derived, source: panel.source };
}

export interface HostStyleOptions {
  /**
   * `true` → `border-radius:50%; overflow:hidden`. The compositor passes
   * `frame.shape === 'circle' && placement.resize === 'scale'` (§2.2): a pixel
   * kind gets clipped to its circle, a layout kind lays itself out inside its
   * own safe inset and needs no clip.
   */
  round?: boolean;
}

/**
 * Exactly the declaration block in §2.2, as a property map.
 *
 * The base gets `{}`: `inset: 0` comes from `.kh-stage__module` and it must
 * publish NO `--kh-*` variables, so every module's CSS keeps resolving against
 * `:root` and the one-layer DOM stays byte-identical to today's `ModuleHost`.
 */
export function hostStyle(
  layer: Layer,
  panel: Geometry,
  opts: HostStyleOptions = {},
): Record<string, string> {
  if (layer.frame === 'panel') return {};

  const r = panel.radiusPx;
  const w = layer.frame.w * r;
  const h = layer.frame.h * r;
  const g = layerGeometry(layer, panel);
  const a = layer.t.a;

  const style: Record<string, string> = {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: px(w),
    height: px(h),
    'pointer-events': 'none',
    transform: transformCss(layer.t, panel),
    'transform-origin': '50% 50%',
    '--kh-w': px(g.width),
    '--kh-h': px(g.height),
    '--kh-r': px(g.radiusPx),
    '--kh-safe': px(g.safeInsetPx),
    '--kh-inscribed': px(g.inscribedSquarePx),
  };
  if (a < 1) style['opacity'] = String(Math.round(a * 1000) / 1000);
  if (opts.round === true) {
    style['border-radius'] = '50%';
    style['overflow'] = 'hidden';
  }
  return style;
}

/**
 * Layer-local px (origin at the frame's centre, unscaled) → panel px.
 * `translate(centre) · rotate(r) · scale(s)`.
 */
export function layerMatrix(layer: Layer, panel: Geometry): Mat2x3 {
  const r = panel.radiusPx;
  const cx = panel.width / 2 + layer.t.x * r;
  const cy = panel.height / 2 + layer.t.y * r;
  if (layer.frame === 'panel') return [1, 0, 0, 1, panel.width / 2, panel.height / 2];
  const rad = layer.t.r * DEG;
  const cos = Math.cos(rad) * layer.t.s;
  const sin = Math.sin(rad) * layer.t.s;
  return [cos, sin, -sin, cos, cx, cy];
}

function applyMatrix(m: Mat2x3, lx: number, ly: number): [number, number] {
  return [m[0] * lx + m[2] * ly + m[4], m[1] * lx + m[3] * ly + m[5]];
}

/** The transformed corners and their bounding box, in panel px. */
export function layerBounds(layer: Layer, panel: Geometry): LayerBounds {
  const box = hostBox(layer, panel);
  if (layer.frame === 'panel') {
    return {
      rect: box,
      corners: [
        [box.x, box.y],
        [box.x + box.w, box.y],
        [box.x + box.w, box.y + box.h],
        [box.x, box.y + box.h],
      ],
    };
  }
  const m = layerMatrix(layer, panel);
  const hw = box.w / 2;
  const hh = box.h / 2;
  const corners: [number, number][] = [
    applyMatrix(m, -hw, -hh),
    applyMatrix(m, hw, -hh),
    applyMatrix(m, hw, hh),
    applyMatrix(m, -hw, hh),
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    rect: { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY },
    corners,
  };
}

/** Panel px → layer-local px. `null` when the matrix is degenerate (`s → 0`). */
export function toLayerLocal(layer: Layer, panel: Geometry, pt: Point): Point | null {
  const [a, b, c, d, e, f] = layerMatrix(layer, panel);
  const det = a * d - b * c;
  if (det === 0) return null;
  const dx = pt.x - e;
  const dy = pt.y - f;
  return { x: (dx * d - dy * c) / det, y: (-dx * b + dy * a) / det };
}

/**
 * Which layer is under a point, in panel px.
 *
 * Top-most first (the array is z-order, bottom first), rotation-aware, and it
 * NEVER returns the base: the base fills the panel and is not draggable, so a
 * hit on it is a click on the background — which is how "tap empty deselects"
 * stays one rule instead of two.
 */
export function hitTest(look: Look, pt: Point, panel: Geometry): LayerId | null {
  for (let i = look.layers.length - 1; i >= 1; i--) {
    const layer = look.layers[i];
    if (layer === undefined || !layer.on || layer.frame === 'panel') continue;
    const local = toLayerLocal(layer, panel, pt);
    if (local === null) continue;
    const hw = (layer.frame.w * panel.radiusPx) / 2;
    const hh = (layer.frame.h * panel.radiusPx) / 2;
    if (hw <= 0 || hh <= 0) continue;
    const inside =
      layer.frame.shape === 'circle'
        ? (local.x / hw) ** 2 + (local.y / hh) ** 2 <= 1
        : Math.abs(local.x) <= hw && Math.abs(local.y) <= hh;
    if (inside) return layer.id;
  }
  return null;
}

/** The transform a host is currently wearing — used by `preview()` to restore. */
export function transformCss(t: Transform, panel: Geometry): string {
  const r = panel.radiusPx;
  const scale = t.s === 1 ? '' : ` scale(${String(Math.round(t.s * 1000) / 1000)})`;
  return `translate(-50%, -50%) translate(${px(t.x * r)}, ${px(t.y * r)}) rotate(${String(
    Math.round(t.r * 1000) / 1000,
  )}deg)${scale}`;
}
