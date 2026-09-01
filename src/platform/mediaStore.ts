/**
 * ONE media library — clips and pictures, in one store, with `kind` as a
 * property (wave 2, C2).
 *
 * ## What this replaces
 *
 * Two libraries: `clips`/`clipBlobs` written by `modules/video/local/clipStore`
 * and `images`/`imageBlobs` written by `modules/image/imageStore`, with two
 * orderings, two localStorage mirrors and two index shapes. Their union existed
 * only in the view layer, which is why the shelf could look like one shelf and
 * behave like two.
 *
 * ## The merge, in three rules
 *
 *  1. **The upgrade is additive.** v4 creates `mediaBlobs` and reads nothing —
 *     see the `DB_VERSION` note in `idb.ts`. `media` itself has existed and been
 *     empty since v1.
 *  2. **The copy is an ordinary transaction, one row at a time, idempotent.** A
 *     row already in `media` is not copied again; a row copied and then
 *     interrupted before the next one is simply a migration that has not
 *     finished, and the next call finishes it. Nothing is ever *moved*: the
 *     legacy row stays where it is.
 *  3. **Reads fall back.** A read is `media` plus any legacy row not yet copied,
 *     merged by id with `media` winning. So the shelf is complete at every point
 *     during the migration, including before it starts and while it is running.
 *
 * The legacy stores are dropped in a LATER release. Overlap costs a duplicate
 * library on disk and buys a rollback. A delete, however, removes the legacy row
 * too — otherwise the fallback read would resurrect what the user just deleted,
 * which is the one way "copy, don't move" can bite.
 *
 * ## Layering
 *
 * This is `src/platform`, so it may not import a module (invariant I6) and does
 * not need to: the two historical row shapes are *data*, and both are subsets of
 * the merged row's field set, so one generic mapper covers both. The modules
 * keep their own record types and adapt at their own boundary.
 */

import { createLogger } from '../lib/log';

import {
  STORE_CLIPS,
  STORE_CLIP_BLOBS,
  STORE_IMAGES,
  STORE_IMAGE_BLOBS,
  STORE_MEDIA,
  STORE_MEDIA_BLOBS,
  idbRequest,
  idbTxDone,
  openDb,
} from './idb';

const log = createLogger('platform/media');

/** Kind is a property, not a place. */
export type MediaKind = 'clip' | 'image';

/**
 * One row of the one library.
 *
 * The union of what a clip row and a picture row carried, which is smaller than
 * it sounds: they differed by exactly `durationSec`/`sha256Prefix` (a clip) and
 * `animated` (a picture). Both are always present and both have a meaningless
 * value for the other kind, because a row with optional fields is a row every
 * reader has to branch on.
 */
export interface MediaRecord {
  id: string;
  kind: MediaKind;
  name: string;
  mime: string;
  size: number;
  width: number;
  height: number;
  createdAt: number;
  lastUsedAt: number;
  /** A 320-edge WebP for both kinds now (C3). `null` when none could be made. */
  thumbBlob: Blob | null;
  /** Where the bytes came from, when they were fetched rather than uploaded. */
  sourceUrl: string | null;
  /** Pinned rows are never suggested for LRU eviction. */
  pinned: boolean;
  /** Clips only; `0` for a picture. */
  durationSec: number;
  /** Clips only. */
  sha256Prefix: string | null;
  /** Pictures only; `false` for a clip. */
  animated: boolean;
}

/** Where a kind's rows and bytes used to live, before the merge. */
const LEGACY: Record<MediaKind, { rows: string; blobs: string }> = {
  clip: { rows: STORE_CLIPS, blobs: STORE_CLIP_BLOBS },
  image: { rows: STORE_IMAGES, blobs: STORE_IMAGE_BLOBS },
};

export const MEDIA_KINDS: readonly MediaKind[] = ['clip', 'image'];

