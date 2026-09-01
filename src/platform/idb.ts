/**
 * IndexedDB opener — the ONLY module allowed to call `indexedDB.open`
 * (invariant I5: the database name carries the `kraken-hub` namespace).
 *
 * M0 ships the opener and the object-store shape only. The clip library
 * (put/get/list/gc, ref-counted blob URLs, quota management) lands in M1 with
 * the video module; see design-videoEngine.md.
 */

import { createLogger } from '../lib/log';

const log = createLogger('platform/idb');

/** Canonical database name (plan: "Canonical conventions"). */
export const DB_NAME = 'kraken-hub.v1';
/**
 * v2 adds the video module's clip library (design-videoEngine.md §5.2);
 * v3 adds the image module's library (M3);
 * v4 adds the bytes half of the ONE media library (wave 2, C2).
 *
 * ## Why the two libraries were separate, and why they are not any more
 *
 * The v3 note argued for separate stores on one ground that still holds and one
 * that does not. The one that holds: an additive upgrade cannot half-migrate a
 * library, because nothing is read or rewritten inside `versionchange`. The one
 * that does not: "the two record types share almost nothing". They share
 * everything a *shelf* is made of — an id, a name, a size, a creation time, a
 * pin, a source URL and a thumbnail — and the fields that differ (a duration, an
 * animation flag) are exactly the kind of difference a `kind` property is for.
 * Keeping them apart meant a picture and a clip were one shelf only in the view
 * layer, which is the whole complaint this wave answers.
 *
 * ## The merge keeps the property that made the old argument right
 *
 * `media` and `meta` were created at v1 and referenced nowhere outside this
 * file, so every install already carries an EMPTY `media` store. v4 therefore
 * adds a blob store and nothing else — no row is read, rewritten or backfilled
 * inside the `versionchange` transaction, so an interrupted upgrade still cannot
 * leave a library half-migrated. The copy out of `clips`/`images` happens
 * afterwards, in an ordinary `readwrite` transaction, one row at a time,
 * idempotently (see `mediaStore.ts`): an interruption means "not finished yet".
 *
 * The old stores are still written to nothing and still read as a FALLBACK, and
 * they are dropped in a later release — overlap costs a duplicate library on
 * disk and buys a rollback.
 */
export const DB_VERSION = 4;

/**
 * The one media library: clips and pictures, `kind` as a property (C2).
 *
 * Its `byCreated`/`bySha` indexes date from v1 and are not used — the shelf is
 * sorted in memory by one comparator shared with the wire packet, and `bySha`
 * indexes a `sha256` key the merged row does not carry. They are left exactly as
 * they are rather than dropped: recreating an index is a `versionchange` write
 * on a store that now holds the user's whole library, which is the one thing
 * this migration is designed never to do.
 */
export const STORE_MEDIA = 'media';
/** The bytes half of the merged library (v4). Blobs NEVER enter localStorage (I6). */
export const STORE_MEDIA_BLOBS = 'mediaBlobs';
/** Small key/value bag: persist grant, last GC timestamp, db creation time. */
export const STORE_META = 'meta';

/**
 * The video clip library as it was written up to v3 (§5.2) — **legacy, read-only
 * except for deletes**.
 *
 * New rows go to `media`/`mediaBlobs`. These two are still read as a fallback
 * for a library that has not finished copying, and a delete still removes the
 * legacy row so a deleted clip cannot come back through that fallback. They are
 * dropped in a later release, not this one.
 */
export const STORE_CLIPS = 'clips';
export const STORE_CLIP_BLOBS = 'clipBlobs';
/** Module scratch: `persistGranted`, `lastQuotaCheck`. */
export const STORE_KV = 'kv';

/** The image library as it was written up to v3 (M3) — legacy, exactly like `clips`. */
export const STORE_IMAGES = 'images';
export const STORE_IMAGE_BLOBS = 'imageBlobs';

let handle: Promise<IDBDatabase> | null = null;

