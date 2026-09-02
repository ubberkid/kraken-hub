/**
 * STEP 4 — declare the module, then add ONE import and ONE array entry in
 * `src/modules/registry.ts`. No build config, no routing, no state migration.
 *
 * This directory is intentionally NOT registered; `_template` is a starting
 * point, and the leading underscore keeps it out of the module id space.
 */

import { IDENTITY, MAX_LAYERS } from '../../state/look/types';
import { defineModule } from '../defineModule';

import { TEMPLATE_DEFAULTS, validateTemplate, type TemplateConfig } from './schema';

import type { KrakenModule } from '../types';

export const templateModule: KrakenModule<TemplateConfig> = defineModule<TemplateConfig>({
  id: 'template',
  name: 'Template',
  summary: 'Copy this directory to start a new module.',
  icon: 'M4 4h16v16H4z',
  configVersion: 1,
  capabilities: {
    needsMonitoring: false,
    needsFrameLoop: false,
    usesMedia: false,
    hasTimeline: false,
    motionLevel: 'static',
    substrate: 'dom',
    audio: 'none',
    remoteCommands: [],
  },

  /**
   * STEP 5b (docs/modules.md §7) — where your module may sit in a look.
   *
   * `['base', 'overlay']` is the right answer for almost everything: a renderer
   * that lays itself out from `ctx.geometry()` — which is the only supported way
   * to lay anything out — is already an overlay, because a layer's `geometry()`
   * is its own box. Declare `['base']` only if you own something there can be
   * exactly one of, the way `video` owns the decoder.
   *
   *  - `resize`: `'frame'` for text and SVG (re-lay out, stay crisp), `'scale'`
   *    for pixels and canvases (one style write, no reflow). §3.2.
   *  - `minFrame`: the smallest DIAMETER, in units, at which you are still
   *    legible. The editor clamps to it.
   *  - `overlayDefault`: where a fresh overlay lands, plus any config that makes
   *    it an overlay (stats switches to its `strip` face here).
   *  - `cost()`: pure, tiny, called on every keystroke in the editor. Declare
   *    what you ACTUALLY do — a `'frame'` cadence you do not need makes every
   *    look containing you look expensive and trips the governor early.
   */
  layer: {
    roles: ['base', 'overlay'],
    maxInstances: MAX_LAYERS,
    resize: 'frame',
    minFrame: 0.3,
    overlayDefault: { frame: { w: 1, h: 0.5, shape: 'square' }, t: { ...IDENTITY, y: 0.55 } },
    cost: () => ({ cadence: 'static', coverage: 1, entropy: 'low', decoders: 0, gl: 0 }),
  },

  defaults: TEMPLATE_DEFAULTS,
  validate: validateTemplate,
  loadDisplay: () => import('./display'),
  loadConfigPanel: () => import('./TemplateConfig'),
});
