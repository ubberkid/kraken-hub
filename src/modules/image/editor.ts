/**
 * Image's selection strip (§2.3) — source · fit · opacity · More.
 *
 * LAZY: the manifest is eager (the registry validates stored config and parses
 * URL parameters before anything renders), the strip is config-only data, and
 * the LCD has no editor. `KrakenModule.editor.loadStrip()` fetches this when an
 * image layer is first selected. See `src/modules/types.ts`'s `EditorContract`.
 *
 * `opacity` is a `'layer'` control, so it is live on a picture used as an
 * overlay and disabled on one used as the base — a base wears `IDENTITY` by
 * definition (§4.1), and a control that silently did nothing would be worse
 * than one that says it does not apply here.
 */

import type { StripDeclaration } from '../types';

export const strip: StripDeclaration['strip'] = [
  { id: 'source', label: 'Source', control: 'action', action: 'source' },
  { id: 'fill', label: 'Fit', control: 'fit', target: 'cfg', path: 'render.fit' },
  {
    id: 'opacity',
    label: 'Opacity',
    control: 'range',
    target: 'layer',
    path: 't.a',
    min: 0.1,
    max: 1,
    step: 0.05,
    format: 'percent',
  },
  { id: 'more', label: 'More', control: 'more' },
];
