/**
 * `?loop=` reaches the video module as an A-B loop — round 13, F3.
 *
 * The parser's half of this lives in `src/state/urlParams.test.ts`; this is the
 * other end of the same wire. It asserts on the MANIFEST, not on a player,
 * because `applyUrlParams` is the seam the host calls before anything is
 * mounted: what it returns is passed straight back through `validate()`, and
 * the loop rules then clamp the range against a duration nothing here knows.
 */

import { describe, expect, it } from 'vitest';

import { VIDEO_DEFAULTS } from './types';

import { videoModule } from './index';

import type { VideoModuleConfig } from './types';

function apply(params: Record<string, string>): VideoModuleConfig {
  const applied = videoModule.applyUrlParams?.(VIDEO_DEFAULTS, params) ?? VIDEO_DEFAULTS;
  // The host always re-validates, so the test asserts on what actually lands.
  return videoModule.validate(applied);
}

describe('videoModule.applyUrlParams', () => {
  it('maps ?loop=<start>-<end> onto the A-B loop', () => {
    const cfg = apply({ loop: '12-31.5' });
    expect(cfg.loop.enabled).toBe(true);
    expect(cfg.loop.start).toBe(12);
    expect(cfg.loop.end).toBe(31.5);
  });

  it('keeps ?loop=1 meaning "loop the whole clip"', () => {
    const cfg = apply({ loop: '1' });
    expect(cfg.loop.enabled).toBe(true);
    expect(cfg.loop.start).toBe(VIDEO_DEFAULTS.loop.start);
    // `null` is "to the end of the clip, less the end guard" (§3.2).
    expect(cfg.loop.end).toBeNull();
  });

  it('keeps ?loop=0 meaning "stop looping" without inventing a span', () => {
    const cfg = apply({ loop: '0' });
    expect(cfg.loop.enabled).toBe(false);
    expect(cfg.loop.end).toBeNull();
  });

  it('leaves the loop alone when the range is nonsense', () => {
    // The parser rejects these before the module sees them; the module is
    // asked directly here because `applyUrlParams` is a public seam.
    for (const loop of ['30-12', '5-5', 'maybe', '12-', '-9']) {
      const cfg = apply({ loop });
      expect(cfg.loop).toEqual(VIDEO_DEFAULTS.loop);
    }
  });

  it('still honours ?src=, ?mute= and ?demo=1 beside the range', () => {
    const cfg = apply({ src: 'https://example.test/a.mp4', mute: '1', loop: '0-4' });
    expect(cfg.url).toBe('https://example.test/a.mp4');
    expect(cfg.audioEnabled).toBe(false);
    expect(cfg.loop.enabled).toBe(true);
    expect(cfg.loop.end).toBe(4);
  });
});
