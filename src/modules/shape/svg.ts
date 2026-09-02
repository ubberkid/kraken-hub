/**
 * STEP 2 (docs/modules.md §4) — the pure logic: one config plus one box in,
 * one `<svg>` string out.
 *
 * No DOM, no globals, no `Geometry` — which is what makes the whole geometry of
 * this module a table-driven unit test in node rather than something you have
 * to boot a panel to check.
 *
 * ## The viewBox rule
 *
 * `viewBox="0 0 W H"` where `W`/`H` are the host's own measured pixels, and the
 * `<svg>` is `width:100%; height:100%`. One user unit is therefore one CSS
 * pixel, so:
 *
 *  - nothing is ever distorted — a circle is a circle in a wide box, not an
 *    ellipse, which is what `preserveAspectRatio="none"` over a fixed square
 *    viewBox would have produced;
 *  - a stroke is the width it says it is, on both axes;
 *  - and the shape still scales crisply when the compositor scales the host,
 *    because it is vector all the way down (`resize: 'scale'`, §3.2).
 *
 * Every length in the config is a fraction of the box's SHORT edge, so a shape
 * keeps its proportions when its frame changes aspect.
 */

import { NO_PAINT, type ShapeConfig } from './schema';

/**
 * The floor for a stroke that IS the shape.
 *
 * A ring or a line drawn with `strokeWidth: 0` is not a subtle ring, it is an
 * invisible layer — and an invisible layer on a panel with no cursor is a layer
 * the user cannot find again to fix. Rect and circle have a fill to fall back
 * on and are left alone.
 */
const MIN_LINE_FRACTION = 0.004;

/** Dash on/off, in multiples of the stroke width — an even, obviously-dashed rhythm. */
const DASH_MULTIPLE = 2;

/** Two decimals: enough for a sub-pixel edge, short enough to keep attributes stable. */
const COORD_DECIMALS = 2;

function n(value: number): string {
  return value.toFixed(COORD_DECIMALS);
}

export interface ShapeBox {
  w: number;
  h: number;
}

function attr(name: string, value: string): string {
  return `${name}="${value}"`;
}

/**
 * The paint a stroke-only primitive draws itself with.
 *
 * A ring and a line have no interior, so `stroke: 'none'` would erase them.
 * Falling back to the fill colour is the reading that matches what somebody
 * doing it meant: they picked a colour, and this is the shape it should be.
 */
function linePaint(cfg: ShapeConfig): string {
  return cfg.stroke === NO_PAINT ? cfg.fill : cfg.stroke;
}

/**
 * The `<svg>` for one shape in one box. Total: a zero or negative box yields an
 * empty (but well-formed) `<svg>` rather than `NaN` in an attribute.
 */
export function shapeMarkup(cfg: ShapeConfig, box: ShapeBox): string {
  const w = Number.isFinite(box.w) ? Math.max(box.w, 0) : 0;
  const h = Number.isFinite(box.h) ? Math.max(box.h, 0) : 0;
  const open =
    `<svg class="kh-shape__svg" ${attr('viewBox', `0 0 ${n(w)} ${n(h)}`)} ` +
    `width="100%" height="100%" aria-hidden="true">`;
  if (w <= 0 || h <= 0) return `${open}</svg>`;

  const short = Math.min(w, h);
  const sw = cfg.strokeWidth * short;
  const strokes = cfg.stroke !== NO_PAINT && sw > 0;

  /** Common paint attributes for a primitive that has an interior. */
  const painted = (): string => {
    const parts = [attr('fill', cfg.fill)];
    if (cfg.fill !== NO_PAINT) parts.push(attr('fill-opacity', n(cfg.fillOpacity)));
    if (strokes) {
      parts.push(attr('stroke', cfg.stroke), attr('stroke-width', n(sw)));
      if (cfg.dash) parts.push(attr('stroke-dasharray', dashFor(sw)));
    }
    return parts.join(' ');
  };

  /** …and for one that IS its stroke. */
  const drawn = (): string => {
    const width = Math.max(sw, short * MIN_LINE_FRACTION);
    const parts = [
      attr('fill', NO_PAINT),
      attr('stroke', linePaint(cfg)),
      attr('stroke-width', n(width)),
      attr('stroke-linecap', 'round'),
    ];
    if (cfg.dash) parts.push(attr('stroke-dasharray', dashFor(width)));
    return parts.join(' ');
  };

  const inset = strokes ? sw / 2 : 0;

  let body: string;
  switch (cfg.shape) {
    case 'rect': {
      const rw = Math.max(w - inset * 2, 0);
      const rh = Math.max(h - inset * 2, 0);
      // A corner radius can never exceed half the shorter side, or the browser
      // silently reduces it and the shape stops matching the slider.
      const rx = Math.min(cfg.radius * short, Math.min(rw, rh) / 2);
      body =
        `<rect ${attr('x', n(inset))} ${attr('y', n(inset))} ${attr('width', n(rw))} ` +
        `${attr('height', n(rh))} ${attr('rx', n(rx))} ${painted()} />`;
      break;
    }
    case 'circle': {
      const r = Math.max(short / 2 - inset, 0);
      body =
        `<circle ${attr('cx', n(w / 2))} ${attr('cy', n(h / 2))} ` +
        `${attr('r', n(r))} ${painted()} />`;
      break;
    }
    case 'ring': {
      const width = Math.max(sw, short * MIN_LINE_FRACTION);
      const r = Math.max((short - width) / 2, 0);
      body =
        `<circle ${attr('cx', n(w / 2))} ${attr('cy', n(h / 2))} ` +
        `${attr('r', n(r))} ${drawn()} />`;
      break;
    }
    case 'line': {
      const width = Math.max(sw, short * MIN_LINE_FRACTION);
      const pad = width / 2;
      const y = h / 2;
      body =
        `<line ${attr('x1', n(pad))} ${attr('y1', n(y))} ${attr('x2', n(Math.max(w - pad, pad)))} ` +
        `${attr('y2', n(y))} ${drawn()} />`;
      break;
    }
  }

  return `${open}${body}</svg>`;
}

function dashFor(width: number): string {
  const on = width * DASH_MULTIPLE;
  return `${n(on)} ${n(on)}`;
}
