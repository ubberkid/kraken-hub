/**
 * What a merge unit IS — the one place the answer is written down.
 *
 * The merge is per-leaf last-writer-wins, so "leaf" is the single most
 * load-bearing definition in the sync layer: too coarse and two people editing
 * unrelated settings overwrite each other, too fine and a coherent value (a
 * playback sample, a layer's geometry) tears into pieces that were never true
 * together. It used to be answered in three places that disagreed —
 * `diffLeaves` walked to scalars, `applyCausally` walked to scalars again with
 * its own copy of the walk, and `Envelope.orig` capped a third enumeration by
 * insertion order — which is why a leaf could be claimed under one name and
 * arbitrated under another.
 *
 * One function now, with a test that pins the enumeration for a full document.
 *
 * ## The carving, and why each cut is where it is
 *
 *  - **`activeModuleId`** — the base kind. `look.layers[0].kind` is the same
 *    fact and is written from this leaf on the way out and forced to agree with
 *    it on the way in (`validateAppState` does the same for the stored
 *    document), so the two can never disagree on the wire. §1.2 of the layers
 *    design deletes the field at schema 8; until then it is mirrored, not
 *    duplicated.
 *  - **`playback`** — ATOMIC. `posSec` and `posAtTs` are only meaningful
 *    together: merging one peer's position with another peer's timestamp
 *    produces a seek to a place nobody was.
 *  - **`render.<key>`** — per key. Three people changing fit, rotation and zoom
 *    are doing three unrelated things, and the property seeds in
 *    `threePeerConvergence.dom.test.ts` assert exactly that.
 *  - **`modules.<kind>.cfg.<…>`** — per scalar key, which is the granularity
 *    `diffLeaves` always used: the module bank is a bag of independent
 *    settings, and a phone changing a clip must not revert somebody's fit.
 *  - **`look.layer.<id>`** — one leaf per layer, ATOMIC. A layer is a position,
 *    a size and a config that were composed together; half of one is not a
 *    layer. Reconciling by id is also what the compositor does (§2.6).
 *  - **`look.order`** — the z-order, as one array. Ordering is a fact about the
 *    whole stack rather than about any layer in it, and `mergeLeaf` replaces
 *    arrays wholesale anyway (§4.5).
 *
 * A layer id that appears in `look.order` with no layer leaf is skipped, and a
 * layer leaf no order mentions is dropped: the order leaf is what makes a layer
 * part of the look, so adding and removing are ordinary stamped writes.
 */

import { isPlainObject } from '../lib/clamp';
import { BASE_LAYER_ID, type Layer, type Look } from '../state/look/types';

import type { SyncStateBody } from './types';
import type { AppState, DeepPartial } from '../state/schema';

/** `look.order` — the z-order as one value. */
export const ORDER_LEAF = 'look.order';
/** Prefix for the per-layer leaves. */
export const LAYER_LEAF_PREFIX = 'look.layer.';
/** The base kind, mirrored into `look.layers[0].kind` on the way out. */
export const BASE_KIND_LEAF = 'activeModuleId';

/**
 * Structural equality, for "is this leaf already the value it is being set to?".
 *
 * Not `JSON.stringify` on both sides: key order is an accident of how two peers
 * built the same object, and treating `{a,b}` and `{b,a}` as different values
 * would restamp a leaf nobody changed on every frame.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => deepEqual(value, b[index]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => key in b && deepEqual(a[key], b[key]));
}

/** How a module slot and a layer are read off the wire: as claims, not as facts. */
type ModuleView = Record<string, unknown>;
type LayerView = Record<string, unknown>;

/** Every scalar path under `node`, prefixed. `undefined` is an absence. */
function scalarLeaves(node: unknown, prefix: string, out: Map<string, unknown>): void {
  if (node === undefined) return;
  if (!isPlainObject(node)) {
    out.set(prefix, node);
    return;
  }
  const entries = Object.entries(node);
  if (entries.length === 0) {
    // An empty object is itself a value — a module whose config is `{}`.
    out.set(prefix, {});
    return;
  }
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    scalarLeaves(value, `${prefix}.${key}`, out);
  }
}