/**
 * The two localStorage keys the module stores mirror their half of the shelf to.
 *
 * They are named HERE, in the file that owns the library, for two reasons.
 *
 * **They are a signal, not a source of truth.** They used to be both: the
 * display built the wire packet out of `readClipIndex()` + `readImageIndex()`
 * while CAM's grid built its own out of the merged store, so two readers read
 * two different things and nothing reconciled them — a row that reached
 * IndexedDB while a mirror write failed (`writeRaw` degrades to memory, and an
 * in-memory mirror in one window's JS context is invisible to the other's) was a
 * row the phone could never see, permanently, with no repair path.
 * `publishLibrary` reads `listMedia()` now. What the mirrors still do is the one
 * thing IndexedDB cannot: a `localStorage` write fires a `storage` event in every
 * OTHER document on the origin, which is how CAM's configuration window and the
 * hidden display window learn that the one library changed without polling it.
 *
 * **The display has to know their names.** It listens for exactly these two keys
 * and re-reads the store; it may not import a module to find that out (the LCD's
 * chunk graph, I8), and `platform` may not import a module either (I6). So the
 * names live in platform and the two module stores import them.
 */
export const CLIP_INDEX_SUFFIX = 'video:clipIndex';
export const IMAGE_INDEX_SUFFIX = 'image:index';

/** Both of them, for the one listener that watches the pair. */
export const MEDIA_MIRROR_SUFFIXES: readonly string[] = [CLIP_INDEX_SUFFIX, IMAGE_INDEX_SUFFIX];

// ---------------------------------------------------------------------------
// Pure — the parts worth testing without a database
// ---------------------------------------------------------------------------

/**
 * Newest first, ties broken by id so the order is TOTAL.
 *
 * The same comparator the wire packet trims with (`lib/libraryPacket`), which is
 * the "one order" half of one library: two rows written in the same millisecond
 * must not be able to swap places between the window that owns them and the
 * window that is looking at them from the sofa.
 */
