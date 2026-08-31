/**
 * The image module does not own any fit math — it reuses `src/render/fit.ts`,
 * the file the video engine's `RenderController` uses. These tests assert that
 * reuse produces the right answers for the shapes an image module actually
 * meets (a landscape photo on a round panel, a portrait photo on a square one,
 * a quarter turn), so a regression in the shared file is caught from both sides.
 */

import { describe, expect, it } from 'vitest';

import { computeFit, inscribeInCircle, toTransformCss } from '../../render/fit';
import { PAN_LIMIT, ZOOM_MAX } from '../../render/types';

import { DEFAULT_IMAGE_RENDER, validateImageConfig } from './schema';

import type { FitInput } from '../../render/fit';

const PANEL_640 = 640;
const PANEL_240 = 240;

function input(over: Partial<FitInput> = {}): FitInput {
  return {
    viewportW: PANEL_640,
    viewportH: PANEL_640,
    rect: { x: 0, y: 0, w: 1920, h: 1080 },
    fit: 'cover',
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
    ...over,
  };
}

describe('image framing reuses the shared fit math', () => {
  it('covers a square panel with a 16:9 photo by matching the WIDER axis', () => {
    const f = computeFit(input());
    // 640/1080 > 640/1920, so height governs.
    expect(f.scaleX).toBeCloseTo(PANEL_640 / 1080, 10);
    expect(f.scaleY).toBe(f.scaleX);
    // Horizontal slack is cropped symmetrically; vertically nothing is left over.
    expect(f.slackY).toBeCloseTo(0, 10);
    expect(f.slackX).toBeGreaterThan(0);
    expect(f.letterboxX).toBe(0);
    expect(f.letterboxY).toBe(0);
  });

  it('contains the whole photo, letterboxed, with no offset drift', () => {
    const f = computeFit(input({ fit: 'contain' }));
    expect(f.scaleX).toBeCloseTo(PANEL_640 / 1920, 10);
    expect(f.slackX).toBeCloseTo(0, 10);
    expect(f.slackY).toBeCloseTo(0, 10);
    expect(f.translateX).toBeCloseTo(0, 10);
    // Centred vertically: (640 - 1080*640/1920) / 2 = 140.
    expect(f.letterboxY).toBeCloseTo(140, 10);
    expect(f.translateY).toBeCloseTo(140, 10);
  });

  it('inscribes a 16:9 photo in the round bezel for contain-circle', () => {
    const aspect = 1920 / 1080;
    const { w, h } = inscribeInCircle(aspect, PANEL_640);
    // The inscribed rect's diagonal is the panel diameter.
    expect(Math.hypot(w, h)).toBeCloseTo(PANEL_640, 6);

    const f = computeFit(input({ fit: 'contain-circle' }));
    expect(f.scaleX).toBeCloseTo(w / 1920, 10);
    // Strictly smaller than `contain`, which would touch the bezel's widest chord.
    expect(f.scaleX).toBeLessThan(PANEL_640 / 1920);
  });

  it('stretches both axes independently for fill', () => {
    const f = computeFit(input({ fit: 'fill' }));
    expect(f.scaleX).toBeCloseTo(PANEL_640 / 1920, 10);
    expect(f.scaleY).toBeCloseTo(PANEL_640 / 1080, 10);
    expect(toTransformCss(f)).toMatch(/scale\([^,]+, [^)]+\)/);
  });

  it('pans within the crop slack and never past it', () => {
    const centred = computeFit(input());
    const left = computeFit(input({ offsetX: -PAN_LIMIT }));
    const right = computeFit(input({ offsetX: PAN_LIMIT }));
    expect(left.translateX).toBeGreaterThan(centred.translateX);
    expect(right.translateX).toBeLessThan(centred.translateX);
    // Beyond the limit the clamp holds it exactly at the edge.
    expect(computeFit(input({ offsetX: -1 })).translateX).toBeCloseTo(left.translateX, 10);
  });

  it('has no pan effect when there is no slack (contain)', () => {
    const a = computeFit(input({ fit: 'contain', offsetX: PAN_LIMIT, offsetY: PAN_LIMIT }));
    const b = computeFit(input({ fit: 'contain' }));
    expect(a.translateX).toBeCloseTo(b.translateX, 10);
    expect(a.translateY).toBeCloseTo(b.translateY, 10);
  });

  it('is correct on the 240 square panel too', () => {
    const f = computeFit(input({ viewportW: PANEL_240, viewportH: PANEL_240 }));
    expect(f.scaleX).toBeCloseTo(PANEL_240 / 1080, 10);
  });

  it('fits a portrait photo into the swapped box a quarter turn produces', () => {
    // A 90/270 rotation is applied to the wrapper, so the picture is fitted into
    // a box whose sides are swapped. On a square panel that is a no-op, which is
    // exactly what makes the display code able to ignore trigonometry entirely.
    const portrait = { x: 0, y: 0, w: 1080, h: 1920 };
    const upright = computeFit(input({ rect: portrait }));
    const turned = computeFit(
      input({ rect: portrait, viewportW: PANEL_640, viewportH: PANEL_640 }),
    );
    expect(turned.scaleX).toBeCloseTo(upright.scaleX, 10);
  });

  it('clamps zoom to the shared limits', () => {
    const f = computeFit(input({ zoom: 99 }));
    const capped = computeFit(input({ zoom: ZOOM_MAX }));
    expect(f.scaleX).toBeCloseTo(capped.scaleX, 10);
  });
});

describe('validateImageConfig', () => {
  it('fills everything from defaults for junk', () => {
    for (const junk of [undefined, null, 0, '', [], { render: 7 }]) {
      const cfg = validateImageConfig(junk);
      expect(cfg.url).toBe('');
      expect(cfg.render).toEqual(DEFAULT_IMAGE_RENDER);
      expect(cfg.downloadMode).toBe('auto');
    }
  });

  it('floors the slideshow interval at ten seconds', () => {
    expect(validateImageConfig({ slideshow: { enabled: true, intervalSec: 1 } }).slideshow).toEqual(
      {
        enabled: true,
        intervalSec: 10,
      },
    );
    expect(
      validateImageConfig({ slideshow: { enabled: true, intervalSec: 45 } }).slideshow,
    ).toEqual({ enabled: true, intervalSec: 45 });
  });

  it('clamps zoom, pan and rotate', () => {
    const cfg = validateImageConfig({
      render: { zoom: 99, offsetX: -9, offsetY: 9, rotate: 45, fit: 'nope' },
    });
    expect(cfg.render.zoom).toBe(ZOOM_MAX);
    expect(cfg.render.offsetX).toBe(-PAN_LIMIT);
    expect(cfg.render.offsetY).toBe(PAN_LIMIT);
    expect(cfg.render.rotate).toBe(0);
    expect(cfg.render.fit).toBe('cover');
  });

  it('is idempotent', () => {
    const once = validateImageConfig({ url: 'https://example.com/a.png', render: { zoom: 2 } });
    expect(validateImageConfig(once)).toEqual(once);
  });
});
