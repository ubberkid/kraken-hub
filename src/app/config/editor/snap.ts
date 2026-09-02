/**
 * Snapping — in UNITS, so a 640 Elite and a 240 square snap identically.
 *
 * This is the reason the whole model is unit-based. If snapping worked in
 * pixels, a threshold that felt right on a 640 round panel would be twice as
 * sticky on a 240 square one, and the same drag would land in two different
 * places on two Krakens. Everything here — the threshold, the rings, the
 * targets — is expressed against `1.0 = radiusPx`, and the only thing the
 * panel contributes is its SHAPE (a square panel has edges and thirds; a round
 * one has clock angles and rings).
 *
 * What it snaps to, in the order it is applied:
 *
 *  1. **Rotation** — 0 / ±45 / ±90 / 180, plus *tangent* (perpendicular to the
 *     radius, `atan2(y,x) + 90°`), within 3°.
 *  2. **Polar**, only once the layer is off-centre (`|c| > 0.3`) — the 12 clock
 *     angles and the rings `r ∈ {0, 0.5, safeRadiusPct}`. Near the centre polar
 *     snapping is meaningless (a 1° move swings the whole thing), so it is off.
 *  3. **Cartesian** — the centre crosslines, the other layers' centres and frame
 *     edges, and on a SQUARE panel the panel edges and thirds. The moving
 *     layer's own edges are candidates too, so a box can align its left edge to
 *     another box's left edge — except against the centre crosslines, which
 *     snap centres only (see `Target.edges`).
 *  4. **Tangent to the safe circle** — the farthest corner lands exactly on the
 *     safe ring, which is the placement that reads as "as big as it can be
 *     without the bezel eating it". Skipped when a ring snap already claimed the
 *     radius; two rules pulling the same value is how a drag starts to stutter.
 *
 * Guides are DESCRIPTIONS, not state: the editor draws them while the finger is
 * down and forgets them on release.
 *
 * See docs/design/design-layers-architecture.md §8.
 */

import {
  TRANSFORM_LIMITS,
  type Frame,
  type Layer,
  type LayerId,
  type Look,
  type Transform,
  type Units,
} from '../../../state/look/types';

/** All the panel contributes: a square has edges and thirds, a circle does not. */
export interface SnapPanel {
  shape: 'circle' | 'square';
}

export interface SnapRender {
  /** Fraction of the radius treated as visible on a round panel (default 0.88). */
  safeRadiusPct: number;
}

export type GuideKind =
  | 'centre-x'
  | 'centre-y'
  | 'panel-edge'
  | 'panel-third'
  | 'layer-centre'
  | 'layer-edge'
  | 'ring'
  | 'clock'
  | 'tangent'
  | 'rotation';

export interface Guide {
  kind: GuideKind;
  /** Present for the line-shaped guides. */
  axis?: 'x' | 'y';
  /** Units for a position guide, degrees for `clock`/`rotation`. */
  at: number;
  /** The layer this guide aligned to, when it was another layer. */
  layerId?: LayerId;
}

/** Units. One threshold for every panel, because units are panel-independent. */
export const SNAP_UNITS = 0.03;
/** Degrees. The UX spec's "within 3°". */
export const SNAP_ROT_DEG = 3;
/** Twelve o'clock positions. */
export const CLOCK_STEP_DEG = 30;
/** Below this radius the layer is "at the centre" and polar snapping is off. */
export const POLAR_MIN_RADIUS = 0.3;

const DEG = Math.PI / 180;

/**
 * The rotation ticks: every 15°, plus the tangent.
 *
 * The architecture spec (§8) wrote this ladder as `0/±45/±90/180`, and the UX
 * spec (§2.1, §11) as `0/15/45/90`. They disagree, and the tie-break is stated:
 * *the model wins on data, the UX document wins on behaviour* — and which angles
 * a drag settles on is behaviour. Fifteen degrees is also the ladder every
 * drawing tool uses, for a good reason: it contains 45 and 90, so nothing the
 * coarser list offered is lost, and it puts a tick where a person actually wants
 * a tilted caption.
 *
 * Within the 3° threshold the ticks are 12° apart at their closest, so no two
 * can claim the same angle and a deliberate 20° is still left alone.
 */
