/**
 * STEP 5 (docs/modules.md §7) — the Effects manifest.
 *
 * Twelve moving backgrounds, ported from the author's own Unity banner
 * materials (`docs/design/effects-ports/PORTS.md` records every source file and
 * every deviation). The user-facing word for one of them is **Effect**, here and
 * everywhere else; the technical word belongs in comments and in that document.
 *
 * EAGER, and deliberately thin: this file and `schema.ts` are what the registry
 * imports, so between them they hold the id table, the clamps and the
 * placement — and not one palette, not one line of GLSL. The catalogue is
 * behind `loadConfigPanel()`, the twelve programs behind `loadDisplay()` and a
 * second dynamic import inside it.
 */

import { IDENTITY } from '../../state/look/types';
import { defineModule } from '../defineModule';

import {
  CUSTOM_PRESET_ID,
  EFFECT_DEFAULTS,
  EFFECT_IDS,
  effectEntropy,
  validateEffect,
  type EffectConfig,
} from './schema';

import type { KrakenModule } from '../types';

/** Two effects is the ceiling: `Σ gl ≤ 2` across a look (§3.4). */
const MAX_EFFECT_INSTANCES = 2;
/**
 * Below about half the panel an effect is a texture swatch rather than a
 * picture — every one of the twelve composes against the whole disc.
 */
const MIN_FRAME = 0.5;
/**
 * A fresh overlay lands as a CORNER BADGE, not as a lid.
 *
 * It used to be `1.2 × 1.2` centred — a disc slightly proud of the panel, so it
 * bled to the bezel. As a BASE that is exactly right and it is what `frame:
 * 'panel'` still gives; as an OVERLAY it is an opaque circle painted on top of
 * everything, and audit 11 (M-i) photographed the result: adding an effect to a
 * look hid the look. Every one of the twelve fills its box — `coverage: 1` is
 * the honest cost — so a full-size centred overlay cannot be anything but a lid.
 *
 * So a fresh effect OVERLAY is a badge: `0.6 × 0.6` — just over the `0.5` floor,
 * still a picture rather than a swatch — in the upper-right, at `a: 0.85` so the
 * base reads through it. It is the same idiom, and the same position, the image
 * module's overlay default uses.
 *
 * The geometry is checked, not asserted: at `(0.45, −0.45)` a `0.6` circle
 * reaches `0.45 + 0.3 = 0.75` on each axis, inside the `0.88` safe ring, and
 * `√(0.45² + 0.45²) + 0.3 = 0.94` from the centre, inside the panel — so no part
 * of it is cut by the bezel. `registry.test.ts` pins that for every kind.
 */
const OVERLAY_FRAME = 0.6;
/** Upper-right, on both axes — the image module's badge corner. */
const OVERLAY_OFFSET = 0.45;
/** Translucent enough that the base is still the picture underneath it. */
const OVERLAY_ALPHA = 0.85;

export const effectModule: KrakenModule<EffectConfig> = defineModule<EffectConfig>({
  id: 'effect',
  name: 'Effects',
  chipName: 'Effect',
  summary: 'Twelve moving backgrounds with your own colours. No network, no media.',
  // Overlapping ripples — the one shape all twelve have in common.
  icon: 'M2 15c2-2 4-2 6 0s4 2 6 0 4-2 6 0v3c-2-2-4-2-6 0s-4 2-6 0-4-2-6 0v-3zm0-6c2-2 4-2 6 0s4 2 6 0 4-2 6 0v3c-2-2-4-2-6 0s-4 2-6 0-4-2-6 0V9z',
  configVersion: 1,
  capabilities: {
    // Subscribed always, used only when "Reacts to temperature" is on: the
    // capability is a static fact about the module, and the 1 Hz feed costs a
    // function call whether or not the config reads it.
    needsMonitoring: true,
    needsFrameLoop: true,
    usesMedia: false,
    hasTimeline: false,
    /*
     * `'full'`: these ARE motion, and at CAM's 1 FPS default they are twelve
     * slideshows. The advisory is honest about that — the effect still paints,
     * still glides its warmth and still advances its own clock, so raising the
     * frame rate is a genuine improvement rather than a bug report.
     */
    motionLevel: 'full',
    substrate: 'canvas',
    audio: 'none',
    remoteCommands: [],
  },

  /**
   * `resize: 'scale'` — the crispness rule (§3.2) inverted. A fragment program
   * has no native resolution and nothing to re-lay-out, so a resize gesture
   * commits `t.s` and the picture is redrawn at the new size for free. There is
   * no scaled bitmap to smear, which is exactly why text commits a frame and
   * this does not.
   */
  layer: {
    roles: ['base', 'overlay'],
    maxInstances: MAX_EFFECT_INSTANCES,
    resize: 'scale',
    minFrame: MIN_FRAME,
    overlayDefault: {
      frame: { w: OVERLAY_FRAME, h: OVERLAY_FRAME, shape: 'circle' },
      t: { ...IDENTITY, x: OVERLAY_OFFSET, y: -OVERLAY_OFFSET, a: OVERLAY_ALPHA },
    },
    /*
     * Every frame, every pixel, one GL context. `coverage: 1` is not pessimism:
     * a fullscreen triangle rewrites the whole box on every painted tick, which
     * is the honest number for the cost bar to add up. Entropy is per effect —
     * ten of the twelve are broad smooth gradients, two sweep a hard edge
     * across the disc.
     */
    cost: (cfg) => ({
      cadence: 'frame',
      coverage: 1,
      entropy: effectEntropy(cfg),
      decoders: 0,
      gl: 1,
    }),
  },

  /**
   * §2.3: effect · preset · custom colours · reacts-to-temp · More —
   * declared in `./editor`, which the config page fetches on first selection.
   */
  editor: { loadStrip: () => import('./editor') },

  defaults: EFFECT_DEFAULTS,
  validate: validateEffect,

  /**
   * `?module=effect&effect=voronoi`. The host re-validates the result.
   *
   * One parameter, not two. There is no `?preset=`, because a preset is a
   * PALETTE and the palette table is in `catalog.ts`, which is lazy so that
   * twelve materials sets stay off the LCD's 90 kB critical path — this file
   * could record the label but could not paint the colours, and a parameter
   * that half-applies is worse than one that does not exist.
   *
   * Which is also why switching effect sets `preset` to `custom`: the user's
   * stored colours come across unchanged (they are the truth, per `schema.ts`),
   * and they are not the new effect's material, so naming a material here would
   * be a label that lies about what is on the panel.
   */
  applyUrlParams(config, params) {
    const id = params['effect'];
    if (id === undefined || !(EFFECT_IDS as readonly string[]).includes(id)) return config;
    if (id === config.effect) return config;
    return { ...config, effect: id as EffectConfig['effect'], preset: CUSTOM_PRESET_ID };
  },

  loadDisplay: () => import('./display'),
  loadConfigPanel: () => import('./ConfigPanel'),
});
