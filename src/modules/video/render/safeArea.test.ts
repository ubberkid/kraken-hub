import { describe, expect, it } from 'vitest';

import { circleSafeInsetPx } from '../../../platform/geometry';

import { MIN_OVERLAY_FONT_PX, isInsideSafeCircle, safeAreaBox } from './safeArea';

const OPTS = { safeRadiusPct: 0.88, safeAreaPct: 0.08 };

describe('§4.3 circular safe area', () => {
  it('reuses the platform inset helper rather than duplicating the formula', () => {
    const box = safeAreaBox({ width: 640, height: 640, shape: 'circle' }, OPTS);
    expect(box.insetPx).toBeCloseTo(circleSafeInsetPx(640, 0.88), 12);
  });

  it('gives the documented 398x398 box at 640 / 0.88', () => {
    const box = safeAreaBox({ width: 640, height: 640, shape: 'circle' }, OPTS);
    expect(box.insetPx).toBeCloseTo(120.9, 1);
    expect(box.w).toBeCloseTo(398.2, 1);
    expect(box.h).toBeCloseTo(box.w, 12);
    expect(box.x).toBeCloseTo(box.insetPx, 12);
  });

  it('scales with the panel', () => {
    const big = safeAreaBox({ width: 640, height: 640, shape: 'circle' }, OPTS);
    const small = safeAreaBox({ width: 320, height: 320, shape: 'circle' }, OPTS);
    expect(small.w).toBeCloseTo(big.w / 2, 9);
  });

  it('uses the square inset on a square panel', () => {
    const box = safeAreaBox({ width: 240, height: 240, shape: 'square' }, OPTS);
    expect(box.insetPx).toBeCloseTo(240 * 0.08, 9);
    expect(box.w).toBeCloseTo(240 - 2 * 240 * 0.08, 9);
  });

  it('clamps the square inset to 20 % of the short edge', () => {
    const box = safeAreaBox(
      { width: 240, height: 240, shape: 'square' },
      { ...OPTS, safeAreaPct: 5 },
    );
    expect(box.insetPx).toBeCloseTo(48, 9);
  });

  it('is exactly the inscribed square — its corners sit ON the visible radius', () => {
    const panel = { width: 640, height: 640, shape: 'circle' } as const;
    const box = safeAreaBox(panel, OPTS);
    const cornerRadius = Math.hypot(box.w / 2, box.h / 2);
    expect(cornerRadius).toBeCloseTo((640 / 2) * OPTS.safeRadiusPct, 9);

    // A hair inside the corner is inside the disc; a hair outside is not.
    const eps = 0.01;
    expect(isInsideSafeCircle(panel, OPTS.safeRadiusPct, box.x + eps, box.y + eps)).toBe(true);
    expect(isInsideSafeCircle(panel, OPTS.safeRadiusPct, box.x - eps, box.y - eps)).toBe(false);
  });

  it('rejects a point outside the visible radius', () => {
    const panel = { width: 640, height: 640, shape: 'circle' } as const;
    expect(isInsideSafeCircle(panel, 0.88, 0, 0)).toBe(false);
    expect(isInsideSafeCircle(panel, 0.88, 320, 320)).toBe(true);
  });

  it('accepts anything on the panel when it is square', () => {
    const panel = { width: 240, height: 240, shape: 'square' } as const;
    expect(isInsideSafeCircle(panel, 0.88, 0, 0)).toBe(true);
    expect(isInsideSafeCircle(panel, 0.88, 500, 0)).toBe(false);
  });

  it('holds the 22 px readability floor', () => {
    expect(MIN_OVERLAY_FONT_PX).toBe(22);
  });
});
