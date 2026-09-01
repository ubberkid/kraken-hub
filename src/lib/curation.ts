/**
 * The library's three curation commands, as they go on the wire.
 *
 * ## Why these are commands and playing is not
 *
 * Putting something on the panel is a *state commit* — `activeModuleId` plus the
 * module's `url` — and state is a full retained snapshot that both windows
 * already share, so `showTile` needed no protocol at all. Pinning, renaming and
 * deleting are different in kind: they change a row in a database that lives in
 * exactly one browser profile, and the window asking for the change is usually
 * not that browser. There is nothing to commit; there is somebody to ask.
 *
 * ## The three rules every one of them obeys
 *
 *  1. **Absolute, never relative.** `setPinned` carries the value it wants, not
 *     "toggle". The `cmd` channel is redelivered by a replaying transport and
 *     deduped only inside `CMD_MAX_AGE_MS`; a toggle applied twice is a bug that
 *     looks exactly like a user changing their mind. This is the `seekBy`
 *     hazard, written down.
 *  2. **Batched by id.** `SyncService.sendCmd` throttles PER OP at 200 ms and
 *     **drops** what lands inside the window rather than queueing it, so a
 *     five-item delete loop sends one command and the user watches four tiles
 *     come back. Every op here therefore takes an id ARRAY (rename excepted —
 *     one new name cannot apply to five rows) and the UI collects a selection
 *     before it speaks.
 *  3. **Idempotent by id.** `patchMedia` on an absent row is a no-op and
 *     `deleteMedia` on an absent key is a no-op, so replay costs nothing. That
 *     is what makes it safe to have no ack protocol: the remote removes the tile
 *     optimistically and reconciles against the next library packet, and a
 *     command that arrived twice reconciles the same as one that arrived once.
 *
 * Pure, dependency-free and DOM-free: the display page parses an argument that
 * was written by a peer which may be a different build of this app, or a fork,
 * so every field is checked here, once, and the caller can treat the result as a
 * fact. Anything malformed is `null`, which the caller drops.
 */

/** Mirrors `platform/mediaStore.MediaKind`, copied so this stays a leaf. */
export type CurationKind = 'clip' | 'image';

/**
 * How many ids one command may carry.
 *
 * The same forty the shelf itself is cut at (`LIBRARY_ITEM_MAX`): a selection
 * cannot contain more things than the shelf shows, and forty ids of 36 chars is
 * ~1.5 KB, comfortably inside the 8 KB envelope.
 */
export const CURATION_MAX_IDS = 40;

/** A name longer than this is a paragraph, and the tile renders one line. */
export const MEDIA_NAME_MAX = 120;

export interface SetPinnedArg {
  ids: string[];
  kind: CurationKind;
  pinned: boolean;
}

export interface RenameMediaArg {
  id: string;
  name: string;
}

export interface DeleteMediaArg {
  ids: string[];
}

function record(arg: unknown): Record<string, unknown> | null {
  if (typeof arg !== 'object' || arg === null || Array.isArray(arg)) return null;
  return arg as Record<string, unknown>;
}

/**
 * A batch of ids, de-duplicated and capped.
 *
 * De-duplication is not tidiness: the batch is applied by iterating it, and a
 * selection built from two overlapping gestures would otherwise write the same
 * row twice for no reason.
 */
function ids(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= CURATION_MAX_IDS) break;
  }
  return out.length === 0 ? null : out;
}

/**
 * A name a tile can actually render.
 *
 * Control characters are stripped rather than rejected — a filename pasted from
 * somewhere strange should not fail, it should arrive tidy — and the result is
 * trimmed and capped. An empty result is `null`: renaming something to nothing
 * is not a rename, it is a row you can no longer recognise.
 */
export function cleanMediaName(raw: string): string | null {
  // eslint-disable-next-line no-control-regex -- removing them is the entire point
  const stripped = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (stripped.length === 0) return null;
  return stripped.slice(0, MEDIA_NAME_MAX);
}

export function parseSetPinned(arg: unknown): SetPinnedArg | null {
  const o = record(arg);
  if (o === null) return null;
  const list = ids(o['ids']);
  if (list === null) return null;
  const kind = o['kind'];
  if (kind !== 'clip' && kind !== 'image') return null;
  if (typeof o['pinned'] !== 'boolean') return null;
  return { ids: list, kind, pinned: o['pinned'] };
}

export function parseRenameMedia(arg: unknown): RenameMediaArg | null {
  const o = record(arg);
  if (o === null) return null;
  const id = o['id'];
  const name = o['name'];
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof name !== 'string') return null;
  const clean = cleanMediaName(name);
  return clean === null ? null : { id, name: clean };
}

export function parseDeleteMedia(arg: unknown): DeleteMediaArg | null {
  const o = record(arg);
  if (o === null) return null;
  const list = ids(o['ids']);
  return list === null ? null : { ids: list };
}
