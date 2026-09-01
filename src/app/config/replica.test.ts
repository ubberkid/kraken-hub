import { describe, expect, it } from 'vitest';

import { DEFAULT_GEOMETRY_RENDER } from '../../platform/geometry';
import { DEFAULT_RENDER } from '../../state/defaults';

import { replicaGeometry } from './replica';

const render = DEFAULT_RENDER;

/**
 * The injectable geometry seam.
 *
 * This is the piece that makes the remote's ring correct rather than merely
 * plausible: the module is laid out for the PANEL the display reported, not for
 * the 132 px div it is scaled into. A stats dial tuned for a 240 px square must
 * not be drawn as though it were a 640 px circle.
 */
describe('replicaGeometry', () => {
  it('uses the paired device’s reported panel, not a default', () => {
    const g = replicaGeometry({ w: 240, h: 240, shape: 'square', targetFps: 20 }, render);
    expect(g.width).toBe(240);
    expect(g.height).toBe(240);
    expect(g.shape).toBe('square');
  });

  it('honours the reported frame rate rather than the local preference', () => {
    // `deriveGeometry` substitutes the *preference* frame rate for a
    // `'fallback'` source — so a replica that reported its source wrongly would
    // silently show a different target FPS than the panel has.
    expect(
      replicaGeometry({ w: 640, h: 640, shape: 'circle', targetFps: 30 }, render).targetFps,
    ).toBe(30);
  });

  it('treats anything that is not a circle as square, like the platform does', () => {
    expect(replicaGeometry({ w: 320, h: 320, shape: 'wat', targetFps: 1 }, render).shape).toBe(
      'square',
    );
  });

  it('falls back to the library default before any packet has arrived', () => {
    const g = replicaGeometry(null, render);
    expect(g.source).toBe('fallback');
    expect(g.width).toBeGreaterThan(0);
    expect(g.height).toBeGreaterThan(0);
  });

  it('carries the render settings’ safe area through, so overlays land right', () => {
    const tight = { ...render, safeRadiusPct: 0.5 };
    const loose = { ...render, safeRadiusPct: 1 };
    const a = replicaGeometry({ w: 640, h: 640, shape: 'circle', targetFps: 1 }, tight);
    const b = replicaGeometry({ w: 640, h: 640, shape: 'circle', targetFps: 1 }, loose);
    expect(a.safeInsetPx).toBeGreaterThan(b.safeInsetPx);
    expect(DEFAULT_GEOMETRY_RENDER.safeRadiusPct).toBeGreaterThan(0);
  });
});
