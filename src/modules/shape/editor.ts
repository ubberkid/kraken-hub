/**
 * Shape's selection strip (§2.3) — shape · fill · stroke · More.
 *
 * LAZY: the manifest is eager (the registry validates stored config before
 * anything renders), the strip is config-only data, and the LCD has no editor.
 * `KrakenModule.editor.loadStrip()` fetches this when a shape layer is first
 * selected. See `src/modules/types.ts`'s `EditorContract`.
 */

import { INKS } from '../swatches';

import { NO_PAINT, SHAPE_KINDS } from './schema';

import type { StripDeclaration, StripOption } from '../types';

const SHAPE_LABELS: Readonly<Record<(typeof SHAPE_KINDS)[number], string>> = {
  rect: 'Rectangle',
  circle: 'Disc',
  line: 'Rule',
  ring: 'Ring',
};

const SHAPE_OPTIONS: readonly StripOption[] = SHAPE_KINDS.map((kind) => ({
  value: kind,
  label: SHAPE_LABELS[kind],
}));

/**
 * The paints a fill or a stroke can be, with `none` first.
 *
 * `none` is the choice that makes an outline an outline, so it is a swatch like
 * any other rather than a switch somewhere else — a ring with no fill and a
 * disc with no stroke are the two shapes people actually draw.
 *
 * The four colours come from the house inks (`../swatches`) rather than four
 * literals, so "White" here is the same white `text` and `date` offer. Shape is
 * the one kind that wants BLACK — it is a ground, and a ground is often the
 * dark one — and the one that can spend a slot on `none`, so it composes its
 * row from the named inks instead of taking `INK_SWATCHES` whole.
 */
const SHAPE_PAINTS: readonly StripOption[] = [
  { value: NO_PAINT, label: 'None', swatch: 'transparent' },
  INKS.white,
  INKS.black,
  INKS.amber,
  INKS.cyan,
];

export const strip: StripDeclaration['strip'] = [
  {
    id: 'shape',
    label: 'Shape',
    control: 'segmented',
    target: 'cfg',
    path: 'shape',
    options: SHAPE_OPTIONS,
  },
  {
    id: 'fill',
    label: 'Fill',
    control: 'swatches',
    target: 'cfg',
    path: 'fill',
    options: SHAPE_PAINTS,
  },
  {
    id: 'stroke',
    label: 'Stroke',
    control: 'swatches',
    target: 'cfg',
    path: 'stroke',
    options: SHAPE_PAINTS,
  },
  { id: 'more', label: 'More', control: 'more' },
];
