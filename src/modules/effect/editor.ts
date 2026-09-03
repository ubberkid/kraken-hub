/**
 * Effect's selection strip (§2.3) — ONE control.
 *
 * It used to be five: Effect · Preset · Colours · Warmth · More. Four of those
 * five opened the same room. `Effect`, `Preset` and `Colours` were three
 * `control: 'action'` doors that all ran the same line — open the inspector at
 * the kind's own panel — and `More` opened that same sheet at the top, so a
 * person pressing three differently-labelled buttons got the same screen three
 * times. That is a menu pretending to be a set of controls, and the strip's own
 * rule (§2.3: "which four matter most") is answered honestly here by "none of
 * them, because the panel already holds them together".
 *
 * So the kind declares one opener, named after what is behind it. Warmth went
 * with the rest: it is a switch in the panel, next to the temperature source it
 * only means anything with — a strip toggle for it was the fifth button on a
 * row whose other four were the same door.
 *
 * LAZY: the manifest is eager (the registry validates stored config and parses
 * URL parameters before anything renders), the strip is config-only data, and
 * the LCD has no editor. `KrakenModule.editor.loadStrip()` fetches this when an
 * effect layer is first selected. See `src/modules/types.ts`'s
 * `EditorContract`.
 *
 * It OPENS rather than sets, and that is the boundary doing its job:
 * `catalog.ts` — the twelve human names, the colour-well labels and the
 * author's own materials — is deliberately NOT on the display path, and a strip
 * that inlined those names would put all of it in this chunk. The module says
 * it wants its panel; the editor, which is allowed to read the catalog, is what
 * shows one.
 */

import type { StripDeclaration } from '../types';

export const strip: StripDeclaration['strip'] = [
  // The ellipsis is the same promise every "opens something" label in the app
  // makes. `reveal: 'options'` is what keeps it from landing on Layout.
  { id: 'more', label: 'Effect…', control: 'more', reveal: 'options' },
];
