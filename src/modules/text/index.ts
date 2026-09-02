/**
 * STEP 5 (docs/modules.md §7) — the Text manifest.
 *
 * This file is EAGER — the registry imports it so both pages can validate
 * stored config before anything renders. Everything that touches the DOM, and
 * everything that could touch the network, is behind `loadDisplay()` /
 * `loadConfigPanel()`.
 *
 * ## Overlay-only, on purpose
 *
 * `roles: ['overlay']` is the one placement decision worth arguing about, and
 * `docs/design/design-layers-architecture.md` §1.4 settles it: a full-panel
 * base made of one line of text is a look nobody composes, and a kind that can
 * be the base has to answer "what does it do with the whole panel" for the
 * editor, the picker and the legacy single-module path. Text is a thing you put
 * ON something — over a video, under a clock — so it declares the one role it
 * is for.
 */

import { IDENTITY, MAX_LAYERS } from '../../state/look/types';
import { defineModule } from '../defineModule';

import { TEXT_DEFAULTS, validateText, type TextConfig } from './schema';

import type { KrakenModule } from '../types';

export const textModule: KrakenModule<TextConfig> = defineModule<TextConfig>({
  id: 'text',
  name: 'Text',
  summary: 'A line of your own words — size, colour, alignment and one of six faces.',
  // A serif capital T. Inline path data, so no asset request on the LCD.
  icon: 'M4 4h16v4h-2V6h-5v12h3v2H8v-2h3V6H6v2H4V4z',
  configVersion: 1,
  capabilities: {
    needsMonitoring: false,
    // Nothing changes over time. A frame tick would be a wasted call.
    needsFrameLoop: false,
    usesMedia: false,
    hasTimeline: false,
    /*
     * `'static'`, and it agrees with `cost().cadence` below — the registry
     * conformance suite checks that the two say the same thing. A line of text
     * is exactly as legible at CAM's 1 FPS default as it is at 40.
     */
    motionLevel: 'static',
    substrate: 'dom',
    audio: 'none',
    remoteCommands: [],
  },

  /**
   * Where a Text layer may sit, and what it costs there — the row this module
   * fills in from design-layers-architecture.md §1.4's table.
   *
   * `resize: 'frame'` because glyphs re-laid-out at a new size are crisp and
   * glyphs scaled by the compositor are not; `minFrame: 0.2` because a box
   * narrower than a fifth of the panel cannot hold a readable word at any font
   * size the panel can resolve.
   */
  layer: {
    roles: ['overlay'],
    maxInstances: MAX_LAYERS,
    resize: 'frame',
    minFrame: 0.2,
    // A banner across the upper third — clear of a clock's default strip below.
    overlayDefault: {
      frame: { w: 1.2, h: 0.3, shape: 'square' },
      t: { ...IDENTITY, y: -0.6 },
    },
    /*
     * Static, and it repaints its whole (small) frame when it does — a config
     * change rewrites the line. `'low'` entropy: flat fill, no gradient, which
     * is the cheapest thing CAM's compressor can be handed.
     */
    cost: () => ({ cadence: 'static', coverage: 1, entropy: 'low', decoders: 0, gl: 0 }),
  },

  /** §2.3: text · size · colour · font · More — declared in `./editor`. */
  editor: { loadStrip: () => import('./editor') },

  defaults: TEXT_DEFAULTS,
  validate: validateText,

  loadDisplay: () => import('./display'),
  loadConfigPanel: () => import('./TextConfigPanel'),
});
