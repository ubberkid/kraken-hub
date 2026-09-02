import { describe, expect, it } from 'vitest';

import { CATEGORY_LABELS, GLYPHS, GLYPH_CATEGORIES, GLYPH_IDS, getGlyph, glyphsIn } from './glyphs';

/**
 * The set, as a set.
 *
 * A glyph table is data, and the failures a data table has are the ones nobody
 * reads a diff carefully enough to catch: two glyphs with one id (the second
 * silently unreachable), a `d` that is empty (a layer that renders nothing), a
 * category nothing shows. Every one of them is one assertion here.
 */
describe('the curated glyph set', () => {
  it('ships the promised number of glyphs', () => {
    expect(GLYPHS.length).toBe(48);
    expect(GLYPH_IDS.length).toBe(GLYPHS.length);
  });

  it('has unique ids', () => {
    expect(new Set(GLYPH_IDS).size).toBe(GLYPH_IDS.length);
  });

  it.each(GLYPHS.map((g) => [g.id, g] as const))('%s is well formed', (id, glyph) => {
    // Kebab-case, so an id is safe in a `data-testid` and in a URL.
    expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(glyph.label.length).toBeGreaterThan(0);
    expect(['stroke', 'fill']).toContain(glyph.paint);
    expect(GLYPH_CATEGORIES).toContain(glyph.category);

    // Path data: starts with a move, contains only the commands and numbers an
    // SVG path may contain. A `d` with a letter outside the command set is a
    // typo that renders as nothing.
    expect(glyph.d.length).toBeGreaterThan(0);
    expect(glyph.d.startsWith('M')).toBe(true);
    expect(glyph.d).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]+$/);
  });

  it('draws everything on the 24 grid', () => {
    /*
     * Every coordinate a glyph names is inside ±25 — a point far outside the
     * box is a glyph drawn on somebody else's grid, and it gets clipped on a
     * panel rather than caught in a review.
     *
     * Arc segments are skipped, and not out of laziness: SVG packs an arc's two
     * flags against the number after them (`a3.5 3.5 0 100-7` is `1`, `0`,
     * `0`, `-7`), so a naive scan reads a flag pair as the number one hundred.
     * Parsing arcs properly to assert a bound on them would be a second SVG
     * implementation living in a test; the arcs here are radii and offsets in
     * the same hand-checked table as everything else.
     */
    for (const glyph of GLYPHS) {
      const withoutArcs = glyph.d.replace(/[aA][^A-Za-z]*/g, ' ');
      for (const raw of withoutArcs.match(/-?\d+(?:\.\d+)?/g) ?? []) {
        expect(Math.abs(Number(raw)), `${glyph.id}: ${raw}`).toBeLessThanOrEqual(25);
      }
    }
  });

  it('fills every category', () => {
    for (const category of GLYPH_CATEGORIES) {
      expect(glyphsIn(category).length, `${category} is empty`).toBeGreaterThan(0);
      expect(CATEGORY_LABELS[category].length).toBeGreaterThan(0);
    }
    // Every glyph is in exactly one drawer, so the drawers partition the set.
    const drawered = GLYPH_CATEGORIES.reduce((sum, c) => sum + glyphsIn(c).length, 0);
    expect(drawered).toBe(GLYPHS.length);
  });

  it('looks a glyph up by id, and answers null for one it does not have', () => {
    expect(getGlyph('bolt')?.label).toBe('Power draw');
    expect(getGlyph('no-such-glyph')).toBeNull();
  });
});
