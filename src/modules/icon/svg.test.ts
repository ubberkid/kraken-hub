import { describe, expect, it } from 'vitest';

import { GLYPHS } from './glyphs';
import { ICON_DEFAULTS, WEIGHT_STROKE, type IconConfig } from './schema';
import { iconMarkup, iconSidePx } from './svg';

const cfg = (over: Partial<IconConfig> = {}): IconConfig => ({ ...ICON_DEFAULTS, ...over });

/**
 * The size rule, at three host sizes and with no device literal in sight — the
 * shape `text/size.test.ts` set. `size` is unit-relative, so the same config
 * has to produce the same PROPORTION on a 640 round Elite and a 240 square
 * Kraken, and a wide banner frame must not produce a glyph taller than its box.
 */
describe('iconSidePx', () => {
  it('is a share of a square box', () => {
    expect(iconSidePx(0.5, { w: 640, h: 640 })).toBe(320);
    expect(iconSidePx(0.5, { w: 240, h: 240 })).toBe(120);
  });

  it('measures a wide box by its SHORT edge', () => {
    // A glyph is square, so `size` claims a share of both edges and the smaller
    // one decides: 0.6 × 100, not 0.6 × 400. A banner frame gets a glyph that
    // fits in it rather than one taller than its own box.
    expect(iconSidePx(0.6, { w: 400, h: 100 })).toBeCloseTo(60, 10);
  });

  it('clamps to the box even if a config asks for more than all of it', () => {
    // Unreachable through `validateIcon()` — `SIZE_MAX` is 0.6 — and a guard
    // rather than a feature: nothing this module draws may spill its own host.
    expect(iconSidePx(2, { w: 400, h: 100 })).toBe(100);
  });

  it('scales identically at two panel sizes', () => {
    const big = iconSidePx(0.3, { w: 640, h: 640 });
    const small = iconSidePx(0.3, { w: 320, h: 320 });
    expect(big / small).toBeCloseTo(2, 10);
  });

  it('is total: a box that has not been laid out yields the floor, not NaN', () => {
    for (const box of [
      { w: 0, h: 0 },
      { w: -10, h: 10 },
      { w: Number.NaN, h: 100 },
      { w: Number.POSITIVE_INFINITY, h: Number.NaN },
    ]) {
      const side = iconSidePx(0.4, box);
      expect(Number.isFinite(side)).toBe(true);
      expect(side).toBeGreaterThan(0);
    }
  });
});

describe('iconMarkup', () => {
  it.each(GLYPHS.map((g) => [g.id, g] as const))(
    '%s renders one <svg> on the 24 grid with one <path>',
    (id, glyph) => {
      const markup = iconMarkup(cfg({ icon: id }), 120);

      expect(markup.match(/<svg/g)?.length).toBe(1);
      expect(markup.match(/<path/g)?.length).toBe(1);
      expect(markup).toContain('viewBox="0 0 24 24"');
      // Aspect preserved and centred: the glyph's visual centre is the anchor.
      expect(markup).toContain('preserveAspectRatio="xMidYMid meet"');
      expect(markup).toContain(`d="${glyph.d}"`);
      expect(markup.endsWith('</svg>')).toBe(true);
    },
  );

  it('paints a drawn glyph with the weight, and a solid one without', () => {
    const drawn = iconMarkup(cfg({ icon: 'check', weight: 'bold' }), 100);
    expect(drawn).toContain('fill="none"');
    expect(drawn).toContain(`stroke-width="${WEIGHT_STROKE.bold.toFixed(2)}"`);
    expect(drawn).toContain(`stroke="${ICON_DEFAULTS.color}"`);

    const solid = iconMarkup(cfg({ icon: 'play', weight: 'bold' }), 100);
    expect(solid).toContain(`fill="${ICON_DEFAULTS.color}"`);
    expect(solid).not.toContain('stroke-width');
  });

  it('moves a drawn glyph with the weight and leaves a solid one alone', () => {
    const thin = iconMarkup(cfg({ icon: 'check', weight: 'thin' }), 100);
    const bold = iconMarkup(cfg({ icon: 'check', weight: 'bold' }), 100);
    expect(thin).not.toBe(bold);

    const solidThin = iconMarkup(cfg({ icon: 'play', weight: 'thin' }), 100);
    const solidBold = iconMarkup(cfg({ icon: 'play', weight: 'bold' }), 100);
    expect(solidThin).toBe(solidBold);
  });

  it('writes the side length it was given onto the <svg>', () => {
    expect(iconMarkup(cfg(), 128)).toContain('width="128.00" height="128.00"');
  });

  it('falls back to the default glyph for an id this build does not ship', () => {
    // An older look or a fork's set. Something findable, not an empty layer:
    // there is no cursor on a panel, so a layer that draws nothing is a layer
    // nobody can select again to fix.
    const unknown = iconMarkup({ ...ICON_DEFAULTS, icon: 'unicorn' }, 100);
    expect(unknown).toBe(iconMarkup(ICON_DEFAULTS, 100));
    expect(unknown).toContain('<path');
  });
});
