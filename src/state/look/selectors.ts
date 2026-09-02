/**
 * Read and write helpers over a document's `look`. Pure, cheap, DOM-free.
 *
 * These are written against a STRUCTURAL slice (`LookState`) rather than
 * `AppState`. That is no longer a way of landing the model before the schema
 * bump — schema 7 shipped, and `AppState` satisfies `LookState` structurally, so
 * every helper here IS an `AppState → AppState` helper at the call sites, with
 * no cast and no second implementation (`src/state/selectors.ts` re-exports them
 * as the document's own, and a type test there pins the binding). The slice
 * stays because it is also what a look FILE, an editor snapshot and a wire body
 * satisfy: the helpers should not need a whole document to move a layer.
 *
 * The one rule they all obey: the base (`layers[0]`) never carries a `cfg`. It
 * wears `modules[kind].cfg` — the per-kind bank — which is why `switchBase`
 * keeps the outgoing kind's config exactly where it was (swap back and your
 * settings are still there) and why `withLayerConfig` writes to the bank when
 * you address index 0.
 *
 * See docs/design/design-layers-architecture.md §4.3.
 */

import { baseLook, type Layer, type LayerId, type Look } from './types';

import type { ModuleId, ModuleSlot } from '../schema';

/** The slice of the document these helpers need. `AppState` satisfies it as of schema 7. */
export interface LookState {
  look: Look;
  modules: Record<ModuleId, ModuleSlot>;
}

export function selectBaseLayer(s: LookState): Layer | null {
  return s.look.layers[0] ?? null;
}

/** Replaces the old `selectActiveModuleId`: the base's kind IS the active module. */
export function selectBaseKind(s: LookState): ModuleId | null {
  return selectBaseLayer(s)?.kind ?? null;
}

export function selectLayer(s: LookState, id: LayerId): Layer | null {
  return s.look.layers.find((l) => l.id === id) ?? null;
}

/** Everything above the base, bottom-first. */
export function selectOverlays(s: LookState): Layer[] {
  return s.look.layers.slice(1);
}

/** The base reads the bank; an overlay carries its own. Raw — the module's `validate()` shapes it. */
export function selectLayerConfig(s: LookState, layer: Layer): unknown {
  return layer.cfg ?? s.modules[layer.kind]?.cfg;
}

export function withLook<S extends LookState>(s: S, look: Look): S {
  return { ...s, look };
}

/**
 * Patch one layer in place. `id`, and at index 0 the positional fields the base
 * may not own, are not patchable — the invariant is structural, so no caller
 * gets to argue with it.
 */
export function withLayer<S extends LookState>(
  s: S,
  id: LayerId,
  patch: Partial<Omit<Layer, 'id'>>,
): S {
  const layers = s.look.layers.map((layer, i) => {
    if (layer.id !== id) return layer;
    if (i > 0) return { ...layer, ...patch };
    // The base owns exactly three patchable fields; `frame`, `t`, `cfg` and `v`
    // are fixed by position (§4.1) and silently ignored here.
    const { kind, on, name } = patch;
    const next: Layer = { ...layer };
    if (kind !== undefined) next.kind = kind;
    if (on !== undefined) next.on = on;
    if (name !== undefined) next.name = name;
    return next;
  });
  return withLook(s, { layers });
}

/**
 * Write a layer's config to its one home: the bank for the base, the layer for
 * an overlay.
 */
export function withLayerConfig<S extends LookState>(
  s: S,
  id: LayerId,
  configVersion: number,
  cfg: unknown,
): S {
  const index = s.look.layers.findIndex((l) => l.id === id);
  const layer = s.look.layers[index];
  if (layer === undefined) return s;
  if (index === 0) {
    // Mirrors `withModuleConfig` in ../selectors.ts, generically.
    return { ...s, modules: { ...s.modules, [layer.kind]: { v: configVersion, cfg } } };
  }
  return withLayer(s, id, { v: configVersion, cfg });
}

/**
 * Replace the base kind. Overlays survive; the outgoing kind's config stays in
 * the bank, so switching away and back is not a way to lose your settings.
 */
export function switchBase<S extends LookState>(s: S, kind: ModuleId): S {
  const { layers } = baseLook(kind);
  return withLook(s, { layers: [...layers, ...s.look.layers.slice(1)] });
}
