import { describe, expect, it } from 'vitest';

import { NUDGE_PX, NUDGE_SHIFT_PX, nudgeStep, nudgeUnits } from './nudge';

/**
 * §2.1's "1 px, 10 with Shift" — and the point is that it is a PANEL pixel.
 *
 * The editor shipped a flat `0.01` unit step, which is 3.2 px on a 640 Elite and
 * 1.2 on a 240 square: the same press, two different visible distances, neither
 * of them a pixel. These are the arithmetic that fixes it.
 */
describe('nudgeUnits', () => {
  it('turns a panel pixel into the reciprocal of the radius', () => {
    // A 640 round panel has R = 320, so one pixel is 1/320 of a unit.
    expect(nudgeUnits(1, 320)).toBe(1 / 320);
    expect(nudgeUnits(10, 320)).toBe(10 / 320);
  });

  it('gives the SAME pixel on a panel of another size', () => {
    // The whole point: a press moves one panel pixel on a 240 square too, which
    // is a bigger number in units because the units are smaller there.
    const elite = nudgeUnits(1, 320);
    const square = nudgeUnits(1, 120);
    expect(square).toBeGreaterThan(elite);
    expect(elite * 320).toBeCloseTo(1, 10);
    expect(square * 120).toBeCloseTo(1, 10);
  });

  it('yields zero rather than Infinity on a panel that has not been measured', () => {
    // A press that does nothing is recoverable; one that throws the layer to
    // the clamp is not.
    expect(nudgeUnits(1, 0)).toBe(0);
    expect(nudgeUnits(1, -5)).toBe(0);
    expect(nudgeUnits(Number.NaN, 320)).toBe(0);
    expect(nudgeUnits(1, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('nudgeStep', () => {
  it('is one pixel, and ten with Shift', () => {
    expect(nudgeStep(false, 320)).toBe(NUDGE_PX / 320);
    expect(nudgeStep(true, 320)).toBe(NUDGE_SHIFT_PX / 320);
    expect(nudgeStep(true, 320)).toBe(nudgeStep(false, 320) * 10);
  });
});
