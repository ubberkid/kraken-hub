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
 * v3 adds the image module's library (M3).
 *
 * The image stores are SEPARATE from the clip stores rather than the clip rows
 * gaining a `kind` field. Both shapes were on the table; separate stores won
 * because the upgrade is purely additive — no existing row is read, rewritten
 * or backfilled inside the `versionchange` transaction, so an interrupted
 * upgrade cannot leave the video library half-migrated. The two record types
 * also share almost nothing beyond an id and a blob: a clip has a duration, a
 * loop and a poster frame; an image has none of those and does have an
 * animation flag. Generalising them would have meant every video query filtering
 * on `kind` forever, for one saved object store.
 */
export const DB_VERSION = 3;

/** Blob store. Blobs NEVER enter localStorage (invariant I6). */
export const STORE_MEDIA = 'media';
/** Small key/value bag: persist grant, last GC timestamp, db creation time. */
export const STORE_META = 'meta';

/**
 * Video clip library (§5.2). `clips` holds metadata only and `clipBlobs` holds
 * the bytes, split so listing the library never pulls megabytes of video into
 * memory. Both are written in ONE `readwrite` transaction so a metadata row can
 * never exist without its bytes.
 */
export const STORE_CLIPS = 'clips';
export const STORE_CLIP_BLOBS = 'clipBlobs';
/** Module scratch: `persistGranted`, `lastQuotaCheck`. */
export const STORE_KV = 'kv';

/**
 * Image module library (M3). Same metadata/bytes split as the clip library, and
 * for the same reason: listing the library must never pull megabytes of pixels
 * into memory, and both rows are written in ONE `readwrite` transaction so a
 * metadata row can never exist without its bytes.
 */
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
