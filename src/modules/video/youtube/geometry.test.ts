import { describe, expect, it } from 'vitest';

import { ASPECT_16_9, ASPECT_9_16, YT_LADDER } from '../types';

import {
  barSafePx,
  computeGeometry,
  cropSideForWidth,
  requiredCropSide,
  selectElementWidth,
  shouldStepTo2560,
  supersampleRatio,
  toTransformCss,
  type GeomInput,
} from './geometry';

const QUALITY_FLOOR = 1920;

function input(over: Partial<GeomInput> = {}): GeomInput {
  return {
    displayW: 640,
    displayH: 640,
    dpr: 1,
    zoom: 1,
    sourceAspect: ASPECT_16_9,
    mode: 'square',
    qualityFloorPx: QUALITY_FLOOR,
    ladder: YT_LADDER,
    ...over,
  };
}

describe('step 1 — required crop side', () => {
  it('is max(displayW, displayH) x dpr x zoom, rounded up', () => {
    expect(requiredCropSide(input())).toBe(640);
    expect(requiredCropSide(input({ zoom: 1.5 }))).toBe(960);
    expect(requiredCropSide(input({ dpr: 2 }))).toBe(1280);
    expect(requiredCropSide(input({ displayW: 240, displayH: 240 }))).toBe(240);
  });

  it('clamps dpr to [1,3] and zoom to [1,4] before multiplying', () => {
    expect(requiredCropSide(input({ dpr: 0 }))).toBe(640);
    expect(requiredCropSide(input({ dpr: 9 }))).toBe(1920);
    expect(requiredCropSide(input({ zoom: 0.1 }))).toBe(640);
    expect(requiredCropSide(input({ zoom: 99 }))).toBe(2560);
  });
});

describe('step 2 — crop side for an element width', () => {
  it('is bounded by the video height in landscape', () => {
    expect(cropSideForWidth(1920, ASPECT_16_9)).toBeCloseTo(1080, 6);
    expect(cropSideForWidth(2560, ASPECT_16_9)).toBeCloseTo(1440, 6);
    expect(cropSideForWidth(1280, ASPECT_16_9)).toBeCloseTo(720, 6);
  });

  it('is bounded by the element width in portrait', () => {
    expect(cropSideForWidth(1080, ASPECT_9_16)).toBe(1080);
  });
});

describe('step 3 — element width selection', () => {
  it('takes the smallest rung that clears BOTH the crop need and the quality floor', () => {
    // C(1280) = 720 already covers 640, but the 1920 floor forces the step.
    const picked = selectElementWidth(640, {
      sourceAspect: ASPECT_16_9,
      qualityFloorPx: QUALITY_FLOOR,
      ladder: YT_LADDER,
    });
    expect(picked).toEqual({ width: 1920, undersized: false });
  });

  it('honours a lower floor in performance mode', () => {
    expect(
      selectElementWidth(640, {
        sourceAspect: ASPECT_16_9,
        qualityFloorPx: 1280,
        ladder: YT_LADDER,
      }),
    ).toEqual({ width: 1280, undersized: false });
  });

  it('falls back to the widest rung and flags undersized when nothing qualifies', () => {
    const picked = selectElementWidth(4000, {
      sourceAspect: ASPECT_16_9,
      qualityFloorPx: QUALITY_FLOOR,
      ladder: YT_LADDER,
    });
    expect(picked).toEqual({ width: 2560, undersized: true });
  });
});

describe('step 4 — bar safety', () => {
  it('uses the 180 px landscape floor at 1920/16:9', () => {
    expect(barSafePx(1080, 'landscape')).toBe(180);
  });

  it('uses the fraction once the video is tall enough', () => {
    expect(barSafePx(2000, 'landscape')).toBe(240);
  });

  it('uses the 240 px portrait floor', () => {
    expect(barSafePx(1920, 'portrait')).toBe(240);
    expect(barSafePx(800, 'portrait')).toBe(240);
  });
});

