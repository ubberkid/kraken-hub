/**
 * `stats` — CPU/GPU temperature and load plus liquid temperature, from CAM's
 * 1 Hz monitoring feed.
 *
 * EAGER: the registry imports this so both pages can validate stored config and
 * parse URL parameters without downloading anything.
 */

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
     * FALSE, deliberately. The data source is 1 Hz; painting faster cannot
     * produce a different pixel whatever `targetFps` is. The one timer the
     * module owns exists to notice the feed going AWAY, not to render.
     */
    needsFrameLoop: false,
    usesMedia: false,
    hasTimeline: false,
    // A dial arc moving one step per second is not motion in the sense the
    // low-FPS advisory means; at 1 FPS this module is entirely correct.
    motionLevel: 'static',
    substrate: 'mixed',
    audio: 'none',
    remoteCommands: [],
  },
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
