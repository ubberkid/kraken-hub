/**
 * The ONLY place placement rules run.
 *
 * `src/state/look/validate.ts` is structural and module-agnostic — it knows a
 * transform has to be a number and that `layers[0]` wears the panel, and it
 * knows nothing about what a `video` is. Everything that needs the registry to
 * answer — may this kind be an overlay, how many of it may exist, what does the
 * whole stack cost — lives here, in one file, so there is exactly one answer
 * per question and the display, the editor and the phone all read it.
 *
 * Two hard rules this file obeys:
 *
 *  1. **It never rewrites the document.** A violation produces a RENDER PLAN in
 *     which the offending layer is off or absent, and a note saying why. The
 *     stored look is untouched, so a look made by a newer build (an `effect`
 *     this build has never heard of) survives a round trip through an older one
 *     instead of being quietly deleted.
 *  2. **It is reference-stable.** When nothing is wrong, `plan.layers` IS
 *     `look.layers`, so the compositor's reconcile and React's memoisation both
 *     see "no change" rather than a fresh array every tick.
 *
 * See docs/design/design-layers-architecture.md §3.4 and §7.2.
 */

import { IDENTITY, MAX_LAYERS } from '../state/look/types';

import type { AnyKrakenModule, LayerCost, LayerPlacement } from './types';
import type { Layer, LayerId, Look } from '../state/look/types';
import type { ModuleId } from '../state/schema';

/** How the registry is injected. `null` = this build has never heard of the kind. */
export type GetModule = (id: ModuleId) => AnyKrakenModule | null;

/** A layer's config, for the two functions that need one. Base → the bank. */
export type ConfigOf = (layer: Layer) => unknown;

const defaultConfigOf: ConfigOf = (layer) => layer.cfg;

/**
 * The legacy placement, derived for a module that predates `layer` (§1.4).
 *
 * This is the backward-compatibility path, and it is deliberately the most
 * conservative one possible: a fork's module keeps rendering exactly as it did,
 * as the base, one instance, with no edit to its manifest. It cannot become an
 * overlay by accident — nobody has checked that it lays out from
 * `ctx.geometry()` rather than from the panel.
 */
export function placementOf(mod: AnyKrakenModule): LayerPlacement {
  if (mod.layer !== undefined) return mod.layer;
  const motion = mod.capabilities.motionLevel;
  return {
    roles: ['base'],
    maxInstances: 1,
    resize: 'scale',
    minFrame: 0.5,
    overlayDefault: { frame: { w: 1, h: 1, shape: 'square' }, t: IDENTITY },
    cost: () => ({
      cadence: motion === 'full' ? 'frame' : motion === 'low' ? 'tick' : 'static',
      coverage: 1,
      entropy: 'mid',
      decoders: 0,
      gl: 0,
    }),
  };
}

/** One decoder (`video.maxInstances === 1` puts it there; this makes it a stack fact). */
const MAX_DECODERS = 1;
/** Two WebGL contexts (`effect.maxInstances === 2`). */
const MAX_GL = 2;

/** `placementOf` for a kind, or `null` when the kind is not registered. */
export function placementOfKind(kind: ModuleId, getModule: GetModule): LayerPlacement | null {
  const mod = getModule(kind);
  return mod === null ? null : placementOf(mod);
}

export interface StackNote {
  id: LayerId;
  kind: ModuleId;
  reason: 'unknown-kind' | 'role' | 'max-instances' | 'base-not-base-capable';
  /** One line, already in words a person could be shown. */
  detail: string;
}

export interface RenderPlan {
  /** The look as stored, by reference. Normalising never edits the document. */
  look: Look;
  /** What to actually mount, in z-order. `=== look.layers` when nothing is wrong. */
  layers: Layer[];
  notes: StackNote[];
}

const NO_NOTES: StackNote[] = [];

