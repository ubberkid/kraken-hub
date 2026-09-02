/**
 * Smart placement — principle 5, "never a pile".
 *
 * ESC drops every new element at the centre of the panel, so adding three
 * things gives you three things on top of each other and a drag before you can
 * even see what you added. A new layer here lands in the first FREE slot: the
 * kind's own `overlayDefault` if nothing is sitting there, and otherwise the
 * next position on a ring that keeps it inside the safe circle and clear of
 * everything already on the panel.
 *
 * All of it in UNITS, so the answer is the same on a 640 round Elite and a 240
 * square — the same reason `snap.ts` is.
 *
 * Four rules the candidate list encodes, in order:
 *
 *  1. **The kind's own default is the first candidate**, and on an EMPTY panel
 *     it is honoured exactly, bleed and all. A stats strip belongs along the
 *     bottom and a clock belongs under the middle; a placement engine that
 *     ignored that would be "tidy" and wrong.
 *  2. **Candidates are tried outward, not randomly.** The second clock goes
 *     above the first, the third to one side. A person adding four layers gets
 *     a composition they can read rather than a scatter they have to sort out.
 *  3. **Every generated candidate contains its own box** (round 11's M-i). A
 *     disc's width at a given height is its chord, not its diameter, so a wide
 *     overlay near the bottom moves up rather than hanging off both sides.
 *  4. **A layer that will not fit anywhere shrinks before it stacks** (M-i
 *     again). The whole ring walk is retried at 85 %, then 72 %, down to the
 *     model's `sMin`, so the answer is the largest free slot rather than a pile.
 *
 * Pure, DOM-free, unit-tested.
 */

import {
  TRANSFORM_LIMITS,
  type Frame,
  type Layer,
  type Look,
  type Transform,
  type Units,
} from '../../../state/look/types';

import type { SnapPanel, SnapRender } from './snap';

/** The gap kept between two boxes, in units. Tight enough to be a layout. */
export const PLACEMENT_GAP: Units = 0.04;

/**
 * How far the search walks out before it gives up and stacks.
 *
 * Eight layers is the model's ceiling (`MAX_LAYERS`), and three rings of eight
 * candidates is comfortably more positions than eight boxes can occupy — so
 * running out means the panel is genuinely full, not that the search was lazy.
 */
const RINGS: readonly Units[] = [0, 0.45, 0.75, 1.0];
const ANGLES_DEG: readonly number[] = [90, -90, 0, 180, 45, 135, -45, -135];

/**
 * The sweep the rings fall back to — round 11's M-i.
 *
 * `SWEEP_REACH` is a shade under the widest safe radius any panel declares, so
 * the grid covers the whole disc and `boxOnPanel` does the trimming; the step is
 * a twentieth of the panel's radius, which is finer than any gap a layer at the
 * model's minimum scale could hide in and coarse enough that the whole sweep is
 * 361 points.
 */
const SWEEP_REACH: Units = 0.9;
const SWEEP_STEP: Units = 0.1;

const DEG = Math.PI / 180;

interface Box {
  x: Units;
  y: Units;
  hw: Units;
  hh: Units;
}

function boxOf(frame: Frame, t: Pick<Transform, 'x' | 'y' | 's'>): Box {
  if (frame === 'panel') return { x: 0, y: 0, hw: 1, hh: 1 };
  return { x: t.x, y: t.y, hw: (frame.w / 2) * t.s, hh: (frame.h / 2) * t.s };
}

/** Axis-aligned overlap, with the gap counted as part of each box. */
function overlaps(a: Box, b: Box, gap: Units): boolean {
  return Math.abs(a.x - b.x) < a.hw + b.hw + gap && Math.abs(a.y - b.y) < a.hh + b.hh + gap;
}

/**
 * Does a GENERATED candidate fit on the panel — box and all?
 *
 * ## What this used to ask, and why it was the wrong question
 *
 * It asked about the layer's CENTRE: `hypot(x, y) <= safeRadiusPct`. The
 * reasoning was sound about the kind's own `overlayDefault` — a stats scrim at
 * `1.6 x 0.5` along the bottom is MEANT to bleed to the bezel, and a rule that
 * demanded four corners inside the disc would reject every default this app
 * ships. That exemption still stands, and it lives where it belongs: the
 * preferred transform is tried first, before any of this (see `placeNewLayer`).
 *
 * Applied to a GENERATED position it was simply wrong, and round 11's M-i is
 * what it produced. A panel is a disc, so the room available at a given `y` is
 * the CHORD there, not the diameter: at `y = 0.7` on a 0.88 safe circle the
 * usable width is `2 * sqrt(0.88² - 0.7²)` = 1.06 units, not 1.76. A wide
 * overlay whose centre sat comfortably inside the ring therefore had most of
 * its box outside the glass — measured, an auto-placed Date near the bottom
 * read "…ed, Se…" with both ends over the bezel, and the search had called that
 * slot free because the only thing it looked at was the middle of it.
 *
 * So a candidate has to contain its own box: every corner inside the disc,
 * which for an axis-aligned box centred at `(x, y)` is one `hypot` on the far
 * corner. The chord falls out of that for free — near the bottom a wide box
 * fails, and `placeNewLayer` responds by moving it up or shrinking it, which is
 * exactly the choice a person would make.
 *
 * Rotation is deliberately not modelled: `boxOf` is axis-aligned throughout
 * this file, a rotated box is never larger than its own diagonal, and a
 * placement engine that reasoned about rotation would be a second geometry to
 * keep in step with `layerBox.ts`. Whether a layer the USER has since dragged
 * or turned is cut is a different question with its own answer, and
 * `bounds.outsideSafeCircle` says it without policing it (§2.7).
 */
