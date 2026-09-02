/**
 * Clock's selection strip (§2.3) — face · 12/24 · seconds · colour · More.
 *
 * LAZY: the manifest is eager (the registry validates stored config and parses
 * URL parameters before anything renders), the strip is config-only data, and
 * the LCD has no editor. `KrakenModule.editor.loadStrip()` fetches this when a
 * clock layer is first selected. See `src/modules/types.ts`'s `EditorContract`.
 */

import { CLOCK_PALETTES, CLOCK_THEMES } from './schema';

import type { StripDeclaration, StripOption } from '../types';

/**
 * The colour choice, as colour.
 *
 * A swatch row rather than five words: the strip has room for one control here
 * and the thing being chosen is visible, so showing it is both smaller and more
 * honest than naming it. The labels survive for the accessibility tree.
 *
 * Derived from the module's own palettes rather than the house inks
 * (`../swatches`), because a clock THEME is a pair of colours the renderer
 * owns — the swatch shows its foreground, and inventing a sixth theme here by
 * offering an ink the renderer has never heard of would show nothing selected.
 */
const CLOCK_SWATCHES: readonly StripOption[] = CLOCK_THEMES.map((theme) => ({
  value: theme,
  label: theme.charAt(0).toUpperCase() + theme.slice(1),
  swatch: CLOCK_PALETTES[theme].fg,
}));

export const strip: StripDeclaration['strip'] = [
  {
    id: 'face',
    label: 'Face',
    control: 'segmented',
    target: 'cfg',
    path: 'face',
    options: [
      { value: 'digital', label: 'Digital' },
      { value: 'analog', label: 'Analog' },
    ],
  },
  {
    id: 'format',
    label: 'Hours',
    control: 'segmented',
    target: 'cfg',
    path: 'hourFormat',
    options: [
      { value: '24', label: '24' },
      { value: '12', label: '12' },
    ],
  },
  { id: 'seconds', label: 'Seconds', control: 'toggle', target: 'cfg', path: 'showSeconds' },
  {
    id: 'colour',
    label: 'Colour',
    control: 'swatches',
    target: 'cfg',
    path: 'theme',
    options: CLOCK_SWATCHES,
  },
  { id: 'more', label: 'More', control: 'more' },
];
