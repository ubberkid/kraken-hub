/**
 * The one glide, and the cadence that drives it.
 *
 * CAM's monitoring feed is 1 Hz. Written straight to the screen that is a step
 * function: once a second every arc jumps and every digit jumps with it, which
 * on a panel viewed from a metre reads as a twitch rather than as a reading —
 * and costs the most of anything the module can do, because CAM re-compresses
 * whatever moved and a step moves everything at once.
 *
 * So every displayed value goes through `approach()` on the way to the DOM: an
 * exponential glide in the value's OWN scale (°C, a 0..1 load, RPM), advanced
 * by the frame clock's `dt`. Three properties make it the right shape:
 *
 *  - **Frame-rate independent.** The blend factor is derived from `dt`, so the
 *    glide takes the same wall-clock time at 1 fps and at 40, and the module
 *    stays correct under the governor rather than merely cheaper.
 *  - **Monotone, and incapable of overshoot.** The factor is in `[0, 1)`, so
 *    the value moves toward the target and stops there. A spring would look
 *    livelier and would show a temperature the sensor never reported.
 *  - **Settled inside {@link TWEEN_MS}.** The time constant is chosen so the
 *    remaining error is under {@link SETTLE_EPS} after one `TWEEN_MS`, which is
 *    what makes "the number is never more than a moment behind the truth" a
 *    testable claim rather than a feel.
 *
 * Deliberately its own file, and deliberately NOT an import from another
 * module's helpers: the effect module has a glide of its own with a ~2 s time
 * constant for warmth, and reaching across for it would both bind the two
 * timings together and pull a second module's chunk onto the stats display
 * path, which `tests/e2e` asserts never happens.
 */

/**
 * How long a value takes to reach its new sample, in ms.
 *
 * Inside the 300–600 ms band: long enough that a step never reads as a jump,
 * short enough that the number on the glass is the number the sensor reported
 * well before the next sample replaces it.
 */
export const TWEEN_MS = 420;

/** "Settled" — the residual error that counts as arrived. */
export const SETTLE_EPS = 0.02;

/**
 * The same idea, expressed against a metric's OWN range.
 *
 * `SETTLE_EPS` is a fraction of the remaining distance, which is what sizes the
 * time constant. Deciding whether a glide is still RUNNING needs an absolute
 * answer instead, and it cannot be one number: the readings are in °C (a range
 * eighty wide), in RPM (three thousand) and as a 0..1 load, so `0.02` would be
 * a rounding error on one and a visible step on another.
 *
 * A twentieth of a percent of the metric's range is comfortably below anything
 * either mark can show — the digits are whole units and the dash is two
 * decimals of a hundred — so crossing it means "nothing on the glass can change
 * again", which is exactly when the renderer should go quiet.
 */
export const SETTLE_FRACTION = 0.0005;

/**
 * Is this glide still going anywhere?
 *
 * Exponential decay never reaches its target in floating point until the step
 * underflows, which takes ~3 s of frames — three times longer than the feed's
 * own period, so a renderer that waited for equality would never stop asking
 * for frames. This is the honest stopping rule, and the renderer snaps to the
 * target the moment it returns `false`.
 */
export function unsettled(current: number, target: number, span: number): boolean {
  if (!Number.isFinite(current) || !Number.isFinite(target)) return false;
  const scale = Number.isFinite(span) && span > 0 ? span : 1;
  return Math.abs(target - current) > SETTLE_FRACTION * scale;
}

/** `-ln(SETTLE_EPS)`: how many time constants one `TWEEN_MS` has to be worth. */
const SETTLE_DECAYS = -Math.log(SETTLE_EPS);

/**
 * Longest `dt` that may be integrated in one step.
 *
 * A hidden window, a stalled rAF or a laptop lid produces a multi-second `dt`.
 * Clamping means the value snaps (the factor is effectively 1 by then) rather
 * than the maths being handed a number it was never sized for.
 */
export const MAX_STEP_MS = 1000;

/**
 * One step of the glide.
 *
 * `target` non-finite returns `current` untouched — a sensor that stopped
 * reporting must not drag the reading toward zero, because gliding to cold is a
 * lie told slowly. `current` non-finite snaps to the target: that is the first
 * sample after a mount, and there is nothing to glide from.
 */
export function approach(
  current: number,
  target: number,
  dtMs: number,
  durationMs: number = TWEEN_MS,
): number {
  if (!Number.isFinite(target)) return current;
  if (!Number.isFinite(current)) return target;
  if (!Number.isFinite(dtMs) || dtMs <= 0) return current;
  if (durationMs <= 0) return target;
  const tau = durationMs / SETTLE_DECAYS;
  const k = 1 - Math.exp(-Math.min(dtMs, MAX_STEP_MS) / tau);
  return current + (target - current) * k;
}

/** Governor tiers, in the vocabulary `DisplayRenderer.budget()` speaks. */
export type BudgetTier = 'full' | 'reduced' | 'hz1';

/** `reduced` updates ten times a second; `hz1` once, and without a glide. */
export const REDUCED_INTERVAL_MS = 100;
export const HZ1_INTERVAL_MS = 1000;

/**
 * How long the module must wait between updates at a tier.
 *
 * `full` is zero — every tick. The other two are wall-clock intervals rather
 * than tick counts, because a tick is worth 25 ms at `targetFps = 40` and a
 * whole second at 1, and "ten times a second" has to mean the same thing on
 * both panels.
 */
export function tierIntervalMs(tier: BudgetTier): number {
  if (tier === 'reduced') return REDUCED_INTERVAL_MS;
  if (tier === 'hz1') return HZ1_INTERVAL_MS;
  return 0;
}

/**
 * Does this tier still glide?
 *
 * `hz1` does not. At one update per second the glide has no frames to happen
 * in, and an exponential sampled once per time constant is not a glide — it is
 * a step with a rounding error. The honest answer at that tier is to snap to
 * the sample, which is exactly what the feed is giving us anyway.
 */
export function tierTweens(tier: BudgetTier): boolean {
  return tier !== 'hz1';
}
