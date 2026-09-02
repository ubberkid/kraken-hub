/**
 * STEP 5 (docs/modules.md §7) — the Date manifest.
 *
 * EAGER: the registry imports this so both pages can validate stored config
 * before anything renders. Everything that touches the DOM is behind
 * `loadDisplay()` / `loadConfigPanel()`.
 *
 * ## Overlay-only, and why there is no date BASE
 *
 * `roles: ['overlay']` for the reason `text` gives — a full-panel base made of
 * one line is a look nobody composes — and for one more that is particular to
 * this kind: the clock already offers a date line on a base that also tells the
 * time, so a date base would be a worse clock with a setting missing. A date is
 * a thing you put ON something: under a video, beside a temperature, over a
 * picture.
 *
 * ## `cadence: 'tick'`, `motionLevel: 'static'`
 *
 * The two are not in conflict and the registry conformance suite allows exactly
 * this pair: `'tick'` means "repaints at most once a second" and `'static'` is
 * the honest ADVISORY — at CAM's 1 FPS default a date is not degraded, it is
 * identical. `display.ts` earns the claim with an integer compare per frame and
 * one format per minute.
 */

import { IDENTITY, MAX_LAYERS } from '../../state/look/types';
import { defineModule } from '../defineModule';

import { DATE_DEFAULTS, validateDate, type DateConfig } from './schema';

import type { KrakenModule } from '../types';

export const dateModule: KrakenModule<DateConfig> = defineModule<DateConfig>({
  id: 'date',
  name: 'Date',
  summary: "Today's date in one line, in this machine's own locale.",
  // A calendar leaf. Inline path data, so no asset request on the LCD.
  icon: 'M7 2h2v3h6V2h2v3h3v4H2V5h3V2zM2 11h20v10H2V11z',
  configVersion: 1,
  capabilities: {
    needsMonitoring: false,
    /*
     * True, and it is the whole clock this module has: the tick is how the
     * layer learns the day rolled over. `display.ts` spends one integer compare
     * on all but one frame a minute, which is why `cost().cadence` can say
     * `'tick'` honestly.
     */
    needsFrameLoop: true,
    usesMedia: false,
    hasTimeline: false,
    // At 1 FPS a date is not a degraded date; it is the same date.
    motionLevel: 'static',
    substrate: 'dom',
    audio: 'none',
    remoteCommands: [],
  },

  /** The row this module fills in from design-layers-architecture.md §1.4. */
  layer: {
    roles: ['overlay'],
    maxInstances: MAX_LAYERS,
    // §3.2: type re-laid out at the new size is crisp; type scaled by the
    // compositor is the artefact CAM's compressor is worst at.
    resize: 'frame',
    // A box narrower than a fifth of the panel cannot hold a readable weekday
    // at any font size the panel can resolve — `text`'s floor, for its reason.
    minFrame: 0.2,
    /*
     * A band under the middle — inside the safe ring, which the first one was
     * not.
     *
     * It was `1.2 × 0.28` at `y = 0.78`, chosen to sit clear of a clock's
     * default strip. That put the band's bottom edge at `0.78 + 0.14 = 0.92`,
     * outside the `0.88` safe ring and very nearly outside the panel: the chord
     * a round panel offers at that height is `2·√(1 − 0.78²) ≈ 1.25` before any
     * margin, so a 1.2-wide box there is a line the bezel clips at both ends.
     *
     * `1.1 × 0.28` at `y = 0.66` reaches `0.80` vertically and `0.55`
     * horizontally, both inside `0.88`. It is no longer clear of the clock's
     * default box, and it does not need to be: `placeNewLayer` walks a fresh
     * layer outward from its kind's default until it finds a free slot, so the
     * "not on top of the clock" rule is the placer's job and always was — this
     * value only has to be a position that exists.
     */
    overlayDefault: {
      frame: { w: 1.1, h: 0.28, shape: 'square' },
      t: { ...IDENTITY, y: 0.66 },
    },
    /*
     * Once a minute at most, and the whole (small) frame when it does: the line
     * is rewritten, not patched. `'low'` entropy — flat type on flat ground is
     * the cheapest thing CAM's compressor ever sees.
     */
    cost: () => ({ cadence: 'tick', coverage: 1, entropy: 'low', decoders: 0, gl: 0 }),
  },

  /** §2.3: format · size · colour · More — declared in `./editor`. */
  editor: { loadStrip: () => import('./editor') },

  defaults: DATE_DEFAULTS,
  validate: validateDate,

  loadDisplay: () => import('./display'),
  loadConfigPanel: () => import('./DateConfigPanel'),
});
