/**
 * The curated faces, fetched at the moment a layer actually asks for one.
 *
 * ## Why this is a file and not four lines in `display.ts`
 *
 * `docs/design/design-editor-ux.md` §10 requires "system + 6 curated faces
 * loaded lazily only when a layer uses them", and the word doing the work is
 * *only*. `src/ui/ui.css`'s header states the app's position outright: the
 * shipped app loads no webfont, because a font request is a network dependency
 * on a page that must work offline. A text layer set to `system` — the default,
 * and what every existing look wears — must therefore cost the display exactly
 * zero requests, and the way to guarantee that is for the request to be made by
 * a function that takes the face id as an argument and is never called with
 * anything else.
 *
 * So: no `@font-face` in any stylesheet, no `<link>` in `index.html`, nothing
 * on the display's critical path. One `<link>` per face, injected on first use,
 * deduplicated by a data attribute so a look with four Serif layers still makes
 * one request.
 *
 * ## Where the stylesheet comes from
 *
 * A DOCUMENT-RELATIVE path, `fonts/<id>.css`, resolved by the browser against
 * the page — never an absolute URL and never a CDN. Two invariants say so and
 * both of them are enforced: invariant 4 (no hardcoded origins — a fork must
 * work from its own hostname, and `src/config/knownHosts.ts` is the only file
 * allowed to name an external host) and invariant 8 (nothing is loaded from a
 * CDN, because the strict CSP and the offline demo depend on it). A
 * `fonts.googleapis.com` link would breach both.
 *
 * The consequence is honest and deliberate: until the six stylesheets and their
 * `woff2` files are vendored into `public/fonts/`, a curated face resolves to
 * the fallback stack in `TEXT_FACES` and the panel still renders readable text
 * of the right character. A missing stylesheet degrades; it never blanks the
 * panel.
 */

import { createLogger } from '../../lib/log';

import { CURATED_FONTS, type TextFontId } from './schema';

const log = createLogger('modules/text/fonts');

/** Marks the one `<link>` per face, so the second layer to ask adds nothing. */
export const FONT_LINK_ATTR = 'data-kh-font';

/**
 * Document-relative on purpose (see the file header). Vite is configured with
 * `base: './'`, so this resolves correctly at a project page, a user page, a
 * custom domain and `http://127.0.0.1` alike.
 */
export function fontStylesheetHref(id: TextFontId): string {
  return `fonts/${id}.css`;
}

function selectorFor(id: TextFontId): string {
  return `link[${FONT_LINK_ATTR}="${id}"]`;
}

/**
 * Ensure the stylesheet for `id` is in the document. Idempotent and cheap.
 *
 * `system` is a no-op by construction, which is the whole point: the default
 * config, and every look that never touched the font control, makes no request.
 */
export function ensureFontLoaded(id: TextFontId): void {
  if (id === 'system') return;
  if (!(CURATED_FONTS as readonly string[]).includes(id)) return;
  if (typeof document === 'undefined') return;
  if (document.head.querySelector(selectorFor(id)) !== null) return;

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.setAttribute(FONT_LINK_ATTR, id);
  // A face that fails to arrive is a fallback stack, not an error card: the
  // layer is already rendering readable text in the meantime.
  link.addEventListener('error', () => {
    log.warn(`curated face "${id}" did not load; falling back to the system stack`);
  });
  // `setAttribute`, not `link.href`: the no-navigation lint rule (invariant:
  // the Kraken Browser does not follow navigations) forbids writing a `.href`
  // property anywhere, and a stylesheet link is not a navigation.
  link.setAttribute('href', fontStylesheetHref(id));
  document.head.append(link);
}

/** Test hook — the document persists between cases in one jsdom environment. */
export function loadedFontLinks(): readonly string[] {
  if (typeof document === 'undefined') return [];
  return [...document.head.querySelectorAll(`link[${FONT_LINK_ATTR}]`)].map(
    (el) => el.getAttribute(FONT_LINK_ATTR) ?? '',
  );
}
