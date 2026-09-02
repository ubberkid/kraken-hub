/**
 * `stats` — CPU/GPU temperature and load plus liquid temperature, from CAM's
 * 1 Hz monitoring feed.
 *
 * EAGER: the registry imports this so both pages can validate stored config and
 * parse URL parameters without downloading anything.
 */

import { IDENTITY, MAX_LAYERS } from '../../state/look/types';
import { defineModule } from '../defineModule';

import { STATS_DEFAULTS, STATS_LAYOUTS, validateStatsConfig, type StatsConfig } from './schema';

import type { KrakenModule } from '../types';

export const statsModule: KrakenModule<StatsConfig> = defineModule<StatsConfig>({
  id: 'stats',
  /**
   * One name, everywhere.
   *
   * It was `name: 'System stats'` with `chipName: 'Stats'`, and the round-2
   * audit caught the consequence: the home chip said "Stats", the panel heading
   * said "System stats", and the remote's module picker — which reads `name` —
   * said a third thing again from the row directly above it. A module that is
   * called two things is two modules to a person reading the screen.
   */
  name: 'Stats',
  summary: 'CPU and GPU temperature and load, plus liquid temperature, from CAM.',
  // Gauge glyph: a dial arc with a needle. Inline path data, no asset request.
  icon: 'M12 4a8 8 0 018 8h-2a6 6 0 10-2.2 4.63l1.4 1.42A8 8 0 1112 4zm.7 3.3l1.3 5.3-4 1.4 2.7-6.7z',
  configVersion: 1,
  capabilities: {
    // The whole point of the module.
    needsMonitoring: true,
    /*
     * TRUE since the face redesign, and the reason is the only reason that
     * would justify it.
     *
     * It was false, on the sound argument that the data source is 1 Hz and
     * painting faster cannot produce a different pixel. That holds only while
     * the module paints the SAMPLE. It paints a glide toward the sample now —
     * one tween per metric, ~400 ms, so a new reading arrives rather than
     * appearing — and between samples there genuinely is a different pixel.
     *
     * It is not a licence to be expensive: `frame()` returns on a boolean while
     * no tween is moving, which is most frames, and the module still declares
     * `cadence: 'tick'` below because the CHANGE it can produce is still capped
     * by a 1 Hz feed. The timer it kept exists to notice the feed going AWAY.
     */
    needsFrameLoop: true,
    usesMedia: false,
    hasTimeline: false,
    // A dial arc moving one step per second is not motion in the sense the
    // low-FPS advisory means; at 1 FPS this module is entirely correct.
    motionLevel: 'static',
    substrate: 'mixed',
    audio: 'none',
    remoteCommands: [],
  },

  /**
   * Stats over your video is the gesture the whole layer model exists for, so
   * this is the placement that had to be right.
   *
   * The overlay default is the `strip` face: a scrim along the bottom of the
   * panel with three compact ring meters on it. An OPAQUE scrim is not a
   * compromise — over a video it *reduces* the changed area CAM has to
   * compress, because the pixels underneath it stop moving.
   *
   * `resize: 'frame'` for the same reason as the clock: this is type and SVG,
   * and it should be laid out again rather than scaled.
   */
  layer: {
    roles: ['base', 'overlay'],
    maxInstances: MAX_LAYERS,
    resize: 'frame',
    minFrame: 0.4,
    overlayDefault: {
      frame: { w: 1.6, h: 0.5, shape: 'square' },
      t: { ...IDENTITY, y: 0.6 },
      // The face that makes it an overlay rather than a shrunken base.
      cfg: { ...STATS_DEFAULTS, layout: 'strip' },
    },
    /*
     * The feed is 1 Hz, so nothing here can paint faster than that whatever the
     * frame rate is, and a second's change is one arc segment and a digit or
     * two — `0.3` of its own box, flat fills, no gradient anywhere.
     */
    cost: () => ({ cadence: 'tick', coverage: 0.3, entropy: 'low', decoders: 0, gl: 0 }),
  },

  /** §2.3: metric · face · size · colour · More — declared in `./editor`. */
  editor: { loadStrip: () => import('./editor') },

  defaults: STATS_DEFAULTS,
  validate: validateStatsConfig,

  /** `?module=stats&layout=grid`. The host re-validates the result. */
  applyUrlParams(config, params) {
    let next: StatsConfig = config;
    const layout = params['layout'];
    if (layout !== undefined && (STATS_LAYOUTS as readonly string[]).includes(layout)) {
      next = { ...next, layout: layout as StatsConfig['layout'] };
    }
    return next;
  },

  loadDisplay: () => import('./display'),
  loadConfigPanel: () => import('./StatsConfigPanel'),
});
