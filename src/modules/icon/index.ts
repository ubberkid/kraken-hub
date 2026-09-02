/**
 * STEP 5 (docs/modules.md §7) — the Icon manifest.
 *
 * EAGER: the registry imports this so both pages can validate stored config
 * before anything renders. Everything that touches the DOM is behind
 * `loadDisplay()` / `loadConfigPanel()`; the glyph TABLE is eager on purpose —
 * `validate()` has to know whether a stored id is one this build ships, and a
 * lazy table would mean a config that cannot be validated until a chunk lands.
 *
 * ## Overlay-only, on purpose
 *
 * `roles: ['overlay']` for the reason `text` gives: a full-panel base made of
 * one glyph is a look nobody composes, and a kind that can be the base has to
 * answer "what does it do with the whole panel" for the editor, the picker and
 * the legacy single-module path. An icon is a thing you put ON something — a
 * flame beside a temperature, a bolt over a video.
 *
 * ## Why `resize: 'frame'`
 *
 * §3.2's crispness rule. A glyph is vector either way, so the argument is not
 * sharpness — it is the ANCHOR: `'frame'` re-fits the glyph inside the new box
 * with `preserveAspectRatio`, which keeps its visual centre on the layer's
 * anchor at every size. `'scale'` would multiply `t.s` and leave the same
 * markup, which is identical here and would make the strip's size control and
 * the resize gesture two different sizes of one thing.
 */

import { IDENTITY, MAX_LAYERS } from '../../state/look/types';
import { defineModule } from '../defineModule';

import { ICON_DEFAULTS, validateIcon, type IconConfig } from './schema';

import type { KrakenModule } from '../types';

export const iconModule: KrakenModule<IconConfig> = defineModule<IconConfig>({
  id: 'icon',
  name: 'Icon',
  summary: 'One glyph from a curated set — colour, size and stroke weight.',
  // A four-point spark. Inline path data, so no asset request on the LCD.
  icon: 'M12 2l2.2 6.3L20.5 10l-6.3 2.2L12 18.5l-2.2-6.3L3.5 10l6.3-1.7L12 2z',
  configVersion: 1,
  capabilities: {
    needsMonitoring: false,
    // Nothing changes over time. A frame tick would be a wasted call.
    needsFrameLoop: false,
    usesMedia: false,
    hasTimeline: false,
    // `'static'`, and it agrees with `cost().cadence` below — the registry
    // conformance suite checks the two say the same thing. A glyph is exactly
    // as legible at CAM's 1 FPS default as it is at 40.
    motionLevel: 'static',
    substrate: 'dom',
    audio: 'none',
    remoteCommands: [],
  },

  /** The row this module fills in from design-layers-architecture.md §1.4. */
  layer: {
    roles: ['overlay'],
    maxInstances: MAX_LAYERS,
    resize: 'frame',
    // A glyph stays a glyph small: it has no words to become illegible, so the
    // floor is the model's own minimum rather than text's 0.2.
    minFrame: 0.1,
    // A square badge up and to the left, clear of a clock's or a stats strip's
    // default band along the bottom.
    overlayDefault: {
      frame: { w: 0.5, h: 0.5, shape: 'square' },
      t: { ...IDENTITY, x: -0.45, y: -0.45 },
    },
    /*
     * Static, and it repaints its whole (small) frame when it does — a config
     * change rewrites one `<path>`. `'low'` entropy: flat fill or one solid
     * stroke, which is the cheapest thing CAM's compressor can be handed.
     */
    cost: () => ({ cadence: 'static', coverage: 1, entropy: 'low', decoders: 0, gl: 0 }),
  },

  /**
   * §2.3: icon · colour · size · weight · More — declared in `./editor`.
   *
   * The glyph itself is an `action`, not a `segmented`: forty-eight options is
   * not a strip control at any width, and the picker needs a search field and
   * five category drawers — data a manifest may not carry. The module declares
   * that it wants the affordance and the editor opens the panel that owns it,
   * exactly as `preset` does for the effect palettes.
   */
  editor: { loadStrip: () => import('./editor') },

  defaults: ICON_DEFAULTS,
  validate: validateIcon,

  /*
   * No `applyUrlParams`. `src/state/urlParams.ts` forwards a fixed set of
   * module-scoped keys and `icon=` is not one of them, so a manifest hook here
   * would be a branch nothing can reach — the glyph is chosen in the picker and
   * carried in the stored config like every other setting on this kind.
   */

  loadDisplay: () => import('./display'),
  loadConfigPanel: () => import('./IconConfigPanel'),
});
