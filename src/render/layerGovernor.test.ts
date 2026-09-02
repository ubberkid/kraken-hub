/**
 * The governor is a state machine over a fake clock, because the two numbers
 * that matter about it are ten seconds and thirty seconds. A test that asserted
 * "it eventually demotes" would pass with no hysteresis at all — and no
 * hysteresis is exactly the bug: the tier would flap once a second, which looks
 * worse on the panel than either tier does.
 */

import { describe, expect, it } from 'vitest';

import { DEMOTE_AFTER_MS, PROMOTE_AFTER_MS, attribute, createLayerGovernor } from './layerGovernor';

import type { LookCost } from '../modules/stack';

const TARGET = 40;
/** 0.5 × target — below the 0.6 demote ratio. */
const BAD = 20;
/** 0.95 × target — above the 0.9 promote ratio. */
const GOOD = 38;
/** Between the two ratios: neither acts. */
const MIDDLE = 30;

function run(
  g: ReturnType<typeof createLayerGovernor>,
  fps: number,
  from: number,
  to: number,
  stepMs = 1000,
  targetFps = TARGET,
): number {
  let t = from;
  for (; t <= to; t += stepMs) g.sample({ t, achievedFps: fps, targetFps });
  return t - stepMs;
}

describe('demotion', () => {
  it('waits the full ten seconds — 9.9 s of bad frames is still full', () => {
    const g = createLayerGovernor();
    run(g, BAD, 0, DEMOTE_AFTER_MS - 100, 100);
    expect(g.tier()).toBe('full');
    g.sample({ t: DEMOTE_AFTER_MS, achievedFps: BAD, targetFps: TARGET });
    expect(g.tier()).toBe('reduced');
  });

  it('steps one tier at a time, never straight to hz1', () => {
    const g = createLayerGovernor();
    run(g, BAD, 0, DEMOTE_AFTER_MS, 500);
    expect(g.tier()).toBe('reduced');
    run(g, BAD, DEMOTE_AFTER_MS + 500, 2 * DEMOTE_AFTER_MS, 500);
    expect(g.tier()).toBe('hz1');
  });

  it('never goes below hz1 — there is no tier that hides a layer', () => {
    const g = createLayerGovernor();
    run(g, BAD, 0, 10 * DEMOTE_AFTER_MS, 1000);
    expect(g.tier()).toBe('hz1');
  });

  it('restarts the clock the moment the frame rate is no longer bad', () => {
    const g = createLayerGovernor();
    run(g, BAD, 0, 9000, 1000);
    // One recovered sample in the middle band: the ten seconds start over.
    g.sample({ t: 9500, achievedFps: MIDDLE, targetFps: TARGET });
    run(g, BAD, 10_000, 18_000, 1000);
    expect(g.tier()).toBe('full');
  });

  it('demotes immediately when the panel is already a slideshow', () => {
    const g = createLayerGovernor();
    g.sample({ t: 0, achievedFps: 2, targetFps: 5 });
    expect(g.tier()).toBe('reduced');
    g.sample({ t: 1000, achievedFps: 2, targetFps: 5 });
    expect(g.tier()).toBe('hz1');
  });
});

describe('promotion', () => {
  it('takes thirty seconds, three times longer than demotion', () => {
    const g = createLayerGovernor();
    run(g, BAD, 0, DEMOTE_AFTER_MS, 1000);
    expect(g.tier()).toBe('reduced');

    const at = run(g, GOOD, 11_000, 11_000 + PROMOTE_AFTER_MS - 1000, 1000);
    expect(g.tier()).toBe('reduced');
    g.sample({ t: at + 1000, achievedFps: GOOD, targetFps: TARGET });
    expect(g.tier()).toBe('full');
  });

  it('stays put in the band between the two ratios', () => {
    const g = createLayerGovernor('reduced');
    run(g, MIDDLE, 0, 5 * PROMOTE_AFTER_MS, 1000);
    expect(g.tier()).toBe('reduced');
  });

  it('reset returns to full with both timers cleared', () => {
    const g = createLayerGovernor();
    run(g, BAD, 0, 3 * DEMOTE_AFTER_MS, 1000);
    expect(g.tier()).toBe('hz1');
    g.reset();
    expect(g.tier()).toBe('full');
    run(g, BAD, 100_000, 105_000, 1000);
    expect(g.tier()).toBe('full');
  });
});

describe('attribution', () => {
  const cost: LookCost = {
    total: 1.6,
    layers: [
      { id: 'base', kind: 'video', w: 1 },
      { id: 'ovra', kind: 'effect', w: 0.6 },
    ],
    worst: { id: 'base', kind: 'video', w: 1 },
    verdict: 'rich',
    surfaces: 0,
    decoders: 1,
    gl: 1,
  };

  it('says nothing at full — there is nothing to explain', () => {
    expect(attribute('full', cost, TARGET).sentence).toBe('');
  });

  it('names the costliest layer in words, not ids', () => {
    const a = attribute('reduced', cost, TARGET);
    expect(a.worst?.kind).toBe('video');
    expect(a.sentence).toBe('This look is too rich for 40 fps — the costliest layer is video.');
  });

  it('has nothing to blame for an empty look', () => {
    const empty: LookCost = { ...cost, layers: [], worst: null };
    expect(attribute('hz1', empty, TARGET).sentence).toBe('');
  });
});
