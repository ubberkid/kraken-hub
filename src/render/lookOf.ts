/**
 * The adapter between the document and the compositor.
 *
 * `LayerHost` renders a `Look`. The stored document HAS one as of schema 7 — so
 * this is now mostly a read of `state.look` — but it may not on a peer running
 * an older build, on a v6 wire body, or on a snapshot restored from a browser
 * that predates looks entirely. So the compositor is never handed `state.look`
 * directly; it is handed `lookOf(state)`, which is TOTAL: every input, up to and
 * including `undefined` and a corrupt blob, produces a valid one-layer look.
 *
 * That totality is the whole point. The alternative — the display asserting a
 * field that has not shipped — is a black panel on exactly the machines nobody
 * is watching. `lookOf` degrades in one direction only: to the base-only look
 * the single-module display has always rendered, derived from `activeModuleId`
 * with the same `baseLook()` the 6 → 7 migration and the legacy wire projection
 * use, so all three agree byte for byte.
 *
 * See docs/design/design-layers-architecture.md §4.2 and §6.1.
 */

import { isPlainObject } from '../lib/clamp';
import { DEFAULT_MODULE_ID } from '../state/defaults';
import { baseLook, type Layer, type LayerId, type Look } from '../state/look/types';
import { validateLook } from '../state/look/validate';
import { MODULE_ID_RE } from '../state/validate';

import type { LayerConfigs } from './LayerHost';
import type { GetModule } from '../modules/stack';
import type { ModuleId, ModuleSlot } from '../state/schema';

/**
 * The look this document describes.
 *
 * A `look` that is present and has at least one layer is validated and used —
 * the ordinary path since schema 7, and the reason a `?module=` link changes the
 * base kind rather than the arrangement: `validateAppState` maps the flat
 * `activeModuleId` (which is where `?module=` still lands) onto the base and
 * leaves the overlays standing, so by the time the field reaches here it already
 * says what the URL asked for. A document WITHOUT a look — a v6 snapshot, an
 * older peer's wire body — projects its `activeModuleId` into a base-only look
 * with the same `baseLook()` the 6 → 7 migration uses. Anything else falls back
 * to the default module: the panel shows something.
 */
export function lookOf(state: unknown): Look {
  if (!isPlainObject(state)) return baseLook(DEFAULT_MODULE_ID);

  const raw = state['look'];
  if (isPlainObject(raw) && Array.isArray(raw['layers']) && raw['layers'].length > 0) {
    return validateLook(raw).look;
  }

  const kind = state['activeModuleId'];
  return baseLook(typeof kind === 'string' && MODULE_ID_RE.test(kind) ? kind : DEFAULT_MODULE_ID);
}

/** The slice of the document a config resolution needs: the per-kind bank. */
export interface ConfigBank {
  modules: Record<ModuleId, ModuleSlot>;
}

/**
 * Resolve every layer's config to the shape its renderer expects.
 *
 * A config has exactly one home, decided by POSITION (§4.1):
 *
 *   base    `state.modules[kind].cfg` — the per-kind bank — plus any URL params,
 *           which is why switching the base away and back does not lose your
 *           settings and why `?module=video&src=…` still works.
 *   overlay `layer.cfg`, verbatim, run through the kind's `migrateConfig` at the
 *           point of use rather than rewritten in the document.
 *
 * Every result goes through the module's own `validate()`, which must not throw,
 * so a corrupt overlay config degrades to that module's defaults instead of
 * taking the layer down.
 */
export function configsOf(
  look: Look,
  bank: ConfigBank,
  registry: GetModule,
  moduleParams: Readonly<Record<string, string>> = {},
): LayerConfigs {
  const out: Record<LayerId, unknown> = {};
  for (const layer of look.layers) {
    out[layer.id] = configOfLayer(layer, bank, registry, moduleParams);
  }
  return out;
}

function configOfLayer(
  layer: Layer,
  bank: ConfigBank,
  registry: GetModule,
  moduleParams: Readonly<Record<string, string>>,
): unknown {
  const mod = registry(layer.kind);
  // An unknown kind is preserved verbatim: this build cannot validate a config
  // it has never seen, and destroying it would lose a fork's work on a round trip.
  if (mod === null) return layer.cfg;

  if (layer.frame === 'panel') {
    let next: unknown = mod.validate(bank.modules[layer.kind]?.cfg);
    if (mod.applyUrlParams !== undefined && Object.keys(moduleParams).length > 0) {
      next = mod.validate(mod.applyUrlParams(next, moduleParams));
    }
    return next;
  }

  const raw =
    layer.v !== undefined && mod.migrateConfig !== undefined
      ? mod.migrateConfig(layer.v, layer.cfg)
      : layer.cfg;
  return mod.validate(raw);
}
