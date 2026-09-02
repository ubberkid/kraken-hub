import { describe, expect, it } from 'vitest';

import { IDENTITY, type Layer, type Look } from '../../../state/look/types';

import { beginGesture, applyGesture } from './gesture';
import { fakeRegistry } from './registryPort';
import {
  LONG_PRESS_MS,
  LONG_PRESS_SLOP_UNITS,
  PINCH_DEADZONE_LN,
  TWIST_DEADZONE_DEG,
  fingerAngle,
  fingerSpread,
  longPressFired,
  pinchFactor,
  rotateDrivePoint,
  scaleDrivePoint,
  twistDegrees,
  twoFingerIntent,
  type TwoFingerSample,
} from './touchGesture';

/**
 * The phone's three gestures, as arithmetic — §8.
 *
 * The interesting assertions are not the trigonometry (which is four lines and
 * obviously right) but the two properties the surface depends on:
 *
 *  - a pinch and a twist mean ONE thing, decided once, so a sloppy hand cannot
 *    leave a resized layer a few degrees off square;
 *  - the drive points really do drive `applyGesture` — the whole point of this
 *    module is that the phone does not fork the gesture model, and a translator
 *    nobody checks against the thing it translates for is a fork with extra
 *    steps. The last describe below runs the real `beginGesture`/`applyGesture`
 *    and asserts the transform that comes out.
 */

function sample(ax: number, ay: number, bx: number, by: number): TwoFingerSample {
  return { a: { x: ax, y: ay }, b: { x: bx, y: by } };
}

describe('the two-finger readings', () => {
  it('measures the spread and the angle of the line between the fingers', () => {
    expect(fingerSpread(sample(0, 0, 3, 4))).toBeCloseTo(5, 10);
    expect(fingerAngle(sample(0, 0, 1, 0))).toBeCloseTo(0, 10);
    expect(fingerAngle(sample(0, 0, 0, 1))).toBeCloseTo(90, 10);
  });

  it('turns a pinch into the factor the scale arm already speaks', () => {
    expect(pinchFactor(sample(-1, 0, 1, 0), sample(-2, 0, 2, 0))).toBeCloseTo(2, 10);
    expect(pinchFactor(sample(-2, 0, 2, 0), sample(-1, 0, 1, 0))).toBeCloseTo(0.5, 10);
  });

  /**
   * Two fingers that landed on one pixel have not described a size.
   *
   * `1` rather than `Infinity` or `NaN`: the honest answer is "no change", and
   * either of the others would make the layer jump or vanish on frame one.
   */
  it('refuses to invent a factor from a degenerate grab', () => {
    expect(pinchFactor(sample(0, 0, 0, 0), sample(-1, 0, 1, 0))).toBe(1);
  });

  it('wraps the twist the way the model wraps rotation', () => {
    expect(twistDegrees(sample(0, 0, 1, 0), sample(0, 0, 0, 1))).toBeCloseTo(90, 10);
    // Just past half a turn is a small NEGATIVE angle, not 190°: the hand
    // turned one way, and the layer must not spin the long way round.
    expect(
      twistDegrees(sample(0, 0, 1, 0), sample(0, 0, Math.cos(3.32), Math.sin(3.32))),
    ).toBeLessThan(0);
  });
});

describe('what the hand is doing', () => {
  it('says nothing at all until a dead zone is cleared', () => {
    // A hand that has barely moved: half of each threshold.
    const nudged = Math.exp(PINCH_DEADZONE_LN / 2);
    const start = sample(-1, 0, 1, 0);
    const now = sample(-nudged, 0, nudged, 0);
    expect(twoFingerIntent(start, now)).toBeNull();
  });

  it('reads a spread as a scale and a turn as a rotate', () => {
    const start = sample(-1, 0, 1, 0);
    expect(twoFingerIntent(start, sample(-2, 0, 2, 0))).toBe('scale');
    expect(twoFingerIntent(start, sample(0, -1, 0, 1))).toBe('rotate');
  });

  it('is symmetric: shrinking by a tenth is as decisive as growing by one', () => {
    const start = sample(-1, 0, 1, 0);
    const bigger = Math.exp(PINCH_DEADZONE_LN * 1.5);
    expect(twoFingerIntent(start, sample(-bigger, 0, bigger, 0))).toBe('scale');
    expect(twoFingerIntent(start, sample(-1 / bigger, 0, 1 / bigger, 0))).toBe('scale');
  });

  /**
   * The tie-break, which is the only part with a choice in it.
   *
   * A fast gesture clears both thresholds on the same frame. Comparing each
   * reading to its OWN threshold is what stops the smaller number winning by
   * being smaller — degrees and log-ratios are not comparable quantities.
   */
  it('picks whichever reading went furthest past its own threshold', () => {
    const start = sample(-1, 0, 1, 0);
    const factor = Math.exp(PINCH_DEADZONE_LN * 4);
    const barelyTurned = (TWIST_DEADZONE_DEG * 1.1 * Math.PI) / 180;
    const scaleWins = sample(
      -factor * Math.cos(barelyTurned),
      -factor * Math.sin(barelyTurned),
      factor * Math.cos(barelyTurned),
      factor * Math.sin(barelyTurned),
    );
    expect(twoFingerIntent(start, scaleWins)).toBe('scale');

    const barelyBigger = Math.exp(PINCH_DEADZONE_LN * 1.05);
    const turned = (TWIST_DEADZONE_DEG * 5 * Math.PI) / 180;
    const rotateWins = sample(
      -barelyBigger * Math.cos(turned),
      -barelyBigger * Math.sin(turned),
      barelyBigger * Math.cos(turned),
      barelyBigger * Math.sin(turned),
    );
    expect(twoFingerIntent(start, rotateWins)).toBe('rotate');
  });
});

