import { describe, expect, it } from 'vitest';

import {
  HZ1_INTERVAL_MS,
  MAX_STEP_MS,
  REDUCED_EVERY,
  TEMP_COOL_C,
  TEMP_HOT_C,
  advanceTime,
  approachTemp,
  normalizeTemp,
  shouldDraw,
} from './motion';

describe('advanceTime', () => {
  it('integrates seconds at the configured speed', () => {
    expect(advanceTime(0, 100, 1)).toBeCloseTo(0.1);
    expect(advanceTime(0, 100, 2)).toBeCloseTo(0.2);
    expect(advanceTime(10, 25, 0.25)).toBeCloseTo(10.00625);
  });

  it('bends the curve instead of jumping when the speed changes', () => {
    // Ten ticks at 1×, then ten at 2×: the second run adds twice as much, and
    // nothing is recomputed from the elapsed run — so nothing teleports.
    let slow = 0;
    let fast = 0;
    for (let i = 0; i < 10; i += 1) slow = advanceTime(slow, 25, 1);
    fast = slow;
    for (let i = 0; i < 10; i += 1) fast = advanceTime(fast, 25, 2);
    expect(fast - slow).toBeCloseTo(2 * slow);
  });

  it('clamps a stall so a hidden window does not jump-cut the effect', () => {
    const gap = advanceTime(0, 30_000, 1);
    expect(gap).toBeCloseTo(MAX_STEP_MS / 1000);
  });

  it('is monotone and total', () => {
    expect(advanceTime(5, 0, 1)).toBe(5);
    expect(advanceTime(5, -1, 1)).toBe(5);
    expect(advanceTime(5, NaN, 1)).toBe(5);
    expect(advanceTime(5, 16, NaN)).toBe(5);
  });
});

describe('shouldDraw', () => {
  it('paints the first frame at every tier', () => {
    for (const tier of ['full', 'reduced', 'hz1'] as const) {
      expect(shouldDraw(tier, 0, 0, null)).toBe(true);
    }
  });

  it('paints every tick at full', () => {
    for (let frame = 1; frame <= 8; frame += 1) {
      expect(shouldDraw('full', frame, frame * 25, 0)).toBe(true);
    }
  });

  it('paints every other tick at reduced', () => {
    const painted: number[] = [];
    for (let frame = 1; frame <= 8; frame += 1) {
      if (shouldDraw('reduced', frame, frame * 25, 0)) painted.push(frame);
    }
    expect(painted).toEqual([2, 4, 6, 8]);
    expect(painted.length).toBe(8 / REDUCED_EVERY);
  });

  it('paints once a second at hz1, whatever the tick rate', () => {
    // 40 fps: 40 ticks, one paint.
    let last = 0;
    let paints = 0;
    for (let frame = 1; frame <= 40; frame += 1) {
      const now = frame * 25;
      if (shouldDraw('hz1', frame, now, last)) {
        paints += 1;
        last = now;
      }
    }
    expect(paints).toBe(1);
  });

  it('paints on the boundary, not a tick after it', () => {
    expect(shouldDraw('hz1', 99, HZ1_INTERVAL_MS - 1, 0)).toBe(false);
    expect(shouldDraw('hz1', 99, HZ1_INTERVAL_MS, 0)).toBe(true);
  });
});

describe('normalizeTemp', () => {
  it('maps the working range onto 0..1', () => {
    expect(normalizeTemp(TEMP_COOL_C)).toBe(0);
    expect(normalizeTemp(TEMP_HOT_C)).toBe(1);
    expect(normalizeTemp((TEMP_COOL_C + TEMP_HOT_C) / 2)).toBeCloseTo(0.5);
  });

  it('clamps outside it rather than over-driving the tint', () => {
    expect(normalizeTemp(-40)).toBe(0);
    expect(normalizeTemp(140)).toBe(1);
  });

  it('answers null for a sensor CAM is not reporting', () => {
    // Not 0: "no reading" and "cold" are different facts, and only one of them
    // should move the picture.
    expect(normalizeTemp(undefined)).toBeNull();
    expect(normalizeTemp(NaN)).toBeNull();
  });
});

describe('approachTemp', () => {
  it('approaches monotonically and never overshoots, going up', () => {
    let v = 0;
    let previous = -1;
    for (let i = 0; i < 1200; i += 1) {
      const next = approachTemp(v, 1, 25);
      expect(next).toBeGreaterThan(previous);
      expect(next).toBeGreaterThanOrEqual(v);
      expect(next).toBeLessThanOrEqual(1);
      previous = v;
      v = next;
    }
    expect(v).toBeCloseTo(1, 2);
  });

  it('approaches monotonically and never undershoots, coming down', () => {
    let v = 1;
    for (let i = 0; i < 1200; i += 1) {
      const next = approachTemp(v, 0, 25);
      expect(next).toBeLessThanOrEqual(v);
      expect(next).toBeGreaterThanOrEqual(0);
      v = next;
    }
    expect(v).toBeCloseTo(0, 2);
  });

  it('never steps: one 1 Hz reading moves the frame by a fraction of itself', () => {
    // The failure this exists for is writing the reading straight in, which
    // steps every pixel once a second — the one thing the compressor charges
    // most for. A single 25 ms tick may not cross a tenth of the gap.
    expect(approachTemp(0, 1, 25)).toBeLessThan(0.1);
  });

  it('is frame-rate independent: one long tick ≈ many short ones', () => {
    let many = 0;
    for (let i = 0; i < 10; i += 1) many = approachTemp(many, 1, 20);
    const one = approachTemp(0, 1, 200);
    expect(Math.abs(one - many)).toBeLessThan(0.01);
  });

  it('holds still when there is nothing to integrate', () => {
    expect(approachTemp(0.3, 1, 0)).toBe(0.3);
    expect(approachTemp(0.3, 1, NaN)).toBe(0.3);
    expect(approachTemp(0.3, NaN, 25)).toBe(0.3);
  });
});