function boxOnPanel(box: Box, panel: SnapPanel, render: SnapRender): boolean {
  if (panel.shape === 'square') {
    return Math.abs(box.x) + box.hw <= 1 && Math.abs(box.y) + box.hh <= 1;
  }
  return Math.hypot(Math.abs(box.x) + box.hw, Math.abs(box.y) + box.hh) <= render.safeRadiusPct;
}

/** Every ON overlay already on the panel, as boxes. The base is the ground. */
function occupied(look: Look): Box[] {
  return look.layers
    .slice(1)
    .filter((l) => l.on)
    .map((l) => boxOf(l.frame, l.t));
}

export interface PlacementInput {
  look: Look;
  frame: Exclude<Frame, 'panel'>;
  /** The kind's `overlayDefault.t` — the first candidate, and the fallback. */
  preferred: Transform;
  panel: SnapPanel;
  render: SnapRender;
}

export interface Placement {
  t: Transform;
  /**
   * `false` when every candidate at every size was taken and the layer landed
   * on its preferred spot anyway.
   *
   * The editor does not need to say anything about it — the layer is selected
   * and visibly on top — but the property test does: "never overlaps" is only
   * assertable up to the point where the panel is genuinely full. Since round
   * 11's M-i the search shrinks before it gives up, so this is a much rarer
   * answer than it was: it means eight layers really have used the disc.
   */
  free: boolean;
}

/**
 * How the search shrinks a layer that will not fit at its own size — M-i.
 *
 * Each step is 15 % off, and the walk stops at `TRANSFORM_LIMITS.sMin`, which
 * is the smallest scale the model will hold — the "≥ minFrame" floor. Fifteen
 * per cent is a step a person can see happened (so the layer does not look like
 * it was placed at a random size) and small enough that the first size that
 * fits is close to the largest one that would.
 *
 * Tried in order, largest first, so what comes back IS the largest free slot
 * rather than the first one the walk stumbles into.
 */
const SHRINK_STEP = 0.85;

/**
 * Where a new layer of this frame should land.
 *
 * The candidate order IS the design: the kind's own default, then a ring at the
 * preferred radius, then wider rings. `y = +r` (bottom) comes before `y = -r`
 * (top) because the bottom of a round panel is where a caption goes and the top
 * is where a clock usually already is.
 */
