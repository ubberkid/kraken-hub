/**
 * The image library, on the canonical IndexedDB database `kraken-hub.v1`.
 *
 * Deliberately the same shape as the video module's clip library
 * (`src/modules/video/local/clipStore.ts`): metadata in `images`, bytes in
 * `imageBlobs`, both written in ONE `readwrite` transaction so a metadata row
 * can never exist without its bytes, and an index mirrored to localStorage so
 * the configuration browser sees the library for free.
 *
 * It is a separate pair of stores rather than a `kind` field on `clips` — see
 * the note on `DB_VERSION` in `src/platform/idb.ts` for why (an additive
 * upgrade cannot half-migrate the existing video library).
 *
 * Like the clip library, this is not a cache of a remote thing: under the
 * download-first flow it IS the source of truth, and a stored image must
 * survive a reload with the network switched off.
 */

import { createLogger } from '../../lib/log';
import { STORE_IMAGES, STORE_IMAGE_BLOBS, openDb } from '../../platform/idb';
import { readRaw, writeRaw } from '../../platform/storage';

const log = createLogger('image/store');

export interface ImageRecord {
  id: string;
  name: string;
  mime: string;
  size: number;
  width: number;
  height: number;
  /** GIF / APNG / animated WebP: rendered as `<img>` so the browser animates it. */
  animated: boolean;
  createdAt: number;
  lastUsedAt: number;
  /** Where the bytes came from, when they were fetched rather than uploaded. */
  sourceUrl: string | null;
  pinned: boolean;
}

/** What the config UI and the remote page see. No blobs, no bytes. */
export interface ImageSummary {
  id: string;
  name: string;
  size: number;
  width: number;
  height: number;
  mime: string;
  animated: boolean;
  pinned: boolean;
  createdAt: number;
}

/** Mirrored to localStorage so the config page reads the library for free. */
export const IMAGE_INDEX_SUFFIX = 'image:index';
const IMAGE_INDEX_MAX = 60;

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('IndexedDB request failed'));
    };
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
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

/** Never the filename: two different files called `wallpaper.png` must not collide. */
export function newImageId(): string {
  return globalThis.crypto.randomUUID();
}

export function toImageSummary(row: ImageRecord): ImageSummary {
  return {
    id: row.id,
    name: row.name,
    size: row.size,
    width: row.width,
    height: row.height,
    mime: row.mime,
    animated: row.animated,
    pinned: row.pinned,
    createdAt: row.createdAt,
  };
}

export async function putImage(row: ImageRecord, blob: Blob): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_IMAGES, STORE_IMAGE_BLOBS], 'readwrite');
  tx.objectStore(STORE_IMAGE_BLOBS).put({ id: row.id, blob });
  tx.objectStore(STORE_IMAGES).put(row);
  await txDone(tx);
  await publishImageIndex();
}

/** Newest first — the same order the library list and the slideshow use. */
export async function listImages(): Promise<ImageRecord[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_IMAGES, 'readonly');
  const all = await promisify(tx.objectStore(STORE_IMAGES).getAll() as IDBRequest<ImageRecord[]>);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getImage(id: string): Promise<ImageRecord | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_IMAGES, 'readonly');
  const row = await promisify(
    tx.objectStore(STORE_IMAGES).get(id) as IDBRequest<ImageRecord | undefined>,
  );
  return row ?? null;
}

export async function getImageBlob(id: string): Promise<Blob | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_IMAGE_BLOBS, 'readonly');
  const row = await promisify(
    tx.objectStore(STORE_IMAGE_BLOBS).get(id) as IDBRequest<{ id: string; blob: Blob } | undefined>,
  );
  return row?.blob ?? null;
}

/**
 * The reload-survival lookup. Without it a display that reboots with the
 * original https URL still in its config would re-download the same picture on
 * every boot instead of painting the local copy.
 */
export async function findImageBySourceUrl(url: string): Promise<ImageRecord | null> {
  const rows = await listImages();
  return rows.find((r) => r.sourceUrl === url) ?? null;
}

export async function deleteImage(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_IMAGES, STORE_IMAGE_BLOBS], 'readwrite');
  tx.objectStore(STORE_IMAGES).delete(id);
  tx.objectStore(STORE_IMAGE_BLOBS).delete(id);
  await txDone(tx);
  await publishImageIndex();
}

export async function setImagePinned(id: string, pinned: boolean): Promise<void> {
  const row = await getImage(id);
  if (row === null) return;
  const db = await openDb();
  const tx = db.transaction(STORE_IMAGES, 'readwrite');
  tx.objectStore(STORE_IMAGES).put({ ...row, pinned });
  await txDone(tx);
  await publishImageIndex();
}

/** LRU input. Fire-and-forget: never block a mount on a write. */
export async function touchImage(id: string): Promise<void> {
  const row = await getImage(id);
  if (row === null) return;
  const db = await openDb();
  const tx = db.transaction(STORE_IMAGES, 'readwrite');
  tx.objectStore(STORE_IMAGES).put({ ...row, lastUsedAt: Date.now() });
  await txDone(tx);
}

/**
 * Publishes the library through localStorage. The CAM Configuration Browser
 * shares this origin, so the panel gets the index for free via the `storage`
 * event, with zero network — the most reliable channel we have.
 */
export async function publishImageIndex(): Promise<ImageSummary[]> {
  const rows = await listImages();
  const index = rows.slice(0, IMAGE_INDEX_MAX).map(toImageSummary);
  if (!writeRaw(IMAGE_INDEX_SUFFIX, JSON.stringify(index))) {
    log.warn('image index could only be kept in memory');
  }
  return index;
}

/** Synchronous read of the published index; `[]` when nothing was published. */
export function readImageIndex(): ImageSummary[] {
  const raw = readRaw(IMAGE_INDEX_SUFFIX);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ImageSummary[]) : [];
  } catch {
    return [];
  }
}
