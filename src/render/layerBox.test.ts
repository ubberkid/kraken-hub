import { describe, expect, it } from 'vitest';

import { circleSafeInsetPx, deriveGeometry, type Geometry } from '../platform/geometry';
import { IDENTITY, type Layer, type Look } from '../state/look/types';

import { hitTest, hostBox, hostStyle, layerBounds, layerGeometry, layerMatrix } from './layerBox';

/**
 * The maths the compositor, the replica and the editor all share.
 *
 * The worked examples are the spec's (§2.3): if these three numbers drift, the
 * halo's handles stop landing on the thing they are supposed to be dragging.
 */

function panel640(): Geometry {
  return deriveGeometry(
    { width: 640, height: 640, shape: 'circle', targetFps: 40, dpr: 1, source: 'nzxt' },
    { fallbackTargetFps: 30 },
  );
}

function panel240(): Geometry {
  return deriveGeometry(
    { width: 240, height: 240, shape: 'square', targetFps: 20, dpr: 1, source: 'nzxt' },
    { fallbackTargetFps: 30 },
  );
}

function overlay(over: Partial<Layer> = {}): Layer {
  return {
    id: 'lover001',
    kind: 'clock',
    on: true,
    frame: { w: 0.6, h: 0.6, shape: 'square' },
    t: { ...IDENTITY },
    cfg: {},
    ...over,
  };
}

describe('hostBox', () => {
  it('places a 0.6 u square at x = 0.5 on a 640 panel exactly where the spec says', () => {
    const box = hostBox(overlay({ t: { ...IDENTITY, x: 0.5 } }), panel640());
    // R = 320 → size 0.6·320 = 192; left = 640/2 + 0.5·320 − 192/2 = 384.
    expect(box.w).toBe(192);
    expect(box.h).toBe(192);
    expect(box.x).toBe(384);
    expect(box.y).toBe(320 - 96);
  });

  it('gives the base the whole panel', () => {
    const base: Layer = { id: 'base', kind: 'video', on: true, frame: 'panel', t: IDENTITY };
    expect(hostBox(base, panel640())).toEqual({ x: 0, y: 0, w: 640, h: 640 });
  });

  it('does not fold t.s into the layout box — scale is a transform, not a re-layout', () => {
    const box = hostBox(overlay({ t: { ...IDENTITY, s: 2 } }), panel640());
    expect(box.w).toBe(192);
  });
});

describe('layerGeometry', () => {
  it('derives a circle frame’s safe inset from its own diameter', () => {
    const g = layerGeometry(overlay({ frame: { w: 0.6, h: 0.6, shape: 'circle' } }), panel640());
    expect(g.width).toBe(192);
    expect(g.safeInsetPx).toBe(Math.round(circleSafeInsetPx(192, 0.88)));
    expect(g.shape).toBe('circle');
  });

  it('returns the panel BY IDENTITY for the base, so the one-layer fast path is unchanged', () => {
    const panel = panel640();
    const base: Layer = { id: 'base', kind: 'video', on: true, frame: 'panel', t: IDENTITY };
    expect(layerGeometry(base, panel)).toBe(panel);
  });

  it('keeps the panel’s provenance rather than laundering a sim panel into nzxt', () => {
    const panel = { ...panel640(), source: 'sim' as const };
    expect(layerGeometry(overlay(), panel).source).toBe('sim');
  });
});

