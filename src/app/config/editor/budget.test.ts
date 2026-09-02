import { describe, expect, it } from 'vitest';

import { DEMOTE_RATIO, PROMOTE_RATIO } from '../../../render/layerGovernor';
import { BASE_LAYER_ID, IDENTITY, type Layer, type Look } from '../../../state/look/types';

import { budgetReading } from './budget';

import type { GetModule } from '../../../modules/stack';
import type { AnyKrakenModule, LayerCost } from '../../../modules/types';

/**
 * The meter's arithmetic — round 10's F3.
 *
 * The bar was `min(1, lookCost().total)`, and `lookCost` is normalised so ONE
 * VIDEO BASE is exactly 1.0. So the commonest Look in the product pinned the
 * meter at 100 %; eight layers on top of it pinned it at 100 % as well, because
 * the clamp had already been reached at one; and a clock base read 0 %. Three
 * distinct readings, two of them the ends, with the word *calm* beside the full
 * one.
 *
 * What the number should be measured against is HEADROOM, and the only thing in
 * the build that knows where the headroom runs out is `layerGovernor.ts`. So the
 * bar's two marks are the governor's two ratios, and these are the assertions
 * that keep them there — stated against `DEMOTE_RATIO` and `PROMOTE_RATIO`
 * themselves rather than against 0.6 and 0.9, so a change to the governor moves
 * the meter with it instead of quietly disagreeing.
 *
 * A hand-built registry rather than the real one: the editor may not import
 * `modules/registry.ts` (eager, and it would drag every manifest into
 * `config-ui`), and a test reading the real one would be asserting facts about
 * the video module rather than about this file's arithmetic.
 */

/** A kind that declares exactly the cost the test wants it to. */
function kind(cost: Partial<LayerCost>): AnyKrakenModule {
  return {
    capabilities: { motionLevel: 'full' },
    layer: {
      roles: ['base', 'overlay'],
      maxInstances: 8,
      resize: 'scale',
      minFrame: 0.3,
      overlayDefault: { frame: { w: 1, h: 1, shape: 'square' }, t: IDENTITY },
      cost: (): LayerCost => ({
        cadence: 'frame',
        coverage: 1,
        entropy: 'high',
        decoders: 0,
        gl: 0,
        ...cost,
      }),
    },
  } as unknown as AnyKrakenModule;
}

/**
 * The shapes that mattered in the finding.
 *
 * `video` is the unit `lookCost` is normalised against — a full-frame,
 * full-entropy repaint with a decoder, which sums to exactly 1.0. `clock` is the
 * other end: a `static` cadence, which is a layer that costs the panel nothing
 * once it is up and really should read as almost nothing. `effect` sits between
 * them.
 */
const REGISTRY: Record<string, AnyKrakenModule> = {
  video: kind({ decoders: 1 }),
  effect: kind({ entropy: 'mid', coverage: 1, gl: 1 }),
  clock: kind({ cadence: 'static', entropy: 'low', coverage: 0.2 }),
  /* An overlay that costs a full repaint and no scarce hardware, so a test can
     stack as many as it likes without `normalizeLook` refusing them for a
     reason — one decoder, two contexts — that is not the one under test. */
  heavy: kind({}),
};

const registry: GetModule = (id) => REGISTRY[id] ?? null;

function baseOf(kindId: string): Layer {
  return { id: BASE_LAYER_ID, kind: kindId, on: true, frame: 'panel', t: IDENTITY };
}

function look(kindId: string, overlays: readonly string[] = []): Look {
  return {
    layers: [
      baseOf(kindId),
      ...overlays.map((k, i) => ({
        id: `L${String(i)}`,
        kind: k,
        on: true,
        frame: 'panel' as const,
        t: IDENTITY,
      })),
    ],
  };
}

function estimate(kindId: string, overlays: readonly string[] = []) {
  return budgetReading({
    look: look(kindId, overlays),
    registry,
    presence: 'quiet',
    targetFps: null,
    achievedFps: null,
  });
}

