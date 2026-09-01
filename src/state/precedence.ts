/**
 * Config precedence: `defaults < persisted < remote < local < url`.
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
  /**
   * Edits this page made itself that are **newer than every remote frame seen
   * so far**. In-memory only, and normally empty.
   *
   * It exists because the remote layer is sticky: once a peer has said "the
   * active module is video", that entry outranks everything this page saves,
   * for the life of the page. So switching to Clock in CAM wrote `clock` to
   * storage, showed it — and reverted the moment any state frame arrived and
   * this function ran again with a remote layer that still said `video`. A
   * retained snapshot redelivered on a reconnect is enough, which is why it
   * looks intermittent rather than broken.
   *
   * The ordering rule is the Lamport `rev` the envelope already carries, so
   * this is not "local always wins" — that would break the phone remote. It is
   * "a remote frame that is not strictly newer than this page's last commit
   * cannot overwrite it". A genuine change from a phone carries a higher `rev`,
   * clears this layer and wins, exactly as before. `src/sync/appSync.ts` owns
   * that comparison; this file only owns the order.
   */
  local?: DeepPartial<AppState>;
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

/** Resolve the effective state from the five layers. Never throws. */
export function resolveState(layers: Layers): ResolveResult {
  const order = [
    layers.defaults ?? defaultAppState(),
    layers.persisted,
    layers.remote,
    layers.local,
    layers.url,
  ];
  let merged: unknown = {};
  for (const layer of order) merged = mergeLeaf(merged, layer);

  const overridden = new Set<string>();
  collectPaths(layers.remote, '', overridden);
  collectPaths(layers.local, '', overridden);
  collectPaths(layers.url, '', overridden);

  const { state, notes } = validateAppState(merged);
  return { state, notes, overridden: [...overridden].sort() };
}
