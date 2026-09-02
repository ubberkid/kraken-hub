/**
 * STEP 2 (docs/modules.md §4) — the pure logic: one config plus one box in, one
 * `<svg>` string out.
 *
 * No DOM, no globals, no `Geometry` — which is what makes the whole geometry of
 * this module a table-driven unit test in node rather than something you have to
 * boot a panel to check.
 *
 * ## The viewBox rule, and why it is not the shape module's
 *
 * `viewBox="0 0 24 24"`, always: a glyph is drawn on the 24 grid and it must
 * never be distorted, so the grid is the coordinate system and
 * `preserveAspectRatio="xMidYMid meet"` (the SVG default, written out because a
 * reader should not have to know it) fits it into whatever square the layer
 * gives it, centred. That is the `resize: 'frame'` reading of §3.2 for a kind
 * whose content has ONE aspect: the frame changes, the glyph re-fits, and its
 * visual centre stays on the layer's anchor.
 *
 *     sidePx = min(size × boxW, size × boxH, min(boxW, boxH))
 *
 * Read it as: **`size` is the share of the box a glyph claims, and it never
 * spills past the short edge.** Text's rule is the share of the WIDTH, because
 * a line of type runs along the width; a glyph is square, so the short edge is
 * the honest limit and a wide banner frame does not produce a glyph taller than
 * its own box.
 */

import { getGlyph } from './glyphs';
import { ICON_DEFAULTS, WEIGHT_STROKE, type IconConfig } from './schema';

export interface IconBox {
  w: number;
  h: number;
}

/** Below this a glyph is a smudge on a compressed frame; a floor, not a size. */
const MIN_SIDE_PX = 4;

/** Two decimals: enough for a sub-pixel edge, short enough to keep attributes stable. */
const COORD_DECIMALS = 2;

function n(value: number): string {
  return value.toFixed(COORD_DECIMALS);
}

/**
 * THE rule, extracted so it can be tested without a DOM.
 *
 * Total and deliberately so: a zero or negative box — a host that has not been
 * laid out yet, an observer firing during teardown — yields the floor rather
 * than `NaN` or a side of 0.
 */
export function iconSidePx(size: number, box: IconBox): number {
  const w = Number.isFinite(box.w) ? Math.max(box.w, 0) : 0;
  const h = Number.isFinite(box.h) ? Math.max(box.h, 0) : 0;
  const side = Math.min(size * w, size * h, Math.min(w, h));
  return Number.isFinite(side) && side > MIN_SIDE_PX ? side : MIN_SIDE_PX;
}

/**
 * The `<svg>` for one glyph, at one side length.
 *
 * Exactly one `<svg>` with exactly one `<path>`: a glyph is one `d`, so the
 * whole set can be asserted uniformly and a renderer's repaint is one string
 * compare.
 *
 * This is also where an id this build does not ship is settled — an older look,
 * a fork's set — because this file has the table and `schema.ts` deliberately
 * does not (it is eager, and the table is six kilobytes of path data that may
 * not sit on the display's critical path). The fallback is the DEFAULT glyph,
 * not nothing: a layer that draws nothing is a layer nobody can find again on a
 * panel with no cursor.
 */
export function iconMarkup(cfg: IconConfig, sidePx: number): string {
  const glyph = getGlyph(cfg.icon) ?? getGlyph(ICON_DEFAULTS.icon);
  const side = n(Math.max(sidePx, 0));
  const open =
    `<svg class="kh-icon__svg" viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" ` +
    `width="${side}" height="${side}" aria-hidden="true">`;
  if (glyph === null) return `${open}</svg>`;

  const body =
    glyph.paint === 'fill'
      ? `<path d="${glyph.d}" fill="${cfg.color}" />`
      : `<path d="${glyph.d}" fill="none" stroke="${cfg.color}" ` +
        `stroke-width="${n(WEIGHT_STROKE[cfg.weight])}" stroke-linecap="round" ` +
        `stroke-linejoin="round" />`;

  return `${open}${body}</svg>`;
}
