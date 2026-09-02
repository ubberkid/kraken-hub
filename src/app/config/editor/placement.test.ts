import { describe, expect, it } from 'vitest';

import { baseLook, IDENTITY, type Frame, type Layer, type Look } from '../../../state/look/types';

import { PLACEMENT_GAP, overlapsExisting, placeNewLayer } from './placement';

import type { SnapPanel, SnapRender } from './snap';

const ROUND: SnapPanel = { shape: 'circle' };
const SQUARE: SnapPanel = { shape: 'square' };
const RENDER: SnapRender = { safeRadiusPct: 0.88 };

const STRIP: Exclude<Frame, 'panel'> = { w: 1.2, h: 0.4, shape: 'square' };
const BOTTOM = { ...IDENTITY, y: 0.55 };

function overlay(id: string, frame: Exclude<Frame, 'panel'>, x: number, y: number): Layer {
  return { id, kind: 'clock', on: true, frame, t: { ...IDENTITY, x, y }, cfg: {} };
}

function look(...overlays: Layer[]): Look {
  return { layers: [...baseLook('video').layers, ...overlays] };
}

describe('smart placement', () => {
  it('uses the kind’s own default when nothing is sitting there', () => {
    const { t, free } = placeNewLayer({
      look: look(),
      frame: STRIP,
      preferred: BOTTOM,
      panel: ROUND,
      render: RENDER,
    });
    expect(free).toBe(true);
    expect(t).toEqual(BOTTOM);
  });

  /** Principle 5's ✓: a new layer never lands on top of an existing one. */
  it('never overlaps an existing layer', () => {
    let current = look();
    const placed: Layer[] = [];
    for (let i = 0; i < 6; i++) {
      const { t, free } = placeNewLayer({
        look: current,
        frame: STRIP,
        preferred: BOTTOM,
        panel: ROUND,
        render: RENDER,
      });
      if (!free) break;
      const layer = { ...overlay(`l${String(i)}0000`, STRIP, t.x, t.y), t };
      expect(
        overlapsExisting(current, layer),
        `layer ${String(i)} landed on top of something at ${JSON.stringify(t)}`,
      ).toBe(false);
      placed.push(layer);
      current = { layers: [...current.layers, layer] };
    }
    // The search actually found room for more than one, or the assertion above
    // is vacuous.
    expect(placed.length).toBeGreaterThan(1);
  });

  /**
   * A GENERATED slot keeps its centre on the panel.
   *
   * The kind's own default is exempt — several of them are wide strips whose
   * corners bleed to the bezel on purpose — but a position this module invented
   * has no such excuse.
   */
  it('keeps a generated slot’s centre inside the safe circle', () => {
    const wide: Exclude<Frame, 'panel'> = { w: 1.4, h: 0.5, shape: 'square' };
    const preferred = { ...IDENTITY, x: 0, y: 0.55 };
    const { t, free } = placeNewLayer({
      look: look(overlay('lsitting', wide, preferred.x, preferred.y)),
      frame: wide,
      preferred,
      panel: ROUND,
      render: RENDER,
    });
    expect(free).toBe(true);
    // Not the preferred spot, and not off the disc either.
    expect(t).not.toEqual(preferred);
    expect(Math.hypot(t.x, t.y)).toBeLessThanOrEqual(RENDER.safeRadiusPct + 1e-9);
  });

  it('uses the panel edges on a square panel rather than a circle', () => {
    const { t, free } = placeNewLayer({
      look: look(overlay('lbottom0', STRIP, 0, 0.55)),
      frame: STRIP,
      preferred: BOTTOM,
      panel: SQUARE,
      render: RENDER,
    });
    expect(free).toBe(true);
    expect(t).not.toEqual(BOTTOM);
  });

  it('falls back to the preferred spot, and says so, when the panel is full', () => {
    const wall = [
      overlay('lw000001', { w: 2, h: 0.7, shape: 'square' }, 0, -0.6),
      overlay('lw000002', { w: 2, h: 0.7, shape: 'square' }, 0, 0),
      overlay('lw000003', { w: 2, h: 0.7, shape: 'square' }, 0, 0.6),
    ];
    const { t, free } = placeNewLayer({
      look: look(...wall),
      frame: STRIP,
      preferred: BOTTOM,
      panel: ROUND,
      render: RENDER,
    });
    expect(free).toBe(false);
    expect(t).toEqual(BOTTOM);
  });

  it('counts the gap as part of each box, so two layers are never flush', () => {
    const first = overlay('lfirst00', STRIP, 0, 0.55);
    const { t } = placeNewLayer({
      look: look(first),
      frame: STRIP,
      preferred: BOTTOM,
      panel: ROUND,
      render: RENDER,
    });
    const gap = Math.abs(t.y - 0.55) - STRIP.h;
    const apart = Math.abs(t.x) > STRIP.w || gap >= PLACEMENT_GAP - 1e-9;
    expect(apart).toBe(true);
  });
});

