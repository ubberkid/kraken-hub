/**
 * STEP 4 — declare the module, then add ONE import and ONE array entry in
 * `src/modules/registry.ts`. No build config, no routing, no state migration.
 *
 * This directory is intentionally NOT registered; `_template` is a starting
 * point, and the leading underscore keeps it out of the module id space.
 */

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
  defaults: TEMPLATE_DEFAULTS,
  validate: validateTemplate,
  loadDisplay: () => import('./display'),
  loadConfigPanel: () => import('./TemplateConfig'),
});
