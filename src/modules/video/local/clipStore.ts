/**
 * The clip half of the ONE media library (design-videoEngine.md §5.2), on the
 * canonical IndexedDB database `kraken-hub.v1`.
 *
 * ## What changed in wave 2 (C2)
 *
 * The rows no longer live in a store of their own. `platform/mediaStore` holds
 * clips and pictures together with `kind` as a property, and this file is the
 * video module's view of it: `ClipRecord` in, `ClipRecord` out, the same
 * functions with the same names, so nothing above it had to learn about the
 * merge. The old `clips`/`clipBlobs` stores are still read as a fallback while
 * the copy finishes, and are dropped in a later release.
 *
 * Metadata and bytes are still separate stores so listing the library never
 * loads a single video byte, and are still written in ONE `readwrite`
 * transaction so a metadata row can never exist without its bytes.
 *
 * The library is not a cache of a remote thing — under the download-first flow
 * it IS the source of truth for playback, and a clip must survive a reload with
 * the network switched off.
 */

import { createLogger } from '../../../lib/log';
import {
  STORE_KV,
  idbRequest,
  idbTxDone,
  openDb,
  requestPersistentStorage,
} from '../../../platform/idb';
import {
  CLIP_INDEX_SUFFIX,
  deleteMedia,
  getMedia,
  getMediaBlob,
  listMedia,
  patchMedia,
  putMedia,
  type MediaRecord,
} from '../../../platform/mediaStore';
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

/**
 * What the config UI and the remote page see. No blobs, no bytes.
 *
 * **Every field here is paid for forty times over an 8 KB envelope**, so the row
 * carries what a tile actually renders and nothing else. `mime`, `width` and
 * `height` were dropped in wave 1 (B1): the tile's detail line has not rendered
 * pixel dimensions since round 2's R7 — `640×640` on every tile changed nothing
 * a person could do from a shelf — and nothing ever rendered the MIME type at
 * all. That is ~90 bytes a row, which is the difference between 40 clips
 * arriving and the whole packet being dropped with a `log.warn`. The stored
 * `ClipRecord` keeps all three for the diagnostics that genuinely need them.
 *
 * `sourceUrl` is the one field that was ADDED, and it earns its bytes: it is how
 * a phone draws a YouTube poster for a tile without anybody shipping a
 * thumbnail over the radio — the still already has a public URL and the phone
 * already has internet (A4). Omitted entirely when there is nothing to say.
 */
export interface ClipSummary {
  id: string;
  name: string;
  durationSec: number;
  size: number;
  pinned: boolean;
  createdAt: number;
  /** Where the bytes came from, when they were fetched. Absent when unknown. */
  sourceUrl?: string;
}

/** §5.1 — the `tele` payload budget caps the published index. */
const CLIP_INDEX_MAX = 40;

const KV_PERSIST_GRANTED = 'persistGranted';
const KV_LAST_QUOTA_CHECK = 'lastQuotaCheck';

/**
 * The two conversions between this module's row and the merged one.
 *
 * They are total and lossless in both directions: `MediaRecord` minus `kind` and
 * `animated` IS `ClipRecord`, which is why the merge needed no schema surgery
 * and why a clip written before it reads back identical afterwards.
 */
function toMedia(clip: ClipRecord): MediaRecord {
  return { ...clip, kind: 'clip', animated: false };
}

function fromMedia(row: MediaRecord): ClipRecord {
  return {
    id: row.id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    durationSec: row.durationSec,
    width: row.width,
    height: row.height,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    thumbBlob: row.thumbBlob,
    sha256Prefix: row.sha256Prefix,
    sourceUrl: row.sourceUrl,
    pinned: row.pinned,
  };
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
    pinned: clip.pinned,
    createdAt: clip.createdAt,
    // Spread rather than `sourceUrl: clip.sourceUrl`: an explicit `undefined`
    // still costs `"sourceUrl":null` once this is stringified for the wire.
    ...(clip.sourceUrl === null || clip.sourceUrl === '' ? {} : { sourceUrl: clip.sourceUrl }),
  };
}

