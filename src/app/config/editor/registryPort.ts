/**
 * The editor's view of the module registry — one interface, injected.
 *
 * The editor model is pure: it decides where a layer goes, not what a layer
 * IS. But three of its decisions need registry facts — can this kind be an
 * overlay (`roles`), how many of it may exist (`maxInstances`), and does a
 * resize gesture commit to the frame or to the scale (`resize`, §3.2) — so
 * those arrive through this port instead of an import.
 *
 * Why a port rather than `import { placementOf } from '../../../modules/stack'`:
 *
 *  - `src/modules/registry.ts` is EAGER. Importing it here would drag every
 *    module manifest into the `config-ui` chunk and, worse, make the editor's
 *    unit tests depend on whatever the registry happens to contain that week.
 *  - The tests can then state the placement they are testing against, in the
 *    test, in four lines (`fakeRegistry` below) — so "a second video is
 *    refused" is a fact about the OP, not about the video module.
 *
 * `EditorPlacement` is a structural SUBSET of `LayerPlacement` (§1.4), so the
 * real `placementOf(mod)` satisfies it without an adapter.
 */

import type { Frame, Transform, Units } from '../../../state/look/types';
import type { ModuleId } from '../../../state/schema';

export interface EditorPlacement {
  readonly roles: readonly ('base' | 'overlay')[];
  /** video 1, effect 2, everything else `MAX_LAYERS`. */
  readonly maxInstances: number;
  /** What the resize gesture commits to on release (§3.2). */
  readonly resize: 'frame' | 'scale';
  /** Diameter units; the editor clamps a frame to it. */
  readonly minFrame: Units;
  readonly overlayDefault: { frame: Exclude<Frame, 'panel'>; t: Transform };
}

export interface EditorRegistry {
  /** `null` = this build has never heard of the kind (a fork's module, an old look). */
  placementOf: (kind: ModuleId) => EditorPlacement | null;
  /**
   * A fresh config for a new overlay: the `modules` bank entry if the user has
   * one, else the kind's defaults. Absent → `{}`, which every module's
   * `validate()` turns into its own defaults anyway.
   */
  defaultConfigOf?: (kind: ModuleId) => unknown;
}

/**
 * A registry made of a plain table. Used by the editor's own tests, and by any
 * caller that wants to reason about placement without booting the registry.
 */
export function fakeRegistry(
  table: Readonly<Record<string, EditorPlacement>>,
  defaults?: Readonly<Record<string, unknown>>,
): EditorRegistry {
  return {
    placementOf: (kind) => table[kind] ?? null,
    defaultConfigOf: (kind) => defaults?.[kind] ?? {},
  };
}
