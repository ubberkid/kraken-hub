/** Read helpers over `AppState`. Pure, cheap, and reference-stable. */

import { selectBaseKind } from './look/selectors';

import type { AppState, ModuleId, ModuleSlot, RenderSettings } from './schema';

export {
  selectBaseKind,
  selectBaseLayer,
  selectLayer,
  selectLayerConfig,
  selectOverlays,
  switchBase,
  withLayer,
  withLayerConfig,
  withLook,
} from './look/selectors';

/**
 * The base kind, read from the base.
 *
 * Schema 7 gave the document a `look`, and `look.layers[0].kind` is where the
 * answer lives now — `activeModuleId` is the mirrored write path that
 * `validateAppState` keeps in lockstep with it for one release. Reading the base
 * is what makes the migration of the 21 call sites a no-op rather than a flag
 * day: they keep calling this, the value stops coming from the flat field, and
 * nothing observable changes. The `??` is for a document that has not been
 * through the validator.
 */
export function selectActiveModuleId(s: AppState): ModuleId {
  return selectBaseKind(s) ?? s.activeModuleId;
}

export function selectModuleSlot(s: AppState, id: ModuleId): ModuleSlot | null {
  return Object.hasOwn(s.modules, id) ? (s.modules[id] ?? null) : null;
}

/** Raw stored config for a module. The module's own `validate()` shapes it. */
export function selectModuleConfig(s: AppState, id: ModuleId): unknown {
  return selectModuleSlot(s, id)?.cfg;
}

export function selectRender(s: AppState): RenderSettings {
  return s.render;
}

/** `true` when the round mask should be applied for this panel shape. */
export function selectMaskCircle(s: AppState, shape: 'circle' | 'square'): boolean {
  const mode = s.render.maskCircle;
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return shape === 'circle';
}

/** Immutably replace one module's config slot. */
export function withModuleConfig(
  s: AppState,
  id: ModuleId,
  configVersion: number,
  cfg: unknown,
): AppState {
  return { ...s, modules: { ...s.modules, [id]: { v: configVersion, cfg } } };
}