describe('the long press', () => {
  const from = { x: 0, y: 0 };

  it('needs the platform’s own half-second, and not a millisecond less', () => {
    expect(longPressFired({ downAt: 0, now: LONG_PRESS_MS - 1, from, to: from })).toBe(false);
    expect(longPressFired({ downAt: 0, now: LONG_PRESS_MS, from, to: from })).toBe(true);
  });

  it('tolerates a fingertip of jitter and nothing more', () => {
    const jitter = { x: LONG_PRESS_SLOP_UNITS * 0.9, y: 0 };
    const dragged = { x: LONG_PRESS_SLOP_UNITS * 1.1, y: 0 };
    expect(longPressFired({ downAt: 0, now: LONG_PRESS_MS, from, to: jitter })).toBe(true);
    expect(longPressFired({ downAt: 0, now: LONG_PRESS_MS, from, to: dragged })).toBe(false);
  });
});

/**
 * ── THE POINT OF THE MODULE ─────────────────────────────────────────────────
 *
 * The drive points are only correct if `applyGesture` produces exactly the
 * scale factor and exactly the rotation the fingers described. Anything else
 * and the phone has quietly grown its own gesture arithmetic.
 */
describe('driving the ONE gesture model', () => {
  const REGISTRY = fakeRegistry({
    text: {
      roles: ['overlay'],
      maxInstances: 8,
      resize: 'frame',
      minFrame: 0.2,
      overlayDefault: { frame: { w: 1, h: 0.4, shape: 'square' }, t: IDENTITY },
    },
  });

  const layer: Layer = {
    id: 'l1',
    kind: 'text',
    on: true,
    frame: { w: 1, h: 0.4, shape: 'square' },
    t: { ...IDENTITY, x: 0.2, y: -0.1, r: 10, s: 1 },
  };
  const look: Look = {
    layers: [{ id: 'base', kind: 'video', on: true, frame: 'panel', t: IDENTITY }, layer],
  };
  const ctx = {
    look,
    registry: REGISTRY,
    panel: { shape: 'circle' as const },
    render: { safeRadiusPct: 0.88 },
  };
  const centre = { x: layer.t.x, y: layer.t.y };
  const p0 = { x: centre.x + 1, y: centre.y };

  it('turns a pinch into that exact scale factor', () => {
    const gs = beginGesture(layer, 'scale-se', p0, ctx);
    const next = applyGesture(gs, scaleDrivePoint(centre, p0, 1.75));
    expect(next.s).toBeCloseTo(1.75, 10);
    // …and nothing else moved. A pinch is a size, not a place.
    expect(next.x).toBeCloseTo(layer.t.x, 10);
    expect(next.y).toBeCloseTo(layer.t.y, 10);
  });

  it('turns a twist into that exact rotation', () => {
    const gs = beginGesture(layer, 'rotate', p0, ctx);
    // Snapping off: the model snaps rotation to 0/15/45/90 and this assertion
    // is about the translation, not about the snap (which `snap.test.ts` owns).
    const next = applyGesture(gs, rotateDrivePoint(centre, p0, 32), { snap: false });
    expect(next.r).toBeCloseTo(layer.t.r + 32, 10);
  });

  it('keeps the rotation snap the desktop has, because it is the same call', () => {
    const gs = beginGesture(layer, 'rotate', p0, ctx);
    // 10° + 34° = 44°, which the model pulls to the 45° tick.
    const next = applyGesture(gs, rotateDrivePoint(centre, p0, 34));
    expect(next.r).toBeCloseTo(45, 6);
  });
});
