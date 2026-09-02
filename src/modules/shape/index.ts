/**
 * STEP 5 (docs/modules.md §7) — the Shape manifest.
 *
 * EAGER: the registry imports this so both pages can validate stored config
 * before anything renders. Everything that touches the DOM is behind
 * `loadDisplay()` / `loadConfigPanel()`.
 *
 * ## Why this one can also be a base
 *
 * A full-panel rectangle is the "solid base" of `design-editor-ux.md` §10 —
 * a flat ground to put a clock and a line of text on — so `roles` names both.
 * `resize: 'scale'` is the row `design-layers-architecture.md` §1.4 gives it:
 * a vector shape scaled by the compositor is exactly as crisp as one re-laid
 * out, so there is nothing to buy by re-laying it out and one style write to
 * save.
 */

import { IDENTITY, MAX_LAYERS } from '../../state/look/types';
import { defineModule } from '../defineModule';

import { SHAPE_DEFAULTS, validateShape, type ShapeConfig } from './schema';

import type { KrakenModule } from '../types';

export const shapeModule: KrakenModule<ShapeConfig> = defineModule<ShapeConfig>({
  id: 'shape',
  name: 'Shape',
  summary: 'A rectangle, disc, ring or rule — a ground to put the rest of a look on.',
  // A square with a disc beside it. Inline path data, so no asset request.
  icon: 'M3 3h8v8H3V3zm12 6a6 6 0 110 12 6 6 0 010-12z',
  configVersion: 1,
  capabilities: {
    needsMonitoring: false,
    needsFrameLoop: false,
    usesMedia: false,
    hasTimeline: false,
    // Nothing moves, so 1 FPS is not a degraded rendering of it — it is the
    // same rendering. `cost().cadence` says the same thing.
    motionLevel: 'static',
    substrate: 'dom',
    audio: 'none',
    remoteCommands: [],
  },

  /** The row from design-layers-architecture.md §1.4's table. */
  layer: {
    roles: ['base', 'overlay'],
    maxInstances: MAX_LAYERS,
    resize: 'scale',
    minFrame: 0.1,
    // A scrim across the bottom — the band a stats strip or a caption sits on.
    overlayDefault: {
      frame: { w: 1.6, h: 0.5, shape: 'square' },
      t: { ...IDENTITY, y: 0.6 },
    },
    /*
     * Static, whole-frame when it does change, and the lowest-entropy thing
     * CAM's compressor can be handed: flat fills and one solid stroke.
     */
    cost: () => ({ cadence: 'static', coverage: 1, entropy: 'low', decoders: 0, gl: 0 }),
  },

  /**
   * §2.3: shape · fill · stroke · More — declared in `./editor`.
   *
   * Four, not five, and the cap is a ceiling rather than a quota: a rectangle
   * has three things worth deciding on a strip, and padding the row out to five
   * would be furniture.
   */
  editor: { loadStrip: () => import('./editor') },

  defaults: SHAPE_DEFAULTS,
  validate: validateShape,

  loadDisplay: () => import('./display'),
  loadConfigPanel: () => import('./ShapeConfigPanel'),
});
