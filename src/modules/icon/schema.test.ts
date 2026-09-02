import { describe, expect, it } from 'vitest';

import { GLYPHS } from './glyphs';
import {
  ICON_DEFAULTS,
  ICON_WEIGHTS,
  SIZE_MAX,
  SIZE_MIN,
  normalizeHex,
  validateIcon,
} from './schema';

/**
 * `validate()` is the boundary: everything past it is a valid `IconConfig`, and
 * the argument is always `unknown` — it comes from localStorage, from a synced
 * look, or from another build's version of this module.
 */
describe('validateIcon', () => {
  it('never throws, whatever storage hands it', () => {
    for (const junk of [undefined, null, 0, '', [], {}, { deeply: { wrong: [1, 2] } }, NaN]) {
      expect(() => validateIcon(junk)).not.toThrow();
    }
  });

  it('is idempotent on its own defaults', () => {
    expect(validateIcon(ICON_DEFAULTS)).toEqual(ICON_DEFAULTS);
    expect(validateIcon(validateIcon(ICON_DEFAULTS))).toEqual(ICON_DEFAULTS);
  });

  it('defaults to a glyph this build actually ships', () => {
    expect(GLYPHS.some((g) => g.id === ICON_DEFAULTS.icon)).toBe(true);
  });

  const CASES: readonly [string, unknown, Partial<typeof ICON_DEFAULTS>][] = [
    ['keeps a known glyph', { icon: 'flame' }, { icon: 'flame' }],
    /*
     * A well-shaped id this build does not ship is KEPT, on purpose. The table
     * is not importable from the eager schema (it would put six kilobytes of
     * path data on the display's critical path), so the meaning of an id is
     * settled in `svg.ts`, which falls back to the default glyph. The rule here
     * is only the shape — which is what keeps arbitrary strings out of the
     * config document.
     */
    ['keeps a well-shaped id it cannot check', { icon: 'unicorn' }, { icon: 'unicorn' }],
    ['drops an id that is not a token', { icon: 'Not An Id!' }, { icon: ICON_DEFAULTS.icon }],
    ['drops an over-long id', { icon: 'a'.repeat(40) }, { icon: ICON_DEFAULTS.icon }],
    ['drops a non-string glyph', { icon: 7 }, { icon: ICON_DEFAULTS.icon }],
    ['expands a short hex', { color: '#ABC' }, { color: '#aabbcc' }],
    ['keeps a long hex, lowercased', { color: '#FFB648' }, { color: '#ffb648' }],
    ['rejects a colour word', { color: 'red' }, { color: ICON_DEFAULTS.color }],
    ['clamps a size below the floor', { size: 0 }, { size: SIZE_MIN }],
    ['clamps a size above the ceiling', { size: 4 }, { size: SIZE_MAX }],
    ['rejects a size that is not a number', { size: 'big' }, { size: ICON_DEFAULTS.size }],
    ['keeps a known weight', { weight: 'bold' }, { weight: 'bold' }],
    ['drops an unknown weight', { weight: 'ultra' }, { weight: ICON_DEFAULTS.weight }],
    ['keeps a glow flag', { glow: true }, { glow: true }],
    ['rejects a glow that is not a boolean', { glow: 'yes' }, { glow: ICON_DEFAULTS.glow }],
  ];

  it.each(CASES)('%s', (_name, raw, expected) => {
    expect(validateIcon(raw)).toEqual({ ...ICON_DEFAULTS, ...expected });
  });

  it('accepts every weight it offers', () => {
    for (const weight of ICON_WEIGHTS) {
      expect(validateIcon({ weight }).weight).toBe(weight);
    }
  });

  it('accepts every glyph it ships', () => {
    for (const glyph of GLYPHS) {
      expect(validateIcon({ icon: glyph.id }).icon).toBe(glyph.id);
    }
  });
});

describe('normalizeHex', () => {
  it('falls back rather than inventing a colour', () => {
    expect(normalizeHex('#ff', '#000000')).toBe('#000000');
    expect(normalizeHex(undefined, '#000000')).toBe('#000000');
    expect(normalizeHex('  #FfF  ', '#000000')).toBe('#ffffff');
  });
});