/**
 * Turn a stored look into what the compositor should mount.
 *
 *  - an unknown kind is **excluded from the plan** and kept in the document;
 *  - a `roles: ['base']` kind at index ≥ 1 is planned `on: false`;
 *  - instances past `maxInstances` — in array order, so the oldest wins — are
 *    planned `on: false`. `Σ decoders ≤ 1` and `Σ gl ≤ 2` are enforced on top of
 *    that, because those are hardware limits rather than per-kind ones and a
 *    fork could otherwise reach them with two different kinds;
 *  - a base whose kind cannot be a base is planned as an overlay-in-place over
 *    the stage background rather than dropped: something is better than a black
 *    panel, and the note says so.
 */
export function normalizeLook(
  look: Look,
  getModule: GetModule,
  configOf: ConfigOf = defaultConfigOf,
): RenderPlan {
  const notes: StackNote[] = [];
  const planned: Layer[] = [];

  const instances = new Map<ModuleId, number>();
  let decoders = 0;
  let gl = 0;

  look.layers.forEach((layer, index) => {
    const mod = getModule(layer.kind);
    if (mod === null) {
      notes.push({
        id: layer.id,
        kind: layer.kind,
        reason: 'unknown-kind',
        detail: `This build does not have a "${layer.kind}" layer. It is kept and skipped.`,
      });
      return;
    }

    const placement = placementOf(mod);
    const role = index === 0 ? 'base' : 'overlay';
    let on = layer.on;

    if (index === 0 && !placement.roles.includes('base')) {
      // Not switched off: it renders where it is, over the background.
      notes.push({
        id: layer.id,
        kind: layer.kind,
        reason: 'base-not-base-capable',
        detail: `"${layer.kind}" cannot be a base layer; it is drawn over the background instead.`,
      });
    } else if (role === 'overlay' && !placement.roles.includes('overlay')) {
      on = false;
      notes.push({
        id: layer.id,
        kind: layer.kind,
        reason: 'role',
        detail: `"${layer.kind}" can only be the base layer, so this one is off.`,
      });
    }

    if (on) {
      const used = (instances.get(layer.kind) ?? 0) + 1;
      instances.set(layer.kind, used);
      const cost = placement.cost(configOf(layer), layer);
      const overCount = used > placement.maxInstances;
      const overDecoders = decoders + cost.decoders > MAX_DECODERS;
      const overGl = gl + cost.gl > MAX_GL;
      if (overCount || overDecoders || overGl) {
        on = false;
        notes.push({
          id: layer.id,
          kind: layer.kind,
          reason: 'max-instances',
          detail: overCount
            ? `Only ${String(placement.maxInstances)} "${layer.kind}" layer${placement.maxInstances === 1 ? '' : 's'} can run at once, so this one is off.`
            : overDecoders
              ? 'Only one video can play at a time, so this layer is off.'
              : `Only ${String(MAX_GL)} effect layers can run at once, so this one is off.`,
        });
      } else {
        decoders += cost.decoders;
        gl += cost.gl;
      }
    }

    planned.push(on === layer.on ? layer : { ...layer, on });
  });

  /*
   * Reference stability, decided by comparing what came out with what went in
   * rather than by a flag: every layer kept its identity and none was dropped,
   * so hand back the ORIGINAL array. The compositor reconciles by identity and
   * the home screen memoises on it.
   */
  const untouched =
    planned.length === look.layers.length && planned.every((l, i) => l === look.layers[i]);
  return {
    look,
    layers: untouched ? look.layers : planned,
    notes: notes.length === 0 ? NO_NOTES : notes,
  };
}

/** `C` — what the cadence multiplies by. A static layer is free once it is up. */
const CADENCE_WEIGHT: Readonly<Record<LayerCost['cadence'], number>> = {
  static: 0,
  tick: 0.05,
  frame: 1,
};

/** `E` — what CAM's compressor charges for the KIND of change, not its area. */
const ENTROPY_WEIGHT: Readonly<Record<LayerCost['entropy'], number>> = {
  low: 0.3,
  mid: 0.6,
  high: 1,
};

/** A translucent layer forces an offscreen compositor surface. */
const SURFACE_CHARGE = 0.1;

const CALM_MAX = 1;
const BUSY_MAX = 1.5;

export type LookVerdict = 'calm' | 'busy' | 'rich';

