/**
 * Every edit a look can undergo, as pure functions.
 *
 * The UI — halo handles, the phone ring, the chip row — may call ONLY these.
 * That is the whole point of the boundary: a drag on the phone and a drag on
 * the desktop run the same `setTransform`, so they cannot disagree about what a
 * drag means, and a refusal is a value the UI can render rather than an
 * exception it has to catch.
 *
 * Two rules run through all of it:
 *
 *  - **A refusal is typed and explicit.** Adding a ninth layer, a second video
 *    or a look over `MAX_LOOK_BYTES` returns `{ ok:false, reason }`. It never
 *    silently drops a layer, and it never writes a document the wire would have
 *    to truncate (§6.2 refuses to truncate `layers`, so the refusal has to
 *    happen here, at op time, where there is still a person to tell).
 *  - **Every op leaves through `validateLook`.** The positional invariants (base
 *    has no `cfg`, overlays are boxes, transforms are clamped) are enforced on
 *    the way OUT of every op, so no op has to remember them and none of them
 *    can produce a document the display would have to repair.
 *
 * Registry facts arrive through `EditorRegistry` (see `registryPort.ts`).
 *
 * See docs/design/design-layers-architecture.md §8.
 */

import { clamp } from '../../../lib/clamp';
import { randomId } from '../../../lib/id';
import {
  BASE_LAYER_ID,
  IDENTITY,
  MAX_LAYERS,
  MAX_LAYER_NAME,
  MAX_LOOK_BYTES,
  TRANSFORM_LIMITS,
  lookBytes,
  type Frame,
  type Layer,
  type LayerId,
  type Look,
  type Transform,
} from '../../../state/look/types';
import { validateLook } from '../../../state/look/validate';

import type { EditorRegistry } from './registryPort';
import type { ModuleId } from '../../../state/schema';

/** Why an op said no, in words the UI can turn into a sentence. */
export type OpRefusal =
  'max-layers' | 'max-instances' | 'role' | 'too-big' | 'unknown-kind' | 'locked';

export type OpResult = { ok: true; look: Look; id?: LayerId } | { ok: false; reason: OpRefusal };

/** Frame sides are clamped to the same window the validator uses. */
const FRAME_MAX = 3;

/** The nudge a duplicate gets so it is visibly a second thing, in units. */
const DUPLICATE_OFFSET = 0.06;

function fail(reason: OpRefusal): OpResult {
  return { ok: false, reason };
}

/** The single exit: structural rules, then the byte cap. */
function commit(look: Look, id?: LayerId): OpResult {
  const { look: clean } = validateLook(look);
  if (lookBytes(clean) > MAX_LOOK_BYTES) return fail('too-big');
  return id === undefined ? { ok: true, look: clean } : { ok: true, look: clean, id };
}

/** The exit for ops that cannot fail (they only ever shrink or clamp). */
function settle(look: Look): Look {
  return validateLook(look).look;
}

function indexOf(look: Look, id: LayerId): number {
  return look.layers.findIndex((l) => l.id === id);
}

function countKind(look: Look, kind: ModuleId): number {
  return look.layers.filter((l) => l.kind === kind).length;
}

function freshId(look: Look): LayerId {
  const taken = new Set(look.layers.map((l) => l.id));
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = `l${randomId(7)}`;
    if (!taken.has(id)) return id;
  }
  /* c8 ignore next */
  return `l${randomId(7)}`;
}

function clampTransform(t: Transform): Transform {
  const { pos, sMin, sMax, rot } = TRANSFORM_LIMITS;
  return {
    x: clamp(t.x, -pos, pos),
    y: clamp(t.y, -pos, pos),
    s: clamp(t.s, sMin, sMax),
    r: clamp(t.r, -rot, rot),
    a: clamp(t.a, 0, 1),
  };
}

/**
 * Frames are clamped to the kind's `minFrame` — never to zero, never past 3 —
 * and quantised to 4 decimals.
 *
 * The quantisation is not cosmetic: a resize factor is a ratio of two measured
 * distances, so doubling a `1.0` box lands on `2.0000000000000013`, which then
 * rides the wire, comes back, and makes two peers' documents differ in a digit
 * no one can see. Four decimals is one more than the wire keeps.
 */
