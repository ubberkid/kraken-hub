/**
 * Icon's selection strip (§2.3) — icon · colour · size · weight · More.
 *
 * LAZY: the manifest is eager (the registry validates stored config before
 * anything renders), the strip is config-only data, and the LCD has no editor.
 * `KrakenModule.editor.loadStrip()` fetches this when an icon layer is first
 * selected. See `src/modules/types.ts`'s `EditorContract`.
 *
 * `icon` is an `'action'` rather than a chooser: the glyph catalog is far too
 * long for five segments, so the module says it wants a picker and the editor
 * owns what opens.
 */

import { INK_SWATCHES } from '../swatches';

import { ICON_WEIGHTS, SIZE_MAX, SIZE_MIN, type IconWeight } from './schema';

import type { StripDeclaration, StripOption } from '../types';

const WEIGHT_LABELS: Readonly<Record<IconWeight, string>> = {
  thin: 'Thin',
  regular: 'Regular',
  bold: 'Bold',
};

const WEIGHT_OPTIONS: readonly StripOption[] = ICON_WEIGHTS.map((w) => ({
  value: w,
  label: WEIGHT_LABELS[w],
}));

export const strip: StripDeclaration['strip'] = [
  { id: 'icon', label: 'Icon', control: 'action', action: 'preset' },
  {
    id: 'colour',
    label: 'Colour',
    control: 'swatches',
    target: 'cfg',
    path: 'color',
    options: INK_SWATCHES,
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
    id: 'weight',
    label: 'Weight',
    control: 'segmented',
    target: 'cfg',
    path: 'weight',
    options: WEIGHT_OPTIONS,
  },
  { id: 'more', label: 'More', control: 'more' },
];
