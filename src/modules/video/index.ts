// `config/words.ts`, not `config/vocabulary.ts`: this file is EAGER and on the
// display path, so a static import of the whole dictionary would ship ~0.38 kB
// gzip of config-only sentences in `core`. The dictionary re-exports this term,
// so it is still written once. See `src/config/words.ts`.
import { KEPT_A_COPY } from '../../config/words';
import { IDENTITY } from '../../state/look/types';
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

  /**
   * Base-only, one instance (§0.4, §11.3).
   *
   * Not a limitation that fell out of the implementation — a rule that removes
   * four separate hazards in one line: a second hardware decoder, the module's
   * `let context` telemetry singleton, `RenderController`'s promoted stage, and
   * an `<iframe>` that re-navigates the moment `insertBefore` moves it. Because
   * the base never moves in the DOM, reorders only ever touch overlays.
   *
   * `overlayDefault` and `minFrame` are unreachable while `roles` is `['base']`
   * and exist only because the type asks for them.
   */
  layer: {
    roles: ['base'],
    maxInstances: 1,
    // A video scales; re-laying out a decoder to resize it would be absurd.
    resize: 'scale',
    minFrame: 0.5,
    overlayDefault: { frame: { w: 1, h: 1, shape: 'square' }, t: IDENTITY },
    cost: () => ({ cadence: 'frame', coverage: 1, entropy: 'high', decoders: 1, gl: 0 }),
  },

  /** §2.3: source · fit · loop · quality · More — declared in `./editor`. */
  editor: { loadStrip: () => import('./editor') },

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
   *
   * `loop` arrives in one of two spellings, both already validated by
   * `src/state/urlParams.ts`: `1`/`0` — loop the whole clip, or stop looping —
   * and `"<start>-<end>"`, the A-B loop in seconds. The range is what a kiosk
   * link is usually for ("play these nineteen seconds forever"), and it is the
   * spelling docs/getting-started.md has always promised.
   *
   * The END is taken at face value HERE and checked against the media LATER:
   * nothing in a manifest knows how long a clip is, and the loop rules (§3.2)
   * already clamp an end past the duration — and an end guard before it — on
   * the frame the clip reports one. So a link that asks for `0-9999` on a
   * ten-second clip loops the whole clip rather than being refused.
   */
  applyUrlParams(config, params) {
    let next: VideoModuleConfig = config;
    const src = params['src'];
    if (src !== undefined && src.length > 0) next = { ...next, url: src };
    const loop = params['loop'];
    if (loop === '1' || loop === '0') {
      next = { ...next, loop: { ...next.loop, enabled: loop === '1' } };
    } else if (loop !== undefined) {
      /*
       * The pair to `parseLoopRange` in `src/state/urlParams.ts`, which has
       * already rejected everything that is not two non-negative seconds with
       * `start < end`. Re-checked rather than trusted, because `applyUrlParams`
       * is a public seam a fork can call with anything.
       */
      const [rawStart, rawEnd] = loop.split('-');
      const start = Number(rawStart);
      const end = Number(rawEnd);
      if (
        rawStart !== undefined &&
        rawEnd !== undefined &&
        rawStart.length > 0 &&
        rawEnd.length > 0 &&
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        start >= 0 &&
        start < end
      ) {
        next = { ...next, loop: { ...next.loop, enabled: true, start, end } };
      }
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