export function newestFirst(
  a: { createdAt: number; id: string },
  b: { createdAt: number; id: string },
): number {
  return b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function str(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * A row as one of the two old stores wrote it → a merged row.
 *
 * One mapper for both kinds, because both old shapes are subsets of the merged
 * one: a clip supplies `durationSec`/`sha256Prefix`/`thumbBlob` and no
 * `animated`; a picture supplies `animated` and none of the other three. The
 * defaults are the merged row's "not this kind" values, so a migrated row is
 * indistinguishable from a freshly written one.
 *
 * `null` for a row with no id: it is not addressable, so it cannot be copied,
 * read back, played or deleted — and a half-read row on a shelf is worse than a
 * missing one.
 */
export function legacyToMedia(row: Record<string, unknown>, kind: MediaKind): MediaRecord | null {
  const id = str(row, 'id');
  if (id === null) return null;
  const thumb = row['thumbBlob'];
  return {
    id,
    kind,
    name: str(row, 'name') ?? id,
    mime: str(row, 'mime') ?? '',
    size: num(row, 'size'),
    width: num(row, 'width'),
    height: num(row, 'height'),
    createdAt: num(row, 'createdAt'),
    lastUsedAt: num(row, 'lastUsedAt'),
    thumbBlob: thumb instanceof Blob ? thumb : null,
    sourceUrl: str(row, 'sourceUrl'),
    pinned: row['pinned'] === true,
    durationSec: num(row, 'durationSec'),
    sha256Prefix: str(row, 'sha256Prefix'),
    animated: row['animated'] === true,
  };
}

/**
 * The merged shelf: everything in `media`, plus every legacy row that has not
 * been copied yet, newest first.
 *
 * `media` wins on a collision rather than the legacy row, and that is the whole
 * of the correctness argument for "copy, don't move": once a row is in `media`
 * it is the row, and a pin or a rename written after the copy can never be
 * shadowed by the stale original sitting in `clips`.
 */
export function mergeWithLegacy(
  media: readonly MediaRecord[],
  legacy: readonly MediaRecord[],
): MediaRecord[] {
  const have = new Set(media.map((row) => row.id));
  return [...media, ...legacy.filter((row) => !have.has(row.id))].sort(newestFirst);
}

/**
 * Which legacy rows still need copying. Idempotence and restartability are the
 * same property here, and it is this function.
 */
export function planCopy(copiedIds: ReadonlySet<string>, legacyIds: readonly string[]): string[] {
  return legacyIds.filter((id) => !copiedIds.has(id));
}

// ---------------------------------------------------------------------------
// The database
// ---------------------------------------------------------------------------

/**
 * A store this database may not have.
 *
 * Not defensiveness for its own sake: a page can be open across an upgrade, and
 * a test (or a fork) can create the database itself with only the stores it
 * cares about. A missing store must degrade to "nothing here", never to a
 * `NotFoundError` that takes the whole shelf down.
 */
function has(db: IDBDatabase, store: string): boolean {
  return db.objectStoreNames.contains(store);
}

async function readAll(db: IDBDatabase, store: string): Promise<Record<string, unknown>[]> {
  if (!has(db, store)) return [];
  const tx = db.transaction(store, 'readonly');
  const rows = await idbRequest(
    tx.objectStore(store).getAll() as IDBRequest<Record<string, unknown>[]>,
  );
  return rows;
}

async function legacyRows(db: IDBDatabase, kind: MediaKind): Promise<MediaRecord[]> {
  const raw = await readAll(db, LEGACY[kind].rows);
  return raw
    .map((row) => legacyToMedia(row, kind))
    .filter((row): row is MediaRecord => row !== null);
}

async function mediaRows(db: IDBDatabase): Promise<MediaRecord[]> {
  const raw = await readAll(db, STORE_MEDIA);
  // The rows in `media` were written by `putMedia`, so they are already the
  // merged shape; the id check is only there so a hand-seeded or forked row
  // without one cannot become a tile nothing can address.
  return raw.filter((row) => typeof row['id'] === 'string') as unknown as MediaRecord[];
}

// ---------------------------------------------------------------------------
// The copy (C2)
// ---------------------------------------------------------------------------

let migration: Promise<number> | null = null;

/**
 * Copy one legacy row and its bytes into the merged store, in ONE transaction.
 *
 * Both stores are read in a single `readonly` transaction and both writes go in
 * a single `readwrite` one, so a row can never land in `media` without its bytes
 * landing in `mediaBlobs` — the same discipline `putClip` has always had, for
 * the same reason: a metadata row with no bytes is a tile that plays nothing.
 */
async function copyOne(db: IDBDatabase, kind: MediaKind, id: string): Promise<boolean> {
  const spec = LEGACY[kind];
  const rtx = db.transaction([spec.rows, spec.blobs], 'readonly');
  const rowReq = rtx.objectStore(spec.rows).get(id) as IDBRequest<
    Record<string, unknown> | undefined
  >;
  const blobReq = rtx.objectStore(spec.blobs).get(id) as IDBRequest<
    { id: string; blob: Blob } | undefined
  >;
  const [raw, bytes] = await Promise.all([idbRequest(rowReq), idbRequest(blobReq)]);
  if (raw === undefined) return false;
  const row = legacyToMedia(raw, kind);
  if (row === null) return false;

  const wtx = db.transaction([STORE_MEDIA, STORE_MEDIA_BLOBS], 'readwrite');
  wtx.objectStore(STORE_MEDIA).put(row);
  if (bytes !== undefined) wtx.objectStore(STORE_MEDIA_BLOBS).put({ id, blob: bytes.blob });
  await idbTxDone(wtx);
  return true;
}

/**
 * Finish the copy, or start it, or discover there is nothing to do — the same
 * call in all three cases, memoised per page load.
 *
 * Never rejects. A migration that cannot run is not a reason to refuse to show
 * somebody their library: the fallback read already covers exactly that case, so
 * the failure mode of this function is "slower reads", not "no shelf".
 */
export function ensureMediaMigrated(): Promise<number> {
  migration ??= (async () => {
    let copied = 0;
    try {
      const db = await openDb();
      if (!has(db, STORE_MEDIA) || !has(db, STORE_MEDIA_BLOBS)) return 0;
      const copiedIds = new Set((await mediaRows(db)).map((row) => row.id));
      for (const kind of MEDIA_KINDS) {
        if (!has(db, LEGACY[kind].rows)) continue;
        const legacyIds = (await legacyRows(db, kind)).map((row) => row.id);
        for (const id of planCopy(copiedIds, legacyIds)) {
          if (await copyOne(db, kind, id)) {
            copiedIds.add(id);
            copied += 1;
          }
        }
      }
    } catch (err) {
      log.warn('media migration did not finish; the fallback read covers it', err);
    }
    return copied;
  })();
  return migration;
}

/** Test/diagnostics helper: forget that the copy was attempted this page load. */
export function resetMediaMigration(): void {
  migration = null;
}

// ---------------------------------------------------------------------------
// The API the two module stores are written on top of
// ---------------------------------------------------------------------------

/**
 * Metadata and bytes in a SINGLE transaction across both stores, exactly as the
 * two libraries this replaces did: if the blob write fails the whole thing
 * aborts and the library is unchanged, rather than gaining a row that plays
 * nothing.
 */
export async function putMedia(row: MediaRecord, blob: Blob): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_MEDIA, STORE_MEDIA_BLOBS], 'readwrite');
  tx.objectStore(STORE_MEDIA_BLOBS).put({ id: row.id, blob });
  tx.objectStore(STORE_MEDIA).put(row);
  await idbTxDone(tx);
}