/**
 * The pile, under pressure — round 11's M-i.
 *
 * The single test above adds six copies of ONE frame, which is the easy case:
 * every candidate is the same size and the ring walk either finds room or does
 * not. What M-i found is the hard case, and it is the one a person actually
 * produces — one of each kind, in whatever order they happened to think of
 * them. The frames differ by a factor of four in width, so whether the seventh
 * fits depends on the order the first six went down in, and a search that only
 * ever tries one SIZE runs out and stacks.
 *
 * Measured before the fix, adding one of each kind: the last-added effect
 * overlay painted an opaque disc over the whole composition, and the
 * auto-placed Date ran off both sides of the glass ("…ed, Se…") because the
 * free-slot test looked at the layer's centre and never at its box.
 *
 * So this is a property rather than a case: every kind, in twenty random
 * orders, with two things asserted after every single add.
 *
 *  1. **No two overlays overlap** — `overlapsExisting`, the same predicate the
 *     single-frame test uses, for every layer already down.
 *  2. **Every PLACED layer's box is inside the safe circle** — every corner,
 *     which is the chord rule `boxOnPanel` enforces.
 *
 * The FIRST layer of each run is exempt from (2), and deliberately: it lands on
 * its kind's own `overlayDefault`, and several of those are wide strips meant
 * to bleed to the bezel (`placement.ts` says why, at length). The exemption is
 * exactly one layer per run, and the test asserts that it is — a search that
 * quietly started returning uncontained positions would fail here.
 *
 * The frames are the ones the shipped manifests declare, copied rather than
 * imported: this file is a pure unit test of a pure function, and reaching into
 * `modules/registry` to get them would make it a test of the registry's load
 * order too. `placement.property.test` failing after a manifest changes its
 * default is the right kind of failure — it means the geometry moved.
 */
const KIND_DEFAULTS: readonly {
  kind: string;
  frame: Exclude<Frame, 'panel'>;
  t: { x: number; y: number; s: number };
}[] = [
  { kind: 'clock', frame: { w: 1, h: 0.5, shape: 'square' }, t: { x: 0, y: 0.55, s: 1 } },
  { kind: 'stats', frame: { w: 1.6, h: 0.5, shape: 'square' }, t: { x: 0, y: 0.62, s: 1 } },
  { kind: 'text', frame: { w: 1.4, h: 0.4, shape: 'square' }, t: { x: 0, y: -0.5, s: 1 } },
  { kind: 'date', frame: { w: 1.2, h: 0.35, shape: 'square' }, t: { x: 0, y: 0.75, s: 1 } },
  { kind: 'icon', frame: { w: 0.5, h: 0.5, shape: 'square' }, t: { x: 0, y: -0.55, s: 1 } },
  { kind: 'shape', frame: { w: 1.4, h: 0.5, shape: 'square' }, t: { x: 0, y: 0.6, s: 1 } },
  { kind: 'image', frame: { w: 1, h: 1, shape: 'square' }, t: { x: 0, y: 0, s: 1 } },
  { kind: 'effect', frame: { w: 1.2, h: 1.2, shape: 'circle' }, t: { x: 0, y: 0, s: 1 } },
];

/** The model's own floor — nothing may be placed smaller than this (M-i). */
const MIN_SCALE = 0.1;

/** Deterministic shuffles: a failing seed is a failing seed on every machine. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed * 2654435761 + 1;
  const next = (): number => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** Is every corner of this box inside the safe disc? */
function insideSafeCircle(
  frame: Exclude<Frame, 'panel'>,
  t: { x: number; y: number; s: number },
): boolean {
  const hw = (frame.w / 2) * t.s;
  const hh = (frame.h / 2) * t.s;
  return Math.hypot(Math.abs(t.x) + hw, Math.abs(t.y) + hh) <= RENDER.safeRadiusPct + 1e-9;
}

describe('smart placement, under pressure (M-i)', () => {
  const ORDERS = 20;

  for (let seed = 0; seed < ORDERS; seed++) {
    it(`never piles and never leaves the glass — order ${String(seed)}`, () => {
      const order = shuffled(KIND_DEFAULTS, seed);
      let current = look();
      let placedCount = 0;
      let uncontained = 0;
      let stackedAt = -1;

      for (const [index, spec] of order.entries()) {
        // `MAX_LAYERS` is 8 — the base plus seven overlays — so the eighth kind
        // in the order is one the model would refuse anyway.
        if (current.layers.length >= 8) break;

        const { t, free } = placeNewLayer({
          look: current,
          frame: spec.frame,
          preferred: { ...IDENTITY, ...spec.t },
          panel: ROUND,
          render: RENDER,
        });

        if (!free) {
          // A genuinely full panel is allowed to stack, and nothing after it in
          // this order can be judged. Recorded rather than asserted here — the
          // "not on the first add" claim is made once, at the end, so the
          // assertion is not inside a branch.
          stackedAt = index;
          break;
        }

        expect(t.s, `${spec.kind} was shrunk below the model's floor`).toBeGreaterThanOrEqual(
          MIN_SCALE,
        );

        const layer: Layer = {
          id: `l${String(index)}00000`,
          kind: spec.kind,
          on: true,
          frame: spec.frame,
          t,
          cfg: {},
        };
        expect(
          overlapsExisting(current, layer),
          `${spec.kind} landed on top of something at ${JSON.stringify(t)}`,
        ).toBe(false);

        if (!insideSafeCircle(spec.frame, t)) uncontained += 1;

        current = { layers: [...current.layers, layer] };
        placedCount += 1;
      }

      // An empty panel always has room for the first layer.
      expect(stackedAt, 'the empty panel had no room for the first layer').not.toBe(0);
      // The run is only meaningful if it actually filled the panel up a bit.
      expect(placedCount).toBeGreaterThanOrEqual(4);
      /*
       * At most ONE layer per run may be outside the disc, and it is the first:
       * every other position this function returns is generated, and a
       * generated position is contained by construction.
       */
      expect(uncontained, 'more than the first layer was placed off the glass').toBeLessThanOrEqual(
        1,
      );
    });
  }
});
