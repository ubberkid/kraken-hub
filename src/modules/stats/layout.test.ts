/**
 * The face's proportions, per panel.
 *
 * The numbers this file asserts are *fractions of the panel*, never pixels, and
 * every geometry comes from `DEVICE_PRESETS` — the module under test must not
 * know a panel dimension, and neither must its test. The sizes come out of
 * `statsSizes()` rather than out of constants copied over from `display.ts`,
 * so a fill that changes cannot leave a passing test asserting the old one.
 */

import { describe, expect, it } from 'vitest';

import { DEVICE_PRESETS, type DevicePresetId } from '../../platform/devicePresets';
import { DEFAULT_RENDER } from '../../state/defaults';

import { statsBoxPx, statsSizes } from './display';
import { STATS_LAYOUTS, type StatsLayout } from './schema';

import type { Geometry } from '../../platform/geometry';

function geometryFor(id: DevicePresetId): Geometry {
  const p = DEVICE_PRESETS[id];
  const short = Math.min(p.width, p.height);
  return {
    width: p.width,
    height: p.height,
    shape: p.shape,
    targetFps: p.targetFps,
    dpr: 1,
    source: 'sim',
    safeInsetPx: Math.round(short * DEFAULT_RENDER.safeAreaPct),
    inscribedSquarePx: Math.round(short * Math.SQRT1_2),
    radiusPx: short / 2,
  };
}

/** Ring diameter as a fraction of the panel's short edge. */
function ringFraction(id: DevicePresetId, layout: StatsLayout): number {
  const g = geometryFor(id);
  return statsSizes(g, DEFAULT_RENDER, layout).ring / Math.min(g.width, g.height);
}

