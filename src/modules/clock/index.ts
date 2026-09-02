/**
 * STEP 5 (docs/modules.md §7) — the Clock manifest.
 *
 * `clock` supersedes the M0 placeholder `clock-lite`, and takes over its id
 * space: the id is `clock`, and state migration 3 → 4
 * (`src/state/migrations.ts`) rewrites `activeModuleId` and moves the stored
 * config slot across, mapping `format` → `hourFormat` and keeping
 * `showSeconds`, so a user who was on the placeholder comes back to the same
 * clock. `clock-lite` is gone rather than aliased: an alias would have kept a
 * second id alive in every picker, every URL and every synced snapshot forever,
 * to preserve a module that existed only because M0 needed *something* to
 * render.
 *
 * This file is EAGER — the registry imports it so both pages can validate
 * stored state and parse URL parameters before anything renders. Everything
 * that touches the DOM is behind `loadDisplay()` / `loadConfigPanel()`.
 */

import { IDENTITY, MAX_LAYERS } from '../../state/look/types';
import { defineModule } from '../defineModule';

import { CLOCK_DEFAULTS, CLOCK_FACES, validateClock, type ClockConfig } from './schema';

import type { KrakenModule } from '../types';

export const clockModule: KrakenModule<ClockConfig> = defineModule<ClockConfig>({
  id: 'clock',
  name: 'Clock',
  summary: 'Digital or analog, with an optional date line. No network, no media.',
  // Clock-face glyph; inline path data, so no asset request on the LCD.
  icon: 'M12 2a10 10 0 100 20 10 10 0 000-20zm1 5h-2v6l5 3 1-1.7-4-2.3V7z',
  configVersion: 1,
  capabilities: {
    needsMonitoring: false,
    // One tick per frame, but the repaint guard means all but one per second
    // are a string compare. `frame()` is still how the clock learns time passed.
    needsFrameLoop: true,
    usesMedia: false,
    hasTimeline: false,
    /*
     * `'low'`, not `'full'`: nothing here animates. Every visual state is a
     * function of the current wall-clock second, so at CAM's 1 FPS default the
     * clock is *correct*, merely up to a second late. Declaring `'full'` would
     * put a "raise your frame rate" card over a module that does not need one.
     */
    motionLevel: 'low',
    // DOM for the digital face, inline SVG for the analog dial.
    substrate: 'mixed',
    audio: 'none',
    remoteCommands: [],
  },

  /**
   * `resize: 'frame'` — the crispness rule (§3.2). A clock is text and SVG, so
   * a resize gesture commits a new FRAME and the module lays itself out again
   * at the new size; committing `t.s` instead would leave the digits as a
   * scaled bitmap, which is exactly the artefact CAM's compressor is worst at.
   *
   * The default sits along the bottom, where a wide, short box lands under
   * whatever the base is showing without covering its middle.
   */
  layer: {
    roles: ['base', 'overlay'],
    maxInstances: MAX_LAYERS,
    resize: 'frame',
    minFrame: 0.4,
    overlayDefault: { frame: { w: 1, h: 0.5, shape: 'square' }, t: { ...IDENTITY, y: 0.55 } },
    /*
     * Once a second, and only the digits that changed: the renderer's repaint
     * guard means the other 39 ticks a second are a string compare. `0.15`
     * coverage is the digits against their own box; flat type on flat ground is
     * the cheapest thing the compressor ever sees.
     */
    cost: () => ({ cadence: 'tick', coverage: 0.15, entropy: 'low', decoders: 0, gl: 0 }),
  },

  /** §2.3: face · 12/24 · seconds · colour · More — declared in `./editor`. */
  editor: { loadStrip: () => import('./editor') },

  defaults: CLOCK_DEFAULTS,
  validate: validateClock,

  /** `?module=clock&face=analog`. The host re-validates the result. */
  applyUrlParams(config, params) {
    let next: ClockConfig = config;
    const face = params['face'];
    if (face !== undefined && (CLOCK_FACES as readonly string[]).includes(face)) {
      next = { ...next, face: face as ClockConfig['face'] };
    }
    return next;
  },

  loadDisplay: () => import('./display'),
  loadConfigPanel: () => import('./ClockConfigPanel'),
});
