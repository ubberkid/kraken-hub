/**
 * The glide, proved rather than felt.
 *
 * The claim the face redesign makes is that a 1 Hz feed never *chunks*: a new
 * sample is arrived at, not jumped to, and the arrival takes a bounded, known
 * time. Both halves of that are testable without a DOM and without a clock,
 * because `approach()` takes `dt` as an argument — which is also the property
 * that makes the module correct at 1 fps and at 40 rather than merely cheaper.
 */

import { describe, expect, it } from 'vitest';

import {
  HZ1_INTERVAL_MS,
  MAX_STEP_MS,
  REDUCED_INTERVAL_MS,
  SETTLE_EPS,
  TWEEN_MS,
  approach,
  tierIntervalMs,
  tierTweens,
} from './tween';

/** A frame at 60 Hz, which is the fastest the module will ever be ticked. */
const FRAME_MS = 1000 / 60;
/** The band the brief allows a value glide to live in. */
const BAND_MIN_MS = 300;
const BAND_MAX_MS = 600;

/** Run `ms` of simulated frames and hand back every value along the way. */
function glide(from: number, to: number, ms: number, stepMs = FRAME_MS): number[] {
  const seen: number[] = [];
  let v = from;
  for (let t = 0; t < ms; t += stepMs) {
    v = approach(v, to, stepMs);
    seen.push(v);
  }
  return seen;
}

describe('the value glide', () => {
  it('takes between 300 and 600 ms — long enough to read, short enough to trust', () => {
    expect(TWEEN_MS).toBeGreaterThanOrEqual(BAND_MIN_MS);
    expect(TWEEN_MS).toBeLessThanOrEqual(BAND_MAX_MS);
  });

  it('approaches the sample monotonically and never overshoots it', () => {
    const seen = glide(40, 80, BAND_MAX_MS);
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i] ?? 0).toBeGreaterThanOrEqual(seen[i - 1] ?? 0);
      // The overshoot a spring would give is a temperature nobody reported.
      expect(seen[i] ?? 0).toBeLessThanOrEqual(80);
    }
  });

  it('runs the same way downhill', () => {
    const seen = glide(80, 40, BAND_MAX_MS);
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i] ?? 0).toBeLessThanOrEqual(seen[i - 1] ?? 0);
      expect(seen[i] ?? 0).toBeGreaterThanOrEqual(40);
    }
  });

  it('settles inside 600 ms of simulated frames', () => {
    const span = 80 - 40;
    const seen = glide(40, 80, BAND_MAX_MS);
    const landed = seen[seen.length - 1] ?? 0;
    expect(Math.abs(80 - landed)).toBeLessThanOrEqual(span * SETTLE_EPS);
  });

  it('is frame-rate independent: 1 fps and 60 fps arrive together', () => {
    const fast = glide(40, 80, BAND_MAX_MS, FRAME_MS);
    const slow = glide(40, 80, BAND_MAX_MS, BAND_MAX_MS);
    const a = fast[fast.length - 1] ?? 0;
    const b = slow[slow.length - 1] ?? 0;
    // Not identical — one is a coarser sampling of the same curve — but both
    // have arrived, which is the property the panel depends on.
    expect(Math.abs(a - b)).toBeLessThan(1);
  });

  it('clamps a monstrous dt rather than being handed one it was not sized for', () => {
    // A hidden window or a laptop lid produces a multi-second gap.
    const huge = approach(40, 80, MAX_STEP_MS * 100);
    const capped = approach(40, 80, MAX_STEP_MS);
    expect(huge).toBe(capped);
  });

  it('holds the last reading when the sensor stops reporting', () => {
    // Gliding toward zero would be a lie told slowly.
    expect(approach(61, Number.NaN, FRAME_MS)).toBe(61);
  });

  it('snaps on the first sample, which has nothing behind it to glide from', () => {
    expect(approach(Number.NaN, 61, FRAME_MS)).toBe(61);
  });

  it('does nothing on a zero or backwards dt', () => {
    expect(approach(40, 80, 0)).toBe(40);
    expect(approach(40, 80, -1)).toBe(40);
  });
});

describe('the governor tiers', () => {
  it('updates every tick at full, ten times a second reduced, once at hz1', () => {
    expect(tierIntervalMs('full')).toBe(0);
    expect(tierIntervalMs('reduced')).toBe(REDUCED_INTERVAL_MS);
    expect(tierIntervalMs('hz1')).toBe(HZ1_INTERVAL_MS);
    // Ten times a second, said as arithmetic rather than as a comment.
    expect(1000 / REDUCED_INTERVAL_MS).toBe(10);
  });

  it('stops gliding at hz1, because a glide sampled once a second is a step', () => {
    expect(tierTweens('full')).toBe(true);
    expect(tierTweens('reduced')).toBe(true);
    expect(tierTweens('hz1')).toBe(false);
  });
});