function upgrade(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(STORE_MEDIA)) {
    const media = db.createObjectStore(STORE_MEDIA, { keyPath: 'id' });
    media.createIndex('byCreated', 'createdAt');
    media.createIndex('bySha', 'sha256');
  }
  if (!db.objectStoreNames.contains(STORE_META)) {
    db.createObjectStore(STORE_META, { keyPath: 'key' });
  }
  if (!db.objectStoreNames.contains(STORE_CLIPS)) {
    const clips = db.createObjectStore(STORE_CLIPS, { keyPath: 'id' });
    clips.createIndex('by-createdAt', 'createdAt');
    clips.createIndex('by-lastUsedAt', 'lastUsedAt');
  }
  if (!db.objectStoreNames.contains(STORE_CLIP_BLOBS)) {
    db.createObjectStore(STORE_CLIP_BLOBS, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(STORE_KV)) {
    db.createObjectStore(STORE_KV, { keyPath: 'k' });
  }
  if (!db.objectStoreNames.contains(STORE_IMAGES)) {
    const images = db.createObjectStore(STORE_IMAGES, { keyPath: 'id' });
    images.createIndex('by-createdAt', 'createdAt');
    images.createIndex('by-lastUsedAt', 'lastUsedAt');
  }
  if (!db.objectStoreNames.contains(STORE_IMAGE_BLOBS)) {
    db.createObjectStore(STORE_IMAGE_BLOBS, { keyPath: 'id' });
  }
  // v4, and the whole of the schema half of C2: a store creation, nothing read.
  if (!db.objectStoreNames.contains(STORE_MEDIA_BLOBS)) {
    db.createObjectStore(STORE_MEDIA_BLOBS, { keyPath: 'id' });
  }
}

/**
 * `navigator.storage.persist()`. Chromium only grants it from a user gesture or
 * an engaged origin, so a `false` here is normal and merely means clips are
 * evictable under disk pressure. Never throws.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (!('storage' in navigator)) return false;
  try {
    return await navigator.storage.persist();
  } catch (err) {
    log.warn('persist() failed', err);
    return false;
  }
}

/** Opens (and memoises) the namespaced database. Rejects if IndexedDB is blocked. */
export function openDb(): Promise<IDBDatabase> {
  handle ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      upgrade(req.result);
    };
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      log.error('open failed', req.error);
      reject(req.error ?? new Error('indexedDB.open failed'));
    };
    req.onblocked = () => {
      log.warn('open blocked by another tab holding an older version');
    };
  });
  return handle;
}

/** Test/diagnostics helper: forget the memoised handle. */
export function resetDbHandle(): void {
  handle = null;
}

/**
 * The two promise adapters every store in the app was writing out for itself.
 *
 * They lived, byte for byte identical, in `clipStore.ts`, in `imageStore.ts` and
 * then very nearly in `mediaStore.ts` — three copies of the only two shapes
 * IndexedDB has. They belong next to the opener.
 */
export function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('IndexedDB request failed'));
    };
  });
}

export function idbTxDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('IndexedDB transaction failed'));
    };
  });
}

export interface StorageEstimate2 {
  usageBytes: number | null;
  quotaBytes: number | null;
  persisted: boolean | null;
}

/** `navigator.storage` probe used by the diagnostics report. Never throws. */
export async function probeStorageEstimate(): Promise<StorageEstimate2> {
  const out: StorageEstimate2 = { usageBytes: null, quotaBytes: null, persisted: null };
  if (!('storage' in navigator)) return out;
  const storage = navigator.storage;
  try {
    const est = await storage.estimate();
    out.usageBytes = est.usage ?? null;
    out.quotaBytes = est.quota ?? null;
  } catch (err) {
    log.warn('estimate() failed', err);
  }
  try {
    out.persisted = await storage.persisted();
  } catch (err) {
    log.warn('persisted() failed', err);
  }
  return out;
}
