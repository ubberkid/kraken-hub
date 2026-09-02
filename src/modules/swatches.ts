/**
 * The house inks — one five-swatch list, shared by every kind that offers a
 * colour on the selection strip.
 *
 * It was four copies. `text`, `date` and `icon` each declared the same five
 * `#rrggbb` literals with the same five labels, and `shape` declared its own
 * paints that agreed with three of them and not the other two. Five inks that
 * are *nearly* the same across four kinds is worse than five that differ on
 * purpose: a look composed of a line of text over a shape could be made to
 * agree only by matching hex by eye, which is exactly what a swatch row exists
 * to stop.
 *
 * This is a CONSISTENCY change, not a size one — the four copies were a few
 * hundred bytes. The table lives here rather than in one of the kinds because
 * no kind owns it, and it is read only by the per-kind `editor.ts` files, which
 * are lazy: nothing on the display's critical path ever asks what "Amber" is.
 *
 * The exact colour a person wants that is not one of these lives in the
 * inspector's colour well. Five is the choice made ninety per cent of the time.
 */

import type { StripOption } from './types';

/**
 * The named inks, addressable one at a time.
 *
 * `shape` needs `black` (a ground wants a dark option that `text` never does)
 * and does not offer `lime` or `magenta`, so it composes its own row out of
 * these entries rather than taking `INK_SWATCHES` whole — same values, same
 * labels, one definition.
 */
export const INKS = {
  white: { value: '#f2f4f8', label: 'White', swatch: '#f2f4f8' },
  black: { value: '#0b0e13', label: 'Black', swatch: '#0b0e13' },
  amber: { value: '#ffb648', label: 'Amber', swatch: '#ffb648' },
  cyan: { value: '#5ad8ff', label: 'Cyan', swatch: '#5ad8ff' },
  lime: { value: '#8ef07a', label: 'Lime', swatch: '#8ef07a' },
  magenta: { value: '#ff7ad9', label: 'Magenta', swatch: '#ff7ad9' },
} as const satisfies Readonly<Record<string, StripOption>>;

/**
 * Five inks, not a colour wheel — what `text`, `date` and `icon` put on the
 * strip, in this order.
 *
 * Five is the strip's own arithmetic: a swatch row is ONE of at most five
 * controls (`stripContract.ts`), so it gets one line and no scroller.
 */
export const INK_SWATCHES: readonly StripOption[] = [
  INKS.white,
  INKS.amber,
  INKS.cyan,
  INKS.lime,
  INKS.magenta,
];