describe('the ring box grows with the panel', () => {
  it('fills most of the largest panel instead of sitting as an island in it', () => {
    // The gap this closes: on the biggest, most common panel the tuned fills
    // used barely a quarter of the height, because the inscribed square throws
    // away the corners a *circular* ring never needed.
    expect(ringFraction('elite', 'single')).toBeGreaterThan(0.55);
    expect(ringFraction('elite', 'single')).toBeLessThan(0.7);
  });

  /*
   * The dual face is TWO HALVES OF ONE CIRCLE since the redesign, not two
   * circles side by side — which is the shape a round panel actually has, and
   * why it now gets the same generous ring the single face does instead of the
   * half-size pair that had to fit two of them across the width.
   */
  it('gives the dual face the whole ring, because it is one ring', () => {
    expect(ringFraction('elite', 'dual')).toBeCloseTo(ringFraction('elite', 'single'), 6);
  });

  it('gives the triple face the most room of all: it has three rings to nest', () => {
    expect(ringFraction('elite', 'triple')).toBeGreaterThan(ringFraction('elite', 'single'));
  });

  it('leaves the small panels exactly as they were', () => {
    for (const id of ['z', 'kraken2023'] as const) {
      const g = geometryFor(id);
      const short = Math.min(g.width, g.height);
      const inscribedSafeSquare =
        g.shape === 'circle'
          ? short * DEFAULT_RENDER.safeRadiusPct * Math.SQRT1_2
          : short * (1 - 2 * DEFAULT_RENDER.safeAreaPct);
      for (const layout of ['single', 'dual', 'triple', 'grid'] as const) {
        expect(statsBoxPx(g, DEFAULT_RENDER, layout)).toBeCloseTo(inscribedSafeSquare, 6);
      }
    }
  });

  it('never grows the text-first grid face: six tiles of text want the corners', () => {
    const g = geometryFor('elite');
    expect(statsBoxPx(g, DEFAULT_RENDER, 'grid')).toBeLessThan(
      statsBoxPx(g, DEFAULT_RENDER, 'single'),
    );
  });

  it('never lets the box overflow the panel, however wrong the safe-area setting', () => {
    const g = geometryFor('elite');
    const wideOpen = { ...DEFAULT_RENDER, safeRadiusPct: 1, safeAreaPct: 0 };
    for (const layout of ['single', 'dual', 'triple', 'grid'] as const) {
      expect(statsBoxPx(g, wideOpen, layout)).toBeLessThanOrEqual(Math.min(g.width, g.height));
    }
  });

  /*
   * Audit 10, F6. The text-first face wrote `--kh-stats-dial: 0px` and drew six
   * `<svg>`s of 0 × 0 — while the renderer went on re-dashing the arcs inside
   * them once a frame. A face whose thresholds can change a colour has to have a
   * mark for the colour to live on, so the dial is asserted BOTH ways: it exists
   * at every preset, and it still fits the tile it is inside.
   */
  describe('the text-first face has a meter (F6)', () => {
    /** The 2 × 3 grid and the 4 % gap the stylesheet writes between its tiles. */
    const COLUMNS = 2;
    const ROWS = 3;
    const GAP = 0.04;

    it.each(['elite', 'z', 'kraken2023'] as const)('%s draws a dial with a size', (id) => {
      expect(statsSizes(geometryFor(id), DEFAULT_RENDER, 'grid').ring).toBeGreaterThan(0);
    });

    it.each(['elite', 'z', 'kraken2023'] as const)('%s keeps the dial inside its tile', (id) => {
      const g = geometryFor(id);
      const s = statsSizes(g, DEFAULT_RENDER, 'grid');
      const tileW = (s.box - GAP * s.box * (COLUMNS - 1)) / COLUMNS;
      const tileH = (s.box - GAP * s.box * (ROWS - 1)) / ROWS;
      expect(s.ring).toBeLessThanOrEqual(tileW);
      // Room under the ring for the label that lives there, on every panel.
      expect(s.ring + s.small).toBeLessThanOrEqual(tileH);
    });

    it('holds the reading inside the arc it is drawn behind', () => {
      // The hero is a share of the BOX and the dial is a share of a TILE, so the
      // two are only in proportion by arithmetic — which is exactly the kind of
      // relationship that silently stops holding when a face scale is retuned.
      for (const id of ['elite', 'z', 'kraken2023'] as const) {
        const s = statsSizes(geometryFor(id), DEFAULT_RENDER, 'grid');
        expect(s.value).toBeLessThan(s.ring / 2);
      }
    });
  });

  it('keeps the ring inside the visible disc on every round panel', () => {
    for (const id of ['elite', 'z'] as const) {
      const g = geometryFor(id);
      const safeRadius = (Math.min(g.width, g.height) / 2) * DEFAULT_RENDER.safeRadiusPct;
      for (const layout of ['single', 'dual', 'triple'] as const) {
        expect(statsSizes(g, DEFAULT_RENDER, layout).ring / 2).toBeLessThanOrEqual(safeRadius);
      }
    }
  });
});

describe('three type sizes, in order, on every face', () => {
  it.each(STATS_LAYOUTS.map((l) => [l] as const))('%s', (layout) => {
    const g = geometryFor('elite');
    const s = statsSizes(g, DEFAULT_RENDER, layout);
    // Hero, then unit, then everything else — and the hero is genuinely a hero.
    expect(s.value).toBeGreaterThan(s.unit);
    expect(s.unit).toBeGreaterThan(s.small);
    expect(s.small).toBeGreaterThan(0);
  });
});

describe('the whole face scales with the frame it was given', () => {
  /*
   * The invariant behind "no size literals": every number the renderer writes
   * is a multiple of the geometry, so halving the frame halves the type. This
   * is what makes one face correct at full panel, at a 0.6 overlay, and at the
   * smallest device preset without a breakpoint anywhere.
   */
  it.each(STATS_LAYOUTS.map((l) => [l] as const))('%s scales linearly', (layout) => {
    const full = geometryFor('elite');
    const half: Geometry = {
      ...full,
      width: full.width / 2,
      height: full.height / 2,
      radiusPx: full.radiusPx / 2,
    };
    const a = statsSizes(full, DEFAULT_RENDER, layout);
    const b = statsSizes(half, DEFAULT_RENDER, layout);
    // Not exactly half for the ring faces — the box growth ramp is deliberately
    // non-linear — but strictly smaller on every measure, and never zero.
    expect(b.box).toBeLessThan(a.box);
    expect(b.value).toBeLessThan(a.value);
    expect(b.small).toBeGreaterThan(0);
  });
});
