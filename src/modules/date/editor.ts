/**
 * Date's selection strip (§2.3) — format · size · colour · More.
 *
 * LAZY: the manifest is eager (the registry validates stored config before
 * anything renders), the strip is config-only data, and the LCD has no editor.
 * `KrakenModule.editor.loadStrip()` fetches this when a date layer is first
 * selected. See `src/modules/types.ts`'s `EditorContract`.
 */

import { INK_SWATCHES } from '../swatches';

import { DATE_FORMATS, FORMAT_LABELS } from './format';
import { SIZE_MAX, SIZE_MIN } from './schema';

import type { StripDeclaration, StripOption } from '../types';

const FORMAT_OPTIONS: readonly StripOption[] = DATE_FORMATS.map((format) => ({
  value: format,
  label: FORMAT_LABELS[format],
}));

export const strip: StripDeclaration['strip'] = [
  {
    id: 'format',
    label: 'Format',
    control: 'segmented',
    target: 'cfg',
    path: 'format',
    options: FORMAT_OPTIONS,
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
  { id: 'more', label: 'More', control: 'more' },
];
