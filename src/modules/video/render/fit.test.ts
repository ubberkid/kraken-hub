import { describe, expect, it } from 'vitest';

import { ASPECT_16_9 } from '../types';

import { computeFit, effectiveFit, inscribeInCircle, pickSourceRect, toTransformCss } from './fit';

import type { FitInput } from './fit';
import type { ProviderCapabilities, SourceRect } from '../types';

/** The YouTube square-iframe surface: a 1920x1920 element with the video at y=420. */
const YT_SURFACE: SourceRect = {
  surfaceW: 1920,
  surfaceH: 1920,
  safe: { x: 420, y: 420, w: 1080, h: 1080 },
  full: { x: 0, y: 420, w: 1920, h: 1080 },
  mediaAspect: ASPECT_16_9,
};

function fit(over: Partial<FitInput> = {}): FitInput {
  return {
    viewportW: 640,
    viewportH: 640,
    rect: YT_SURFACE.full,
    fit: 'contain',
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
    ...over,
  };
}

describe('§4.1 worked check — contain, 640x640, 16:9 video in a 1920 square', () => {
  const f = computeFit(fit());

  it('scales by 0.333333 uniformly', () => {
    expect(f.scaleX).toBeCloseTo(0.333333, 6);
    expect(f.scaleY).toBeCloseTo(0.333333, 6);
  });

  it('letterboxes 140 px top and bottom', () => {
    expect(f.letterboxX).toBeCloseTo(0, 6);
    expect(f.letterboxY).toBeCloseTo(140, 6);
  });

  it('produces translate(0,0) — the documented answer', () => {
    expect(f.translateX).toBeCloseTo(0, 6);
    expect(f.translateY).toBeCloseTo(0, 6);
    expect(toTransformCss(f)).toBe('translate(0.000px, 0.000px) scale(0.333333)');
  });

  it('shows the whole 1920x1080 band as 640x360 centred', () => {
    const toScreenY = (v: number): number => v * f.scaleY + f.translateY;
    expect(toScreenY(420)).toBeCloseTo(140, 6);
    expect(toScreenY(1500)).toBeCloseTo(500, 6);
  });
});

describe('§4.1 worked check — contain-circle, 640 circle, 16:9', () => {
  it('inscribes 557.8 x 313.8 in the 640 disc', () => {
    // The doc rounds sqrt(4.16049) to 2.03960; the exact value is 2.039730, so
    // its 313.79 / 557.85 / 0.290547 are correct to ~4 significant digits.
    const { w, h } = inscribeInCircle(ASPECT_16_9, 640);
    expect(h).toBeCloseTo(313.79, 1);
    expect(w).toBeCloseTo(557.85, 1);
  });

  it('scales the 1920-wide source rect by 0.290547', () => {
    const f = computeFit(fit({ fit: 'contain-circle' }));
    expect(f.scaleX).toBeCloseTo(0.290547, 4);
    expect(f.scaleY).toBeCloseTo(f.scaleX, 12);
  });

  it('keeps every corner of the drawn rect inside the bezel circle', () => {
    const f = computeFit(fit({ fit: 'contain-circle' }));
    const w = YT_SURFACE.full.w * f.scaleX;
    const h = YT_SURFACE.full.h * f.scaleY;
    const r = Math.hypot(w / 2, h / 2);
    expect(r).toBeLessThanOrEqual(640 / 2 + 1e-6);
  });
});

describe('cover', () => {
  it('reproduces the YouTube crop when applied to the safe rect', () => {
    const f = computeFit(fit({ fit: 'cover', rect: YT_SURFACE.safe }));
    expect(f.scaleX).toBeCloseTo(0.5925926, 7);
    expect(f.translateX).toBeCloseTo(-248.889, 3);
    expect(f.translateY).toBeCloseTo(-248.889, 3);
  });

  it('fills the viewport from the full rect and leaves horizontal slack to pan', () => {
    const f = computeFit(fit({ fit: 'cover' }));
    expect(f.scaleX).toBeCloseTo(640 / 1080, 9);
    expect(f.visibleW).toBeCloseTo(1080, 6);
    expect(f.slackX).toBeCloseTo(840, 6);
    expect(f.slackY).toBeCloseTo(0, 6);
  });

  it('pans within the slack and nowhere else', () => {
    const left = computeFit(fit({ fit: 'cover', offsetX: -0.5 }));
    const right = computeFit(fit({ fit: 'cover', offsetX: 0.5 }));
    const delta = (left.translateX - right.translateX) / left.scaleX;
    expect(delta).toBeCloseTo(840, 6);
  });

  it('applies zoom on top of the cover scale', () => {
    const f = computeFit(fit({ fit: 'cover', rect: YT_SURFACE.safe, zoom: 2 }));
    expect(f.scaleX).toBeCloseTo((640 / 1080) * 2, 9);
  });
});

describe('fill', () => {
  it('scales the axes independently', () => {
    const f = computeFit(fit({ fit: 'fill' }));
    expect(f.scaleX).toBeCloseTo(640 / 1920, 9);
    expect(f.scaleY).toBeCloseTo(640 / 1080, 9);
    expect(toTransformCss(f)).toContain('scale(0.333333, 0.592593)');
  });
});

describe('clamping', () => {
  it('clamps zoom to [1,4] and pan to [-0.5,0.5]', () => {
    const low = computeFit(fit({ fit: 'cover', zoom: 0.1 }));
    const one = computeFit(fit({ fit: 'cover', zoom: 1 }));
    expect(low.scaleX).toBeCloseTo(one.scaleX, 12);

    const wild = computeFit(fit({ fit: 'cover', offsetX: 12 }));
    const capped = computeFit(fit({ fit: 'cover', offsetX: 0.5 }));
    expect(wild.translateX).toBeCloseTo(capped.translateX, 12);
  });
});

describe('source-rect selection', () => {
  const chrome: Pick<ProviderCapabilities, 'hasOwnChrome'> = { hasOwnChrome: true };
  const noChrome: Pick<ProviderCapabilities, 'hasOwnChrome'> = { hasOwnChrome: false };

  it('always uses the safe rect for cover', () => {
    expect(pickSourceRect(YT_SURFACE, { fit: 'cover', allowChrome: true })).toBe(YT_SURFACE.safe);
  });

  it('uses the full rect for contain only with explicit consent', () => {
    expect(pickSourceRect(YT_SURFACE, { fit: 'contain', allowChrome: false })).toBe(
      YT_SURFACE.safe,
    );
    expect(pickSourceRect(YT_SURFACE, { fit: 'contain', allowChrome: true })).toBe(YT_SURFACE.full);
  });

  it('forces cover on chrome-painting providers unless chrome is allowed', () => {
    expect(effectiveFit('contain', chrome, false)).toBe('cover');
    expect(effectiveFit('contain-circle', chrome, false)).toBe('cover');
    expect(effectiveFit('contain', chrome, true)).toBe('contain');
    expect(effectiveFit('contain', noChrome, false)).toBe('contain');
  });
});
