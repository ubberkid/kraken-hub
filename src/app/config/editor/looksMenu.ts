/**
 * The Looks menu — the current Look's name, and the entries the sheet shows.
 *
 * ## The stub is gone
 *
 * W5 shipped this file with `baseTemplates()`: one base-only Look per kind that
 * could be a background, derived from the registry. It was the honest minimum
 * for a wave whose template TABLE was being written the same afternoon. The
 * table exists now (`src/state/look/templates.ts`, ten designed Looks, each a
 * real `.krakenlook` byte-identical to its file in `public/looks/`), so the derived
 * list is retired and the menu shows the Looks the app actually ships.
 *
 * ## `templates.ts` is imported LAZILY, and that is a byte budget, not a style
 *
 * It lives under `src/state/`, so vite's `core` group would claim it by path —
 * and `core` is on the LCD's first-download path, which has ~1.6 kB of headroom
 * against a 90 kB gate. Ten templates are ~9 kB of table. A static import here
 * would therefore put nine kilobytes of configuration-window content on the
 * critical path of a panel that will never open a menu.
 *
 * Two mechanisms keep it off, and both are needed:
 *
 *  - `await import('../../../state/look/templates')` here, so nothing in
 *    `src/app` reaches the table without asking for it. `looksMenu.test.ts`
 *    greps `src/app` for a static import of it, the way the display-graph rule
 *    greps for a config-UI leak.
 *  - a `looks` chunk group in `vite.config.ts`, ranked below `core` with a
 *    matching lookahead in `core`'s own test — the exact shape `lazy-shared`
 *    uses. Without it the dynamic import still lands in `core`, because a chunk
 *    group claims by path and rolldown honours the group before the edge.
 *
 * Pure, and dependency-free apart from the file format's types.
 */

import type { LookFile } from '../../../state/look/file';

/** The name a Look wears before anybody names one. Not a placeholder — a name. */
export const UNTITLED_LOOK = 'Untitled look';

/** Where an entry in the sheet came from. The card's badge and its actions differ. */
export type LookSource = 'template' | 'saved' | 'gallery';

export interface LookEntry {
  /** Stable within its source: a template id, a saved Look's id, a gallery id. */
  id: string;
  source: LookSource;
  name: string;
  /** One line, from the file's own description. Empty when the file has none. */
  summary: string;
  /** The Look itself. Applying an entry is `resolveMedia` + `applyLookFile` on this. */
  file: LookFile;
}

/** A shipped template, as the sheet's cards want it. Pure; the table is injected. */
export function templateEntries(templates: readonly { id: string; file: LookFile }[]): LookEntry[] {
  return templates.map((t) => ({
    id: t.id,
    source: 'template' as const,
    name: t.file.name,
    summary: t.file.description ?? '',
    file: t.file,
  }));
}

/**
 * The shipped templates, fetched on demand.
 *
 * Called when the sheet opens, not when the editor mounts: the table is a
 * chunk, and a chunk fetched at mount is a chunk on the boot path with extra
 * steps.
 */
export async function loadTemplates(): Promise<LookEntry[]> {
  const { LOOK_TEMPLATES } = await import('../../../state/look/templates');
  return templateEntries(LOOK_TEMPLATES);
}

/**
 * What the menu's button says.
 *
 * A Look with no name is "Untitled look" rather than blank or a guess at what
 * it contains: the name is a thing the user gets to set, and the app inventing
 * "Video + clock" for them would be a name they then have to correct.
 */
export function lookMenuLabel(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  return trimmed === '' ? UNTITLED_LOOK : trimmed;
}

/** The longest a Look's name may be. Same ceiling a layer name has. */
export const MAX_LOOK_NAME = 40;

/** Trim and cap a typed name. Empty means "no name", never an empty string. */
export function normaliseLookName(raw: string): string | null {
  const trimmed = raw.trim().slice(0, MAX_LOOK_NAME);
  return trimmed === '' ? null : trimmed;
}