const ROT_TARGETS: readonly number[] = (() => {
  const out: number[] = [];
  for (let deg = -180; deg <= 180; deg += 15) out.push(deg);
  return out;
})();

/** 4 decimals: kills floating-point dust without touching the 3 the wire keeps. */
function q(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** Degrees into (-180, 180]. 180 stays 180: the model's limit is inclusive. */
function wrap180(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return Object.is(d, -0) ? 0 : d;
}

function halfExtent(frame: Frame, t: Transform): { hw: Units; hh: Units } {
  if (frame === 'panel') return { hw: 1, hh: 1 };
  return { hw: (frame.w / 2) * t.s, hh: (frame.h / 2) * t.s };
}

/** The distance of the farthest rotated corner from the panel centre, in units. */
export function farthestCorner(frame: Frame, t: Transform): Units {
  const { hw, hh } = halfExtent(frame, t);
  const rad = t.r * DEG;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  let max = 0;
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    const lx = sx * hw;
    const ly = sy * hh;
    const x = t.x + lx * cos - ly * sin;
    const y = t.y + lx * sin + ly * cos;
    max = Math.max(max, Math.hypot(x, y));
  }
  return max;
}

interface Target {
  value: number;
  kind: GuideKind;
  /**
   * `true` → the layer's own edges may land on this line as well as its centre.
   *
   * The centre crosslines are deliberately centre-only. Otherwise a box dragged
   * to (0.035, 0) would snap its LEFT EDGE to `x = 0` and settle off-centre,
   * and "drag to the middle and it lands exactly at 0,0" — the one snap every
   * user tries first — would be false for every layer wider than the threshold.
   */
  edges: boolean;
  layerId?: LayerId;
}

function axisTargets(axis: 'x' | 'y', self: Layer, look: Look, panel: SnapPanel): Target[] {
  const out: Target[] = [{ value: 0, kind: axis === 'x' ? 'centre-x' : 'centre-y', edges: false }];
  if (panel.shape === 'square') {
    // A square panel's short edge is at ±1 unit (1.0 = min(w,h)/2).
    out.push(
      { value: -1, kind: 'panel-edge', edges: true },
      { value: 1, kind: 'panel-edge', edges: true },
      { value: -1 / 3, kind: 'panel-third', edges: true },
      { value: 1 / 3, kind: 'panel-third', edges: true },
    );
  }
  for (const [i, l] of look.layers.entries()) {
    if (i === 0 || l.id === self.id || !l.on || l.frame === 'panel') continue;
    const { hw, hh } = halfExtent(l.frame, l.t);
    const c = axis === 'x' ? l.t.x : l.t.y;
    const half = axis === 'x' ? hw : hh;
    out.push({ value: c, kind: 'layer-centre', edges: true, layerId: l.id });
    out.push({ value: c - half, kind: 'layer-edge', edges: true, layerId: l.id });
    out.push({ value: c + half, kind: 'layer-edge', edges: true, layerId: l.id });
  }
  return out;
}

interface AxisSnap {
  value: number;
  guide: Guide | null;
}

/** Best of: my centre, my near edge, my far edge — onto any target line. */
function snapAxis(
  axis: 'x' | 'y',
  value: number,
  half: number,
  targets: readonly Target[],
): AxisSnap {
  let best: { delta: number; value: number; target: Target } | null = null;
  for (const target of targets) {
    for (const offset of target.edges ? [0, -half, half] : [0]) {
      const candidate = target.value - offset;
      const delta = Math.abs(candidate - value);
      if (delta > SNAP_UNITS) continue;
      if (best === null || delta < best.delta) best = { delta, value: candidate, target };
    }
  }
  if (best === null) return { value, guide: null };
  const guide: Guide = { kind: best.target.kind, axis, at: q(best.target.value) };
  if (best.target.layerId !== undefined) guide.layerId = best.target.layerId;
  return { value: q(best.value), guide };
}