/** The whole shelf, or one kind of it. Newest first, legacy rows included. */
export async function listMedia(kind?: MediaKind): Promise<MediaRecord[]> {
  await ensureMediaMigrated();
  const db = await openDb();
  const merged = mergeWithLegacy(
    await mediaRows(db),
    (await Promise.all(MEDIA_KINDS.map((k) => legacyRows(db, k)))).flat(),
  );
  return kind === undefined ? merged : merged.filter((row) => row.kind === kind);
}

export async function getMedia(id: string): Promise<MediaRecord | null> {
  const db = await openDb();
  if (has(db, STORE_MEDIA)) {
    const tx = db.transaction(STORE_MEDIA, 'readonly');
    const row = await idbRequest(
      tx.objectStore(STORE_MEDIA).get(id) as IDBRequest<MediaRecord | undefined>,
    );
    if (row !== undefined) return row;
  }
  for (const kind of MEDIA_KINDS) {
    const store = LEGACY[kind].rows;
    if (!has(db, store)) continue;
    const tx = db.transaction(store, 'readonly');
    const raw = await idbRequest(
      tx.objectStore(store).get(id) as IDBRequest<Record<string, unknown> | undefined>,
    );
    if (raw !== undefined) return legacyToMedia(raw, kind);
  }
  return null;
}

export async function getMediaBlob(id: string): Promise<Blob | null> {
  const db = await openDb();
  for (const store of [STORE_MEDIA_BLOBS, STORE_CLIP_BLOBS, STORE_IMAGE_BLOBS]) {
    if (!has(db, store)) continue;
    const tx = db.transaction(store, 'readonly');
    const row = await idbRequest(
      tx.objectStore(store).get(id) as IDBRequest<{ id: string; blob: Blob } | undefined>,
    );
    if (row !== undefined) return row.blob;
  }
  return null;
}

/**
 * Delete by id, from the merged store AND from wherever the row used to live.
 *
 * Idempotent by construction — `delete` on an absent key is a no-op — which is
 * what makes a delete safe to replay, to batch, and (in a later wave) to accept
 * from a remote that cannot see whether it already happened.
 *
 * The legacy half is not tidiness. `listMedia` falls back to the old stores, so
 * a delete that only removed the merged row would put the item straight back on
 * the shelf on the next read.
 */
export async function deleteMedia(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await openDb();
  const stores = [
    STORE_MEDIA,
    STORE_MEDIA_BLOBS,
    STORE_CLIPS,
    STORE_CLIP_BLOBS,
    STORE_IMAGES,
    STORE_IMAGE_BLOBS,
  ].filter((store) => has(db, store));
  const tx = db.transaction(stores, 'readwrite');
  for (const store of stores) {
    for (const id of ids) tx.objectStore(store).delete(id);
  }
  await idbTxDone(tx);
}

/**
 * Read-modify-write of one row into the merged store.
 *
 * A row still living in a legacy store is upserted into `media` by this call,
 * which is the copy it was going to get anyway — so pinning something on the
 * first visit after an upgrade migrates it, and the fallback read stops
 * shadowing it from that moment on.
 */
export async function patchMedia(id: string, patch: Partial<MediaRecord>): Promise<void> {
  const row = await getMedia(id);
  if (row === null) return;
  const db = await openDb();
  const tx = db.transaction(STORE_MEDIA, 'readwrite');
  tx.objectStore(STORE_MEDIA).put({ ...row, ...patch });
  await idbTxDone(tx);
}