describe('hostStyle', () => {
  it('emits exactly the §2.2 declaration block for an overlay', () => {
    const style = hostStyle(overlay({ t: { ...IDENTITY, x: 0.5 } }), panel640());
    expect(style['position']).toBe('absolute');
    expect(style['left']).toBe('50%');
    expect(style['top']).toBe('50%');
    expect(style['width']).toBe('192px');
    expect(style['transform']).toBe('translate(-50%, -50%) translate(160px, 0px) rotate(0deg)');
    expect(style['transform-origin']).toBe('50% 50%');
    expect(style['--kh-w']).toBe('192px');
    expect(style['opacity']).toBeUndefined();
    expect(style['border-radius']).toBeUndefined();
  });

  it('adds scale only when it is not 1, and opacity only when it is not 1', () => {
    const style = hostStyle(overlay({ t: { ...IDENTITY, s: 1.5, a: 0.5, r: 45 } }), panel640());
    expect(style['transform']).toBe(
      'translate(-50%, -50%) translate(0px, 0px) rotate(45deg) scale(1.5)',
    );
    expect(style['opacity']).toBe('0.5');
  });

  it('clips only when asked (circle frame on a pixel kind)', () => {
    const style = hostStyle(overlay(), panel640(), { round: true });
    expect(style['border-radius']).toBe('50%');
    expect(style['overflow']).toBe('hidden');
  });

  it('gives the base nothing at all — inset:0 comes from the stage stylesheet', () => {
    const base: Layer = { id: 'base', kind: 'video', on: true, frame: 'panel', t: IDENTITY };
    expect(hostStyle(base, panel640())).toEqual({});
  });
});

describe('layerMatrix / layerBounds', () => {
  it('rotates about the frame centre', () => {
    const layer = overlay({ t: { ...IDENTITY, r: 90 } });
    const [a, b, c, d, e, f] = layerMatrix(layer, panel640());
    expect(a).toBeCloseTo(0, 10);
    expect(b).toBeCloseTo(1, 10);
    expect(c).toBeCloseTo(-1, 10);
    expect(d).toBeCloseTo(0, 10);
    expect(e).toBe(320);
    expect(f).toBe(320);
  });

  it('reports a bounding box that grows when a square is rotated 45°', () => {
    const straight = layerBounds(overlay(), panel640());
    const tilted = layerBounds(overlay({ t: { ...IDENTITY, r: 45 } }), panel640());
    expect(straight.rect.w).toBe(192);
    expect(tilted.rect.w).toBeCloseTo(192 * Math.SQRT2, 6);
    expect(tilted.corners).toHaveLength(4);
  });
});

describe('hitTest', () => {
  const base: Layer = { id: 'base', kind: 'video', on: true, frame: 'panel', t: IDENTITY };

  it('never returns the base, however dead-centre the point is', () => {
    expect(hitTest({ layers: [base] }, { x: 320, y: 320 }, panel640())).toBeNull();
  });

  it('picks the top-most overlay of two that overlap', () => {
    const look: Look = {
      layers: [base, overlay({ id: 'lunder01' }), overlay({ id: 'lover002' })],
    };
    expect(hitTest(look, { x: 320, y: 320 }, panel640())).toBe('lover002');
  });

  it('skips a layer that is off', () => {
    const look: Look = {
      layers: [base, overlay({ id: 'lunder01' }), overlay({ id: 'lover002', on: false })],
    };
    expect(hitTest(look, { x: 320, y: 320 }, panel640())).toBe('lunder01');
  });

  it('respects rotation: a point in the un-rotated corner is a miss', () => {
    // A 192×192 box centred at 320,320: (410, 410) is inside the square and
    // 127 px from the centre — outside the same box turned 45° (half-diagonal
    // of the local box is 96 along each local axis).
    const straight: Look = { layers: [base, overlay()] };
    const turned: Look = { layers: [base, overlay({ t: { ...IDENTITY, r: 45 } })] };
    expect(hitTest(straight, { x: 410, y: 410 }, panel640())).toBe('lover001');
    expect(hitTest(turned, { x: 410, y: 410 }, panel640())).toBeNull();
  });

  it('treats a circle frame as a circle, not as its bounding square', () => {
    const look: Look = {
      layers: [base, overlay({ frame: { w: 0.6, h: 0.6, shape: 'circle' } })],
    };
    expect(hitTest(look, { x: 320, y: 320 }, panel640())).toBe('lover001');
    expect(hitTest(look, { x: 320 + 90, y: 320 + 90 }, panel640())).toBeNull();
  });

  it('works the same way on a 240 square panel', () => {
    const look: Look = { layers: [base, overlay()] };
    expect(hitTest(look, { x: 120, y: 120 }, panel240())).toBe('lover001');
    expect(hitTest(look, { x: 4, y: 4 }, panel240())).toBeNull();
  });
});
