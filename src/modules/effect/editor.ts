/**
 * Effect's selection strip (§2.3) — effect · preset · colours · warmth · More.
 *
 * LAZY: the manifest is eager (the registry validates stored config and parses
 * URL parameters before anything renders), the strip is config-only data, and
 * the LCD has no editor. `KrakenModule.editor.loadStrip()` fetches this when an
 * effect layer is first selected. See `src/modules/types.ts`'s
 * `EditorContract`.
 *
 * Three of the five OPEN rather than set, and that is the boundary doing its
 * job: `catalog.ts` — the twelve human names, the colour-well labels and the
 * author's own materials — is deliberately NOT on the display path, and a strip
 * that inlined those names would put all of it in this chunk. The module says
 * it wants an effect picker; the editor, which is allowed to read the catalog,
 * is what opens one.
 */

import type { StripDeclaration } from '../types';

export const strip: StripDeclaration['strip'] = [
  { id: 'effect', label: 'Effect', control: 'action', action: 'effect' },
  { id: 'preset', label: 'Preset', control: 'action', action: 'preset' },
  { id: 'colours', label: 'Colours', control: 'action', action: 'colours' },
  { id: 'reacts', label: 'Warmth', control: 'toggle', target: 'cfg', path: 'reactsToTemp' },
  { id: 'more', label: 'More', control: 'more' },
];
