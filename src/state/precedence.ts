/**
 * Config precedence: `defaults < persisted < remote < url`.
 *
 * The plan is authoritative here and it puts URL parameters on top: they are
 * per-key, non-persistent overrides that always win, so a link can drive a
 * display without mutating what the user saved in CAM. (design-architecture.md
 * §4.1 sketched the opposite order with a `?pin=1` escape hatch; the plan's
 * "Precedence: URL params ... always win" supersedes it, and `?pin=1` is
 * therefore a no-op that remains parsed and reserved.)
 *
 * Merge semantics: deep merge PER LEAF, later layer wins. Arrays replace
 * wholesale. `null` is a value, not an absence. `undefined` is an absence.
 */

import { isPlainObject } from '../lib/clamp';

import { defaultAppState } from './defaults';
import { validateAppState, type ValidationNote } from './validate';

import type { AppState, DeepPartial } from './schema';

export interface Layers {
  defaults?: AppState;
  persisted?: DeepPartial<AppState>;
  /** In-memory only: dropped on reload, recovered from the retained snapshot. */
  remote?: DeepPartial<AppState>;
  url?: DeepPartial<AppState>;
}

/** Deep-merges `patch` onto `base` per leaf. Neither input is mutated. */
export function mergeLeaf(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base;
  if (!isPlainObject(patch) || !isPlainObject(base)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = mergeLeaf(base[key], value);
  }
  return out;
}

export interface ResolveResult {
  state: AppState;
  notes: ValidationNote[];
  /** Dot paths whose value came from a layer above `persisted`. */
  overridden: string[];
}

function collectPaths(patch: unknown, prefix: string, out: Set<string>): void {
  if (!isPlainObject(patch)) {
    if (prefix.length > 0) out.add(prefix);
    return;
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    collectPaths(value, prefix.length > 0 ? `${prefix}.${key}` : key, out);
  }
}

/** Resolve the effective state from the four layers. Never throws. */
export function resolveState(layers: Layers): ResolveResult {
  const order = [layers.defaults ?? defaultAppState(), layers.persisted, layers.remote, layers.url];
  let merged: unknown = {};
  for (const layer of order) merged = mergeLeaf(merged, layer);

  const overridden = new Set<string>();
  collectPaths(layers.remote, '', overridden);
  collectPaths(layers.url, '', overridden);

  const { state, notes } = validateAppState(merged);
  return { state, notes, overridden: [...overridden].sort() };
}
