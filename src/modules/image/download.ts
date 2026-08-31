/**
 * Download-first ingestion for the image module.
 *
 * Same policy as the video module's download manager, and for the same reasons:
 *
 *  - **The DISPLAY page downloads.** The hidden Kraken Browser shares CAM's
 *    storage partition, so it is the only context whose IndexedDB the LCD can
 *    read back. A URL set from the phone remote must therefore be fetched by
 *    the display itself.
 *  - **A CORS refusal is not an error.** Most of the web does not send
 *    `Access-Control-Allow-Origin`, so `fetch` fails where a plain `<img src>`
 *    would have painted. That case falls back to streaming the remote URL into
 *    an `<img>` and says nothing to the user — they see their picture either
 *    way; they just do not get the offline copy.
 *
 * Simpler than the video path in one respect: there is no progress card. A
 * picture is measured in hundreds of kilobytes and arrives in one `fetch`,
 * where a video is measured in hundreds of megabytes and needs a reader loop.
 */

import { createLogger } from '../../lib/log';

import { newImageId, putImage, type ImageRecord } from './imageStore';

const log = createLogger('image/download');

const BYTES_PER_MB = 1_048_576;
const MAX_IMAGE_MB = 64;
/** A picture larger than this is almost certainly not a picture. */
const MAX_IMAGE_BYTES = MAX_IMAGE_MB * BYTES_PER_MB;
/** Refuse a write that would take the origin past this share of its quota. */
const QUOTA_HEADROOM = 0.9;
const DOWNLOAD_TIMEOUT_MS = 20_000;

export type ImageDownloadFailure = 'cors' | 'network' | 'too-large' | 'quota' | 'not-an-image';

export type ImageDownloadResult =
  | { ok: true; record: ImageRecord; blob: Blob }
  | { ok: false; reason: ImageDownloadFailure; message: string };

const ANIMATED_MIME_RE = /^image\/(?:gif|apng)$/i;
const IMAGE_MIME_RE = /^image\//i;

/**
 * GIF and APNG animate on their own inside an `<img>`; WebP and AVIF may or may
 * not, and the only cheap way to know is to sniff the bytes. We do not: the
 * flag exists to warn the user about capture FPS, and being wrong in the
 * conservative direction (calling an animated WebP static) costs nothing but a
 * missing note.
 */
function isAnimatedMime(mime: string, url: string): boolean {
  return ANIMATED_MIME_RE.test(mime) || /\.(?:gif|apng)(?:$|[?#])/i.test(url);
}

function nameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const last = path.split('/').filter(Boolean).pop();
    return last !== undefined && last.length > 0 ? decodeURIComponent(last) : 'image';
  } catch {
    return 'image';
  }
}

/** Decoded dimensions, via `createImageBitmap` with an `<img>` fallback. */
export async function probeImage(blob: Blob): Promise<{ width: number; height: number }> {
  if ('createImageBitmap' in globalThis) {
    try {
      const bitmap = await createImageBitmap(blob);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return size;
    } catch (err) {
      log.debug('createImageBitmap failed; falling back to <img>', err);
    }
  }
  return new Promise<{ width: number; height: number }>((resolve) => {
    const url = URL.createObjectURL(blob);
    const el = new Image();
    const done = (width: number, height: number): void => {
      URL.revokeObjectURL(url);
      resolve({ width, height });
    };
    el.onload = () => {
      done(el.naturalWidth, el.naturalHeight);
    };
    el.onerror = () => {
      done(0, 0);
    };
    el.src = url;
  });
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

/**
 * Fetch the bytes and store them. `signal` is the module's unmount signal, so a
 * source change can never write into a torn-down renderer's library row.
 */
export async function downloadImage(
  url: string,
  signal: AbortSignal,
): Promise<ImageDownloadResult> {
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const composed = AbortSignal.any([signal, timeout]);

  let response: Response;
  try {
    response = await fetch(url, { mode: 'cors', credentials: 'omit', signal: composed });
  } catch (err) {
    // Indistinguishable from the outside: a CORS refusal and a dead host both
    // reject with a TypeError. Both fall back to streaming, so it does not
    // matter which one this was — only the telemetry label differs.
    log.debug(`fetch failed for ${url} — falling back to streaming`, err);
    return { ok: false, reason: 'cors', message: 'The server did not allow a cross-origin fetch.' };
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: 'network',
      message: `The server answered ${String(response.status)}.`,
    };
  }

  const blob = await response.blob();
  const mime = blob.type.length > 0 ? blob.type : (response.headers.get('content-type') ?? '');
  if (mime.length > 0 && !IMAGE_MIME_RE.test(mime)) {
    return {
      ok: false,
      reason: 'not-an-image',
      message: `That link returned ${mime}, not an image.`,
    };
  }
  if (blob.size > MAX_IMAGE_BYTES) {
    return { ok: false, reason: 'too-large', message: 'That file is too large to keep.' };
  }
  if (!(await quotaAllows(blob.size))) {
    return {
      ok: false,
      reason: 'quota',
      message: 'Not enough room in the image library. Delete an image and try again.',
    };
  }

  const { width, height } = await probeImage(blob);
  const now = Date.now();
  const record: ImageRecord = {
    id: newImageId(),
    name: nameFromUrl(url),
    mime: mime.length > 0 ? mime : 'image/*',
    size: blob.size,
    width,
    height,
    animated: isAnimatedMime(mime, url),
    createdAt: now,
    lastUsedAt: now,
    sourceUrl: url,
    pinned: false,
  };

  // `putImage` publishes the index itself, in the same call.
  await putImage(record, blob);
  return { ok: true, record, blob };
}
