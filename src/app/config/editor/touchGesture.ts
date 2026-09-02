/**
 * The touch half of one gesture model — §8, "the phone edits the same Look".
 *
 * `gesture.ts` is the model: begin, apply, end, one history entry. It speaks in
 * **units** and it takes a single point, which is exactly right for a mouse and
 * is not what a hand does. A phone brings three things a mouse never had:
 *
 *  - two fingers moving apart, which means *scale*;
 *  - two fingers turning, which means *rotate*;
 *  - a finger that stays put, which means *tell me about this one*.
 *
 * The tempting shape is a second `applyTouchGesture` beside `applyGesture` —
 * and that is a fork of the model, with its own snapping, its own clamping and
 * its own idea of what `endGesture` commits. Six weeks later the phone rounds
 * rotation to 15° and the desktop does not, and nobody can say which is right.
 *
 * So this file translates instead. A pinch is a *distance ratio*, and
 * `applyGesture`'s scale arm already computes exactly that — the ratio of the
 * finger's distance from the layer's centre now to what it was at finger-down.
 * {@link scaleDrivePoint} synthesises the point that produces the ratio the two
 * fingers just described; {@link rotateDrivePoint} does the same for the angle.
 * The gesture that reaches the store is a `scale-se` or a `rotate` like any
 * other, snapped by the same `snap()`, committed by the same `endGesture`,
 * undone by the same entry.
 *
 * Everything here is pure and unit-free of the DOM: the caller converts screen
 * pixels to units through its own surface scale, which is the same contract the
 * halo and the ring already share.
 */

import type { UnitPoint } from './gesture';

/**
 * How long a finger has to stay still before it is asking a question.
 *
 * 500 ms is the platform convention on both phones (iOS's own long-press, and
 * Android's `ViewConfiguration` default) — a number worth matching rather than
 * improving, because a person's thumb has already learned it somewhere else.
 */
export const LONG_PRESS_MS = 500;

/**
 * …and how far it may drift while it waits, in units.
 *
 * A finger on glass never holds still: capacitive jitter alone moves the
 * reported point by a pixel or two, and 0.03 units is about 9 px on a 640 px
 * Elite — under a fingertip, over the noise. Above it the person is dragging,
 * and a drag that turns into a context menu because the hand paused is the
 * worst kind of surprise.
 */
export const LONG_PRESS_SLOP_UNITS = 0.03;

/**
 * The dead zones that decide what a two-finger gesture MEANS.
 *
 * A real pinch is never purely a pinch: the hand rotates a little while it
 * spreads, and the fingers spread a little while they turn. Running both arms
 * at once would apply that noise as a permanent change — every resize would
 * leave the layer a few degrees off square — so the surface commits to one
 * interpretation, the first one to clear its dead zone, and holds it for the
 * rest of the gesture.
 *
 * The scale threshold is on the LOG of the factor so that growing by a tenth
 * and shrinking by a tenth are the same distance from "no change"; a linear
 * threshold would make shrinking harder to trigger than growing, which is the
 * kind of asymmetry a hand notices and cannot name.
 */
export const PINCH_DEADZONE_LN = 0.08;
export const TWIST_DEADZONE_DEG = 6;

/** Two fingers, in units, at one instant. */
export interface TwoFingerSample {
  a: UnitPoint;
  b: UnitPoint;
}

const DEG = 180 / Math.PI;
/** Below this the two fingers are one point and every ratio is meaningless. */
const MIN_SPREAD = 1e-4;

/** Degrees into (-180, 180]. The same wrap the model uses, stated once here. */
function wrap180(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return Object.is(d, -0) ? 0 : d;
}

/** How far apart the fingers are. */
export function fingerSpread(s: TwoFingerSample): number {
  return Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
}

/** Which way the line between them points, in degrees. */
export function fingerAngle(s: TwoFingerSample): number {
  return Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x) * DEG;
}

/**
 * The pinch, as the factor `applyGesture` already understands.
 *
 * `1` for a degenerate start, which is the honest answer: two fingers that
 * landed on the same pixel have not described a size, and inventing one would
 * make the layer jump on the first frame of the gesture.
 */
export function pinchFactor(start: TwoFingerSample, now: TwoFingerSample): number {
  const d0 = fingerSpread(start);
  if (d0 < MIN_SPREAD) return 1;
  return fingerSpread(now) / d0;
}

/** The twist, in degrees, wrapped the way the model wraps rotation. */
export function twistDegrees(start: TwoFingerSample, now: TwoFingerSample): number {
  return wrap180(fingerAngle(now) - fingerAngle(start));
}

/**
 * What the hand is doing — or `null` while it has not said yet.
 *
 * Deliberately a decision the caller makes ONCE and then keeps: re-deciding
 * every frame would let a rotate become a scale halfway through a gesture,
 * which is a layer that changes shape when the wrist relaxes.
 */
export type TwoFingerIntent = 'scale' | 'rotate';

export function twoFingerIntent(
  start: TwoFingerSample,
  now: TwoFingerSample,
): TwoFingerIntent | null {
  const factor = pinchFactor(start, now);
  const spread = factor <= 0 ? 0 : Math.abs(Math.log(factor));
  const twist = Math.abs(twistDegrees(start, now));
  const pinched = spread >= PINCH_DEADZONE_LN;
  const turned = twist >= TWIST_DEADZONE_DEG;
  if (!pinched && !turned) return null;
  if (pinched && !turned) return 'scale';
  if (turned && !pinched) return 'rotate';
  // Both cleared on the same frame — a fast, sloppy gesture. Compare how far
  // each is PAST its own threshold, so the units cancel and neither dead zone
  // gets to be the tie-breaker by being the smaller number.
  return spread / PINCH_DEADZONE_LN >= twist / TWIST_DEADZONE_DEG ? 'scale' : 'rotate';
}

/**
 * The single point that makes `applyGesture`'s scale arm produce `factor`.
 *
 * Its arithmetic is `|p − centre| / |p0 − centre|`, so the point that yields a
 * given ratio is the original grab pushed out along its own radius. The layer's
 * centre is `t.x, t.y` at finger-down, which is what `beginGesture` captured.
 */
export function scaleDrivePoint(centre: UnitPoint, p0: UnitPoint, factor: number): UnitPoint {
  return {
    x: centre.x + (p0.x - centre.x) * factor,
    y: centre.y + (p0.y - centre.y) * factor,
  };
}

/**
 * …and the point that makes the rotate arm produce `deg`.
 *
 * Same idea: the arm measures the angle the grab has swept around the centre,
 * so the grab is rotated about the centre by the angle the two fingers turned.
 */
export function rotateDrivePoint(centre: UnitPoint, p0: UnitPoint, deg: number): UnitPoint {
  const rad = (deg * Math.PI) / 180;
  const dx = p0.x - centre.x;
  const dy = p0.y - centre.y;
  return {
    x: centre.x + dx * Math.cos(rad) - dy * Math.sin(rad),
    y: centre.y + dx * Math.sin(rad) + dy * Math.cos(rad),
  };
}

/**
 * Has a finger asked a question?
 *
 * Both halves, because either alone is a different gesture: long enough, and
 * still enough. The caller passes the time it has, so this stays testable
 * without a clock and without a timer.
 */
export function longPressFired(args: {
  downAt: number;
  now: number;
  from: UnitPoint;
  to: UnitPoint;
}): boolean {
  if (args.now - args.downAt < LONG_PRESS_MS) return false;
  return Math.hypot(args.to.x - args.from.x, args.to.y - args.from.y) <= LONG_PRESS_SLOP_UNITS;
}
