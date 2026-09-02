/**
 * Align and distribute — the group operations §2.1 asks for, as pure functions.
 *
 * They exist here rather than in the strip for the same reason every other edit
 * does: the UI may only call `ops`, and a group gesture is one op and one
 * history entry (`transformMany`). This module's whole job is to turn "align
 * these four to the left of the canvas" into the list of `Transform` patches
 * that does it.
 *
 * ## Two references, because they answer different questions
 *
 *  - `'canvas'` — the panel itself. "Put these against the left edge of the
 *    screen."
 *  - `'selection'` — the union of the selected layers' boxes. "Line these up
 *    with each other," which leaves the group where it is.
 *
 * Everything is measured with `layerBounds`, the SAME function the compositor
 * positions the host with and the overlay draws the box with, so a layer that
 * LOOKS flush after an align is flush (§2.3). Rotation is therefore handled for
 * free: the axis-aligned bounding box of a rotated layer is what a person sees,
 * and it is what gets aligned.
 *
 * Positions are written in UNITS, so the arithmetic converts once at the end,
 * through `panel.radiusPx` — the one conversion `nudge.ts` also makes.
 *
 * Pure, DOM-free, unit-tested.
 */

import { layerBounds } from '../../../render/layerBox';

import type { TransformPatch } from './ops';
import type { Geometry } from '../../../platform/geometry';
import type { Layer, LayerId, Look } from '../../../state/look/types';

export type AlignEdge = 'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom';
export type AlignRef = 'canvas' | 'selection';
export type DistributeAxis = 'x' | 'y';

interface Measured {
  id: LayerId;
  /** The axis-aligned box, in panel px. */
  x: number;
  y: number;
  w: number;
  h: number;
}

function measure(look: Look, ids: readonly LayerId[], panel: Geometry): Measured[] {
  const out: Measured[] = [];
  for (const id of ids) {
    const layer: Layer | undefined = look.layers.find((l) => l.id === id);
    // The base wears the panel and never moves (§0.4), and a locked layer is
    // not a thing a gesture may touch — both simply are not in the group.
    if (layer === undefined || layer.frame === 'panel' || layer.locked === true) continue;
    const { rect } = layerBounds(layer, panel);
    out.push({ id, x: rect.x, y: rect.y, w: rect.w, h: rect.h });
  }
  return out;
}

/** The union box of what was measured, in panel px. `null` for an empty group. */
function union(items: readonly Measured[]): { x: number; y: number; w: number; h: number } | null {
  const first = items[0];
  if (first === undefined) return null;
  let x0 = first.x;
  let y0 = first.y;
  let x1 = first.x + first.w;
  let y1 = first.y + first.h;
  for (const it of items) {
    x0 = Math.min(x0, it.x);
    y0 = Math.min(y0, it.y);
    x1 = Math.max(x1, it.x + it.w);
    y1 = Math.max(y1, it.y + it.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Where an edge sits, in panel px, for a box of side `side` inside `frame`.
 *
 * One function for all six edges because the horizontal three and the vertical
 * three are the same arithmetic on a different axis — writing them twice is how
 * "centre" and "middle" end up disagreeing by half a pixel.
 */
function edgeTarget(edge: AlignEdge, frameStart: number, frameSide: number, side: number): number {
  if (edge === 'left' || edge === 'top') return frameStart;
  if (edge === 'right' || edge === 'bottom') return frameStart + frameSide - side;
  return frameStart + (frameSide - side) / 2;
}

function isVertical(edge: AlignEdge): boolean {
  return edge === 'top' || edge === 'middle' || edge === 'bottom';
}

export interface ArrangeInput {
  look: Look;
  ids: readonly LayerId[];
  panel: Geometry;
}

/**
 * Align every selected layer to one edge of the canvas or of the selection.
 *
 * Returns the patches, never a look: the caller commits them through
 * `transformMany` so the whole gesture is one entry in the undo stack.
 */
export function alignPatches(
  input: ArrangeInput,
  edge: AlignEdge,
  ref: AlignRef,
): TransformPatch[] {
  const items = measure(input.look, input.ids, input.panel);
  if (items.length === 0) return [];

  const vertical = isVertical(edge);
  let frameStart: number;
  let frameSide: number;
  if (ref === 'canvas') {
    frameStart = 0;
    frameSide = vertical ? input.panel.height : input.panel.width;
  } else {
    const box = union(items);
    /* c8 ignore next */
    if (box === null) return [];
    frameStart = vertical ? box.y : box.x;
    frameSide = vertical ? box.h : box.w;
  }

  const r = input.panel.radiusPx;
  const patches: TransformPatch[] = [];
  for (const it of items) {
    const side = vertical ? it.h : it.w;
    const from = vertical ? it.y : it.x;
    const to = edgeTarget(edge, frameStart, frameSide, side);
    const delta = (to - from) / r;
    if (delta === 0) continue;
    const layer = input.look.layers.find((l) => l.id === it.id);
    /* c8 ignore next */
    if (layer === undefined) continue;
    patches.push({
      id: it.id,
      patch: vertical ? { y: layer.t.y + delta } : { x: layer.t.x + delta },
    });
  }
  return patches;
}

/**
 * Even the gaps between three or more layers along one axis.
 *
 * The two extremes stay exactly where they are — distributing is a statement
 * about what is BETWEEN things, and a version that also moved the ends would be
 * a version nobody could predict — and the ones in between are placed so the
 * spacing between adjacent boxes is equal. Fewer than three layers have no
 * "between", so it returns nothing.
 */
export function distributePatches(input: ArrangeInput, axis: DistributeAxis): TransformPatch[] {
  const items = measure(input.look, input.ids, input.panel);
  if (items.length < 3) return [];

  const vertical = axis === 'y';
  const start = (it: Measured): number => (vertical ? it.y : it.x);
  const side = (it: Measured): number => (vertical ? it.h : it.w);

  const sorted = [...items].sort((a, b) => start(a) - start(b));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  /* c8 ignore next */
  if (first === undefined || last === undefined) return [];

  const span = start(last) + side(last) - start(first);
  const occupied = sorted.reduce((sum, it) => sum + side(it), 0);
  // A negative gap is a group that already overlaps more than it spans; the
  // even distribution of that is still even, and it is what the user asked for.
  const gap = (span - occupied) / (sorted.length - 1);

  const r = input.panel.radiusPx;
  const patches: TransformPatch[] = [];
  let cursor = start(first);
  for (const [i, it] of sorted.entries()) {
    const target = cursor;
    cursor += side(it) + gap;
    if (i === 0 || i === sorted.length - 1) continue;
    const delta = (target - start(it)) / r;
    if (delta === 0) continue;
    const layer = input.look.layers.find((l) => l.id === it.id);
    /* c8 ignore next */
    if (layer === undefined) continue;
    patches.push({
      id: it.id,
      patch: vertical ? { y: layer.t.y + delta } : { x: layer.t.x + delta },
    });
  }
  return patches;
}
