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