describe('§2.3 worked example — Elite 640, DPR 1, zoom 1, 16:9, square', () => {
  const g = computeGeometry(input());

  it('builds a 1920x1920 element with 420 px bars', () => {
    expect(g.elementW).toBe(1920);
    expect(g.elementH).toBe(1920);
    expect(g.barPx).toBe(420);
    expect(g.videoY).toBe(420);
    expect(g.videoH).toBeCloseTo(1080, 6);
  });

  it('crops the centre 1080 square at (420, 420)', () => {
    expect(g.cropSide).toBeCloseTo(1080, 6);
    expect(g.cropEffective).toBeCloseTo(1080, 6);
    expect(g.cropX).toBeCloseTo(420, 6);
    expect(g.cropY).toBeCloseTo(420, 6);
  });

  it('produces translate(-248.889, -248.889) scale(0.5925926)', () => {
    expect(g.scale).toBeCloseTo(0.5925926, 7);
    expect(g.translateX).toBeCloseTo(-248.889, 3);
    expect(g.translateY).toBeCloseTo(-248.889, 3);
    expect(toTransformCss(g)).toBe('translate(-248.889px, -248.889px) scale(0.5925926)');
  });

  it('maps element (420,420) to (0,0) and (1500,1500) to (640,640)', () => {
    const toScreen = (v: number): number => v * g.scale + g.translateX;
    expect(toScreen(420)).toBeCloseTo(0, 6);
    expect(toScreen(1500)).toBeCloseTo(640, 6);
  });

  it('reports the 1.6875x pixel-parity zoom limit and 1080 quality target', () => {
    expect(g.pixelParityZoomLimit).toBeCloseTo(1.6875, 6);
    expect(g.targetQualityHeight).toBe(1080);
    expect(g.undersized).toBe(false);
    expect(g.orientation).toBe('landscape');
  });
});

describe('§2.3 invariant — tx = ty = -0.388889 x displayW, independent of N', () => {
  it.each([640, 320, 240])('holds at %i px', (d) => {
    const g = computeGeometry(input({ displayW: d, displayH: d }));
    expect(g.translateX).toBeCloseTo(-0.388889 * d, 3);
    expect(g.translateY).toBeCloseTo(-0.388889 * d, 3);
  });

  it('gives the documented values at 640 / 320 / 240', () => {
    const at = (d: number): number =>
      computeGeometry(input({ displayW: d, displayH: d })).translateX;
    expect(at(640)).toBeCloseTo(-248.889, 3);
    expect(at(320)).toBeCloseTo(-124.444, 3);
    expect(at(240)).toBeCloseTo(-93.333, 3);
  });

  it('is the same at N = 2560 as at N = 1920', () => {
    const wide = computeGeometry(input({ ladder: [2560], qualityFloorPx: 2560 }));
    expect(wide.elementW).toBe(2560);
    expect(wide.barPx).toBe(560);
    expect(wide.cropSide).toBeCloseTo(1440, 6);
    expect(wide.cropX).toBeCloseTo(560, 6);
    expect(wide.cropY).toBeCloseTo(560, 6);
    expect(wide.scale).toBeCloseTo(0.444444, 6);
    expect(wide.translateX).toBeCloseTo(-248.889, 3);
    expect(wide.pixelParityZoomLimit).toBeCloseTo(2.25, 6);
  });
});

describe('§2.3 worked example — Elite, zoom 1.5', () => {
  const g = computeGeometry(input({ zoom: 1.5 }));

  it('keeps N = 1920 and shrinks the crop to 720', () => {
    expect(g.elementW).toBe(1920);
    expect(g.cropEffective).toBeCloseTo(720, 6);
    expect(g.cropX).toBeCloseTo(600, 6);
    expect(g.cropY).toBeCloseTo(600, 6);
  });

  it('produces scale 0.888889 and tx -533.333', () => {
    expect(g.scale).toBeCloseTo(0.888889, 6);
    expect(g.translateX).toBeCloseTo(-533.333, 3);
    expect(g.translateY).toBeCloseTo(-533.333, 3);
  });

  it('is still at or above pixel parity (720 native behind 640 panel px)', () => {
    expect(g.cropEffective).toBeGreaterThanOrEqual(640);
    expect(1.5).toBeLessThan(g.pixelParityZoomLimit);
  });
});

describe('§2.3 worked example — Elite, mode tight, 16:9', () => {
  const g = computeGeometry(input({ mode: 'tight' }));

  it('drops the element to 1920x1440 while keeping the 1080 crop', () => {
    expect(g.elementW).toBe(1920);
    expect(g.elementH).toBe(1440);
    expect(g.cropSide).toBeCloseTo(1080, 6);
    expect(g.cropX).toBeCloseTo(420, 6);
    expect(g.cropY).toBeCloseTo(180, 6);
  });

  it('produces tx -248.889, ty -106.667', () => {
    expect(g.scale).toBeCloseTo(0.5925926, 7);
    expect(g.translateX).toBeCloseTo(-248.889, 3);
    expect(g.translateY).toBeCloseTo(-106.667, 3);
  });

  it('cuts the composited surface by ~25 %', () => {
    const square = computeGeometry(input());
    const ratio = (g.elementW * g.elementH) / (square.elementW * square.elementH);
    expect(1 - ratio).toBeCloseTo(0.25, 2);
  });
});

