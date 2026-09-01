import { KEPT_A_COPY } from '../../config/vocabulary';
import { defineModule } from '../defineModule';

import { VIDEO_DEFAULTS, validateVideoConfig, type VideoModuleConfig } from './types';

import type { KrakenModule } from '../types';

/**
 * `video` — the flagship module, and the default on a fresh install.
 *
 * This file is EAGER: the registry imports it so both pages can validate stored
 * config and parse URL params without downloading anything. Everything that
 * touches the DOM, IndexedDB or the network is behind `loadDisplay()` /
 * `loadConfigPanel()`, so the hidden Kraken Browser downloads the player only
 * when the video module is the active one, and never downloads the panel.
 */
export const videoModule: KrakenModule<VideoModuleConfig> = defineModule<VideoModuleConfig>({
  id: 'video',
  name: 'Video',
  summary: `Plays a pasted link — ${KEPT_A_COPY} and played from disk.`,
  // Play glyph in a rounded frame; inline path data, so no asset request.
  icon: 'M4 4h16a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2zm6 4v8l6-4-6-4z',
  configVersion: 2,
  capabilities: {
    needsMonitoring: false,
    // The A-B loop's rAF tick lives in the module; the frame clock also feeds
    // the `perf: 'auto'` promotion in §8.3.
    needsFrameLoop: true,
    usesMedia: true,
    hasTimeline: true,
    // Full motion: this is exactly the module CAM's 1 FPS default ruins, which
    // is what arms the low-FPS advisory.
    motionLevel: 'full',
    // §8.1 — the module renders the advisory inside its own safe-area overlays
    // and owns the config-side dismiss key, so the shell's banner stands down.
    ownsFpsAdvisory: true,
    substrate: 'dom',
    audio: 'optional',
    remoteCommands: ['setSource', 'setLoop', 'setRender', 'play', 'hold'],
  },
  defaults: VIDEO_DEFAULTS,
  validate: validateVideoConfig,

  /**
   * 1 → 2: the `quality` setting (`./quality.ts`).
   *
   * The step is a no-op by construction, and that is the point of writing it
   * down rather than leaving `configVersion` at 1. `validateVideoConfig` fills
   * a missing `quality` from `DEFAULT_QUALITY` — `{ mode: 'auto', height: null }`
   * — which is exactly what every existing installation was already doing: no
   * pin, the provider's own adaptive logic, whatever the geometry ladder said
   * for YouTube. Nobody's picture changes on upgrade.
   *
   * The version still has to move, because it is what a v1 build reads to
   * decide whether it understands the document. A v1 reader handed a `quality`
   * key would silently drop it on the next write and quietly un-pin somebody's
   * 1080p — the version is what turns that into a visible "written by a newer
   * build" instead.
   */
  migrateConfig(fromVersion, raw) {
    if (fromVersion >= 2) return raw;
    return raw;
  },

  /**
   * `?src=`, `?loop=`, `?mute=`, `?demo=1`. Raw strings straight off the query
   * string: the result is passed back through `validate()` by the host, so
   * nothing here has to be defensive about ranges.
   */
  applyUrlParams(config, params) {
    let next: VideoModuleConfig = config;
    const src = params['src'];
    if (src !== undefined && src.length > 0) next = { ...next, url: src };
    const loop = params['loop'];
    if (loop !== undefined) {
      next = { ...next, loop: { ...next.loop, enabled: loop === '1' } };
    }
    const mute = params['mute'];
    if (mute !== undefined) next = { ...next, audioEnabled: mute !== '1' };
    // `?demo=1` forces the bundled clip regardless of what is configured, which
    // is what makes it a reliable "is the display alive?" probe.
    if (params['demo'] === '1') next = { ...next, url: '', demoWhenEmpty: true };
    return next;
  },

  loadDisplay: () => import('./display'),
  loadConfigPanel: () => import('./VideoConfigPanel'),
});
