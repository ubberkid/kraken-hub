import { describe, expect, it } from 'vitest';

import {
  IDENTITY,
  baseLook,
  type Layer,
  type Look,
  type Transform,
} from '../../../state/look/types';

import {
  POLAR_MIN_RADIUS,
  SNAP_UNITS,
  farthestCorner,
  snap,
  type Guide,
  type SnapPanel,
} from './snap';

/**
 * Snapping is stated in units and tested in units.
 *
 * There is no pixel anywhere in this file, which is the point: the same look
 * snaps the same way on a 640 round Elite and a 240 square Kraken 2023, because
 * the only thing `snap` learns about the panel is its SHAPE.
 */

const ROUND: SnapPanel = { shape: 'circle' };
const SQUARE: SnapPanel = { shape: 'square' };
const RENDER = { safeRadiusPct: 0.88 };

function box(w: number, t: Partial<Transform> = {}, id = 'lbox0001'): Layer {
  return {
    id,
    kind: 'clock',
    on: true,
    frame: { w, h: w, shape: 'square' },
    t: { ...IDENTITY, ...t },
    cfg: {},
  };
}

function lookWith(...overlays: Layer[]): Look {
  return { layers: [...baseLook('video').layers, ...overlays] };
}

function kinds(guides: readonly Guide[]): string[] {
  return guides.map((g) => g.kind);
}

describe('snap — the spec’s worked example', () => {
  it('pulls a 0.4 u box at (0.49, 0.01) onto the half ring at (0.5, 0)', () => {
    const layer = box(0.4, { x: 0.49, y: 0.01 });
    const result = snap(layer.t, layer, lookWith(layer), ROUND, RENDER);
    expect(result.t.x).toBe(0.5);
    expect(result.t.y).toBe(0);
    expect(kinds(result.guides)).toContain('ring');
  });

  it('reports the clock angle it landed on as well as the ring', () => {
    const layer = box(0.4, { x: 0.49, y: 0.01 });
    const guides = snap(layer.t, layer, lookWith(layer), ROUND, RENDER).guides;
    expect(guides.find((g) => g.kind === 'ring')?.at).toBe(0.5);
    expect(guides.find((g) => g.kind === 'clock')?.at).toBe(0);
  });
});

describe('snap — panel independence', () => {
  it('never sees a pixel, so two panels of the same shape agree exactly', () => {
    const layer = box(0.625, { x: 0.49, y: 0.01, r: 1 });
    const look = lookWith(layer);
    const a = snap(layer.t, layer, look, ROUND, RENDER);
    const b = snap(layer.t, layer, look, { shape: 'circle' }, RENDER);
    expect(a.t).toEqual(b.t);
    expect(a.guides).toEqual(b.guides);
  });

  it('offers panel edges and thirds only on a square panel', () => {
    const layer = box(0.2, { x: 0.34 });
    const round = snap(layer.t, layer, lookWith(layer), ROUND, RENDER);
    const square = snap(layer.t, layer, lookWith(layer), SQUARE, RENDER);
    expect(round.t.x).toBe(0.34);
    expect(square.t.x).toBeCloseTo(1 / 3, 3);
    expect(kinds(square.guides)).toContain('panel-third');
  });
});

describe('snap — the centre', () => {
  it('lands exactly at 0,0 when dragged near the middle', () => {
    const layer = box(0.6, { x: 0.02, y: -0.015 });
    const result = snap(layer.t, layer, lookWith(layer), ROUND, RENDER);
    expect(result.t.x).toBe(0);
    expect(result.t.y).toBe(0);
    expect(kinds(result.guides)).toEqual(expect.arrayContaining(['centre-x', 'centre-y']));
  });

  it('does not snap a centre that is past the threshold', () => {
    const layer = box(0.6, { x: 0.035, y: 0 });
    expect(snap(layer.t, layer, lookWith(layer), ROUND, RENDER).t.x).toBe(0.035);
  });

  it('leaves polar snapping off near the centre — a degree there swings everything', () => {
    const layer = box(0.2, { x: POLAR_MIN_RADIUS - 0.02, y: 0.1 });
    const result = snap(layer.t, layer, lookWith(layer), ROUND, RENDER);
    expect(kinds(result.guides)).not.toContain('clock');
    expect(kinds(result.guides)).not.toContain('ring');
  });
});

/**
 * §11's two rotation-and-centre fidelity assertions, stated as the auditors
 * state them rather than as the implementation happens to be shaped.
 */
