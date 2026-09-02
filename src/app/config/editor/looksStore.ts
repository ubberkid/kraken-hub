/**
 * **Your Looks** — the saved-Looks store (§4), and the live Look's name.
 *
 * ## Why this is not in `AppState`
 *
 * The document rides an 8 kB sync envelope, and every byte in it is paid for on
 * every change by every window. A shelf of fifty Looks is fifty complete
 * arrangements — a hundred kilobytes of JSON describing panels nobody is
 * currently looking at. `MAX_STATE_BYTES` would refuse the write long before
 * that, and refusing it is the RIGHT answer: the document says what is on the
 * panel, and a Look you saved last week is not on the panel.
 *
 * So the shelf lives where the rest of this window's own memory lives — one
 * namespaced localStorage key, `kraken-hub:v1:looks` (invariant I5) — and the
 * document holds only what is showing. That has one honest consequence the UI
 * states out loud rather than hiding: **your saved Looks do not follow you to
 * another browser.** They are files, and a file is how a Look travels.
 *
 * ## The live Look's NAME lives here too
 *
 * It used to have its own key (`config:lookName`), parked there by W5 with a
 * note saying it belonged in the saved-Looks store when one existed. This is
 * that store, so this is where it went — one document, one write, one thing to
 * keep consistent when "Save as…" copies the name onto a new row. A name left
 * behind by the old key is adopted once, on the first read, so nobody's Look
 * loses its name in the move.
 *
 * ## Shape
 *
 * One JSON document, so a read is never torn:
 *
 * ```jsonc
 * { "v": 1, "name": "Slow tide", "looks": [ { id, file, favourite, order, updatedAt } ] }
 * ```
 *
 * `order` is an explicit integer rather than array position, because a drag
 * reorder and a rename can land from two windows in either sequence and array
 * position is not a value you can merge. Reads sort by it; ties fall back to
 * `updatedAt`, then id, so the order is total and stable.
 *
 * Everything below the storage line is PURE — `parseLooksDoc` and the mutators
 * take a document and return one — so the cap, the ordering and the corruption
 * tolerance are tested without a browser.
 */

import { readRaw, removeRaw, writeRaw } from '../../../platform/storage';
import { parseLookFile, type LookFile } from '../../../state/look/file';

/** Namespaced like everything else (I5). */
export const LOOKS_SUFFIX = 'looks';

/** The key W5 parked the live Look's name in, read once and retired. */
export const LEGACY_LOOK_NAME_SUFFIX = 'config:lookName';

/**
 * The shelf's ceiling.
 *
 * Not a storage limit — fifty Looks is well under a hundred kilobytes and
 * localStorage holds megabytes. It is a limit on the shelf being usable: past
 * fifty live previews the grid is a scroll bar, and the honest answer to "I have
 * more than fifty Looks" is a folder of files, which is what the exporter is
 * for. The card at the cap says exactly that.
 */
export const MAX_SAVED_LOOKS = 50;

/** The longest a Look's name may be, matching `looksMenu.MAX_LOOK_NAME`. */
const MAX_NAME = 40;

export interface SavedLook {
  /** Minted here; `[A-Za-z0-9_-]{1,32}`, which is what `validateAppState` accepts. */
  id: string;
  file: LookFile;
  favourite: boolean;
  /** Sort key. Lower is earlier. Favourites sort ahead of it, not instead of it. */
  order: number;
  updatedAt: number;
}

export interface LooksDoc {
  v: 1;
  /** The live Look's name. `null` is "no name", never an empty string. */
  name: string | null;
  looks: SavedLook[];
}

export const EMPTY_DOC: LooksDoc = { v: 1, name: null, looks: [] };

// ---------------------------------------------------------------------------
// Pure: parsing, ordering, mutation
// ---------------------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** Trim and cap a name. Empty means "no name". */
export function normaliseName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, MAX_NAME);
  return trimmed === '' ? null : trimmed;
}

/**
 * Anything at all → a usable document. Never throws, never returns null.
 *
 * A row is kept when it survives `parseLookFile`, which is the same importer a
 * dragged-in file goes through — so a shelf written by an older build is
 * MIGRATED on read rather than discarded, and a row that is not a Look at all
 * is dropped without taking its neighbours with it. That last part is the whole
 * reason this is a per-row loop and not a single validate: one corrupt entry in
 * a fifty-Look shelf must cost one Look.
 */
