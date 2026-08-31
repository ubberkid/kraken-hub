/** Read helpers over `AppState`. Pure, cheap, and reference-stable. */

import type { AppState, ModuleId, ModuleSlot, RenderSettings } from './schema';

export function selectActiveModuleId(s: AppState): ModuleId {
  return s.activeModuleId;
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
