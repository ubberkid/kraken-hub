/**
 * The look model: what is on the panel, in what order, at what size.
 *
 * A **look** is `{ layers: Layer[] }` and the array IS the z-order — bottom
 * first, so `layers[0]` is the base and the last entry is on top. There is no
 * `zIndex` field anywhere in this codebase and `scripts/check-invariants.mjs`
 * keeps it that way: two sources of truth for stacking is how a compositor
 * starts disagreeing with an editor.
 *
 * `layers[0]` is always the base — `id:'base'`, `frame:'panel'`, `t:IDENTITY`
 * and, crucially, **no `cfg`**: the base wears `state.modules[kind].cfg` (the
 * per-kind bank), overlays carry their own. The validator enforces that by
 * POSITION (§4.1), which is what makes "a config has exactly one home" a
 * structural fact rather than a rule someone has to remember.
 *
 * This chunk is core: no DOM, no registry, no React. Registry-aware rules
 * (roles, `maxInstances`, cost) live in `src/modules/stack.ts`.
 *
 * See docs/design/design-layers-architecture.md §1.1.
 */

import { randomId } from '../../lib/id';

import type { ModuleId } from '../schema';

/**
 * Unit-radius panel coordinates: origin = panel centre, +x right, +y down,
 * 1.0 = `Geometry.radiusPx` (= min(w,h)/2). px = u * radiusPx.
 *
 * Everything geometric in a look is expressed in these, which is why a look
 * composed on a 640 Elite lands identically on a 240 square: there is no pixel
 * in the document to be wrong about. 3 decimals on the wire.
 */
export type Units = number;

export interface Transform {
  /** Centre of the frame, in units. */
  x: Units;
  y: Units;
  /** CSS scale. Persisted ≠ 1 only for `resize:'scale'` kinds (§3.2). */
  s: number;
  /** Degrees clockwise. */
  r: number;
  /** Opacity; < 1 costs one compositor surface (charged in `lookCost`, §7.2). */
  a: number;
}

export const IDENTITY: Transform = { x: 0, y: 0, s: 1, r: 0, a: 1 };

export const TRANSFORM_LIMITS = { pos: 1.5, sMin: 0.1, sMax: 4, rot: 180 } as const;

/**
 * `'panel'` = the whole LCD, and only the base may wear it.
 *
 * Box frames are in DIAMETER units: `w: 2` is the full panel width, so a
 * `{w:1,h:1}` box is a quarter of it. Diameter rather than radius because the
 * editor's handles and the user's mental model are both about the size of the
 * thing, not half of it.
 */
export type Frame = 'panel' | { w: Units; h: Units; shape: 'square' | 'circle' };

export type LayerId = string;

/** Short, lowercase, and stable: it is the reconcile key and it rides the wire. */
export const LAYER_ID_RE = /^[a-z][a-z0-9]{3,11}$/;

/** `layers[0].id`, always. Deterministic, so two peers migrating the same document agree. */
export const BASE_LAYER_ID = 'base';

/** The wire-budget test (§6.2) is built on this number. */
export const MAX_LAYERS = 8;

export const MAX_LAYER_NAME = 24;

/** `JSON.stringify(look).length`; refused by ops at write time, only NOTED by the validator. */
export const MAX_LOOK_BYTES = 3072;

export interface Layer {
  id: LayerId;
  /** Registered module id. An unknown kind is preserved verbatim and skipped at render. */
  kind: ModuleId;
  /** OFF = unmounted (costs nothing); the config is kept. */
  on: boolean;
  /** ≤ `MAX_LAYER_NAME`; absent = the kind's `chipName ?? name`. */
  name?: string;
  /** `'panel'` iff index === 0 (the validator forces both directions). */
  frame: Frame;
  /** `IDENTITY` at index 0 (the validator forces it). */
  t: Transform;
  /**
   * Locked: the canvas will not hit-test it and the ops refuse to transform it.
   *
   * OPTIONAL and stored only when `true`, which is why the schema stays at 7 —
   * every document ever written is already a valid document with this field
   * absent, and absent means unlocked. `validateLook` repairs anything that is
   * not a boolean by dropping it, so a corrupt value can never lock somebody
   * out of their own layer.
   *
   * It is a property of the LAYER rather than of the editor's selection state
   * because it has to survive the wire: a layer locked on the desktop is locked
   * on the phone, or the two surfaces disagree about what a drag means.
   */
  locked?: boolean;
  /**
   * ABSENT at index 0 — the base wears `state.modules[kind].cfg`. PRESENT
   * (verbatim, unknown to this layer) for every overlay.
   */
  cfg?: unknown;
  /** The kind's `configVersion` at write time; overlays only. Migrated at point of use. */
  v?: number;
}

export interface Look {
  layers: Layer[];
}

/** A layer without its identity: what a template, a look file and a duplicate carry. */
export type LayerTemplate = Omit<Layer, 'id'>;

/**
 * What a fresh document, the 6 → 7 migration and a legacy wire body all produce.
 *
 * Deterministic on purpose: both CAM browsers migrate the same retained v6
 * snapshot independently, and if the two results differed by so much as a
 * generated id, last-writer-wins would pick one browser's stack at random.
 */
export function baseLook(kind: ModuleId): Look {
  return { layers: [{ id: BASE_LAYER_ID, kind, on: true, frame: 'panel', t: IDENTITY }] };
}

/** The byte cost of a look on the wire and in the state document. */
export function lookBytes(look: Look): number {
  return JSON.stringify(look).length;
}

/**
 * Mint an overlay id: `'l'` + 7 random characters, 8 in all.
 *
 * The length is 7 and not 8 because the editor's `addLayer` (§8) already mints
 * `l${randomId(7)}`, and two id lengths in one document is the kind of detail
 * that looks harmless until a fixture, a wire-budget test or a reader's eye
 * starts treating one of them as the shape of a "real" id. `LAYER_ID_RE` admits
 * 4–12 characters either way; the point is that there is one answer.
 */
export function mintLayerId(): LayerId {
  return `l${randomId(7)}`;
}

/** Templates → layers. Index 0 becomes the base; the rest get fresh ids. */
export function withIds(t: readonly LayerTemplate[]): Layer[] {
  return t.map((template, i) => ({ ...template, id: i === 0 ? BASE_LAYER_ID : mintLayerId() }));
}

/** Layers → templates: everything except the identity, so ids are re-minted on apply. */
export function toTemplates(l: readonly Layer[]): LayerTemplate[] {
  return l.map(({ id: _id, ...rest }) => rest);
}
