import { describe, expect, it } from 'vitest';

import { DEVICE_PRESETS } from './devicePresets';
import { circleSafeInsetPx, deriveGeometry, type GeometryPrefs } from './geometry';

import type { DisplayInfo } from './nzxt';

const prefs: GeometryPrefs = { fallbackTargetFps: 30 };

function info(over: Partial<DisplayInfo> = {}): DisplayInfo {
  return {
    width: 640,
    height: 640,
    shape: 'circle',
    targetFps: 40,
    dpr: 1,
    source: 'nzxt',
    ...over,
  };
}

describe('circleSafeInsetPx', () => {
  it('matches the documented 640 / 0.88 case: ~120.9 px inset, ~398 px box', () => {
    const inset = circleSafeInsetPx(640, 0.88);
    expect(inset).toBeCloseTo(120.9, 1);
    expect(640 - 2 * inset).toBeCloseTo(398.2, 1);
  });

  it('scales linearly with the panel diameter', () => {
    expect(circleSafeInsetPx(320, 0.88)).toBeCloseTo(circleSafeInsetPx(640, 0.88) / 2, 6);
  });

  it('clamps safeRadiusPct to 1 — the inscribed square is the most we can trust', () => {
    // r = 1 gives the geometric inscribed-square inset, r*(1 - cos45°).
    expect(circleSafeInsetPx(640, 1)).toBeCloseTo(320 * (1 - 1 / Math.SQRT2), 6);
    expect(circleSafeInsetPx(640, Math.SQRT2)).toBe(circleSafeInsetPx(640, 1));
  });
});

describe('deriveGeometry', () => {
  it('produces the 640 Elite box', () => {
    const g = deriveGeometry(info(), prefs);
    expect(g.safeInsetPx).toBe(121);
    expect(g.width - 2 * g.safeInsetPx).toBe(398);
    expect(g.inscribedSquarePx).toBe(453);
    expect(g.radiusPx).toBe(320);
    expect(g.targetFps).toBe(40);
  });

  it('handles every device preset', () => {
    for (const preset of Object.values(DEVICE_PRESETS)) {
      const g = deriveGeometry(
        info({
          width: preset.width,
          height: preset.height,
          shape: preset.shape,
          targetFps: preset.targetFps,
        }),
        prefs,
      );
      expect(g.width).toBe(preset.width);
      expect(g.shape).toBe(preset.shape);
      expect(g.safeInsetPx).toBeGreaterThanOrEqual(0);
      expect(g.safeInsetPx * 2).toBeLessThan(preset.width);
    }
  });

  it('uses safeAreaPct (not the ring formula) on a square panel', () => {
    const g = deriveGeometry(info({ width: 240, height: 240, shape: 'square' }), prefs);
    expect(g.safeInsetPx).toBe(19); // round(240 * 0.08)
    expect(g.inscribedSquarePx).toBe(240);
  });

  it('substitutes fallbackTargetFps when window.nzxt was never injected', () => {
    const g = deriveGeometry(info({ source: 'fallback', targetFps: 1 }), prefs);
    expect(g.targetFps).toBe(30);
    expect(g.source).toBe('fallback');
  });

  it('keeps the real targetFps when CAM reported one, even at 1 FPS', () => {
    expect(deriveGeometry(info({ targetFps: 1 }), prefs).targetFps).toBe(1);
  });

  it('clamps an absurd targetFps into 1..60', () => {
    expect(deriveGeometry(info({ targetFps: 5000 }), prefs).targetFps).toBe(60);
    expect(deriveGeometry(info({ targetFps: 0 }), prefs).targetFps).toBe(1);
  });

  it('falls back to 640 round on degenerate dimensions', () => {
    const g = deriveGeometry(info({ width: 0, height: 0 }), prefs);
    expect(g.width).toBe(640);
    expect(g.height).toBe(640);
  });
});
