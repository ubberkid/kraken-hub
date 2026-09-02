import { describe, expect, it } from 'vitest';

import { INKS, INK_SWATCHES } from './swatches';

/**
 * The house inks, as a fact.
 *
 * The bug this suite exists to catch is drift: four kinds used to declare their
 * own five `#rrggbb` literals, and "the same five, everywhere" was a sentence in
 * four doc comments rather than a thing the build could check. Now the sentence
 * is one array and these are its rules.
 */
describe('house inks', () => {
  it('offers exactly five on the strip', () => {
    // The strip's cap is five CONTROLS, and a swatch row is one of them — five
    // swatches is what fits on one line without a scroller.
    expect(INK_SWATCHES).toHaveLength(5);
  });

  it('has unique values and a swatch for every one', () => {
    const values = INK_SWATCHES.map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
    for (const option of INK_SWATCHES) {
      // A swatch control shows the choice rather than naming it, so a swatch
      // with no colour is a blank button nobody can identify.
      expect(option.swatch, `${option.label} needs a swatch colour`).toBeDefined();
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('draws every swatch from the named inks', () => {
    const named = Object.values(INKS).map((o) => o.value);
    for (const option of INK_SWATCHES) expect(named).toContain(option.value);
  });

  it('names each ink once', () => {
    const values = Object.values(INKS).map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
  });
});
