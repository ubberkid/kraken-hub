import { describe, expect, it } from 'vitest';

import { DEFAULT_GEOMETRY_RENDER, deriveGeometry, type Geometry } from '../../../platform/geometry';
import { IDENTITY, type Layer } from '../../../state/look/types';

import { outsideSafeCircle } from './bounds';

/**
 * "May be cut by the bezel" is a SENTENCE, not a rule: nothing here blocks a
 * placement. The predicate exists so the editor can say the true thing.
 */

function panel(shape: 'circle' | 'square', size = 640): Geometry {
  return deriveGeometry(
    { width: size, height: size, shape, targetFps: 40, dpr: 1, source: 'nzxt' },
    { fallbackTargetFps: 30 },
  );
}

function box(t: Partial<typeof IDENTITY>, w = 0.4): Layer {
  return {
    id: 'lbox0001',
    kind: 'clock',
    on: true,
    frame: { w, h: w, shape: 'square' },
    t: { ...IDENTITY, ...t },
    cfg: {},
  };
}

describe('outsideSafeCircle', () => {
  it('is false for a layer sitting inside the visible disc', () => {
    expect(outsideSafeCircle(box({ x: 0, y: 0 }), panel('circle'), DEFAULT_GEOMETRY_RENDER)).toBe(
      false,
    );
  });

  it('is true once a corner crosses the safe ring', () => {
    expect(outsideSafeCircle(box({ x: 0.8, y: 0 }), panel('circle'), DEFAULT_GEOMETRY_RENDER)).toBe(
      true,
    );
  });

  it('notices a rotation that pushes a corner out even though the centre did not move', () => {
    // Straight, the farthest corner is at hypot(0.8, 0.2) = 0.825 R; turned 45°
    // the box's half-diagonal points straight out, at 0.883 R.
    const straight = box({ x: 0.6, y: 0 }, 0.4);
    const turned = box({ x: 0.6, y: 0, r: 45 }, 0.4);
    expect(outsideSafeCircle(straight, panel('circle'), DEFAULT_GEOMETRY_RENDER)).toBe(false);
    expect(outsideSafeCircle(turned, panel('circle'), DEFAULT_GEOMETRY_RENDER)).toBe(true);
  });

  it('follows t.s: scaling a layer up can take it outside without moving it', () => {
    expect(outsideSafeCircle(box({ x: 0.6 }), panel('circle'), DEFAULT_GEOMETRY_RENDER)).toBe(
      false,
    );
    expect(outsideSafeCircle(box({ x: 0.6, s: 3 }), panel('circle'), DEFAULT_GEOMETRY_RENDER)).toBe(
      true,
    );
  });

  it('is never true for the base — full-bleed content is MEANT to reach the bezel', () => {
    const base: Layer = { id: 'base', kind: 'video', on: true, frame: 'panel', t: IDENTITY };
    expect(outsideSafeCircle(base, panel('circle'), DEFAULT_GEOMETRY_RENDER)).toBe(false);
  });

  it('asks about the panel rectangle on a square Kraken', () => {
    const render = DEFAULT_GEOMETRY_RENDER;
    expect(outsideSafeCircle(box({ x: 0, y: 0 }), panel('square', 240), render)).toBe(false);
    expect(outsideSafeCircle(box({ x: 1.4, y: 0 }), panel('square', 240), render)).toBe(true);
  });

  it('gives the same answer on a 640 round and a 320 round panel', () => {
    const layer = box({ x: 0.75, y: 0 });
    expect(outsideSafeCircle(layer, panel('circle', 640), DEFAULT_GEOMETRY_RENDER)).toBe(
      outsideSafeCircle(layer, panel('circle', 320), DEFAULT_GEOMETRY_RENDER),
    );
  });
});
