/**
 * A picture's shelf thumbnail — C3, the mirror of `makeThumbnail` in the video
 * module's ingest.
 *
 * ## Why a picture needs one at all
 *
 * Because it is not free to be your own thumbnail. The tile used to read the
 * full blob back and let the browser scale it, which is a full decode of a
 * multi-megapixel image to paint a 160 px square — forty of them when the shelf
 * is full, every time the page is opened. On the DISPLAY page that decode
 * competes with the renderer's frame budget, which is the one place in this app
 * where a stutter is visible on the physical panel.
 *
 * So the thumbnail is made ONCE, when the bytes arrive, and stored beside them.
 *
 * ## Cover-cropped to a square, like a clip's
 *
 * The same 320-edge WebP the clip library has stored since M1, cropped from the
 * centre rather than letterboxed, so a mixed shelf of clips and pictures is one
 * shelf visually as well as structurally. `null` is a normal answer: an image
 * the decoder cannot draw still stores and still displays, it just falls back to
 * the treated card the rest of the app already uses.
 */

import { createLogger } from '../../lib/log';

const log = createLogger('image/thumb');

// device-size-ok: the media-library thumbnail edge, not a panel dimension.
const THUMB_PX = 320;
const THUMB_QUALITY = 0.8;
const HALF = 0.5;

/** Decode → centre-crop → 320×320 WebP. Never throws; `null` when it cannot. */
export async function makeImageThumbnail(blob: Blob): Promise<Blob | null> {
  try {
    const source = await decode(blob);
    if (source === null) return null;
    const { width, height } = source;
    if (width <= 0 || height <= 0) {
      release(source);
      return null;
    }
    const canvas = document.createElement('canvas');
    canvas.width = THUMB_PX;
    canvas.height = THUMB_PX;
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      release(source);
      return null;
    }
    const side = Math.min(width, height);
    ctx.drawImage(
      source.image,
      (width - side) * HALF,
      (height - side) * HALF,
      side,
      side,
      0,
      0,
      THUMB_PX,
      THUMB_PX,
    );
    release(source);
    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/webp', THUMB_QUALITY);
    });
  } catch (err) {
    log.debug('thumbnail failed; the treated card covers it', err);
    return null;
  }
}

interface Decoded {
  image: CanvasImageSource;
  width: number;
  height: number;
  bitmap: ImageBitmap | null;
  objectUrl: string | null;
}

/**
 * `createImageBitmap` where it exists, an `<img>` where it does not — the same
 * pair, in the same order, that `probeImage` already uses for dimensions.
 */
async function decode(blob: Blob): Promise<Decoded | null> {
  if ('createImageBitmap' in globalThis) {
    try {
      const bitmap = await createImageBitmap(blob);
      return {
        image: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        bitmap,
        objectUrl: null,
      };
    } catch (err) {
      log.debug('createImageBitmap failed; falling back to <img>', err);
    }
  }
  const objectUrl = URL.createObjectURL(blob);
  return new Promise<Decoded | null>((resolve) => {
    const el = new Image();
    el.onload = () => {
      resolve({
        image: el,
        width: el.naturalWidth,
        height: el.naturalHeight,
        bitmap: null,
        objectUrl,
      });
    };
    el.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(null);
    };
    el.src = objectUrl;
  });
}

/** A leaked object URL pins the whole picture for the life of the document. */
function release(source: Decoded): void {
  source.bitmap?.close();
  if (source.objectUrl !== null) URL.revokeObjectURL(source.objectUrl);
}
