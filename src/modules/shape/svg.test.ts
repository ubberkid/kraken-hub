import { describe, expect, it } from 'vitest';

import { NO_PAINT, SHAPE_DEFAULTS, SHAPE_KINDS, type ShapeConfig } from './schema';
import { shapeMarkup } from './svg';

/**
 * The geometry, as a pure function — which is the point of `svg.ts` living
 * apart from `display.ts`. Everything below runs in node with no document.
 */

const WIDE = { w: 400, h: 100 };
const SQUARE = { w: 200, h: 200 };

function markup(cfg: Partial<ShapeConfig>, box = SQUARE): string {
  return shapeMarkup({ ...SHAPE_DEFAULTS, ...cfg }, box);
}

/** The primitive element on its own — never the `<svg>` wrapper's attributes. */
function primitiveOf(svg: string): string {
  return /<(?:rect|circle|line)\s[^>]*>/.exec(svg)?.[0] ?? '';
}

/** `<rect x="1.5" …>` → the value of one attribute on the one primitive. */
function attrOf(svg: string, name: string): string | null {
  // `\b` so `x=` does not match the `x` inside `viewBox=`.
  return new RegExp(`\\b${name}="([^"]*)"`).exec(primitiveOf(svg))?.[1] ?? null;
}

/** The primitive each kind draws itself with. */
const PRIMITIVE: Readonly<Record<(typeof SHAPE_KINDS)[number], string>> = {
  rect: 'rect',
  circle: 'circle',
  ring: 'circle',
  line: 'line',
};

describe('shapeMarkup', () => {
  it.each(SHAPE_KINDS)('%s draws its expected primitive, and only one', (shape) => {
    const svg = markup({ shape });
    const tag = PRIMITIVE[shape];
    expect(svg).toContain(`<${tag} `);
    // Exactly one primitive: a shape layer is one mark, so an extra element
    // would be an extra thing for the compositor to composite.
    expect(svg.match(/<(rect|circle|line) /g)).toHaveLength(1);
  });

  it('is a well-formed svg that fills its host', () => {
    const svg = markup({});
    expect(svg.startsWith('<svg ')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('width="100%"');
    expect(svg).toContain('height="100%"');
  });

  /**
   * The viewBox rule: user units ARE host pixels, so nothing is distorted. A
   * fixed square viewBox with `preserveAspectRatio="none"` would have turned
   * the circle in a wide box into an ellipse.
   */
  it('takes its viewBox from the host box', () => {
    expect(markup({}, WIDE)).toContain('viewBox="0 0 400.00 100.00"');
  });

  it('draws a circle, not an ellipse, in a wide box', () => {
    const svg = markup({ shape: 'circle' }, WIDE);
    // Centred on the box, radius from the SHORT edge.
    expect(attrOf(svg, 'cx')).toBe('200.00');
    expect(attrOf(svg, 'cy')).toBe('50.00');
    expect(Number(attrOf(svg, 'r'))).toBeCloseTo(WIDE.h / 2);
  });

  it('scales every length with the box, so a look lands the same on any panel', () => {
    const small = markup({ shape: 'circle', stroke: '#ffffff' }, { w: 100, h: 100 });
    const big = markup({ shape: 'circle', stroke: '#ffffff' }, { w: 200, h: 200 });
    expect(Number(attrOf(big, 'r'))).toBeCloseTo(Number(attrOf(small, 'r')) * 2);
    expect(Number(attrOf(big, 'stroke-width'))).toBeCloseTo(
      Number(attrOf(small, 'stroke-width')) * 2,
    );
  });

  it('writes the fill and its opacity, and omits the opacity when there is no fill', () => {
    expect(markup({ fill: '#123456', fillOpacity: 0.5 })).toContain('fill-opacity="0.50"');
    const unfilled = markup({ fill: NO_PAINT });
    expect(unfilled).toContain(`fill="${NO_PAINT}"`);
    expect(unfilled).not.toContain('fill-opacity');
  });

  it('omits the stroke entirely when there is none', () => {
    const svg = markup({ shape: 'rect', stroke: NO_PAINT });
    expect(svg).not.toContain('stroke=');
  });

  it('insets a stroked rect by half its stroke, so the edge stays inside the box', () => {
    const svg = markup({ shape: 'rect', stroke: '#ffffff', strokeWidth: 0.1 }, SQUARE);
    const sw = Number(attrOf(svg, 'stroke-width'));
    expect(sw).toBeCloseTo(SQUARE.w * 0.1);
    expect(Number(attrOf(svg, 'x'))).toBeCloseTo(sw / 2);
    expect(Number(attrOf(svg, 'width'))).toBeCloseTo(SQUARE.w - sw);
  });

  it('never lets a corner radius exceed half the shorter side', () => {
    const svg = markup({ shape: 'rect', radius: 0.5 }, WIDE);
    expect(Number(attrOf(svg, 'rx'))).toBeLessThanOrEqual(WIDE.h / 2);
  });

  /**
   * A ring and a line ARE their stroke, so `stroke: 'none'` would erase them
   * outright — an invisible layer on a panel with no cursor is a layer nobody
   * can find again to fix.
   */
  it.each(['ring', 'line'] as const)('%s draws with the fill when no stroke is set', (shape) => {
    const svg = markup({ shape, fill: '#abcdef', stroke: NO_PAINT });
    expect(attrOf(svg, 'stroke')).toBe('#abcdef');
    expect(svg).toContain(`fill="${NO_PAINT}"`);
  });

  it.each(['ring', 'line'] as const)('%s stays visible at stroke width zero', (shape) => {
    const svg = markup({ shape, strokeWidth: 0 });
    expect(Number(attrOf(svg, 'stroke-width'))).toBeGreaterThan(0);
  });

  it('dashes only when asked', () => {
    expect(markup({ shape: 'line', dash: false })).not.toContain('stroke-dasharray');
    expect(markup({ shape: 'line', dash: true })).toContain('stroke-dasharray');
  });

  it.each([
    ['zero', { w: 0, h: 0 }],
    ['negative', { w: -5, h: -5 }],
    ['not a number', { w: Number.NaN, h: Number.NaN }],
  ])('returns an empty but well-formed svg for a %s box', (_why, box) => {
    const svg = shapeMarkup(SHAPE_DEFAULTS, box);
    expect(svg).toContain('</svg>');
    expect(svg).not.toContain('NaN');
    expect(svg).not.toMatch(/<(rect|circle|line) /);
  });

  it('is deterministic — the same config and box give the same string', () => {
    expect(markup({ shape: 'ring' })).toBe(markup({ shape: 'ring' }));
  });
});
