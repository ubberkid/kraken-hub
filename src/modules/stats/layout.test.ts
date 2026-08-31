/**
 * The dial box, per panel.
 *
 * The numbers this file asserts are *fractions of the panel*, never pixels, and
 * every geometry comes from `DEVICE_PRESETS` — the module under test must not
 * know a panel dimension, and neither must its test.
 */

import { describe, expect, it } from 'vitest';

import { DEVICE_PRESETS, type DevicePresetId } from '../../platform/devicePresets';
import { DEFAULT_RENDER } from '../../state/defaults';

import { statsBoxPx } from './display';

import type { Geometry } from '../../platform/geometry';

/** The dial fills the renderer applies to the box, mirrored from `display.ts`. */
const SINGLE_DIAL_FILL = 0.86;
const DUAL_DIAL_FILL = 0.46;

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

/** Dial diameter as a fraction of the panel's short edge. */
function dialFraction(id: DevicePresetId, layout: 'single' | 'dual' | 'grid'): number {
  const g = geometryFor(id);
  const box = statsBoxPx(g, DEFAULT_RENDER, layout);
  const fill = layout === 'single' ? SINGLE_DIAL_FILL : DUAL_DIAL_FILL;
  return (box * fill) / Math.min(g.width, g.height);
}

describe('the dial box grows with the panel', () => {
  it('fills most of the largest panel instead of sitting as an island in it', () => {
    // The gap this closes: on the biggest, most common panel the tuned fills
    // used barely a quarter of the height, because the inscribed square throws
    // away the corners a *circular* dial never needed.
    expect(dialFraction('elite', 'single')).toBeGreaterThan(0.55);
    expect(dialFraction('elite', 'single')).toBeLessThan(0.7);

    // Two dials side by side are bounded by the panel's WIDTH, not its height:
    // a row of them cannot be 60 % tall and still fit. This is the honest
    // ceiling, and it is half again what it used to be.
    expect(dialFraction('elite', 'dual')).toBeGreaterThan(0.35);
    expect(dialFraction('elite', 'dual')).toBeLessThan(0.45);
  });

  it('leaves the small panels exactly as they were', () => {
    for (const id of ['z', 'kraken2023'] as const) {
      const g = geometryFor(id);
      const short = Math.min(g.width, g.height);
      const inscribedSafeSquare =
        g.shape === 'circle'
          ? short * DEFAULT_RENDER.safeRadiusPct * Math.SQRT1_2
          : short * (1 - 2 * DEFAULT_RENDER.safeAreaPct);
      for (const layout of ['single', 'dual', 'grid'] as const) {
        expect(statsBoxPx(g, DEFAULT_RENDER, layout)).toBeCloseTo(inscribedSafeSquare, 6);
      }
    }
  });

  it('never grows the text-first grid layout: six tiles of text want the corners', () => {
    const g = geometryFor('elite');
    expect(statsBoxPx(g, DEFAULT_RENDER, 'grid')).toBeLessThan(
      statsBoxPx(g, DEFAULT_RENDER, 'single'),
    );
  });

  it('never lets the box overflow the panel, however wrong the safe-area setting', () => {
    const g = geometryFor('elite');
    const wideOpen = { ...DEFAULT_RENDER, safeRadiusPct: 1, safeAreaPct: 0 };
    for (const layout of ['single', 'dual', 'grid'] as const) {
      expect(statsBoxPx(g, wideOpen, layout)).toBeLessThanOrEqual(Math.min(g.width, g.height));
    }
  });

  it('places the dual dials inside the visible disc, gap included', () => {
    const g = geometryFor('elite');
    const box = statsBoxPx(g, DEFAULT_RENDER, 'dual');
    const dial = box * DUAL_DIAL_FILL;
    // `stats.css` sets a 4 % gap between the two columns.
    const gap = box * 0.04;
    // Farthest painted point of the outer dial, measured from the panel centre.
    const reach = dial + gap / 2;
    const safeRadius = (Math.min(g.width, g.height) / 2) * DEFAULT_RENDER.safeRadiusPct;
    expect(reach).toBeLessThanOrEqual(safeRadius);
    // ...and the row still fits the box it is laid out in.
    expect(2 * dial + gap).toBeLessThanOrEqual(box);
  });
});
