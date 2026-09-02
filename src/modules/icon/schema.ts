/**
 * STEP 1 (docs/modules.md §3) — the Icon layer's config, its defaults, and a
 * validator that cannot throw.
 *
 * Eager: the registry imports this so both pages can validate stored config
 * before anything renders. No DOM, no storage, no network.
 *
 * ## The size unit, and why it is not pixels
 *
 * `size` is a fraction of the layer's own box, exactly as `text`'s is, never a
 * pixel count: a look composed on a 640 round Elite has to land identically on
 * a 240 square Kraken (design-layers-architecture.md §1.1). `svg.ts` turns it
 * into a side length against the box it is handed, and it is the only file here
 * that ever sees a pixel.
 *
 * ## Why this file does not import the glyph table
 *
 * It is the obvious thing to want: `validate()` could check a stored id against
 * the forty-eight this build ships. It cannot afford to. This file is EAGER —
 * the registry imports every manifest so both pages can validate stored config
 * before anything renders — and an import from here would drag six kilobytes of
 * path data onto the display's critical path, which `budgets.json` caps at
 * 90 kB gzip for the whole of it.
 *
 * So the id is validated by SHAPE here (a short kebab-case token, which is what
 * keeps arbitrary strings out of the config document) and by MEANING in
 * `svg.ts`, which has the table in front of it and falls back to the default
 * glyph for an id it does not know. An older look, or a fork's set, therefore
 * renders something findable rather than an empty layer — which is the outcome
 * a strict validator here would also have produced, one chunk later.
 */

import { clamp, isFiniteNumber, isPlainObject } from '../../lib/clamp';

/**
 * Three stroke weights, and the reason there are not nine.
 *
 * The LCD is read at arm's length through CAM's frame compressor, where the
 * difference between two neighbouring stroke widths is an artefact rather than
 * a decision. Thin, regular and bold are the three that read differently on a
 * panel — the same argument `text` makes about 400/600/800.
 */
export type IconWeight = 'thin' | 'regular' | 'bold';
export const ICON_WEIGHTS: readonly IconWeight[] = ['thin', 'regular', 'bold'];

/** Stroke width in the 24-grid's own units, per weight. */
export const WEIGHT_STROKE: Readonly<Record<IconWeight, number>> = {
  thin: 1.25,
  regular: 1.75,
  bold: 2.5,
};

/** The same range `text` uses, so a caption and a glyph beside it agree. */
export const SIZE_MIN = 0.05;
export const SIZE_MAX = 0.6;

export interface IconConfig {
  /** One of the curated glyph ids (`glyphs.ts`). */
  icon: string;
  /** `#rrggbb`, lowercase. */
  color: string;
  /** Fraction of the layer's own box. See `svg.ts` for the exact rule. */
  size: number;
  /** Stroke width, for the drawn glyphs. Solid glyphs ignore it. */
  weight: IconWeight;
  /** One soft halo, for a glyph over a busy base. */
  glow: boolean;
}

/** The same near-white the clock, the stats readout and the text layer default to. */
export const DEFAULT_ICON_COLOR = '#f2f4f8';

export const ICON_DEFAULTS: IconConfig = {
  icon: 'bolt',
  color: DEFAULT_ICON_COLOR,
  size: 0.4,
  weight: 'regular',
  glow: false,
};

const HEX_SHORT_RE = /^#[0-9a-f]{3}$/;
const HEX_LONG_RE = /^#[0-9a-f]{6}$/;

/**
 * `#RGB` and `#RRGGBB`, case-insensitively, normalised to lowercase six digits.
 *
 * Normalising rather than merely accepting is what keeps `validate()`
 * idempotent: `#FFF` and `#ffffff` are one colour, and a validator that
 * returned the first unchanged would produce a different object on its second
 * pass and fail the registry's idempotence assertion.
 */
export function normalizeHex(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const s = raw.trim().toLowerCase();
  if (HEX_LONG_RE.test(s)) return s;
  if (HEX_SHORT_RE.test(s)) return s.replace(/[0-9a-f]/g, (c) => c + c);
  return fallback;
}

/** A glyph id, by shape: the same token `glyphs.test.ts` requires of the table. */
const GLYPH_ID_RE = /^[a-z][a-z0-9-]{0,23}$/;

function glyphId(raw: unknown, def: string): string {
  return typeof raw === 'string' && GLYPH_ID_RE.test(raw) ? raw : def;
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
export function validateIcon(raw: unknown): IconConfig {
  const o = isPlainObject(raw) ? raw : {};
  return {
    // Shape only; `svg.ts` owns the fallback for an id this build does not ship.
    icon: glyphId(o['icon'], ICON_DEFAULTS.icon),
    color: normalizeHex(o['color'], ICON_DEFAULTS.color),
    size: num(o['size'], SIZE_MIN, SIZE_MAX, ICON_DEFAULTS.size),
    weight: pick(o['weight'], ICON_WEIGHTS, ICON_DEFAULTS.weight),
    glow: flag(o['glow'], ICON_DEFAULTS.glow),
  };
}
