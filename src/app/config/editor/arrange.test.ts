import { describe, expect, it } from 'vitest';

import { deriveGeometry } from '../../../platform/geometry';
import { baseLook, type Look } from '../../../state/look/types';

import { alignPatches, distributePatches } from './arrange';
import { setLocked } from './ops';

import type { Geometry } from '../../../platform/geometry';

/**
 * Align and distribute (§2.1, F7).
 *
 * Every expectation here is in PANEL pixels turned back into units, because
 * that is the only way to check the thing the user sees: `alignPatches` measures
 * with `layerBounds`, the same function the compositor positions the host with,
 * so a layer that reads as flush after an align IS flush.
 */

const PANEL: Geometry = deriveGeometry(
  { width: 640, height: 640, shape: 'circle', targetFps: 30, dpr: 1, source: 'fallback' },
  { fallbackTargetFps: 30 },
);

/** A square overlay of side `w` units, at `x`,`y`. */
function layerAt(id: string, x: number, y: number, w = 0.5): Look['layers'][number] {
  return {
    id,
    kind: 'shape',
    on: true,
    frame: { w, h: w, shape: 'square' },
    t: { x, y, s: 1, r: 0, a: 1 },
  };
}

function look(...layers: Look['layers']): Look {
  return { layers: [...baseLook('video').layers, ...layers] };
}

describe('alignPatches', () => {
  it('puts every member against the canvas’s left edge', () => {
    const l = look(layerAt('lay1', 0.4, -0.3), layerAt('lay2', -0.2, 0.5));
    const patches = alignPatches(
      { look: l, ids: ['lay1', 'lay2'], panel: PANEL },
      'left',
      'canvas',
    );
    expect(patches).toHaveLength(2);

    // A 0.5-unit-wide box on R = 320 is 160 px, so its centre must land at
    // 80 px from the left edge — i.e. 240 px left of the panel's centre.
    for (const p of patches) expect(p.patch.x).toBeCloseTo(-0.75, 5);
  });

  it('centres on the canvas, and never touches the other axis', () => {
    const l = look(layerAt('lay1', 0.4, -0.3));
    const [p] = alignPatches({ look: l, ids: ['lay1'], panel: PANEL }, 'centre', 'canvas');
    expect(p?.patch.x).toBeCloseTo(0, 5);
    expect(p?.patch.y).toBeUndefined();
  });

  it('aligns to the SELECTION’s own box, leaving the group where it is', () => {
    const l = look(layerAt('lay1', -0.6, 0), layerAt('lay2', 0.2, 0));
    const patches = alignPatches(
      { look: l, ids: ['lay1', 'lay2'], panel: PANEL },
      'left',
      'selection',
    );
    // The leftmost is already at the selection's left edge, so it does not move
    // — only the other one does, and it lands on the same left edge.
    expect(patches).toHaveLength(1);
    expect(patches[0]?.id).toBe('lay2');
    expect(patches[0]?.patch.x).toBeCloseTo(-0.6, 5);
  });

  it('works on the vertical three the same way', () => {
    const l = look(layerAt('lay1', 0, 0.4), layerAt('lay2', 0, -0.4));
    const patches = alignPatches({ look: l, ids: ['lay1', 'lay2'], panel: PANEL }, 'top', 'canvas');
    for (const p of patches) {
      expect(p.patch.y).toBeCloseTo(-0.75, 5);
      expect(p.patch.x).toBeUndefined();
    }
  });

  it('leaves a locked layer, and the base, out of the group entirely', () => {
    const l = setLocked(look(layerAt('lay1', 0.4, 0), layerAt('lay2', -0.2, 0)), 'lay1', true);
    const patches = alignPatches(
      { look: l, ids: ['base', 'lay1', 'lay2'], panel: PANEL },
      'left',
      'canvas',
    );
    expect(patches.map((p) => p.id)).toEqual(['lay2']);
  });

  it('returns nothing at all for an empty group', () => {
    expect(alignPatches({ look: look(), ids: [], panel: PANEL }, 'left', 'canvas')).toEqual([]);
  });
});

describe('distributePatches', () => {
  it('evens the gaps and leaves the two extremes alone', () => {
    const l = look(layerAt('lay1', -0.8, 0), layerAt('lay2', -0.1, 0), layerAt('lay3', 0.8, 0));
    const patches = distributePatches(
      { look: l, ids: ['lay1', 'lay2', 'lay3'], panel: PANEL },
      'x',
    );
    expect(patches.map((p) => p.id)).toEqual(['lay2']);
    // Three equal boxes spanning −0.8 to 0.8 sit at the midpoint when evened.
    expect(patches[0]?.patch.x).toBeCloseTo(0, 5);
  });

  it('needs a "between", so two layers get nothing', () => {
    const l = look(layerAt('lay1', -0.5, 0), layerAt('lay2', 0.5, 0));
    expect(distributePatches({ look: l, ids: ['lay1', 'lay2'], panel: PANEL }, 'x')).toEqual([]);
  });

  it('does the same on the vertical axis', () => {
    const l = look(layerAt('lay1', 0, -0.8), layerAt('lay2', 0, 0.3), layerAt('lay3', 0, 0.8));
    const patches = distributePatches(
      { look: l, ids: ['lay1', 'lay2', 'lay3'], panel: PANEL },
      'y',
    );
    expect(patches.map((p) => p.id)).toEqual(['lay2']);
    expect(patches[0]?.patch.y).toBeCloseTo(0, 5);
    expect(patches[0]?.patch.x).toBeUndefined();
  });
});
