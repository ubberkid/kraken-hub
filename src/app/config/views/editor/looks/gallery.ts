/**
 * The Gallery (§9) — the curated Looks in this repository, read as files.
 *
 * `looks/index.json` is a catalogue, not an API: five fields a row, checked into
 * git, reviewed in a pull request. There is no server behind it, no account and
 * nothing tracked, and this module is the whole client — a `fetch` of a static
 * file relative to the page, so a fork on its own domain reads its own gallery
 * without a line of configuration (invariant I7: never a root-relative URL, and
 * never an origin written down).
 *
 * ## Every outcome is data
 *
 * The catalogue may be absent — a deployment that ships the app without the
 * `looks/` folder is a real and legal thing, and it is what the published site
 * does today — so `loadGallery` returns a typed result rather than throwing. The
 * sheet renders the "unavailable" case as a card that says where the Looks are
 * instead of an empty group that looks like a bug. A row whose file will not
 * parse is dropped with its neighbours kept, the same rule the saved-Looks store
 * follows: one bad file costs one Look.
 */

import { parseLookFile, type LookFile } from '../../../../../state/look/file';

import type { LookEntry } from '../../../editor/looksMenu';

/** Where the catalogue lives, relative to whatever page is asking. */
export const GALLERY_INDEX_PATH = 'looks/index.json';

/** One row of `looks/index.json`. */
interface GalleryRow {
  id: string;
  name: string;
  author: string;
  description: string;
  file: string;
}

export type GalleryResult =
  | { ok: true; entries: LookEntry[] }
  /**
   * The catalogue could not be read. `unavailable` is not an error to apologise
   * for: it is what a build that ships without the folder honestly is.
   */
  | { ok: false; reason: 'unavailable' };

function isRow(raw: unknown): raw is GalleryRow {
  if (raw === null || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return (
    typeof o['id'] === 'string' &&
    typeof o['name'] === 'string' &&
    typeof o['file'] === 'string' &&
    o['file'] !== '' &&
    // A file name, never a path: a row cannot point the fetch out of the folder.
    !o['file'].includes('/') &&
    !o['file'].includes('\\')
  );
}

/**
 * The catalogue and every Look in it, resolved against the page's own base.
 *
 * The files are fetched in parallel and each one goes through `parseLookFile` —
 * the same importer a dragged-in file takes — so a gallery Look written at an
 * older schema is migrated on the way in, exactly like anybody else's.
 */
export async function loadGallery(
  base: string = document.baseURI,
  doFetch: typeof fetch = fetch,
): Promise<GalleryResult> {
  let rows: GalleryRow[];
  try {
    const indexUrl = new URL(GALLERY_INDEX_PATH, base);
    const response = await doFetch(indexUrl.href);
    if (!response.ok) return { ok: false, reason: 'unavailable' };
    const parsed: unknown = await response.json();
    if (!Array.isArray(parsed)) return { ok: false, reason: 'unavailable' };
    rows = parsed.filter(isRow);
  } catch {
    return { ok: false, reason: 'unavailable' };
  }

  const settled = await Promise.all(
    rows.map(async (row): Promise<LookEntry | null> => {
      try {
        const url = new URL(`looks/${row.file}`, base);
        const response = await doFetch(url.href);
        if (!response.ok) return null;
        const result = parseLookFile(await response.text());
        if (!result.ok) return null;
        return entryOf(row, result.file);
      } catch {
        return null;
      }
    }),
  );

  return { ok: true, entries: settled.filter((e): e is LookEntry => e !== null) };
}

/**
 * The card's words come from the FILE where the file has them, and from the
 * catalogue where it does not — so a row cannot advertise a Look as something
 * other than what the file says it is.
 */
function entryOf(row: GalleryRow, file: LookFile): LookEntry {
  return {
    id: row.id,
    source: 'gallery',
    name: file.name === '' ? row.name : file.name,
    summary: file.description ?? row.description,
    file,
  };
}