export function clampFrame(
  frame: Exclude<Frame, 'panel'>,
  minFrame: number,
): Exclude<Frame, 'panel'> {
  const min = clamp(minFrame, 0.1, FRAME_MAX);
  const side = (v: number): number => Math.round(clamp(v, min, FRAME_MAX) * 1e4) / 1e4;
  return { w: side(frame.w), h: side(frame.h), shape: frame.shape };
}

function withLayers(layers: Layer[]): Look {
  return { layers };
}

function patchLayer(look: Look, id: LayerId, patch: (l: Layer) => Layer): Look | null {
  const i = indexOf(look, id);
  const layer = look.layers[i];
  if (layer === undefined) return null;
  const next = look.layers.slice();
  next[i] = patch(layer);
  return withLayers(next);
}

export interface AddLayerOptions {
  frame?: Exclude<Frame, 'panel'>;
  t?: Partial<Transform>;
  cfg?: unknown;
  name?: string;
}

/**
 * Add an overlay of `kind`, seeded from the kind's `overlayDefault`.
 *
 * Refusal order is deliberate: identity first (`unknown-kind`), then whether
 * this kind may be an overlay at all (`role`), then the two counting limits,
 * then bytes. The user gets the most specific true answer, not the first limit
 * that happens to be checked.
 */
export function addLayer(
  look: Look,
  kind: ModuleId,
  registry: EditorRegistry,
  o: AddLayerOptions = {},
): OpResult {
  const placement = registry.placementOf(kind);
  if (placement === null) return fail('unknown-kind');
  if (!placement.roles.includes('overlay')) return fail('role');
  if (look.layers.length >= MAX_LAYERS) return fail('max-layers');
  if (countKind(look, kind) >= placement.maxInstances) return fail('max-instances');

  const id = freshId(look);
  const frame = clampFrame(o.frame ?? placement.overlayDefault.frame, placement.minFrame);
  const t = clampTransform({ ...placement.overlayDefault.t, ...o.t });
  const layer: Layer = {
    id,
    kind,
    on: true,
    frame,
    t,
    cfg: o.cfg ?? registry.defaultConfigOf?.(kind) ?? {},
  };
  if (o.name !== undefined) layer.name = o.name.slice(0, MAX_LAYER_NAME);

  return commit(withLayers([...look.layers, layer]), id);
}

/**
 * Replace the base. Overlays survive untouched — switching from a video to an
 * effect keeps the clock that was sitting on top of it, which is the difference
 * between "change the background" and "start again".
 *
 * The new base carries no `cfg`: it wears `state.modules[kind].cfg`, and the
 * outgoing kind's config stays in that bank, so switching back restores it.
 */
export function setBase(look: Look, kind: ModuleId): Look {
  if (look.layers[0]?.kind === kind) return look;
  const base: Layer = { id: BASE_LAYER_ID, kind, on: true, frame: 'panel', t: { ...IDENTITY } };
  return settle(withLayers([base, ...look.layers.slice(1)]));
}

/** Remove an overlay. The base cannot be removed — there is always a base. */
export function removeLayer(look: Look, id: LayerId): Look {
  if (id === BASE_LAYER_ID) return look;
  const i = indexOf(look, id);
  if (i <= 0) return look;
  const next = look.layers.slice();
  next.splice(i, 1);
  return settle(withLayers(next));
}

/** OFF is unmounted, not deleted: it costs nothing and keeps its config. */
export function toggleLayer(look: Look, id: LayerId, on: boolean): Look {
  const next = patchLayer(look, id, (l) => (l.on === on ? l : { ...l, on }));
  return next === null ? look : settle(next);
}

/** An empty name means "use the kind's own name" — it is absence, not "". */
export function renameLayer(look: Look, id: LayerId, name: string): Look {
  const trimmed = name.trim().slice(0, MAX_LAYER_NAME);
  const next = patchLayer(look, id, (l) => {
    if (trimmed === '') {
      const { name: _drop, ...rest } = l;
      return rest;
    }
    return { ...l, name: trimmed };
  });
  return next === null ? look : settle(next);
}