describe('the budget meter, with no reading to go on', () => {
  /**
   * The finding itself: the commonest Look is not a full bar.
   *
   * One video base is `lookCost().total === 1`, which is the cost model's own
   * `calm` boundary — so it lands exactly on the mark where the governor would
   * begin watching, and not a pixel further.
   */
  it('puts one video base at the governor’s first mark, not at the top', () => {
    const reading = estimate('video');
    expect(reading.fill).toBeCloseTo(DEMOTE_RATIO, 5);
    expect(reading.verdict).toBe('calm');
    expect(reading.estimated).toBe(true);
  });

  /** …and the other end is genuinely near zero, because a clock is. */
  it('puts a static base near the bottom', () => {
    const reading = estimate('clock');
    expect(reading.fill).toBeLessThan(0.05);
    expect(reading.verdict).toBe('calm');
  });

  /** Three Looks, three positions — the property the old bar could not have. */
  it('separates looks the old clamp could not tell apart', () => {
    const readings = [estimate('clock').fill, estimate('effect').fill, estimate('video').fill];
    expect(new Set(readings).size).toBe(3);
    expect(readings[0]).toBeLessThan(readings[1] ?? 0);
    expect(readings[1]).toBeLessThan(readings[2] ?? 0);
  });

  /**
   * Loading a video base up moves the bar past the second mark and never past
   * the top — which is what "the meter is full for this look" has to mean.
   */
  it('runs past the second mark when a look is genuinely heavy, and stops at the top', () => {
    const heavy = estimate('video', ['heavy', 'heavy']);
    expect(heavy.fill).toBeGreaterThan(PROMOTE_RATIO);
    expect(heavy.fill).toBeLessThanOrEqual(1);
    expect(heavy.verdict).toBe('rich');
  });

  /**
   * The word is the cost model's, not this file's.
   *
   * `budgetReading` returns `cost.verdict` straight through in the estimate
   * voice, so the boundaries stated in `budget.ts` for the BAR's positions can
   * never make the meter say a different word than `lookCost` does. This is that
   * guarantee, asserted rather than described: `calm` is impossible at the top
   * of the bar and `rich` is impossible at the bottom of it.
   */
  it('never reports a full bar as calm', () => {
    const readings = (
      [
        ['clock', []],
        ['effect', []],
        ['video', []],
        ['video', ['heavy']],
        ['video', ['heavy', 'heavy']],
      ] as const
    ).map(([k, extra]) => {
      const r = estimate(k, extra);
      return { where: `${k} + ${String(extra.length)}`, verdict: r.verdict, fill: r.fill };
    });

    // Stated as a filter rather than as a branch around an assertion: what has
    // to hold is that no `calm` reading is above the first mark and no `rich`
    // one is below the second, and that is a property of the whole set.
    expect(readings.filter((r) => r.verdict === 'calm' && r.fill > DEMOTE_RATIO)).toEqual([]);
    expect(readings.filter((r) => r.verdict === 'rich' && r.fill <= PROMOTE_RATIO)).toEqual([]);
    // …and the set is not vacuous: it contains at least one of each.
    expect(readings.map((r) => r.verdict)).toContain('calm');
    expect(readings.map((r) => r.verdict)).toContain('rich');
  });

  /** The attribution appears whenever the reading is not calm, and only then. */
  it('names the heaviest layer exactly when there is something to say', () => {
    expect(estimate('clock').detail).toBeNull();
    expect(estimate('video', ['heavy', 'heavy']).detail).toContain('heaviest');
  });
});

describe('the budget meter, reading a frame rate', () => {
  function measured(achievedFps: number) {
    return budgetReading({
      look: look('video'),
      registry,
      presence: 'live',
      targetFps: 40,
      achievedFps,
    });
  }

  /** Keeping up perfectly is an empty bar, in the same coordinates. */
  it('is empty when the panel is delivering what it was asked for', () => {
    const reading = measured(40);
    expect(reading.fill).toBe(0);
    expect(reading.verdict).toBe('calm');
    expect(reading.estimated).toBe(false);
    expect(reading.fps).toBe(40);
  });

  /** The governor's demote point is the top of the bar, not a number apart. */
  it('is at the top where the governor would drop a tier', () => {
    const reading = measured(40 * DEMOTE_RATIO);
    expect(reading.fill).toBeCloseTo(PROMOTE_RATIO, 5);
    expect(reading.verdict).toBe('busy');
  });

  it('is past it when the panel is well behind', () => {
    const reading = measured(4);
    expect(reading.fill).toBeGreaterThan(PROMOTE_RATIO);
    expect(reading.verdict).toBe('rich');
    expect(reading.detail).toContain('heaviest');
  });
});
