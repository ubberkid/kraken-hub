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
import { dateModule } from './date';
import { effectModule } from './effect';
import { iconModule } from './icon';
import { imageModule } from './image';
import { shapeModule } from './shape';
import { statsModule } from './stats';
import { textModule } from './text';
import { videoModule } from './video';

import type { AnyKrakenModule } from './types';

/**
 * Order is the order of the module chips on the home screen, and of the module
 * picker everywhere else: **video, clock, stats, image**, exactly as the
 * approved design puts them (docs/design/halo-prototype.html, screen 1).
 *
 * It is ordered by how often a chip is pressed, not by how the code is grouped.
 * The old order paired video with image because both are "media"; in use, the
 * clock is what people switch to when they want the panel to stop moving, and
 * the stats readout is what they switch to when the machine is working. Image
 * is the one that needs a library behind it first, so it sits last.
 *
 * `clock-lite` (M0's placeholder) was removed in M3 and replaced by `clock`;
 * state migration 3 → 4 rewrites `activeModuleId` and moves the stored config
 * across, so nobody's cooler goes blank.
 *
 * `text` and `shape` (W7) sit after the four, and deliberately last: they are
 * LAYER kinds first — a line of words and a flat ground you put on top of
 * something else — so they are what a look reaches for once it has a base,
 * rather than what a chip on the home screen switches the whole panel to. Text
 * declares `roles: ['overlay']` for exactly that reason.
 *
 * `icon` and `date` (the §10 parity round) sit last for the same reason and one
 * more: both are overlay-only, so neither can ever be what a home-screen chip
 * switches the panel TO. They are the small things a composed look puts on top
 * of whatever is already there — a glyph beside a temperature, a date line
 * under a clock.
 */
export const MODULES: readonly AnyKrakenModule[] = [
  videoModule,
  clockModule,
  statsModule,
  imageModule,
  textModule,
  shapeModule,
  effectModule,
  iconModule,
  dateModule,
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
