/**
 * Shortening a name without destroying the part that identifies it.
 *
 * ## Why the middle
 *
 * Round 6's minors, photographed on the compact halo: with the options panel
 * open the mirror shrinks to 64 px, and `demo.mp4` was set inside it with
 * `overflow-wrap: anywhere`, which is CSS for *break this word at whatever
 * character runs out of room*. The bezel read
 *
 *     dem
 *     o.mp
 *     4
 *
 * — three lines of debris where a filename should be. `overflow-wrap` is the
 * right rule for a URL and the wrong one for a name a person chose.
 *
 * The obvious fix, `text-overflow: ellipsis`, is barely better here: names in
 * this product are filenames, and a filename's two informative ends are its
 * start and its extension. `long-holiday-video-2019.mp4` truncated at the tail
 * becomes `long-holiday-vi…`, which discards the one three-character token that
 * says what the thing IS. Cutting the middle keeps both ends:
 * `long-hol…19.mp4`.
 *
 * ## Why it is a function rather than more CSS
 *
 * CSS cannot ellipsise a middle. It is done in the render, which also means the
 * budget is a number a caller picks for the box it is drawing into — the ring
 * and the full-size halo have very different amounts of room — and that the
 * rule is testable as arithmetic rather than by measuring a screenshot.
 */

/** The one character. Never "..." — three dots is three characters of budget. */
const ELLIPSIS = '…';

/**
 * `text` shortened to at most `max` characters, cut in the middle.
 *
 * The head gets the odd character when the budget is even, because a name's
 * start is read first and disambiguates more often than its tail does.
 *
 * `max` below 2 has no useful answer — there is no room for an ellipsis and a
 * character either side of it — so anything at or under 1 returns the ellipsis
 * alone rather than an empty string, which would render as a hole.
 */
export function middleEllipsis(text: string, max: number): string {
  const value = text.trim();
  // `Array.from`, not `.slice`: an emoji or an accented character outside the
  // BMP is two UTF-16 code units, and cutting between them produces a lone
  // surrogate — a replacement glyph in the middle of somebody's filename.
  const chars = Array.from(value);
  if (!Number.isFinite(max) || max < 1) return ELLIPSIS;
  if (chars.length <= max) return value;
  if (max === 1) return ELLIPSIS;

  const room = max - 1;
  const head = Math.ceil(room / 2);
  const tail = room - head;
  return `${chars.slice(0, head).join('')}${ELLIPSIS}${tail === 0 ? '' : chars.slice(-tail).join('')}`;
}
