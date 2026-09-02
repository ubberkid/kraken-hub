/**
 * STEP 1 (docs/modules.md §3) — the Shape layer's config, its defaults, and a
 * validator that cannot throw.
 *
 * Eager: the registry imports this so both pages can validate stored config
 * before anything renders. No DOM, no storage, no network.
 *
 * ## Everything geometric here is unit-relative
 *
 * `strokeWidth` and `radius` are fractions of the layer's own box, never
 * pixels: a look composed on a 640 round Elite has to land identically on a 240
 * square Kraken (design-layers-architecture.md §1.1). `svg.ts` turns them into
 * user units against the box it is handed, and it is the only file that ever
 * sees a pixel.
 */

import { clamp, isFiniteNumber, isPlainObject } from '../../lib/clamp';

/**
 * Four primitives, and the reason there are not fourteen.
 *
 * A rectangle, a disc, a rule and a ring cover what a layered look actually
 * needs a shape for: a scrim behind text, a badge behind a number, a divider,
 * and a bezel ring around the panel's edge. Anything more elaborate is a
 * picture, and there is already a module that paints pictures.
 */
export type ShapeKind = 'rect' | 'circle' | 'line' | 'ring';
export const SHAPE_KINDS: readonly ShapeKind[] = ['rect', 'circle', 'line', 'ring'];

/** The one value that is a colour and is not a colour. */
export const NO_PAINT = 'none';

export const STROKE_MIN = 0;
export const STROKE_MAX = 0.1;
export const RADIUS_MIN = 0;
export const RADIUS_MAX = 0.5;
export const OPACITY_MIN = 0;
export const OPACITY_MAX = 1;

export interface ShapeConfig {
  shape: ShapeKind;
  /** `#rrggbb` or `'none'`. */
  fill: string;
  /** `0..1`, applied to the fill only — the stroke stays crisp. */
  fillOpacity: number;
  /** `#rrggbb` or `'none'`. */
  stroke: string;
  /** Fraction of the box's short edge. */
  strokeWidth: number;
  /** Corner radius as a fraction of the box's short edge. `rect` only. */
  radius: number;
  dash: boolean;
}

/** The same near-white the clock, the stats readout and the text layer default to. */
export const DEFAULT_SHAPE_FILL = '#f2f4f8';

export const SHAPE_DEFAULTS: ShapeConfig = {
  shape: 'rect',
  fill: DEFAULT_SHAPE_FILL,
  fillOpacity: 0.2,
  stroke: NO_PAINT,
  strokeWidth: 0.01,
  radius: 0.08,
  dash: false,
};

/**
 * The **solid base** of `design-editor-ux.md` §10, as one config.
 *
 * §10 lists "Solid base" as a parity item and the shape module already IS it —
 * `roles` names `'base'`, and a `rect` at `frame: 'panel'` is a full-panel
 * fill. What was missing was the CONFIG that makes it one: the module's own
 * defaults are a translucent scrim with rounded corners (0.2 opacity, 0.08
 * radius), which is the right default for an overlay band under a caption and
 * emphatically not a flat ground.
 *
 * So the preset lives here, next to the defaults it differs from, and the add
 * sheet and the look templates use it rather than each writing down their own
 * idea of "solid": opaque, square-cornered, unstroked, edge to edge. It is a
 * `ShapeConfig` and nothing more — no new field, no new kind, no branch in the
 * renderer.
 */
export const SOLID_BASE_CFG: ShapeConfig = {
  shape: 'rect',
  fill: '#0b0e13',
  fillOpacity: 1,
  stroke: NO_PAINT,
  strokeWidth: 0,
  // Zero, not the default 0.08: a rounded ground on a round panel shows the
  // stage through four corners the user did not ask to see.
  radius: 0,
  dash: false,
};

const HEX_SHORT_RE = /^#[0-9a-f]{3}$/;
const HEX_LONG_RE = /^#[0-9a-f]{6}$/;

/**
 * `#RGB`, `#RRGGBB` or the literal `'none'`, normalised to lowercase.
 *
 * Normalising rather than merely accepting is what keeps `validate()`
 * idempotent — `#FFF` and `#ffffff` are one colour, and a validator that
 * returned the first unchanged would produce a different object on its second
 * pass and fail the registry's idempotence assertion.
 */
export function normalizePaint(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const s = raw.trim().toLowerCase();
  if (s === NO_PAINT) return NO_PAINT;
  if (HEX_LONG_RE.test(s)) return s;
  // `#abc` → `#aabbcc`: the `#` is not in the character class, so only the
  // three digits are doubled.
  if (HEX_SHORT_RE.test(s)) return s.replace(/[0-9a-f]/g, (c) => c + c);
  return fallback;
}

function pick<T extends string>(raw: unknown, allowed: readonly T[], def: T): T {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : def;
}

function flag(raw: unknown, def: boolean): boolean {
  return typeof raw === 'boolean' ? raw : def;
}

function num(raw: unknown, min: number, max: number, def: number): number {
  return isFiniteNumber(raw) ? clamp(raw, min, max) : def;
}

/** Never throws: an invalid field falls back to its default. */
export function validateShape(raw: unknown): ShapeConfig {
  const o = isPlainObject(raw) ? raw : {};
  return {
    shape: pick(o['shape'], SHAPE_KINDS, SHAPE_DEFAULTS.shape),
    fill: normalizePaint(o['fill'], SHAPE_DEFAULTS.fill),
    fillOpacity: num(o['fillOpacity'], OPACITY_MIN, OPACITY_MAX, SHAPE_DEFAULTS.fillOpacity),
    stroke: normalizePaint(o['stroke'], SHAPE_DEFAULTS.stroke),
    strokeWidth: num(o['strokeWidth'], STROKE_MIN, STROKE_MAX, SHAPE_DEFAULTS.strokeWidth),
    radius: num(o['radius'], RADIUS_MIN, RADIUS_MAX, SHAPE_DEFAULTS.radius),
    dash: flag(o['dash'], SHAPE_DEFAULTS.dash),
  };
}
