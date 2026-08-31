import { describe, expect, it } from 'vitest';

import { ASPECT_16_9, ASPECT_9_16, QUALITY_FLOOR_PX, YT_LADDER } from '../types';
import { computeGeometry, geometryToSourceRect } from '../youtube/geometry';

import { YOUTUBE_CAPS, YT_INCLUDE_INERT_VQ, buildEmbedUrl } from './youtubeEmbed.adapter';

/**
 * The adapter's pure halves: the §2.5 embed URL, and the bridge from the
 * geometry result to the `SourceRect` the render layer consumes.
 *
 * The `SourceRect` tests matter more than they look: `safe` is the crop square
 * at **zoom 1**, because `RenderController` applies zoom and pan on top. Putting
 * them in here as well would apply both twice, and the failure mode is a picture
 * that is subtly too tight — the kind of bug that survives a code review and
 * only shows up on hardware.
 */

const ELITE = 640;

function elite(over: Partial<Parameters<typeof computeGeometry>[0]> = {}) {
  return computeGeometry({
    displayW: ELITE,
    displayH: ELITE,
    dpr: 1,
    zoom: 1,
    sourceAspect: ASPECT_16_9,
    mode: 'square',
    qualityFloorPx: QUALITY_FLOOR_PX,
    ladder: YT_LADDER,
    ...over,
  });
}

describe('§2.5 embed URL', () => {
  const url = (): URL => new URL(buildEmbedUrl('dQw4w9WgXcQ', 0, 'https://example.test'));

  it('uses the privacy-enhanced host and the video id path', () => {
    expect(url().origin).toBe('https://www.youtube-nocookie.com');
    expect(url().pathname).toBe('/embed/dQw4w9WgXcQ');
  });

  it('carries the full parameter set', () => {
    expect(Object.fromEntries(url().searchParams)).toEqual({
      enablejsapi: '1',
      autoplay: '1',
      mute: '1',
      playsinline: '1',
      controls: '0',
      rel: '0',
      iv_load_policy: '3',
      disablekb: '1',
      fs: '0',
      cc_load_policy: '0',
      color: 'white',
      loop: '0',
      origin: 'https://example.test',
    });
  });

  it('never sends `vq` — measured to be inert, and kept as a named constant', () => {
    expect(YT_INCLUDE_INERT_VQ).toBe(false);
    expect(url().searchParams.has('vq')).toBe(false);
  });

  it('never sends loop=1 — YouTube’s own loop re-cues the video and flashes the poster', () => {
    expect(url().searchParams.get('loop')).toBe('0');
  });

  it('adds `start` only when there is one, floored to whole seconds', () => {
    expect(new URL(buildEmbedUrl('x', 0, null)).searchParams.has('start')).toBe(false);
    expect(new URL(buildEmbedUrl('x', 91.7, null)).searchParams.get('start')).toBe('91');
  });

  it('omits `origin` for an opaque origin rather than sending the string "null"', () => {
    expect(new URL(buildEmbedUrl('x', 0, 'null')).searchParams.has('origin')).toBe(false);
    expect(new URL(buildEmbedUrl('x', 0, null)).searchParams.has('origin')).toBe(false);
  });
});

describe('§1.2 capability row', () => {
  it('declares no true pause and no settable quality — both are the reason for §2.6/§2.7', () => {
    expect(YOUTUBE_CAPS.canTruePause).toBe(false);
    expect(YOUTUBE_CAPS.canSetQuality).toBe(false);
    expect(YOUTUBE_CAPS.canReadQuality).toBe(true);
    expect(YOUTUBE_CAPS.hasOwnChrome).toBe(true);
    expect(YOUTUBE_CAPS.pixelSource).toBe('cross-origin-iframe');
  });

  it('starts with canSeekSilently false — it is earned at runtime (§3.4)', () => {
    expect(YOUTUBE_CAPS.canSeekSilently).toBe(false);
  });
});

describe('geometry → SourceRect', () => {
  it('reports the centre 1080 crop at (420, 420) inside a 1920 square element', () => {
    const rect = geometryToSourceRect(elite(), ASPECT_16_9, true);
    expect(rect.surfaceW).toBe(1920);
    expect(rect.surfaceH).toBe(1920);
    expect(rect.safe).toEqual({ x: 420, y: 420, w: 1080, h: 1080 });
  });

  it('reports the full video band separately, chrome and all', () => {
    const rect = geometryToSourceRect(elite(), ASPECT_16_9, true);
    expect(rect.full).toEqual({ x: 0, y: 420, w: 1920, h: 1080 });
  });

  it('leaves zoom OUT of the rect — RenderController applies it exactly once', () => {
    const at1 = geometryToSourceRect(elite(), ASPECT_16_9, true);
    const at15 = geometryToSourceRect(elite({ zoom: 1.5 }), ASPECT_16_9, true);
    // Same element, same crop square: only the *transform* differs at zoom 1.5.
    expect(at15.safe).toEqual(at1.safe);
  });

  it('anchors a portrait crop to the top, reproducing the §2.3 Shorts example', () => {
    const g = elite({ sourceAspect: ASPECT_9_16, portraitWidth: 1080, mode: 'square' });
    const rect = geometryToSourceRect(g, ASPECT_9_16, true);
    expect(rect.surfaceW).toBe(1080);
    expect(rect.surfaceH).toBe(2400);
    expect(rect.safe).toEqual({ x: 0, y: 240, w: 1080, h: 1080 });
  });

  it('centres a portrait crop when the top anchor is off', () => {
    const g = elite({ sourceAspect: ASPECT_9_16, portraitWidth: 1080 });
    const rect = geometryToSourceRect(g, ASPECT_9_16, false);
    expect(rect.safe.y).toBe(240 + (1920 - 1080) / 2);
  });
});
