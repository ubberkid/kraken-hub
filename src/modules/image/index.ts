/**
 * `image` — a still picture or a GIF, downloaded into its own library and
 * painted from disk.
 *
 * EAGER: the registry imports this so both pages can validate stored config and
 * parse URL parameters without downloading anything. Everything that touches
 * the DOM, IndexedDB or the network is behind `loadDisplay()` /
 * `loadConfigPanel()`.
 */

import { IDENTITY, MAX_LAYERS } from '../../state/look/types';
import { defineModule } from '../defineModule';

import { IMAGE_DEFAULTS, validateImageConfig, type ImageModuleConfig } from './schema';

import type { KrakenModule } from '../types';

export const imageModule: KrakenModule<ImageModuleConfig> = defineModule<ImageModuleConfig>({
  id: 'image',
  name: 'Image',
  summary: 'A picture or GIF — downloaded into a local library and painted from disk.',
  // Picture-frame glyph with a mountain; inline path data, so no asset request.
  icon: 'M4 4h16a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2zm2 12l3.5-4.5 2.5 3 3.5-4.5L20 17H6z',
  configVersion: 1,
  capabilities: {
    needsMonitoring: false,
    // Nothing changes per frame. A still picture repaints when the config, the
    // geometry or the slideshow says so, and a GIF is animated by the browser.
    needsFrameLoop: false,
    usesMedia: true,
    hasTimeline: false,
    /*
     * `'static'` for a still, and still `'static'` here for a GIF: the low-FPS
     * advisory exists to tell a user their VIDEO is being ruined by CAM's 1 FPS
     * default. A GIF at 1 FPS is degraded but legible, and the honest place to
     * say so is the config panel's `animated-capture-fps` note, which names the
     * exact slider — not a card covering the picture on the panel.
     */
    motionLevel: 'static',
    substrate: 'dom',
    audio: 'none',
    remoteCommands: ['setSource', 'setRender'],
  },

  /**
   * A picture is the archetypal overlay: a logo in a corner, a badge over a
   * video. `resize: 'scale'` because a raster has one true size and scaling it
   * is one style write — re-laying it out at a new frame would decode nothing
   * new and cost a reflow.
   *
   * The default lands top-right in a circle, out of the way of both the clock
   * and the stats strip, which default to the bottom.
   */
  layer: {
    roles: ['base', 'overlay'],
    maxInstances: MAX_LAYERS,
    resize: 'scale',
    minFrame: 0.3,
    overlayDefault: {
      frame: { w: 0.8, h: 0.8, shape: 'circle' },
      t: { ...IDENTITY, x: 0.45, y: -0.45 },
    },
    /*
     * A still picture repaints when something asks it to, which is never on its
     * own — except a slideshow, which changes the whole frame once per interval.
     * `mid` entropy: photographs compress worse than a dial, better than video.
     */
    cost: (cfg) => ({
      // `Partial`, not the config type: `cost()` is called with whatever the
      // editor is holding, which during a paste is a half-validated object.
      cadence:
        (cfg as Partial<ImageModuleConfig> | null)?.slideshow?.enabled === true ? 'tick' : 'static',
      coverage: 1,
      entropy: 'mid',
      decoders: 0,
      gl: 0,
    }),
  },

  /**
   * §2.3: source · fit · opacity · More — declared in `./editor`, which the
   * config page fetches on first selection.
   */
  editor: { loadStrip: () => import('./editor') },

  defaults: IMAGE_DEFAULTS,
  validate: validateImageConfig,

  /**
   * `?module=image&src=https://…`. The host re-validates the result.
   *
   * `?fit=` is deliberately NOT read here: it is a global parameter that patches
   * `AppState.render`, exactly as it does for the video module, and the module's
   * own `render.fit` is the per-module setting the panel writes.
   */
  applyUrlParams(config, params) {
    let next: ImageModuleConfig = config;
    const src = params['src'];
    if (src !== undefined && src.length > 0) next = { ...next, url: src };
    return next;
  },

  loadDisplay: () => import('./display'),
  loadConfigPanel: () => import('./ImageConfigPanel'),
});