describe('snap — the fidelity assertions (design-editor-ux.md §11)', () => {
  it('drag to the centre lands exactly at 0, 0', () => {
    /*
     * The one snap every user tries first, and the one a naive implementation
     * gets wrong: a box wider than the threshold would otherwise snap its LEFT
     * EDGE to `x = 0` and settle off-centre. `Target.edges` is false for the
     * centre crosslines precisely so this is true.
     */
    for (const w of [0.2, 0.6, 1.2, 1.8]) {
      const layer = box(w, { x: 0.02, y: -0.015 });
      const result = snap(layer.t, layer, lookWith(layer), ROUND, RENDER);
      expect(result.t.x, `a ${String(w)} u box did not land on 0`).toBe(0);
      expect(result.t.y, `a ${String(w)} u box did not land on 0`).toBe(0);
    }
  });

  it('rotation snaps at 0 / 15 / 45 / 90 within 3°', () => {
    for (const target of [0, 15, 45, 90]) {
      for (const offset of [-2.9, -1, 0, 1, 2.9]) {
        // Placed near the centre so polar snapping is off and the only rule
        // acting on the angle is the rotation ladder.
        const layer = box(0.4, { x: 0.05, y: 0.05, r: target + offset });
        const result = snap(layer.t, layer, lookWith(layer), ROUND, RENDER);
        expect(result.t.r, `${String(target + offset)}° should settle on ${String(target)}°`).toBe(
          target,
        );
      }
    }
  });

  it('leaves an angle further than 3° from any tick exactly where it is', () => {
    // 7.5° is the furthest a 15° ladder can be from a tick.
    const layer = box(0.4, { x: 0.05, y: 0.05, r: 7.5 });
    expect(snap(layer.t, layer, lookWith(layer), ROUND, RENDER).t.r).toBe(7.5);
  });
});

describe('snap — rotation', () => {
  it('settles on 0 / ±45 / ±90 / 180 within 3°', () => {
    for (const [from, to] of [
      [2, 0],
      [43, 45],
      [-88, -90],
      [178, 180],
      [92, 90],
    ] as const) {
      const layer = box(0.4, { x: 0.9, y: 0.9, r: from });
      expect(snap(layer.t, layer, lookWith(layer), ROUND, RENDER).t.r).toBe(to);
    }
  });

  it('leaves a deliberate angle alone', () => {
    const layer = box(0.4, { x: 0.9, y: 0.9, r: 20 });
    const result = snap(layer.t, layer, lookWith(layer), ROUND, RENDER);
    expect(result.t.r).toBe(20);
    expect(kinds(result.guides)).not.toContain('rotation');
  });

  it('snaps to the tangent — perpendicular to the radius', () => {
    // At 3 o'clock (x > 0, y = 0) the tangent is 90°.
    const layer = box(0.4, { x: 0.7, y: 0, r: 88.5 });
    expect(snap(layer.t, layer, lookWith(layer), ROUND, RENDER).t.r).toBeCloseTo(90, 6);
  });
});

describe('snap — the safe circle', () => {
  it('puts the farthest corner exactly on the safe ring', () => {
    const layer = box(0.4, { x: 0.65, y: 0 });
    const result = snap(layer.t, layer, lookWith(layer), ROUND, RENDER);
    expect(kinds(result.guides)).toContain('tangent');
    expect(farthestCorner(layer.frame, result.t)).toBeCloseTo(0.88, 2);
  });

  it('does not fight a ring snap for the same radius', () => {
    const layer = box(0.4, { x: 0.5, y: 0 });
    const result = snap(layer.t, layer, lookWith(layer), ROUND, RENDER);
    expect(kinds(result.guides)).toContain('ring');
    expect(kinds(result.guides)).not.toContain('tangent');
  });
});

describe('snap — other layers', () => {
  it('aligns to another layer’s centre and names it', () => {
    const other = box(0.4, { x: 0.2, y: 0 }, 'lother01');
    const moving = box(0.1, { x: 0.21, y: 0 });
    const result = snap(moving.t, moving, lookWith(other, moving), ROUND, RENDER);
    expect(result.t.x).toBe(0.2);
    const guide = result.guides.find((g) => g.kind === 'layer-centre');
    expect(guide?.layerId).toBe('lother01');
  });

  it('ignores a layer that is off', () => {
    const other = { ...box(0.4, { x: 0.2, y: 0 }, 'lother01'), on: false };
    const moving = box(0.1, { x: 0.21, y: 0 });
    expect(snap(moving.t, moving, lookWith(other, moving), ROUND, RENDER).t.x).toBe(0.21);
  });

  it('aligns edge to edge', () => {
    // `other` spans x ∈ [0, 0.4]; the moving box's left edge is at 0.39 and
    // wants to land on `other`'s right edge at 0.4.
    const other = box(0.4, { x: 0.2, y: 0 }, 'lother01');
    const moving = box(0.2, { x: 0.49, y: 0 });
    const result = snap(moving.t, moving, lookWith(other, moving), ROUND, RENDER);
    expect(result.t.x).toBe(0.5);
  });
});

describe('the threshold itself', () => {
  it('is 0.03 units on every panel', () => {
    expect(SNAP_UNITS).toBe(0.03);
  });
});
