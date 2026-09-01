/**
 * How many bytes something is, said once.
 *
 * ## Why this is a file
 *
 * Round 3 named "a class fixed on one surface and left on the others" as a
 * recurring failure, and this is the round-5 instance of it. There were five
 * definitions of `BYTES_PER_MB` in the tree and three separate byte formatters,
 * and they did not agree with each other:
 *
 *  - `libraryItems.formatBytes` — a kB branch below a megabyte, one decimal
 *    above it. The correct one, and the reason it is correct is written below.
 *  - `LibraryView.mb` — `MB_DECIMALS = 1`, but with its own prose branches and
 *    its own "over 10 MB, drop the decimal" rule.
 *  - `HomeView` — `MB_DECIMALS = 0`, which rendered every download under half a
 *    megabyte as **"0 MB"** on the home screen's own progress line. The app
 *    telling a user their file has no size, in the round about the app saying
 *    things it does not know to be true.
 *
 * So the unit constants and the one formatter live here, in `src/lib`, which
 * both the configuration UI and the display may import (invariant I6/I8).
 *
 * `1024`, not `1000`. Every number this formats is compared by the reader
 * against a browser's storage quota or a file manager's size column, and
 * Chromium reports both in binary units.
 */

export const BYTES_PER_KB = 1024;
export const BYTES_PER_MB = 1_048_576;

/** One decimal above a megabyte — enough to see a download move, not enough to read as precision. */
const MB_DECIMALS = 1;

/**
 * Kilobytes below a megabyte, megabytes above it.
 *
 * A fixed `MB` unit renders a 32 kB clip and an empty one identically as
 * "0.0 MB", which is the tile telling the user their file has no size — and at
 * `MB_DECIMALS = 0`, which is what the home screen shipped, a 400 kB download
 * counts up as "0 MB", "0 MB", "0 MB".
 *
 * Zero, negative and non-finite all render as an em dash rather than "0 kB":
 * they mean *not known*, and every one of them reaches here from a size that
 * was never reported.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < BYTES_PER_MB) return `${String(Math.round(bytes / BYTES_PER_KB))} kB`;
  return `${(bytes / BYTES_PER_MB).toFixed(MB_DECIMALS)} MB`;
}
