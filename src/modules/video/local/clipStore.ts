/**
 * The clip library (design-videoEngine.md §5.2), on the canonical IndexedDB
 * database `kraken-hub.v1`.
 *
 * Metadata (`clips`) and bytes (`clipBlobs`) are separate stores so listing the
 * library never loads a single video byte, and both are written in ONE
 * `readwrite` transaction so a metadata row can never exist without its bytes.
 *
 * The library is not a cache of a remote thing — under the download-first flow
 * it IS the source of truth for playback, and a clip must survive a reload with
 * the network switched off.
 */

import { createLogger } from '../../../lib/log';
import {
  STORE_CLIPS,
  STORE_CLIP_BLOBS,
  STORE_KV,
  openDb,
  requestPersistentStorage,
} from '../../../platform/idb';
import { readRaw, writeRaw } from '../../../platform/storage';

const log = createLogger('video/clips');

/** §5.2 — `clips` row. `thumbBlob` is a 320×320 WebP, never a data URL. */
export interface ClipRecord {
  id: string;
  name: string;
  mime: string;
  size: number;
  durationSec: number;
  width: number;
  height: number;
  createdAt: number;
  lastUsedAt: number;
  thumbBlob: Blob | null;
  sha256Prefix: string | null;
  /** Where the bytes came from, when the download manager fetched them. */
  sourceUrl: string | null;
  /** Pinned clips are never suggested for LRU eviction. */
  pinned: boolean;
}

/** What the config UI and the remote page see. No blobs, no bytes. */
export interface ClipSummary {
  id: string;
  name: string;
  durationSec: number;
  size: number;
  width: number;
  height: number;
  mime: string;
  pinned: boolean;
  createdAt: number;
}

/** Mirrored to localStorage so the config page reads the library for free. */
export const CLIP_INDEX_SUFFIX = 'video:clipIndex';
/** §5.1 — the `tele` payload budget caps the published index. */
const CLIP_INDEX_MAX = 40;

const KV_PERSIST_GRANTED = 'persistGranted';
const KV_LAST_QUOTA_CHECK = 'lastQuotaCheck';

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

/** Never the filename: two different files called `clip.mp4` must not collide. */
export function newClipId(): string {
  return globalThis.crypto.randomUUID();
}

export function toSummary(clip: ClipRecord): ClipSummary {
  return {
    id: clip.id,
    name: clip.name,
    durationSec: clip.durationSec,
    size: clip.size,
    width: clip.width,
    height: clip.height,
    mime: clip.mime,
    pinned: clip.pinned,
    createdAt: clip.createdAt,
  };
}

/**
 * §5.3 step 7 — metadata and bytes in a SINGLE transaction across both stores.
 * If the blob write fails the whole thing aborts and the library is unchanged,
 * rather than gaining a row that plays nothing.
 */
export async function putClip(clip: ClipRecord, blob: Blob): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_CLIPS, STORE_CLIP_BLOBS], 'readwrite');
  tx.objectStore(STORE_CLIP_BLOBS).put({ id: clip.id, blob });
  tx.objectStore(STORE_CLIPS).put(clip);
  await txDone(tx);
  await publishClipIndex();
}

export async function listClips(): Promise<ClipRecord[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_CLIPS, 'readonly');
  const all = await promisify(tx.objectStore(STORE_CLIPS).getAll() as IDBRequest<ClipRecord[]>);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getClip(id: string): Promise<ClipRecord | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_CLIPS, 'readonly');
  const row = await promisify(
    tx.objectStore(STORE_CLIPS).get(id) as IDBRequest<ClipRecord | undefined>,
  );
  return row ?? null;
}

export async function getClipBlob(id: string): Promise<Blob | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_CLIP_BLOBS, 'readonly');
  const row = await promisify(
    tx.objectStore(STORE_CLIP_BLOBS).get(id) as IDBRequest<{ id: string; blob: Blob } | undefined>,
  );
  return row?.blob ?? null;
}

/**
 * The reload-survival lookup: a clip already downloaded from this URL. Without
 * it, a display that reboots with the original https URL still in its config
 * would re-download the same file every time instead of playing the local copy.
 */
export async function findClipBySourceUrl(url: string): Promise<ClipRecord | null> {
  const clips = await listClips();
  return clips.find((c) => c.sourceUrl === url) ?? null;
}

export async function deleteClip(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_CLIPS, STORE_CLIP_BLOBS], 'readwrite');
  tx.objectStore(STORE_CLIPS).delete(id);
  tx.objectStore(STORE_CLIP_BLOBS).delete(id);
  await txDone(tx);
  await publishClipIndex();
}

