/**
 * A picture that arrives as BYTES rather than as a link.
 *
 * `download.ts` has always been able to fetch a URL and store the result; until
 * a phone could hand the display a file over the LAN there was nothing that
 * arrived any other way, so the store-it half lived inside the fetch-it half.
 * This is that half, lifted out and given a front door — the image module's
 * counterpart to `video/local/ingest.ts`, doing the same three things in the
 * same order for the same reasons:
 *
 *   probe → thumbnail → quota → single-transaction write
 *
 * It exists so there is exactly ONE way a picture becomes a library row. A
 * second write path is how two libraries start, and this arc is about not having
 * two of anything.
 *
 * Never throws: failures come back as data, because the caller is a data channel
 * on another device and the only useful thing it can do with a problem is say
 * what it was.
 */

import { BYTES_PER_MB } from '../../lib/bytes';
import { createLogger } from '../../lib/log';
import { ensurePersisted } from '../../platform/idb';

import { probeImage } from './download';
import { newImageId, putImage, type ImageRecord } from './imageStore';
import { makeImageThumbnail } from './thumbnail';

const log = createLogger('image/ingest');

const MAX_IMAGE_MB = 64;
/** A picture larger than this is almost certainly not a picture. Mirrors `download.ts`. */
const MAX_IMAGE_BYTES = MAX_IMAGE_MB * BYTES_PER_MB;
/** Refuse a write that would take the origin past this share of its quota. */
const QUOTA_HEADROOM = 0.9;

const ANIMATED_MIME_RE = /^image\/(?:gif|apng)$/i;
const IMAGE_MIME_RE = /^image\//i;

export type ImageIngestFailure = 'not-an-image' | 'too-large' | 'quota';

export interface ImageIngestResult {
  ok: boolean;
  record: ImageRecord | null;
  failure: ImageIngestFailure | null;
  message: string | null;
}

/**
 * Whether the browser will animate this on its own inside an `<img>`.
 *
 * Conservative on purpose, exactly as `download.ts` is: GIF and APNG always do,
 * an animated WebP may, and the only cheap way to know is to sniff the bytes.
 * The flag exists to warn about capture frame rate, so being wrong in the "call
 * it static" direction costs a missing note and nothing else.
 */
function isAnimated(mime: string, name: string): boolean {
  return ANIMATED_MIME_RE.test(mime) || /\.(?:gif|apng)(?:$|[?#])/i.test(name);
}

async function quotaAllows(sizeBytes: number): Promise<boolean> {
  if (!('storage' in navigator)) return true;
  try {
    const est = await navigator.storage.estimate();
    const quota = est.quota ?? 0;
    if (quota <= 0) return true;
    return (est.usage ?? 0) + sizeBytes <= quota * QUOTA_HEADROOM;
  } catch {
    // No data is not a reason to refuse — refusing on no data helps nobody.
    return true;
  }
}

/** The one function every byte-first picture path ends in. */
export async function ingestImageBlob(blob: Blob, name: string): Promise<ImageIngestResult> {
  /*
   * A picture is an add, so a picture asks too.
   *
   * The request used to live only in the clip path, which meant a library made
   * entirely of pictures had never once asked for the durability the shelf
   * reports on. Fired first and not awaited, for the reason `video/local/ingest`
   * spells out: everything below this line is time spent after the press.
   */
  void ensurePersisted().catch(() => false);

  const mime = blob.type;
  if (mime.length > 0 && !IMAGE_MIME_RE.test(mime)) {
    return {
      ok: false,
      record: null,
      failure: 'not-an-image',
      message: `That file is ${mime}, not an image.`,
    };
  }
  if (blob.size > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      record: null,
      failure: 'too-large',
      message: 'That file is too large to keep.',
    };
  }
  if (!(await quotaAllows(blob.size))) {
    return {
      ok: false,
      record: null,
      failure: 'quota',
      message: 'Not enough room in your library. Delete something and try again.',
    };
  }

  const { width, height } = await probeImage(blob);
  const thumbBlob = await makeImageThumbnail(blob);
  const now = Date.now();
  const record: ImageRecord = {
    id: newImageId(),
    name,
    mime: mime.length > 0 ? mime : 'image/*',
    size: blob.size,
    width,
    height,
    animated: isAnimated(mime, name),
    createdAt: now,
    lastUsedAt: now,
    // Bytes handed over directly have no source URL, and inventing one would put
    // a link on a tile that leads nowhere.
    sourceUrl: null,
    pinned: false,
    thumbBlob,
  };

  try {
    await putImage(record, blob);
  } catch (err) {
    log.warn('a picture could not be written', err);
    return {
      ok: false,
      record: null,
      failure: 'quota',
      message: 'That picture could not be written to your library.',
    };
  }
  return { ok: true, record, failure: null, message: null };
}