/**
 * Copy an overlay, nudged so it is visibly a second thing, inserted directly
 * above the original.
 *
 * The base is refused with `role`: a look has exactly one base by construction,
 * and a copy of it is not a thing the model can hold.
 */
export function duplicateLayer(look: Look, id: LayerId, registry: EditorRegistry): OpResult {
  if (id === BASE_LAYER_ID) return fail('role');
  const i = indexOf(look, id);
  const source = look.layers[i];
  if (source === undefined || i === 0) return fail('role');

  const placement = registry.placementOf(source.kind);
  if (placement === null) return fail('unknown-kind');
  if (look.layers.length >= MAX_LAYERS) return fail('max-layers');
  if (countKind(look, source.kind) >= placement.maxInstances) return fail('max-instances');

  const copy: Layer = {
    ...source,
    id: freshId(look),
    t: clampTransform({
      ...source.t,
      x: source.t.x + DUPLICATE_OFFSET,
      y: source.t.y + DUPLICATE_OFFSET,
    }),
  };
  const next = look.layers.slice();
  next.splice(i + 1, 0, copy);
  return commit(withLayers(next), copy.id);
}

/**
 * Move an overlay in z-order. The array IS the z-order and the base is always
 * index 0 — moving it would re-navigate an `<iframe>` and cost a decoder
 * (§0.4), so `toIndex` is clamped to `[1, length-1]` and `'base'` never moves.
 */
export function reorder(look: Look, id: LayerId, toIndex: number): Look {
  if (id === BASE_LAYER_ID) return look;
  const from = indexOf(look, id);
  if (from <= 0) return look;
  const to = clamp(Math.round(toIndex), 1, look.layers.length - 1);
  if (to === from) return look;
  const next = look.layers.slice();
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return look;
  next.splice(to, 0, moved);
  return settle(withLayers(next));
}

export function bringForward(look: Look, id: LayerId): Look {
  const i = indexOf(look, id);
  return i < 1 ? look : reorder(look, id, i + 1);
}

export function sendBackward(look: Look, id: LayerId): Look {
  const i = indexOf(look, id);
  return i < 1 ? look : reorder(look, id, i - 1);
}

/** Is this layer locked? The one reader, so nothing else has to know the shape. */
export function isLocked(look: Look, id: LayerId): boolean {
  return look.layers.find((l) => l.id === id)?.locked === true;
}

/**
 * Lock or unlock an overlay (§2.2, M3).
 *
 * The base is refused the same way it is refused a transform: it wears the
 * panel and `IDENTITY`, so there is nothing about it a lock could protect.
 * Stored only when `true` — `validateLook` drops a `false`, so unlocking really
 * does return the document to the bytes it had before.
 */
export function setLocked(look: Look, id: LayerId, locked: boolean): Look {
  if (id === BASE_LAYER_ID) return look;
  const i = indexOf(look, id);
  if (i <= 0) return look;
  const next = patchLayer(look, id, (l) => {
    if (locked) return { ...l, locked: true };
    const { locked: _drop, ...rest } = l;
    return rest;
  });
  return next === null ? look : settle(next);
}

/**
 * Clamped, and a no-op on the base: `layers[0].t` is `IDENTITY` by definition.
 *
 * The typed half of this is {@link setTransformOf}: a locked layer refuses with
 * a reason the UI can turn into a sentence, and this wrapper keeps the
 * `Look`-in/`Look`-out shape every existing caller was written against.
 */
export function setTransform(look: Look, id: LayerId, patch: Partial<Transform>): Look {
  const result = setTransformOf(look, id, patch);
  return result.ok ? result.look : look;
}

