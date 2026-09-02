/**
 * Stats' selection strip (§2.3) — metric · face · size · colour · More.
 *
 * LAZY: the manifest is eager (the registry validates stored config and parses
 * URL parameters before anything renders), the strip is config-only data, and
 * the LCD has no editor. `KrakenModule.editor.loadStrip()` fetches this when a
 * stats layer is first selected. See `src/modules/types.ts`'s `EditorContract`.
 */

import {
  STATS_LAYOUTS,
  STATS_METRICS,
  STATS_PALETTES,
  STATS_THEMES,
  metricLongLabel,
} from './schema';

import type { StripDeclaration, StripOption } from '../types';

/**
 * The eight faces, named the way a person picks one — by what it looks like.
 *
 * `strip` is on the list on purpose. It is the overlay face, and until the
 * editor existed the only way to reach it was to add a stats overlay and never
 * touch the layout control; now it is a face like any other, choosable on the
 * layer that is going to wear it.
 *
 * The last three close the parity gap against CAM's own stats modes — a bar
 * face, a column face and a history face — without adding a control: they are
 * three more segments in the one chooser that was already here, and the strip
 * still carries exactly the five controls §2.3 allows it.
 */
const STATS_FACE_LABELS: Readonly<Record<(typeof STATS_LAYOUTS)[number], string>> = {
  single: 'One',
  dual: 'Two',
  triple: 'Three',
  grid: 'All',
  strip: 'Strip',
  bar: 'Bars',
  vertical: 'Columns',
  chart: 'History',
};

const STATS_FACE_OPTIONS: readonly StripOption[] = STATS_LAYOUTS.map((layout) => ({
  value: layout,
  label: STATS_FACE_LABELS[layout],
}));

const STATS_METRIC_OPTIONS: readonly StripOption[] = STATS_METRICS.map((metric) => ({
  value: metric,
  label: metricLongLabel(metric),
}));

/**
 * Derived from the module's own palettes rather than the house inks
 * (`../swatches`): a stats THEME is a set of colours the renderer owns, and the
 * swatch shows its foreground so the row still reads as colour.
 */
const STATS_SWATCHES: readonly StripOption[] = STATS_THEMES.map((theme) => ({
  value: theme,
  label: theme.charAt(0).toUpperCase() + theme.slice(1),
  swatch: STATS_PALETTES[theme].fg,
}));

export const strip: StripDeclaration['strip'] = [
  {
    id: 'metric',
    label: 'Metric',
    control: 'segmented',
    target: 'cfg',
    path: 'primary',
    options: STATS_METRIC_OPTIONS,
  },
  {
    id: 'layout',
    label: 'Face',
    control: 'segmented',
    target: 'cfg',
    path: 'layout',
    options: STATS_FACE_OPTIONS,
  },
  { id: 'size', label: 'Size', control: 'size' },
  {
    id: 'colour',
    label: 'Colour',
    control: 'swatches',
    target: 'cfg',
    path: 'theme',
    options: STATS_SWATCHES,
  },
  { id: 'more', label: 'More', control: 'more' },
];