/**
 * §5.3 step 7 — metadata and bytes in a SINGLE transaction across both stores.
 * If the blob write fails the whole thing aborts and the library is unchanged,
 * rather than gaining a row that plays nothing.
 */
export async function putClip(clip: ClipRecord, blob: Blob): Promise<void> {
  await putMedia(toMedia(clip), blob);
  await publishClipIndex();
}

/** Newest first, and the order is the library's — see `mediaStore.newestFirst`. */
export async function listClips(): Promise<ClipRecord[]> {
  return (await listMedia('clip')).map(fromMedia);
}

export async function getClip(id: string): Promise<ClipRecord | null> {
  const row = await getMedia(id);
  return row?.kind === 'clip' ? fromMedia(row) : null;
}

export async function getClipBlob(id: string): Promise<Blob | null> {
  return getMediaBlob(id);
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

/** Idempotent by id, and it takes a batch — see `mediaStore.deleteMedia`. */
export async function deleteClip(id: string): Promise<void> {
  await deleteMedia([id]);
  await publishClipIndex();
}

export async function setPinned(id: string, pinned: boolean): Promise<void> {
  await patchMedia(id, { pinned });
  await publishClipIndex();
}

/**
 * Rename one row.
 *
 * The name is the ONLY thing on a tile a person chose, and until wave 3 it was
 * whatever the file was called when it arrived — which for a downloaded clip is
 * frequently a hash. It is a `patchMedia` like any other, and it republishes the
 * index because the name is exactly what the index is for.
 */
export async function renameClip(id: string, name: string): Promise<void> {
  await patchMedia(id, { name });
  await publishClipIndex();
}

/**
 * Backfills a thumbnail onto a clip that was stored without one.
 *
 * Two paths produce a `thumbBlob: null` row: a file added through "Add anyway"
 * after the metadata probe timed out, and a download whose bytes landed before
 * the thumbnail step could draw a frame. Round 2's R7 is that those tiles were
 * then a grey rectangle **for good** — the library's whole job is to let you
 * recognise something at a glance, and half its rows had nothing to recognise.
 *
 * The Library page generates the missing frame the first time it draws such a
 * tile and calls this, so the work happens once per clip rather than once per
 * visit. Deliberately does NOT republish the clip index: the index carries no
 * thumbnail, so nothing downstream changes and a republish would be a
 * localStorage write and a `storage` event per backfilled tile.
 */
export async function setClipThumb(id: string, thumbBlob: Blob): Promise<void> {
  await patchMedia(id, { thumbBlob });
}

/** LRU input. Deliberately fire-and-forget: never block a mount on a write. */
export async function touchClip(id: string): Promise<void> {
  await patchMedia(id, { lastUsedAt: Date.now() });
}

// ---------------------------------------------------------------------------
// kv scratch
// ---------------------------------------------------------------------------

export async function kvGet<T>(k: string): Promise<T | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_KV, 'readonly');
  const row = await idbRequest(
    tx.objectStore(STORE_KV).get(k) as IDBRequest<{ k: string; v: T } | undefined>,
  );
  return row?.v ?? null;
}

export async function kvSet(k: string, v: unknown): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_KV, 'readwrite');
  tx.objectStore(STORE_KV).put({ k, v });
  await idbTxDone(tx);
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
 * Mirrors this half of the shelf to localStorage — as a NOTIFICATION.
 *
 * Every window on this origin shares the storage partition, so the write fires a
 * `storage` event in every other document: CAM's configuration window refreshes
 * its grid on it, and the display re-reads the store and re-announces the shelf
 * on it (`app/display/sync.ts`). That is the whole job now. It is no longer a
 * second copy of the library anybody builds a wire packet out of — the display
 * reads `listMedia()` — because a mirror and a store that can disagree are two
 * libraries with extra steps, which is the thing this arc exists to remove.
 * `HomeView` still reads it for a cheap synchronous name lookup.
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
