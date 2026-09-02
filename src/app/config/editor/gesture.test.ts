import { describe, expect, it } from 'vitest';

import { baseLook, type Look } from '../../../state/look/types';

import { testRegistry } from './__fixtures__/placements';
import { applyGesture, beginGesture, endGesture, type GestureContext } from './gesture';
import { addLayer } from './ops';

/**
 * A drag is one edit, not sixty.
 *
 * `applyGesture` is called once per frame and commits nothing; `endGesture`
 * produces the single look that lands in the store and in the undo ring. The
 * §3.2 split lives in `endGesture` and is asserted here in both directions.
 */

function seed(kind: 'clock' | 'image'): { look: Look; id: string } {
  const result = addLayer(baseLook('video'), kind, testRegistry, {
    frame: { w: 1, h: 1, shape: 'square' },
    t: { x: 0.6, y: 0.6 },
  });
  if (!result.ok) throw new Error(result.reason);
  return { look: result.look, id: result.look.layers[1]?.id ?? '' };
}

function ctx(look: Look): GestureContext {
  return {
    look,
    registry: testRegistry,
    panel: { shape: 'circle' },
    render: { safeRadiusPct: 0.88 },
  };
}

describe('move', () => {
  it('follows the finger by the delta, not to the finger', () => {
    const { look } = seed('image');
    const layer = look.layers[1];
    if (layer === undefined) throw new Error('no layer');
    const gs = beginGesture(layer, 'move', { x: 0.6, y: 0.6 }, ctx(look));
    const t = applyGesture(gs, { x: 0.4, y: 0.6 }, { snap: false });
    expect(t.x).toBeCloseTo(0.4, 6);
    expect(t.y).toBeCloseTo(0.6, 6);
  });

  it('snaps when the modifier says so, and not when it does not', () => {
    const { look } = seed('image');
    const layer = look.layers[1];
    if (layer === undefined) throw new Error('no layer');
    const gs = beginGesture(layer, 'move', { x: 0.6, y: 0.6 }, ctx(look));
    const raw = applyGesture(gs, { x: 0.02, y: 0.015 }, { snap: false });
    expect(raw.x).toBeCloseTo(0.02, 6);
    expect(gs.guides).toEqual([]);
    // The same finger position with snapping on: the centre crosslines take
    // the layer exactly to 0,0 — the first snap every user tries.
    const snapped = applyGesture(gs, { x: 0.02, y: 0.015 }, { snap: true });
    expect(snapped.x).toBe(0);
    expect(snapped.y).toBe(0);
    expect(gs.guides.length).toBeGreaterThan(0);
  });

  it('commits exactly one look', () => {
    const { look, id } = seed('image');
    const layer = look.layers[1];
    if (layer === undefined) throw new Error('no layer');
    const gs = beginGesture(layer, 'move', { x: 0.6, y: 0.6 }, ctx(look));
    for (const x of [0.55, 0.5, 0.45, 0.4]) applyGesture(gs, { x, y: 0.6 }, { snap: false });
    const next = endGesture(gs, look);
    expect(next.layers[1]?.t.x).toBeCloseTo(0.4, 6);
    expect(next.layers[1]?.t.y).toBeCloseTo(0.6, 6);
    expect(next.layers[1]?.id).toBe(id);
  });
});

describe('rotate', () => {
  it('turns by the angle swept about the layer’s centre', () => {
    const { look } = seed('image');
    const layer = look.layers[1];
    if (layer === undefined) throw new Error('no layer');
    const gs = beginGesture(layer, 'rotate', { x: 0.6, y: 0.4 }, ctx(look));
    // From straight up to straight right about (0.6, 0.6) is +90°.
    const t = applyGesture(gs, { x: 0.8, y: 0.6 }, { snap: false });
    expect(t.r).toBeCloseTo(90, 6);
  });
});

describe('scale — the §3.2 split', () => {
  it('leaves t.s at 1 for a resize:"frame" kind and grows the box instead', () => {
    const { look, id } = seed('clock');
    const layer = look.layers[1];
    if (layer === undefined) throw new Error('no layer');
    // Grab a point 0.1 u from the centre, drag to 0.2 u → factor 2.
    const gs = beginGesture(layer, 'scale-se', { x: 0.7, y: 0.6 }, ctx(look));
    const preview = applyGesture(gs, { x: 0.8, y: 0.6 });
    expect(preview.s).toBeCloseTo(2, 6);

    const next = endGesture(gs, look);
    expect(next.layers[1]?.t.s).toBe(1);
    expect(next.layers[1]?.frame).toEqual({ w: 2, h: 2, shape: 'square' });
    expect(next.layers[1]?.id).toBe(id);
  });

  it('commits t.s for a resize:"scale" kind and leaves the box alone', () => {
    const { look } = seed('image');
    const layer = look.layers[1];
    if (layer === undefined) throw new Error('no layer');
    const gs = beginGesture(layer, 'scale-nw', { x: 0.7, y: 0.6 }, ctx(look));
    applyGesture(gs, { x: 0.8, y: 0.6 });
    const next = endGesture(gs, look);
    expect(next.layers[1]?.t.s).toBeCloseTo(2, 6);
    expect(next.layers[1]?.frame).toEqual({ w: 1, h: 1, shape: 'square' });
  });

  it('never snaps a scale — a box that jumps size mid-drag reads as a bug', () => {
    const { look } = seed('clock');
    const layer = look.layers[1];
    if (layer === undefined) throw new Error('no layer');
    const gs = beginGesture(layer, 'scale-se', { x: 0.7, y: 0.6 }, ctx(look));
    applyGesture(gs, { x: 0.71, y: 0.6 }, { snap: true });
    expect(gs.guides).toEqual([]);
  });

  it('clamps the committed frame to the kind’s minFrame', () => {
    const { look } = seed('clock');
    const layer = look.layers[1];
    if (layer === undefined) throw new Error('no layer');
    const gs = beginGesture(layer, 'scale-se', { x: 0.7, y: 0.6 }, ctx(look));
    applyGesture(gs, { x: 0.601, y: 0.6 });
    const next = endGesture(gs, look);
    expect(next.layers[1]?.frame).toEqual({ w: 0.4, h: 0.4, shape: 'square' });
  });

  it('treats a degenerate grab as no change rather than dividing by zero', () => {
    const { look } = seed('image');
    const layer = look.layers[1];
    if (layer === undefined) throw new Error('no layer');
    const gs = beginGesture(layer, 'scale-se', { x: 0.6, y: 0.6 }, ctx(look));
    expect(applyGesture(gs, { x: 0.9, y: 0.9 }).s).toBe(1);
  });
});

describe('the base', () => {
  it('cannot be moved by a gesture — layers[0] never moves', () => {
    const { look } = seed('image');
    const base = look.layers[0];
    if (base === undefined) throw new Error('no base');
    const gs = beginGesture(base, 'move', { x: 0, y: 0 }, ctx(look));
    applyGesture(gs, { x: 0.5, y: 0.5 }, { snap: false });
    expect(endGesture(gs, look)).toBe(look);
  });
});