/**
 * The leaves of one snapshot. THE enumeration — everything else in this layer
 * calls it rather than walking a body itself.
 */
export function enumerateLeaves(body: SyncStateBody): Map<string, unknown> {
  const out = new Map<string, unknown>();

  out.set(BASE_KIND_LEAF, body.activeModuleId);
  out.set('playback', body.playback);

  const render = body.render as unknown as Record<string, unknown> | undefined;
  if (isPlainObject(render)) {
    for (const [key, value] of Object.entries(render)) {
      if (value === undefined) continue;
      out.set(`render.${key}`, value);
    }
  }

  /*
   * Read through an `unknown` view from here on, and that is not pedantry: a
   * `SyncStateBody` off the wire has been shape-checked by `decodeEnvelope` only
   * as far as the envelope, so the declared types are a claim the SENDER made
   * about its own body. The document is validated after the merge, not before
   * it, so this walk has to survive a slot that is not an object and a layer
   * with no id.
   */
  const modules = body.modules as unknown as Record<string, ModuleView | undefined>;
  for (const [kind, slot] of Object.entries(modules)) {
    if (!isPlainObject(slot)) continue;
    if (slot['v'] !== undefined) out.set(`modules.${kind}.v`, slot['v']);
    scalarLeaves(slot['cfg'], `modules.${kind}.cfg`, out);
  }

  const layers = body.look?.layers as unknown as (LayerView | undefined)[] | undefined;
  if (Array.isArray(layers)) {
    const ids: string[] = [];
    for (const layer of layers) {
      if (!isPlainObject(layer)) continue;
      const id = layer['id'];
      if (typeof id !== 'string' || id.length === 0) continue;
      ids.push(id);
      out.set(`${LAYER_LEAF_PREFIX}${id}`, layer);
    }
    out.set(ORDER_LEAF, ids);
  }

  return out;
}

/** Write one dot path into a patch, cloning every object it walks. */
function withPath(base: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor = base;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    const child = isPlainObject(next) ? { ...next } : {};
    cursor[part] = child;
    cursor = child;
  }
  const last = parts[parts.length - 1];
  if (last !== undefined) cursor[last] = value;
}

/**
 * The inverse: a set of leaves as a precedence patch.
 *
 * `look` is rebuilt from `look.order` plus the per-layer leaves, and the base
 * layer's `kind` is forced to the `activeModuleId` leaf — the one place the
 * mirroring is enforced, so a merge that took the two from different peers
 * still produces a document where they agree.
 */
export function leavesToPatch(leaves: ReadonlyMap<string, unknown>): DeepPartial<AppState> {
  const out: Record<string, unknown> = {};
  const layers: Layer[] = [];
  const order = leaves.get(ORDER_LEAF);

  for (const [path, value] of leaves) {
    if (path === ORDER_LEAF || path.startsWith(LAYER_LEAF_PREFIX)) continue;
    withPath(out, path, value);
  }

  if (!Array.isArray(order)) return out;

  for (const id of order) {
    if (typeof id !== 'string') continue;
    const layer = leaves.get(`${LAYER_LEAF_PREFIX}${id}`);
    if (!isPlainObject(layer)) continue;
    layers.push(layer as unknown as Layer);
  }
  const kind = leaves.get(BASE_KIND_LEAF);
  const base = layers[0];
  if (typeof kind === 'string' && base !== undefined)
    layers[0] = { ...base, id: BASE_LAYER_ID, kind };
  return { ...out, look: { layers } };
}

/**
 * The body of a look, with the base kind mirrored into `layers[0].kind`.
 *
 * Called on the way OUT so a receiver never has to reconcile two answers, and
 * on the way in by `leavesToPatch` for the same reason.
 */
export function withBaseKind(look: Look, kind: string): Look {
  const base = look.layers[0];
  if (base === undefined || base.kind === kind) return look;
  const next: Layer = { ...base, kind };
  return { layers: [next, ...look.layers.slice(1)] };
}