export function placeNewLayer(input: PlacementInput): Placement {
  const { look, frame, preferred, panel, render } = input;
  const taken = occupied(look);
  const { pos, sMin } = TRANSFORM_LIMITS;

  const clampPos = (v: number): number => Math.max(-pos, Math.min(pos, v));
  const free = (t: Transform): boolean =>
    !taken.some((other) => overlaps(boxOf(frame, t), other, PLACEMENT_GAP));
  const consider = (x: Units, y: Units, s: number): Transform | null => {
    const t: Transform = { ...preferred, x: clampPos(x), y: clampPos(y), s };
    if (!boxOnPanel(boxOf(frame, t), panel, render)) return null;
    return free(t) ? t : null;
  };

  /*
   * The kind's own default is honoured EXACTLY — on an empty panel.
   *
   * It is the module's considered answer to "where does one of these go on a
   * panel with nothing else on it", and several of those answers deliberately
   * bleed to the bezel: a stats scrim at `1.6 x 0.5` along the bottom is meant
   * to run off both sides, and a placer that "tidied" it would be overruling
   * the design of every look built around one.
   *
   * The moment there is something ELSE on the panel, the same position stops
   * being a design and starts being a guess — and round 11's M-i is what the
   * guess cost. Adding one of each kind, an auto-placed Date landed on its
   * declared `y = 0.75` with a 1.2-unit box, which at that height is half again
   * as wide as the chord: it read "…ed, Se…" with both ends over the bezel,
   * beside six other layers it had been fitted around. A layer being fitted
   * INTO a composition has to fit in it, so from the second overlay on, the
   * preferred spot is a candidate like any other and is contained like any
   * other. `boxOnPanel` above is the rule; the loop below will move it up or
   * shrink it, in that order.
   */
  if (taken.length === 0 && free(preferred)) return { t: { ...preferred }, free: true };

  // The preferred radius is where the kind wanted to be; the rings walk out
  // from there rather than from the centre, so a stats strip stays low.
  const baseRadius = Math.hypot(preferred.x, preferred.y);

  /*
   * Sizes outermost, positions innermost — M-i, and the order IS the design.
   *
   * The whole ring walk is tried at the layer's own size before ANY of it is
   * tried smaller, so a layer only shrinks when there is genuinely no room for
   * it at the size the kind asked for. Within a size, the preferred spot comes
   * first (a shrunken clock under the middle beats a full-size one off in a
   * corner), then the rings outward as before.
   *
   * The old function had no second loop at all: when the ring walk ran out it
   * returned `preferred` with `free: false` and the layer landed ON TOP of
   * whatever was already there. That is the pile principle 5 forbids, and it is
   * the other half of M-i — adding one of each kind left the last-placed effect
   * overlay sitting opaque over the entire composition.
   */
  const sizes: number[] = [];
  for (let s = preferred.s; s >= sMin; s *= SHRINK_STEP) sizes.push(s);
  // The floor itself is always a candidate, even when the walk stepped past it.
  if (sizes[sizes.length - 1] !== sMin && preferred.s > sMin) sizes.push(sMin);

  /*
   * The candidate POSITIONS, in the order the design wants them tried.
   *
   * Identical at every size, so the list is built once: the kind's own spot,
   * then the rings outward from the radius it asked for, then the sweep below.
   */
  const ringPositions: [Units, Units][] = [[preferred.x, preferred.y]];
  for (const ring of RINGS) {
    const radius = ring === 0 ? baseRadius : ring;
    if (radius === 0) continue;
    for (const deg of ANGLES_DEG) {
      const rad = deg * DEG;
      ringPositions.push([radius * Math.cos(rad), radius * Math.sin(rad)]);
    }
  }

  /*
   * …and then a SWEEP, because thirty-two positions is not a search — M-i.
   *
   * The ring walk is a good design and a poor search: it is 32 fixed points, so
   * a panel with five wide overlays on it can have a perfectly good gap that no
   * candidate lands in. Measured, adding one of each of the eight kinds: with
   * the size ladder in place and the ring walk as the only position list, the
   * clock and the effect BOTH still fell through to "genuinely full" and
   * stacked — there was a 0.25-unit-wide corridor between the date and the icon
   * that nothing ever looked at, and the effect ended up an opaque disc over the
   * whole composition, which is the finding.
   *
   * So when the rings run out at a size, the panel is swept on a grid, nearest
   * to the kind's own spot first. Ordered that way rather than row by row
   * because "as close as possible to where this kind belongs" is the design; the
   * grid is only how the space is enumerated. Sorted once, outside both loops.
   *
   * The cost is bounded and small: 361 points x 16 sizes x at most seven boxes,
   * of pure arithmetic, on a gesture that already commits a document.
   */
  const sweep: [Units, Units][] = [];
  for (let gx = -SWEEP_REACH; gx <= SWEEP_REACH + 1e-9; gx += SWEEP_STEP) {
    for (let gy = -SWEEP_REACH; gy <= SWEEP_REACH + 1e-9; gy += SWEEP_STEP) {
      sweep.push([gx, gy]);
    }
  }
  sweep.sort(
    (a, b) =>
      Math.hypot(a[0] - preferred.x, a[1] - preferred.y) -
      Math.hypot(b[0] - preferred.x, b[1] - preferred.y),
  );

  for (const size of sizes) {
    // The preferred spot first at every size — a shrunken clock under the
    // middle beats a full-size one off in a corner. At full size this is the
    // contained retry of the position the empty-panel branch above waived.
    for (const [x, y] of ringPositions) {
      const found = consider(x, y, size);
      if (found !== null) return { t: found, free: true };
    }
    for (const [x, y] of sweep) {
      const found = consider(x, y, size);
      if (found !== null) return { t: found, free: true };
    }
  }

  // Genuinely full, at every size down to the model's floor. The layer lands
  // where the kind asked and is selected, so the next gesture moves it — which
  // is better than refusing an add the model would have accepted.
  return { t: { ...preferred }, free: false };
}

/** Would this layer overlap anything already on the panel? The test's predicate. */
export function overlapsExisting(look: Look, layer: Pick<Layer, 'frame' | 't' | 'id'>): boolean {
  const box = boxOf(layer.frame, layer.t);
  return look.layers
    .slice(1)
    .filter((l) => l.on && l.id !== layer.id)
    .some((l) => overlaps(box, boxOf(l.frame, l.t), 0));
}