/**
 * Snap a transform. Returns the settled transform and the guides that explain
 * it — the editor draws exactly these lines and nothing else, so what the user
 * sees IS why the layer moved.
 */
export function snap(
  t: Transform,
  layer: Layer,
  look: Look,
  panel: SnapPanel,
  render: SnapRender,
): { t: Transform; guides: Guide[] } {
  const guides: Guide[] = [];
  const out: Transform = { ...t };

  // 1. Rotation, including the tangent (perpendicular to the radius).
  const tangentDeg = wrap180(Math.atan2(t.y, t.x) / DEG + 90);
  let bestRot: { delta: number; value: number } | null = null;
  for (const target of [...ROT_TARGETS, tangentDeg]) {
    const delta = Math.abs(wrap180(target - t.r));
    if (delta > SNAP_ROT_DEG) continue;
    if (bestRot === null || delta < bestRot.delta) bestRot = { delta, value: wrap180(target) };
  }
  if (bestRot !== null) {
    out.r = q(bestRot.value);
    guides.push({ kind: 'rotation', at: out.r });
  }

  // 2. Polar — only once the layer is genuinely off-centre.
  const c = Math.hypot(t.x, t.y);
  let ringSnapped = false;
  if (c > POLAR_MIN_RADIUS) {
    let radius = c;
    const rings = [0, 0.5, render.safeRadiusPct];
    let bestRing: { delta: number; value: number } | null = null;
    for (const ring of rings) {
      const delta = Math.abs(ring - c);
      if (delta > SNAP_UNITS) continue;
      if (bestRing === null || delta < bestRing.delta) bestRing = { delta, value: ring };
    }
    if (bestRing !== null) {
      radius = bestRing.value;
      ringSnapped = true;
      guides.push({ kind: 'ring', at: q(bestRing.value) });
    }

    const thetaDeg = Math.atan2(t.y, t.x) / DEG;
    const nearest = Math.round(thetaDeg / CLOCK_STEP_DEG) * CLOCK_STEP_DEG;
    // Angular tolerance is an ARC LENGTH: the same 0.03 u everywhere else.
    const arc = c * Math.abs(wrap180(nearest - thetaDeg)) * DEG;
    const theta = arc <= SNAP_UNITS ? nearest : thetaDeg;
    if (arc <= SNAP_UNITS) guides.push({ kind: 'clock', at: wrap180(nearest) });

    if (ringSnapped || arc <= SNAP_UNITS) {
      const rad = theta * DEG;
      out.x = q(radius * Math.cos(rad));
      out.y = q(radius * Math.sin(rad));
    }
  }

  // 3. Cartesian lines.
  const { hw, hh } = halfExtent(layer.frame, out);
  const sx = snapAxis('x', out.x, hw, axisTargets('x', layer, look, panel));
  const sy = snapAxis('y', out.y, hh, axisTargets('y', layer, look, panel));
  out.x = sx.value;
  out.y = sy.value;
  if (sx.guide !== null) guides.push(sx.guide);
  if (sy.guide !== null) guides.push(sy.guide);

  // 4. Tangent to the safe circle: the farthest corner lands ON the ring.
  if (!ringSnapped) {
    const centre = Math.hypot(out.x, out.y);
    if (centre > 0) {
      const dmax = farthestCorner(layer.frame, out);
      const overshoot = dmax - render.safeRadiusPct;
      if (Math.abs(overshoot) <= SNAP_UNITS) {
        const k = (centre - overshoot) / centre;
        out.x = q(out.x * k);
        out.y = q(out.y * k);
        guides.push({ kind: 'tangent', at: q(render.safeRadiusPct) });
      }
    }
  }

  const { pos } = TRANSFORM_LIMITS;
  out.x = q(Math.min(pos, Math.max(-pos, out.x)));
  out.y = q(Math.min(pos, Math.max(-pos, out.y)));
  return { t: out, guides };
}
