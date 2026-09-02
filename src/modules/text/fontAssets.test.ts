import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { fontStylesheetHref } from './fonts';
import { CURATED_FONTS, TEXT_FACES } from './schema';

/**
 * The vendored half of the curated faces.
 *
 * `fonts.dom.test.ts` proves the loader asks for `fonts/<id>.css` and asks for
 * nothing otherwise. This file proves the thing it asks for is actually THERE —
 * because a missing stylesheet degrades silently (the layer falls back to the
 * system stack and nobody sees an error), which is exactly the failure mode that
 * survives a release unnoticed.
 *
 * It also holds the two budgets that keep the faces shippable on a static Pages
 * site: latin subset only, and ≤ 40 kB of woff2 per face.
 */

const PUBLIC_FONTS = fileURLToPath(new URL('../../../public/fonts/', import.meta.url));

/** The budget one face is allowed to cost the display, in bytes. */
const MAX_FACE_BYTES = 40 * 1024;

/** The `latin` unicode-range Google Fonts subsets to. Nothing wider ships. */
const LATIN_RANGE_START = 'U+0000-00FF';

function cssPathFor(id: string): string {
  // The href the loader injects, resolved against `public/` the way the browser
  // resolves it against the deployed page.
  return `${PUBLIC_FONTS}${fontStylesheetHref(id as (typeof CURATED_FONTS)[number]).replace('fonts/', '')}`;
}

function cssFor(id: string): string {
  return readFileSync(cssPathFor(id), 'utf8');
}

/** Every `url('./x.woff2')` in a stylesheet, as bare file names. */
function woff2Refs(css: string): string[] {
  return [...css.matchAll(/url\('\.\/([^']+)'\)/g)].map((m) => m[1] ?? '');
}

describe('the vendored curated faces', () => {
  it.each(CURATED_FONTS)('%s has the stylesheet the loader asks for', (id) => {
    expect(existsSync(cssPathFor(id))).toBe(true);
  });

  it.each(CURATED_FONTS)('%s names the family its fallback stack leads with', (id) => {
    const css = cssFor(id);
    // TEXT_FACES puts the curated family first; the @font-face must define that
    // exact name or the stack silently skips straight to the fallback.
    const family = (TEXT_FACES[id].stack.split(',')[0] ?? '').trim().replaceAll("'", '');
    expect(css).toContain(`font-family: '${family}';`);
  });

  it.each(CURATED_FONTS)('%s swaps rather than blocking first paint', (id) => {
    expect(cssFor(id)).toContain('font-display: swap;');
  });

  it.each(CURATED_FONTS)('%s ships the latin subset only', (id) => {
    const css = cssFor(id);
    // Prettier wraps a long `unicode-range` onto its own lines, so the two
    // halves are asserted separately rather than as one literal.
    expect(css).toContain('unicode-range:');
    expect(css).toContain(LATIN_RANGE_START);
    // One @font-face per file: a second one would be a second subset.
    expect(css.match(/@font-face/g)).toHaveLength(1);
  });

  it.each(CURATED_FONTS)('%s references woff2 files that exist and are woff2', (id) => {
    const refs = woff2Refs(cssFor(id));
    expect(refs.length).toBeGreaterThan(0);

    for (const ref of refs) {
      expect(ref.endsWith('.woff2')).toBe(true);
      const abs = `${PUBLIC_FONTS}${ref}`;
      expect(existsSync(abs)).toBe(true);
      // Magic bytes, not the extension: a 404 page saved under the right name
      // would pass every other check here.
      expect(readFileSync(abs).subarray(0, 4).toString('latin1')).toBe('wOF2');
    }
  });

  it.each(CURATED_FONTS)('%s costs the display at most 40 kB', (id) => {
    const bytes = woff2Refs(cssFor(id)).reduce(
      (sum, ref) => sum + statSync(`${PUBLIC_FONTS}${ref}`).size,
      0,
    );
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(MAX_FACE_BYTES);
  });

  it.each(CURATED_FONTS)('%s vendors the licence it ships under', (id) => {
    const ofl = `${PUBLIC_FONTS}${id}/OFL.txt`;
    expect(existsSync(ofl)).toBe(true);
    const text = readFileSync(ofl, 'utf8');
    expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(text.startsWith('Copyright')).toBe(true);
  });

  it.each(CURATED_FONTS)('%s is listed in THIRD-PARTY-NOTICES.md', (id) => {
    const notices = readFileSync(
      fileURLToPath(new URL('../../../THIRD-PARTY-NOTICES.md', import.meta.url)),
      'utf8',
    );
    const family = (TEXT_FACES[id].stack.split(',')[0] ?? '').trim().replaceAll("'", '');
    expect(notices).toContain(family);
    expect(notices).toContain(`public/fonts/${id}/OFL.txt`);
  });

  it('fetches nothing from a host — every src is a sibling file', () => {
    for (const id of CURATED_FONTS) {
      const css = cssFor(id);
      expect(css).not.toMatch(/url\((['"]?)https?:/);
      expect(css).not.toMatch(/url\((['"]?)\/\//);
    }
  });
});
