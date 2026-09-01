/**
 * The picture half of the ONE media library, on the canonical IndexedDB
 * database `kraken-hub.v1`.
 *
 * ## What changed in wave 2 (C2)
 *
 * There is no separate picture library any more. `platform/mediaStore` holds
 * clips and pictures in one store with `kind` as a property, and this file is
 * the image module's view of it — the same functions with the same names, so a
 * picture is *the same kind of thing* as a clip everywhere above this line.
 * That is fork 3 made true underneath: kind is a property, not a place.
 *
 * The v3 note said the two record types "share almost nothing beyond an id and a
 * blob". They share everything a shelf is made of; what they do not share is one
 * field each, which is what a `kind` is for. The old `images`/`imageBlobs`
 * stores are still read as a fallback while the copy finishes, and are dropped
 * in a later release.
 *
 * Like the clip library, this is not a cache of a remote thing: under the
 * download-first flow it IS the source of truth, and a stored image must
 * survive a reload with the network switched off.
 */

import { createLogger } from '../../lib/log';
import {
  IMAGE_INDEX_SUFFIX,
  deleteMedia,
  getMedia,
  getMediaBlob,
  listMedia,
  patchMedia,
  putMedia,
  type MediaRecord,
} from '../../platform/mediaStore';
import { writeRaw } from '../../platform/storage';

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
  /**
   * A 320-edge WebP, made once at ingest — C3, and the same field a clip has
   * carried since M1.
   *
   * A picture IS its own thumbnail, which is why there was never one: the tile
   * read the full blob back. That is fine in CAM's configuration window and is
   * not fine anywhere the shelf gets long — decoding forty full-size pictures to
   * draw forty 160 px squares is real work, and on the DISPLAY page it is real
   * work on the thread that has to hit a frame budget. It is made once, when the
   * bytes arrive, rather than forty times whenever somebody opens a shelf.
   *
   * `null` for a picture stored before C3, and for one whose frame the encoder
   * refused; the tile falls back to the full blob exactly as it used to.
   */
  thumbBlob: Blob | null;
}

/**
 * What the config UI and the remote page see. No blobs, no bytes.
 *
 * Trimmed to match `ClipSummary` in wave 1 (B1), for the same reason and to the
 * same shape: pictures now travel on the wire alongside clips (B2), so both
 * kinds share one 40-item budget in one 8 KB envelope and every field is paid
 * for forty times. `animated` survives because the tile's detail line renders
 * it; `mime`, `width` and `height` do not, and nothing rendered them.
 */
export interface ImageSummary {
  id: string;
  name: string;
  size: number;
  animated: boolean;
  pinned: boolean;
  createdAt: number;
  /** Where the bytes came from, when they were fetched. Absent when unknown. */
  sourceUrl?: string;
}

const IMAGE_INDEX_MAX = 60;

/** This module's row ↔ the merged one. Total and lossless in both directions. */
function toMedia(row: ImageRecord): MediaRecord {
  return { ...row, kind: 'image', durationSec: 0, sha256Prefix: null };
}

function fromMedia(row: MediaRecord): ImageRecord {
  return {
    id: row.id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    width: row.width,
    height: row.height,
    animated: row.animated,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    sourceUrl: row.sourceUrl,
    pinned: row.pinned,
    thumbBlob: row.thumbBlob,
  };
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
    animated: row.animated,
    pinned: row.pinned,
    createdAt: row.createdAt,
    ...(row.sourceUrl === null || row.sourceUrl === '' ? {} : { sourceUrl: row.sourceUrl }),
  };
}

export async function putImage(row: ImageRecord, blob: Blob): Promise<void> {
  await putMedia(toMedia(row), blob);
  await publishImageIndex();
}

/** Newest first — the same order the shelf, the wire packet and the slideshow use. */
export async function listImages(): Promise<ImageRecord[]> {
  return (await listMedia('image')).map(fromMedia);
}

export async function getImage(id: string): Promise<ImageRecord | null> {
  const row = await getMedia(id);
  return row?.kind === 'image' ? fromMedia(row) : null;
}

export async function getImageBlob(id: string): Promise<Blob | null> {
  return getMediaBlob(id);
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
  await deleteMedia([id]);
  await publishImageIndex();
}

export async function setImagePinned(id: string, pinned: boolean): Promise<void> {
  await patchMedia(id, { pinned });
  await publishImageIndex();
}

/** Rename one row. The picture half of `clipStore.renameClip`. */
export async function renameImage(id: string, name: string): Promise<void> {
  await patchMedia(id, { name });
  await publishImageIndex();
}

/**
 * Backfills a thumbnail onto a picture stored before C3 — the mirror of
 * `setClipThumb`, and for the same reason: the work happens once per picture
 * rather than once per visit. Deliberately does NOT republish the index, which
 * carries no thumbnail.
 */
export async function setImageThumb(id: string, thumbBlob: Blob): Promise<void> {
  await patchMedia(id, { thumbBlob });
}

/** LRU input. Fire-and-forget: never block a mount on a write. */
export async function touchImage(id: string): Promise<void> {
  await patchMedia(id, { lastUsedAt: Date.now() });
}

/**
 * Mirrors this half of the shelf to localStorage — as a NOTIFICATION.
 *
 * The clip half's counterpart, and the docstring on `publishClipIndex` is the
 * argument. The one difference is what used to make this the more dangerous of
 * the two: `writeRaw` degrades to an in-memory map when localStorage refuses,
 * and an in-memory mirror in one window's JS context is invisible to every other
 * window — so while this file WAS a source of truth for the wire, a failed write
 * here meant a picture that reached IndexedDB and never reached the phone, for
 * good, with no repair path. Nothing reads it back any more; a failed write now
 * costs one missed notification, and the next one repairs it.
 */
export async function publishImageIndex(): Promise<ImageSummary[]> {
  const rows = await listImages();
  const index = rows.slice(0, IMAGE_INDEX_MAX).map(toImageSummary);
  if (!writeRaw(IMAGE_INDEX_SUFFIX, JSON.stringify(index))) {
    log.warn('image index could only be kept in memory');
  }
  return index;
}
