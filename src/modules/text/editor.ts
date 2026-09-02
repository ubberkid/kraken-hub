/**
 * Text's selection strip (§2.3) — text · size · colour · font · More.
 *
 * LAZY, and that is the whole reason this file exists rather than a block in
 * `index.ts`: the manifest is eager (the registry validates stored config
 * before anything renders) and the strip is config-only data, so declaring it
 * beside the manifest put the font list and the swatch table on the LCD's
 * critical path. `KrakenModule.editor.loadStrip()` fetches this file when a
 * text layer is first selected, on the one page that has an editor.
 */

import { INK_SWATCHES } from '../swatches';

import { MAX_TEXT_LEN, SIZE_MAX, SIZE_MIN, TEXT_FACES, TEXT_FONTS } from './schema';

import type { StripDeclaration, StripOption } from '../types';

const TEXT_FONT_OPTIONS: readonly StripOption[] = TEXT_FONTS.map((font) => ({
  value: font,
  label: TEXT_FACES[font].label,
}));

export const strip: StripDeclaration['strip'] = [
  {
    id: 'text',
    label: 'Text',
    control: 'text',
    target: 'cfg',
    path: 'text',
    max: MAX_TEXT_LEN,
  },
  {
    id: 'size',
    label: 'Size',
    control: 'range',
    target: 'cfg',
    path: 'size',
    min: SIZE_MIN,
    max: SIZE_MAX,
    step: 0.01,
    format: 'percent',
  },
  {
    id: 'colour',
    label: 'Colour',
    control: 'swatches',
    target: 'cfg',
    path: 'color',
    options: INK_SWATCHES,
  },
  {
    id: 'font',
    label: 'Font',
    control: 'segmented',
    target: 'cfg',
    path: 'font',
    options: TEXT_FONT_OPTIONS,
  },
  { id: 'more', label: 'More', control: 'more' },
];