export function parseLooksDoc(raw: unknown): LooksDoc {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return EMPTY_DOC;
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY_DOC;

  const o = parsed as Record<string, unknown>;
  const rows: SavedLook[] = [];
  const seen = new Set<string>();
  const list: unknown = o['looks'];
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const row = entry as Record<string, unknown>;
      const id = row['id'];
      if (typeof id !== 'string' || !ID_RE.test(id) || seen.has(id)) continue;
      const result = parseLookFile(row['file']);
      if (!result.ok) continue;
      seen.add(id);
      rows.push({
        id,
        file: result.file,
        favourite: row['favourite'] === true,
        order:
          typeof row['order'] === 'number' && Number.isFinite(row['order'])
            ? Math.round(row['order'])
            : rows.length,
        updatedAt:
          typeof row['updatedAt'] === 'number' && Number.isFinite(row['updatedAt'])
            ? row['updatedAt']
            : 0,
      });
      if (rows.length >= MAX_SAVED_LOOKS) break;
    }
  }

  return { v: 1, name: normaliseName(o['name']), looks: sortLooks(rows) };
}

/**
 * The shelf's order: favourites first, then `order`, then newest, then id.
 *
 * Total and stable — every tie has a next key — because a sort that can return
 * two different arrays for the same data makes a drag reorder look like it
 * failed on the window that did not do the dragging.
 */
export function sortLooks(rows: readonly SavedLook[]): SavedLook[] {
  return [...rows].sort((a, b) => {
    if (a.favourite !== b.favourite) return a.favourite ? -1 : 1;
    if (a.order !== b.order) return a.order - b.order;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    return a.id < b.id ? -1 : 1;
  });
}

/** A fresh id. Random rather than sequential: two windows may mint at once. */
export function mintLookId(random: () => number = Math.random): string {
  const n = Math.floor(random() * 0xffffffff);
  return `lk${n.toString(36)}${Date.now().toString(36)}`.slice(0, 32);
}

export type SaveRefusal = 'full';

export type SaveResult =
  { ok: true; doc: LooksDoc; id: string } | { ok: false; reason: SaveRefusal };

/** Add a Look to the shelf. Refuses at the cap rather than evicting somebody's work. */
export function addLook(
  doc: LooksDoc,
  file: LookFile,
  now: number,
  id: string = mintLookId(),
): SaveResult {
  if (doc.looks.length >= MAX_SAVED_LOOKS) return { ok: false, reason: 'full' };
  const order = doc.looks.reduce((max, l) => Math.max(max, l.order), -1) + 1;
  const row: SavedLook = { id, file, favourite: false, order, updatedAt: now };
  return { ok: true, doc: { ...doc, looks: sortLooks([...doc.looks, row]) }, id };
}

/** Rename a saved Look. The name lives in the FILE, because that is what travels. */
export function renameSaved(doc: LooksDoc, id: string, raw: string, now: number): LooksDoc {
  const name = normaliseName(raw) ?? '';
  return mapRow(doc, id, (row) => ({ ...row, file: { ...row.file, name }, updatedAt: now }));
}

/**
 * Duplicate, with the copy landing immediately after its original.
 *
 * The order value is the original's, and every row at or after it steps up by
 * one — rather than appending to the end, which is where a duplicate is least
 * useful and where nobody looking at the row they just copied would look for it.
 */
export function duplicateSaved(
  doc: LooksDoc,
  id: string,
  now: number,
  newId: string = mintLookId(),
): SaveResult {
  const source = doc.looks.find((l) => l.id === id);
  if (source === undefined) return { ok: false, reason: 'full' };
  if (doc.looks.length >= MAX_SAVED_LOOKS) return { ok: false, reason: 'full' };

  const shifted = doc.looks.map((l) => (l.order > source.order ? { ...l, order: l.order + 1 } : l));
  const copy: SavedLook = {
    id: newId,
    file: { ...source.file, name: copyName(source.file.name) },
    favourite: false,
    order: source.order + 1,
    updatedAt: now,
  };
  return { ok: true, doc: { ...doc, looks: sortLooks([...shifted, copy]) }, id: newId };
}