/** The same op, with the refusal visible. `'locked'` is the only one it says. */
export function setTransformOf(look: Look, id: LayerId, patch: Partial<Transform>): OpResult {
  if (id === BASE_LAYER_ID) return fail('role');
  const i = indexOf(look, id);
  if (i <= 0) return fail('role');
  if (isLocked(look, id)) return fail('locked');
  const next = patchLayer(look, id, (l) => ({ ...l, t: clampTransform({ ...l.t, ...patch }) }));
  /* c8 ignore next */
  if (next === null) return fail('role');
  return { ok: true, look: settle(next) };
}

/** One layer's share of a group gesture. */
export interface TransformPatch {
  id: LayerId;
  patch: Partial<Transform>;
}

/**
 * A group gesture's commit — many layers, ONE history entry (§2.1, F7).
 *
 * The alternative is a loop of `setTransform` at the call site, and that is
 * exactly the shape undo cannot survive: dragging three layers would take three
 * presses to walk back, and the second press would leave the group in a
 * position it was never in. So the whole gesture is one op and one document.
 *
 * It refuses the WHOLE batch if any member is locked, rather than quietly
 * moving the rest: a group that half-moved is a group the user has to
 * reconstruct by hand.
 */
export function transformMany(look: Look, patches: readonly TransformPatch[]): OpResult {
  if (patches.length === 0) return { ok: true, look };
  let next = look;
  for (const { id, patch } of patches) {
    if (id === BASE_LAYER_ID) continue;
    const i = indexOf(next, id);
    if (i <= 0) continue;
    if (isLocked(next, id)) return fail('locked');
    const patched = patchLayer(next, id, (l) => ({
      ...l,
      t: clampTransform({ ...l.t, ...patch }),
    }));
    /* c8 ignore next */
    if (patched === null) continue;
    next = patched;
  }
  return commit(next);
}

/** Clamped to the kind's `minFrame`; a no-op on the base (it wears the panel). */
export function setFrame(
  look: Look,
  id: LayerId,
  frame: Exclude<Frame, 'panel'>,
  registry: EditorRegistry,
): Look {
  if (id === BASE_LAYER_ID) return look;
  const i = indexOf(look, id);
  const layer = look.layers[i];
  if (layer === undefined || i === 0) return look;
  if (layer.locked === true) return look;
  const minFrame = registry.placementOf(layer.kind)?.minFrame ?? 0.1;
  const next = patchLayer(look, id, (l) => ({ ...l, frame: clampFrame(frame, minFrame) }));
  return next === null ? look : settle(next);
}

/**
 * An overlay's own config, versioned at write time.
 *
 * The base is refused with `role`: its config lives in the `modules` bank, and
 * the caller wants `withModuleConfig` — which is exactly the ambiguity the
 * positional rule exists to remove.
 */
export function setConfig(look: Look, id: LayerId, v: number, cfg: unknown): OpResult {
  if (id === BASE_LAYER_ID) return fail('role');
  const i = indexOf(look, id);
  if (look.layers[i] === undefined || i === 0) return fail('role');
  const next = patchLayer(look, id, (l) => ({ ...l, v, cfg }));
  /* c8 ignore next */
  if (next === null) return fail('role');
  return commit(next);
}

/**
 * The resize gesture's commit, split by kind (§3.2).
 *
 * `resize:'frame'` kinds (clock, stats, text) grow their BOX and re-lay out, so
 * text stays crisp at any size; `resize:'scale'` kinds (video, image, shape,
 * effect) commit `t.s`, because a raster scales fine and a re-layout would cost
 * a decode. During the drag both preview identically via CSS scale.
 */
export function resize(look: Look, id: LayerId, factor: number, registry: EditorRegistry): Look {
  if (id === BASE_LAYER_ID) return look;
  const i = indexOf(look, id);
  const layer = look.layers[i];
  if (layer === undefined || i === 0 || layer.frame === 'panel') return look;
  if (layer.locked === true) return look;
  if (!Number.isFinite(factor) || factor <= 0) return look;

  const placement = registry.placementOf(layer.kind);
  if (placement?.resize === 'frame') {
    return setFrame(
      look,
      id,
      { w: layer.frame.w * factor, h: layer.frame.h * factor, shape: layer.frame.shape },
      registry,
    );
  }
  return setTransform(look, id, { s: layer.t.s * factor });
}
