/**
 * ★ THE ONE FILE A CONTRIBUTOR EDITS to add a module.
 *
 * Metadata (`id`, `name`, `defaults`, `validate`, `capabilities`, `icon`) is
 * eager and cheap — both pages need it to validate state and parse URL params.
 * `loadDisplay()` and `loadConfigPanel()` are lazy, so the LCD downloads
 * exactly one module's render code and the config page downloads a panel only
 * when its route is visited.
 */

import { DEFAULT_MODULE_ID } from '../state/defaults';

import { clockModule } from './clock';
import { imageModule } from './image';
import { statsModule } from './stats';
import { videoModule } from './video';

import type { AnyKrakenModule } from './types';

/**
 * Order is the order of the module picker in the configuration UI: the
 * flagship first, then the two media-ish modules, then the sensor readout.
 *
 * `clock-lite` (M0's placeholder) was removed in M3 and replaced by `clock`;
 * state migration 3 → 4 rewrites `activeModuleId` and moves the stored config
 * across, so nobody's cooler goes blank.
 */
export const MODULES: readonly AnyKrakenModule[] = [
  videoModule,
  imageModule,
  clockModule,
  statsModule,
];

export { DEFAULT_MODULE_ID };

const byId = new Map(MODULES.map((m) => [m.id, m]));

export function getModule(id: string): AnyKrakenModule | null {
  return byId.get(id) ?? null;
}

/** The active module, falling back to the default when the id is unknown. */
export function resolveModule(id: string): AnyKrakenModule {
  const found = byId.get(id) ?? byId.get(DEFAULT_MODULE_ID);
  if (found === undefined) {
    throw new Error(`kraken-hub: DEFAULT_MODULE_ID "${DEFAULT_MODULE_ID}" is not registered`);
  }
  return found;
}

export function listModules(): readonly AnyKrakenModule[] {
  return MODULES;
}
