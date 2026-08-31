/**
 * Identity helper with DEV-only shape assertions.
 *
 * It exists for two reasons: type inference (so a module author writes
 * `defaults` once and everything else is inferred), and failing loudly in
 * development instead of silently on a cooler.
 */

import { createLogger } from '../lib/log';

import type { KrakenModule } from './types';

const log = createLogger('modules');

export const MODULE_ID_PATTERN = /^[a-z][a-z0-9-]{1,23}$/;
const MAX_DEFAULTS_BYTES = 4096;

export function defineModule<C>(mod: KrakenModule<C>): KrakenModule<C> {
  if (import.meta.env.DEV) {
    if (!MODULE_ID_PATTERN.test(mod.id)) {
      log.error(`module id "${mod.id}" must match ${MODULE_ID_PATTERN.source}`);
    }
    if (mod.configVersion < 1) {
      log.error(`module "${mod.id}": configVersion must be >= 1`);
    }
    if (mod.configVersion > 1 && mod.migrateConfig === undefined) {
      log.error(`module "${mod.id}": configVersion > 1 requires migrateConfig()`);
    }
    const bytes = JSON.stringify(mod.defaults).length;
    if (bytes > MAX_DEFAULTS_BYTES) {
      log.error(
        `module "${mod.id}": defaults are ${String(bytes)} bytes (max ${String(MAX_DEFAULTS_BYTES)})`,
      );
    }
  }
  return mod;
}