export interface LookCost {
  /** Normalised so ONE video base is exactly 1.0. */
  total: number;
  /** Per layer, in plan order — what the home screen names in words. */
  layers: { id: LayerId; kind: ModuleId; w: number }[];
  /** The costliest single layer, or `null` for an empty (or entirely off) look. */
  worst: { id: LayerId; kind: ModuleId; w: number } | null;
  verdict: LookVerdict;
  /** Offscreen compositor surfaces forced by `a < 1`. */
  surfaces: number;
  decoders: number;
  gl: number;
}

/** A frame is written in DIAMETER units, and the panel is 2 units across. */
const DIAMETER_SQUARED = 4;

/** `area('panel') = 1`; a box is `w·h/4` of the panel. */
function frameArea(layer: Layer): number {
  return layer.frame === 'panel' ? 1 : (layer.frame.w * layer.frame.h) / DIAMETER_SQUARED;
}

/**
 * What a look costs, as a number the home screen can draw a bar with.
 *
 * ESTIMATED, and the UI says the word: this is declared cost, and the half of
 * the machine it is trying to predict — CAM's capture and compressor — cannot be
 * measured from this page at all (§11.1). The measured half (per-layer frame
 * times, achieved fps) only ever tightens it.
 *
 * Worked examples, from §7.2:
 *   video base alone                     → 1.0 exactly (this is the unit)
 *   video base + a stats strip overlay   → just over 1.0
 *   an effect base + a stats strip       → about 0.6
 *   any overlay at `a: 0.5` over a video → +0.1 for the surface, +0.1 for the
 *                                          video underneath it losing its
 *                                          direct path to the screen
 */
export function lookCost(
  look: Look,
  getModule: GetModule,
  configOf: ConfigOf = defaultConfigOf,
): LookCost {
  const plan = normalizeLook(look, getModule, configOf);
  const layers: LookCost['layers'] = [];
  let total = 0;
  let surfaces = 0;
  let decoders = 0;
  let gl = 0;

  for (const layer of plan.layers) {
    if (!layer.on) continue;
    const mod = getModule(layer.kind);
    if (mod === null) continue;
    const cost = placementOf(mod).cost(configOf(layer), layer);

    const painted = Math.min(1, cost.coverage * frameArea(layer) * layer.t.s * layer.t.s);
    let w = CADENCE_WEIGHT[cost.cadence] * painted * ENTROPY_WEIGHT[cost.entropy];
    if (layer.t.a < 1) {
      // The layer itself needs a surface...
      w += SURFACE_CHARGE;
      surfaces += 1;
      // ...and a video that has to be composited through one loses the direct
      // path from decoder to screen, which is the expensive half.
      if (cost.decoders > 0) w += SURFACE_CHARGE;
    }

    decoders += cost.decoders;
    gl += cost.gl;
    total += w;
    layers.push({ id: layer.id, kind: layer.kind, w });
  }

  let worst: LookCost['worst'] = null;
  for (const entry of layers) {
    if (worst === null || entry.w > worst.w) worst = entry;
  }

  return {
    total,
    layers,
    worst,
    verdict: total <= CALM_MAX ? 'calm' : total <= BUSY_MAX ? 'busy' : 'rich',
    surfaces,
    decoders,
    gl,
  };
}

/**
 * The stack's cadence, mapped back to the vocabulary the low-FPS advisory
 * speaks: the busiest ON layer decides, because one moving layer is enough to
 * be ruined by a 1 FPS capture.
 */
export function stackMotionLevel(
  look: Look,
  getModule: GetModule,
  configOf: ConfigOf = defaultConfigOf,
): 'static' | 'low' | 'full' {
  let best: 'static' | 'low' | 'full' = 'static';
  for (const layer of normalizeLook(look, getModule, configOf).layers) {
    if (!layer.on) continue;
    const mod = getModule(layer.kind);
    if (mod === null) continue;
    const { cadence } = placementOf(mod).cost(configOf(layer), layer);
    if (cadence === 'frame') return 'full';
    if (cadence === 'tick') best = 'low';
  }
  return best;
}

/** How many more layers a look has room for. Exported so the UI never counts. */
export function layersRemaining(look: Look): number {
  return Math.max(0, MAX_LAYERS - look.layers.length);
}