export async function setPinned(id: string, pinned: boolean): Promise<void> {
  const clip = await getClip(id);
  if (clip === null) return;
  const db = await openDb();
  const tx = db.transaction(STORE_CLIPS, 'readwrite');
  tx.objectStore(STORE_CLIPS).put({ ...clip, pinned });
  await txDone(tx);
  await publishClipIndex();
}

/** LRU input. Deliberately fire-and-forget: never block a mount on a write. */
export async function touchClip(id: string): Promise<void> {
  const clip = await getClip(id);
  if (clip === null) return;
  const db = await openDb();
  const tx = db.transaction(STORE_CLIPS, 'readwrite');
  tx.objectStore(STORE_CLIPS).put({ ...clip, lastUsedAt: Date.now() });
  await txDone(tx);
}

// ---------------------------------------------------------------------------
// kv scratch
// ---------------------------------------------------------------------------

export async function kvGet<T>(k: string): Promise<T | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_KV, 'readonly');
  const row = await promisify(
    tx.objectStore(STORE_KV).get(k) as IDBRequest<{ k: string; v: T } | undefined>,
  );
  return row?.v ?? null;
}

export async function kvSet(k: string, v: unknown): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_KV, 'readwrite');
  tx.objectStore(STORE_KV).put({ k, v });
  await txDone(tx);
}

// ---------------------------------------------------------------------------
// Quota + persistence (§5.3 steps 5 and 6)
// ---------------------------------------------------------------------------

export interface QuotaInfo {
  usageBytes: number;
  quotaBytes: number;
  persisted: boolean;
}

/** §5.3 step 5 — refuse a write that would take us past this share of quota. */
export const QUOTA_HEADROOM = 0.9;

export async function readQuota(): Promise<QuotaInfo> {
  const out: QuotaInfo = { usageBytes: 0, quotaBytes: 0, persisted: false };
  if (!('storage' in navigator)) return out;
  try {
    const est = await navigator.storage.estimate();
    out.usageBytes = est.usage ?? 0;
    out.quotaBytes = est.quota ?? 0;
  } catch (err) {
    log.warn('estimate() failed', err);
  }
  try {
    out.persisted = await navigator.storage.persisted();
  } catch {
    /* not fatal: an unknown persistence state is reported as best-effort */
  }
  void kvSet(KV_LAST_QUOTA_CHECK, Date.now());
  return out;
}

export interface QuotaVerdict {
  ok: boolean;
  quota: QuotaInfo;
  /** Human message naming both numbers in MB, ready for the panel. */
  message: string | null;
}

const BYTES_PER_MB = 1_048_576;

function mb(bytes: number): string {
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}

/** §5.3 step 5. A zero/unknown quota is treated as "go ahead" — refusing on no data helps nobody. */
export async function checkQuotaFor(sizeBytes: number): Promise<QuotaVerdict> {
  const quota = await readQuota();
  if (quota.quotaBytes <= 0) return { ok: true, quota, message: null };
  const projected = quota.usageBytes + sizeBytes;
  if (projected <= quota.quotaBytes * QUOTA_HEADROOM) return { ok: true, quota, message: null };
  return {
    ok: false,
    quota,
    message: `Not enough room: this clip is ${mb(sizeBytes)} and the library already uses ${mb(
      quota.usageBytes,
    )} of ${mb(quota.quotaBytes)}. Delete a clip and try again.`,
  };
}

/**
 * §5.3 step 6 — ask for persistent storage on the first successful add, and
 * keep asking on later adds until it is granted. `false` is not a failure: it
 * means clips are evictable under disk pressure, which the panel says plainly.
 */
export async function ensurePersisted(): Promise<boolean> {
  const already = await kvGet<boolean>(KV_PERSIST_GRANTED);
  if (already === true) return true;
  const granted = await requestPersistentStorage();
  await kvSet(KV_PERSIST_GRANTED, granted);
  return granted;
}

// ---------------------------------------------------------------------------
// Clip index (§5.3 step 8)
// ---------------------------------------------------------------------------

/**
 * Publishes the library through localStorage. The CAM Configuration Browser
 * shares this origin, so the panel gets the index for free via the `storage`
 * event, with zero network — the most reliable channel we have.
 */
export async function publishClipIndex(): Promise<ClipSummary[]> {
  const clips = await listClips();
  const index = clips.slice(0, CLIP_INDEX_MAX).map(toSummary);
  writeRaw(CLIP_INDEX_SUFFIX, JSON.stringify(index));
  return index;
}

/** Synchronous read of the published index; `[]` when nothing was published. */
export function readClipIndex(): ClipSummary[] {
  const raw = readRaw(CLIP_INDEX_SUFFIX);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ClipSummary[]) : [];
  } catch {
    return [];
  }
}