describe('§2.3 worked example — Shorts / portrait 9:16', () => {
  const g = computeGeometry(input({ sourceAspect: ASPECT_9_16 }));

  it('uses a 1080x2400 tall element with 240 px bars', () => {
    expect(g.orientation).toBe('portrait');
    expect(g.elementW).toBe(1080);
    expect(g.elementH).toBe(2400);
    expect(g.barPx).toBe(240);
  });

  it('keeps the element aspect below the source aspect so the player letterboxes', () => {
    expect(g.elementW / g.elementH).toBeLessThan(ASPECT_9_16);
    expect(g.elementW / g.elementH).toBeCloseTo(0.45, 6);
  });

  it('crops 1080 at (0, 240) -> tx 0, ty -142.222', () => {
    expect(g.cropSide).toBeCloseTo(1080, 6);
    expect(g.cropX).toBeCloseTo(0, 6);
    expect(g.cropY).toBeCloseTo(240, 6);
    expect(g.scale).toBeCloseTo(0.5925926, 7);
    expect(g.translateX).toBeCloseTo(0, 6);
    expect(g.translateY).toBeCloseTo(-142.222, 3);
  });

  it('flags the unverified 1080-wide quality heuristic', () => {
    expect(g.portraitUnverified).toBe(true);
  });

  it('centres instead when portraitAnchor is center', () => {
    const centred = computeGeometry(input({ sourceAspect: ASPECT_9_16, portraitAnchor: 'center' }));
    expect(centred.cropY).toBeCloseTo(660, 6);
  });

  it('honours the 1440 portraitWidth alternative', () => {
    const alt = computeGeometry(input({ sourceAspect: ASPECT_9_16, portraitWidth: 1440 }));
    expect(alt.elementW).toBe(1440);
    expect(alt.cropSide).toBeCloseTo(1440, 6);
  });
});

describe('sourceInset — baked-in bars are pixels, not letterbox', () => {
  it('shrinks the video rect before the crop math', () => {
    const g = computeGeometry(input({ sourceInset: { top: 0.1, bottom: 0.1, left: 0, right: 0 } }));
    expect(g.videoY).toBeCloseTo(528, 6);
    expect(g.videoH).toBeCloseTo(864, 6);
    expect(g.cropSide).toBeCloseTo(864, 6);
    expect(g.cropY).toBeCloseTo(528, 6);
    expect(g.scale).toBeCloseTo(640 / 864, 9);
  });

  it('leaves the geometry untouched when every inset is zero', () => {
    const zero = computeGeometry(input({ sourceInset: { top: 0, bottom: 0, left: 0, right: 0 } }));
    expect(zero).toEqual(computeGeometry(input()));
  });
});

describe('pan', () => {
  it('slides the crop inside the crop square, not the whole video rect', () => {
    const g = computeGeometry(input({ zoom: 1.5, panX: 0.5 }));
    // slack = cropSide - cropEffective = 1080 - 720 = 360; half of it at pan 0.5.
    expect(g.cropX).toBeCloseTo(600 + 0.5 * 360, 6);
  });

  it('does nothing at zoom 1, where there is no slack', () => {
    const g = computeGeometry(input({ panX: 0.5, panY: -0.5 }));
    expect(g.cropX).toBeCloseTo(420, 6);
    expect(g.cropY).toBeCloseTo(420, 6);
  });

  it('clamps pan to [-0.5, 0.5]', () => {
    const a = computeGeometry(input({ zoom: 2, panX: 5 }));
    const b = computeGeometry(input({ zoom: 2, panX: 0.5 }));
    expect(a.cropX).toBeCloseTo(b.cropX, 9);
  });
});

describe('telemetry helpers', () => {
  it('reports the supersample ratio the §2.3 example names', () => {
    expect(supersampleRatio(1080, 640)).toBeCloseTo(1.6875, 6);
    expect(supersampleRatio(720, 640)).toBeCloseTo(1.125, 6);
    expect(supersampleRatio(480, 640)).toBeCloseTo(0.75, 6);
  });

  it('only steps to 2560 above pixel parity or on a proven size cap', () => {
    const limit = 1.6875;
    expect(shouldStepTo2560({ zoom: 1, pixelParityZoomLimit: limit, sizeCapProven: false })).toBe(
      false,
    );
    expect(shouldStepTo2560({ zoom: 2, pixelParityZoomLimit: limit, sizeCapProven: false })).toBe(
      true,
    );
    expect(shouldStepTo2560({ zoom: 1, pixelParityZoomLimit: limit, sizeCapProven: true })).toBe(
      true,
    );
  });
});
