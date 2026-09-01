/**
 * `local-file` — a clip out of the IndexedDB library, played from a ref-counted
 * blob URL (design-videoEngine.md §1.2, §5.4).
 *
 * The highest-quality path in the whole app and the only one that works with the
 * network switched off: no CORS, no ads, no provider chrome, silent backward
 * seeks, a real `pause()`. Under the download-first flow this is where a pasted
 * URL ends up.
 */

import { acquire, installPageHideRelease, release } from '../local/blobUrlRegistry';
import { getClipBlob, touchClip } from '../local/clipStore';
import { LOCAL_CLIP_RE } from '../routing/patterns';

import { createHtmlVideoAdapter, type HtmlVideoAdapter } from './HtmlVideoAdapterBase';
import { fail } from './VideoAdapter';

/** Extracts `<id>` from `kraken-hub-clip:<id>`, or `null` when it is not one. */
export function clipIdFromUrl(url: string): string | null {
  return LOCAL_CLIP_RE.exec(url)?.[1] ?? null;
}

export function createAdapter(): HtmlVideoAdapter {
  let acquired: string | null = null;

  return createHtmlVideoAdapter({
    id: 'local-file',
    caps: { canSeekSilently: true },
    resolveSrc: async (ctx) => {
      const id = clipIdFromUrl(ctx.match.url);
      if (id === null) {
        throw fail(
          'clip-missing',
          'That is not a clip reference this display can resolve.',
          'local-file',
          ctx.url,
        );
      }
      const blob = await getClipBlob(id);
      if (blob === null) {
        throw fail(
          'clip-missing',
          "That clip isn't in your library any more.",
          'local-file',
          ctx.url,
        );
      }
      installPageHideRelease();
      acquired = id;
      void touchClip(id);
      return acquire(id, blob);
    },
    // Called by the base AFTER `src` is cleared and `load()` has run (§5.4).
    releaseSrc: () => {
      if (acquired !== null) {
        release(acquired);
        acquired = null;
      }
    },
  });
}
