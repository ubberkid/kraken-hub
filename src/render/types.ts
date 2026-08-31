/**
 * Geometry primitives shared by every module that puts a rectangular source on
 * the panel.
 *
 * These lived in `src/modules/video/types.ts` until M3. The image module needs
 * exactly the same fit/zoom/pan math, and a module may not import another
 * module's internals (invariant I6) — nor would we want it to: a group in
 * `vite.config.ts` claims its matched modules *and their dependencies*, so
 * importing the video module's math would have made the LCD download the whole
 * video player in order to show a JPEG.
 *
 * `src/modules/video/types.ts` re-exports these under their old names, so
 * nothing in the video engine had to change.
 */

/** A rectangle in a surface's own coordinate space, CSS px. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;
/** Normalized pan within the available slack: [-0.5, 0.5]. */
export const PAN_LIMIT = 0.5;
