import { afterEach, describe, expect, it } from 'vitest';

import { FONT_LINK_ATTR, ensureFontLoaded, fontStylesheetHref, loadedFontLinks } from './fonts';
import { CURATED_FONTS, type TextFontId } from './schema';

/**
 * The *only* in "loaded lazily only when a layer uses them"
 * (design-editor-ux.md §10).
 *
 * The display page must not fetch a font, ever, unless a text layer is actually
 * set to a curated face — `src/ui/ui.css` states the position: a font request is
 * a network dependency on a page that must work offline. So the assertions here
 * are as much about what is NOT in the document as about what is.
 */

function links(): NodeListOf<HTMLLinkElement> {
  return document.head.querySelectorAll<HTMLLinkElement>(`link[${FONT_LINK_ATTR}]`);
}

afterEach(() => {
  for (const el of links()) el.remove();
});

describe('the curated-face loader', () => {
  it('injects nothing at import time', () => {
    // The module has been imported by the time this runs; the head is still bare.
    expect(links()).toHaveLength(0);
  });

  it('injects nothing for the system face — the default, and every old look', () => {
    ensureFontLoaded('system');
    expect(links()).toHaveLength(0);
  });

  it.each(CURATED_FONTS)('injects exactly one stylesheet for %s', (id) => {
    ensureFontLoaded(id);
    expect(links()).toHaveLength(1);

    const link = links()[0];
    expect(link?.rel).toBe('stylesheet');
    expect(link?.getAttribute(FONT_LINK_ATTR)).toBe(id);
    expect(link?.getAttribute('href')).toBe(fontStylesheetHref(id));
  });

  it('asks twice and requests once — four Serif layers are one fetch', () => {
    ensureFontLoaded('serif');
    ensureFontLoaded('serif');
    ensureFontLoaded('serif');
    expect(links()).toHaveLength(1);
  });

  it('keeps one link per face when several faces are on the panel', () => {
    ensureFontLoaded('serif');
    ensureFontLoaded('mono');
    ensureFontLoaded('serif');
    expect([...loadedFontLinks()].sort()).toEqual(['mono', 'serif']);
  });

  it('ignores a face id it does not know', () => {
    // A look written by a newer version, or by a fork, reaches this function.
    ensureFontLoaded('comic-sans' as TextFontId);
    expect(links()).toHaveLength(0);
  });

  /**
   * Invariant 4 (no hardcoded origins) and invariant 8 (nothing from a CDN),
   * both of which a `fonts.googleapis.com` link would breach. The href is
   * document-relative, so a fork on its own hostname, a custom domain and
   * `http://127.0.0.1` all resolve it correctly with no configuration.
   */
  it.each(CURATED_FONTS)('%s is fetched from the app itself, never a CDN', (id) => {
    const href = fontStylesheetHref(id);
    expect(href).not.toMatch(/^https?:/);
    expect(href).not.toMatch(/^\/\//);
    expect(href.startsWith('/')).toBe(false);
  });
});
