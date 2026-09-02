/**
 * STEP 2 (docs/modules.md §4) — every decision the renderer makes that does not
 * touch the DOM or a GL context.
 *
 * Three of them, and all three exist because **values glide, they never chunk**:
 *
 *  - `advanceTime` integrates dt rather than reading a wall clock, so changing
 *    the speed slider bends the curve instead of jumping the picture. A renderer
 *    that computed `t = now * speed` would teleport the effect the moment the
 *    slider moved, by up to the whole elapsed run.
 *  - `approachTemp` glides the warmth toward the 1 Hz reading with a
 *    frame-rate-independent exponential. Writing the reading straight into the
 *    uniform would step the whole frame once a second — the one thing CAM's
 *    compressor charges most for, and visible as a pulse.
 *  - `shouldDraw` is the governor's tier expressed as arithmetic, so the cadence
 *    can be tested without a GL context.
 */

import { clamp } from '../../lib/clamp';

/** Governor tiers. `hz1` still advances time — it just paints once a second. */
export type BudgetTier = 'full' | 'reduced' | 'hz1';

/** `reduced` paints on every other tick. */
export const REDUCED_EVERY = 2;
export const HZ1_INTERVAL_MS = 1000;

/**
 * Longest dt that may be integrated in one go.
 *
 * A hidden window, a stalled rAF or a laptop lid produces a multi-second dt.
 * Integrating it would advance the effect by that whole gap in a single frame,
 * which reads as a jump-cut; clamping means a stall costs a slowdown nobody can
 * see rather than a discontinuity everybody can.
 */
export const MAX_STEP_MS = 250;

const MS_PER_S = 1000;

/** Seconds of effect time after `dtMs` at `speed`. Monotone, never jumps. */
export function advanceTime(time: number, dtMs: number, speed: number): number {
  if (!Number.isFinite(dtMs) || dtMs <= 0) return time;
  if (!Number.isFinite(speed)) return time;
  return time + (Math.min(dtMs, MAX_STEP_MS) / MS_PER_S) * speed;
}

/**
 * Should this tick paint?
 *
 * `full` every tick; `reduced` every other tick (the frame counter is the
 * governor's, so two layers at the same tier stay in phase with themselves and
 * the stagger is the governor's business); `hz1` once a second by wall time,
 * which is the only one of the three that has to be time-based — at
 * `targetFps = 1` a tick-counted "once a second" would be once a second, but at
 * 40 it would be once every forty.
 */
export function shouldDraw(
  tier: BudgetTier,
  frame: number,
  nowMs: number,
  lastDrawAt: number | null,
): boolean {
  if (lastDrawAt === null) return true;
  if (tier === 'full') return true;
  if (tier === 'reduced') return frame % REDUCED_EVERY === 0;
  return nowMs - lastDrawAt >= HZ1_INTERVAL_MS;
}

/** Coolest reading that reads as 0 warmth. Idle silicon sits around here. */
export const TEMP_COOL_C = 30;
/** Hottest reading that reads as 1. Above it the effect is simply at full ember. */
export const TEMP_HOT_C = 90;

/**
 * A temperature to the 0..1 the fragment source takes, or `null` when CAM is
 * not reporting that sensor.
 *
 * `null` rather than 0: "no reading" and "cold" are different facts, and the
 * caller decides what to do with the first (it holds the last warmth rather
 * than gliding to cold, which would be a lie told slowly).
 */
export function normalizeTemp(tempC: number | undefined): number | null {
  if (tempC === undefined || !Number.isFinite(tempC)) return null;
  const span = TEMP_HOT_C - TEMP_COOL_C;
  return clamp((tempC - TEMP_COOL_C) / span, 0, 1);
}

/**
 * Time constant of the warmth glide, in ms.
 *
 * The feed is 1 Hz, so anything much shorter than a second still steps; ~2.2 s
 * covers a step in about three readings, which is slow enough that the frame
 * never changes by a visible amount in one tick and fast enough that a spike
 * under load is on screen while the load is.
 */
export const TEMP_GLIDE_MS = 2200;

/**
 * One step of an exponential approach: frame-rate independent, monotone, and
 * mathematically incapable of overshooting (the blend factor is in [0,1)).
 */
export function approachTemp(current: number, target: number, dtMs: number): number {
  if (!Number.isFinite(dtMs) || dtMs <= 0) return current;
  if (!Number.isFinite(target)) return current;
  const k = 1 - Math.exp(-Math.min(dtMs, MAX_STEP_MS) / TEMP_GLIDE_MS);
  return current + (target - current) * k;
}
