/**
 * Video's selection strip (§2.3) — source · fit · loop · quality · More.
 *
 * LAZY: the manifest is eager (the registry validates stored config and parses
 * URL parameters before anything renders), the strip is config-only data, and
 * the LCD has no editor. `KrakenModule.editor.loadStrip()` fetches this when
 * the video layer is selected. See `src/modules/types.ts`'s `EditorContract`.
 */

import type { StripDeclaration } from '../types';

export const strip: StripDeclaration['strip'] = [
  { id: 'source', label: 'Source', control: 'action', action: 'source' },
  { id: 'fill', label: 'Fit', control: 'fit', target: 'cfg', path: 'render.fit' },
  { id: 'loop', label: 'Loop', control: 'action', action: 'loop' },
  /*
   * Quality opens rather than sets, because what it MEANS is decided by the
   * provider (`quality.ts`, `qualityControlFor()`): a resolver-backed clip gets
   * a height ladder, a YouTube embed gets a floor, and a plain file gets
   * whatever the server sends. Four segments would have to lie about one of
   * those three.
   */
  { id: 'quality', label: 'Quality', control: 'action', action: 'quality' },
  { id: 'more', label: 'More', control: 'more' },
];