/** "Slow tide" → "Slow tide copy" → "Slow tide copy 2". Capped like any name. */
export function copyName(name: string): string {
  const match = /^(.*?) copy(?: (\d+))?$/.exec(name);
  const next =
    match === null
      ? `${name} copy`
      : `${match[1] ?? ''} copy ${String(Number(match[2] ?? '1') + 1)}`;
  return next.slice(0, MAX_NAME);
}

export function toggleFavourite(doc: LooksDoc, id: string, now: number): LooksDoc {
  return mapRow(doc, id, (row) => ({ ...row, favourite: !row.favourite, updatedAt: now }));
}

export function deleteSaved(doc: LooksDoc, id: string): LooksDoc {
  return { ...doc, looks: doc.looks.filter((l) => l.id !== id) };
}

/**
 * Move a Look to a position in the CURRENT sorted order.
 *
 * Orders are renumbered 0..n-1 afterwards, which is the one place this file
 * rewrites a value it did not have to. The alternative — fractional orders —
 * drifts toward float precision after a few hundred drags, and a shelf of fifty
 * rows is cheap to renumber.
 */
export function reorderSaved(doc: LooksDoc, id: string, toIndex: number): LooksDoc {
  const rows = sortLooks(doc.looks);
  const from = rows.findIndex((l) => l.id === id);
  if (from < 0) return doc;
  const clamped = Math.max(0, Math.min(rows.length - 1, Math.round(toIndex)));
  const moved = rows.splice(from, 1)[0];
  if (moved === undefined) return doc;
  rows.splice(clamped, 0, moved);
  return { ...doc, looks: rows.map((l, i) => ({ ...l, order: i })) };
}

export function setDocName(doc: LooksDoc, raw: string | null): LooksDoc {
  return { ...doc, name: normaliseName(raw) };
}

/** Change one row, or hand back the document untouched when there is no such row. */
function mapRow(doc: LooksDoc, id: string, fn: (row: SavedLook) => SavedLook): LooksDoc {
  if (!doc.looks.some((row) => row.id === id)) return doc;
  const looks = doc.looks.map((row) => (row.id === id ? fn(row) : row));
  return { ...doc, looks: sortLooks(looks) };
}

// ---------------------------------------------------------------------------
// Storage-bound: one key, one write, one notification
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();

/**
 * Read the shelf.
 *
 * Not cached. The document is small, the read is synchronous, and a cache here
 * would need invalidating from a `storage` event that CAM's webview only
 * delivers reliably on one measured build (H16) — which is the same reason
 * `useMirror` polls.
 */
export function readLooksDoc(): LooksDoc {
  const raw = readRaw(LOOKS_SUFFIX);
  if (raw !== null) return parseLooksDoc(raw);
  // Nothing written here yet: adopt the name W5's own key was holding, once.
  // The next write retires that key, so the two can never disagree afterwards.
  return { ...EMPTY_DOC, name: normaliseName(readRaw(LEGACY_LOOK_NAME_SUFFIX)) };
}

/** Write it back, and tell this window. Returns false when it could only be kept in memory. */
export function writeLooksDoc(doc: LooksDoc): boolean {
  const ok = writeRaw(LOOKS_SUFFIX, JSON.stringify(doc));
  // The legacy key is retired the moment the store has written once, so the two
  // can never disagree about the live Look's name.
  removeRaw(LEGACY_LOOK_NAME_SUFFIX);
  for (const cb of [...listeners]) cb();
  return ok;
}

/** Same-window change notifications. Cross-window is the `storage` event, as ever. */
export function subscribeLooks(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Apply a pure mutation to the stored document. The one write path. */
export function updateLooksDoc(fn: (doc: LooksDoc) => LooksDoc): LooksDoc {
  const next = fn(readLooksDoc());
  writeLooksDoc(next);
  return next;
}

/** The live Look's name, wherever it is currently kept. */
export function readLookName(): string | null {
  return readLooksDoc().name;
}

export function writeLookName(name: string | null): void {
  updateLooksDoc((doc) => setDocName(doc, name));
}
