import { describe, expect, it } from 'vitest';

import {
  ASPECT_16_9,
  ASPECT_9_16,
  CROSSFADE_MAX_MS,
  CROSSFADE_MIN_MS,
  DEFAULT_YOUTUBE,
  LOOP_DEFAULTS,
  MAX_URL_LEN,
  PERF_HYSTERESIS_MS,
  QUALITY_FLOOR_PX,
  RESOLVER_DEFAULT_PORT,
  VIDEO_DEFAULTS,
  YT_LADDER,
  createPerfPromoter,
  perfProfile,
  resolvePerfMode,
  validateVideoConfig,
} from './types';

describe('constants', () => {
  it('carries the canonical resolver port and quality floor', () => {
    expect(RESOLVER_DEFAULT_PORT).toBe(8976);
    expect(QUALITY_FLOOR_PX).toBe(1920);
    expect(YT_LADDER).toEqual([1280, 1600, 1920, 2560]);
  });

  it('carries the §3.1 loop defaults and crossfade clamps', () => {
    expect(LOOP_DEFAULTS).toEqual({ minSpanSec: 0.25, endGuardSec: 1, epsSec: 0.02 });
    expect(CROSSFADE_MIN_MS).toBe(60);
    expect(CROSSFADE_MAX_MS).toBe(1000);
  });

  it('computes the aspect presets exactly', () => {
    expect(ASPECT_16_9).toBeCloseTo(1.777778, 6);
    expect(ASPECT_9_16).toBeCloseTo(0.5625, 9);
  });
});

describe('defaults', () => {
  it('downloads by default — the featured ingestion path', () => {
    expect(VIDEO_DEFAULTS.downloadMode).toBe('auto');
  });

  it('routes YouTube through the resolver when one happens to be running', () => {
    expect(VIDEO_DEFAULTS.resolver.policy).toBe('youtube-only');
    expect(VIDEO_DEFAULTS.resolver.port).toBe(RESOLVER_DEFAULT_PORT);
  });

  it('never calls pauseVideo() by default', () => {
    expect(VIDEO_DEFAULTS.youtube.pauseStrategy).toBe('microloop');
  });

  it('starts on the widest-chrome-margin geometry', () => {
    expect(VIDEO_DEFAULTS.youtube.mode).toBe('square');
    expect(VIDEO_DEFAULTS.youtube.sourceAspect).toBe('auto');
  });

  it('fits within the module defaults budget', () => {
    expect(JSON.stringify(VIDEO_DEFAULTS).length).toBeLessThan(4096);
  });
});

describe('validateVideoConfig', () => {
  it('is idempotent on its own defaults', () => {
    expect(validateVideoConfig(VIDEO_DEFAULTS)).toEqual(VIDEO_DEFAULTS);
    expect(validateVideoConfig(validateVideoConfig(VIDEO_DEFAULTS))).toEqual(VIDEO_DEFAULTS);
  });

  it('never throws, whatever storage hands it', () => {
    for (const junk of [undefined, null, 0, '', [], {}, { deeply: { wrong: [1, 2] } }, NaN]) {
      expect(() => validateVideoConfig(junk)).not.toThrow();
    }
    expect(validateVideoConfig(null)).toEqual(VIDEO_DEFAULTS);
  });

  it('clamps zoom to [1,4] and pan to [-0.5,0.5]', () => {
    const c = validateVideoConfig({ render: { zoom: 99, offsetX: -9, offsetY: 9 } });
    expect(c.render.zoom).toBe(4);
    expect(c.render.offsetX).toBe(-0.5);
    expect(c.render.offsetY).toBe(0.5);
    expect(validateVideoConfig({ render: { zoom: 0.1 } }).render.zoom).toBe(1);
  });

  it('accepts contain-circle and rejects an invented fit', () => {
    expect(validateVideoConfig({ render: { fit: 'contain-circle' } }).render.fit).toBe(
      'contain-circle',
    );
    expect(validateVideoConfig({ render: { fit: 'squish' } }).render.fit).toBe('cover');
  });

  it('only accepts the four rotations', () => {
    expect(validateVideoConfig({ render: { rotate: 270 } }).render.rotate).toBe(270);
    expect(validateVideoConfig({ render: { rotate: 45 } }).render.rotate).toBe(0);
  });

  it('clamps the crossfade duration', () => {
    expect(validateVideoConfig({ loop: { crossfadeMs: 5 } }).loop.crossfadeMs).toBe(60);
    expect(validateVideoConfig({ loop: { crossfadeMs: 9999 } }).loop.crossfadeMs).toBe(1000);
  });

  it('preserves a null loop end and coerces a bad one', () => {
    expect(validateVideoConfig({ loop: { end: null } }).loop.end).toBeNull();
    expect(validateVideoConfig({ loop: { end: 'soon' } }).loop.end).toBe(0);
    expect(validateVideoConfig({ loop: { start: -3 } }).loop.start).toBe(0);
  });

  it('drops an over-long url rather than storing it', () => {
    const long = 'x'.repeat(MAX_URL_LEN + 1);
    expect(validateVideoConfig({ url: long }).url).toBe('');
  });

  it('clamps the resolver port and keeps the policy enum closed', () => {
    expect(validateVideoConfig({ resolver: { port: 0 } }).resolver.port).toBe(1);
    expect(validateVideoConfig({ resolver: { port: 999_999 } }).resolver.port).toBe(65_535);
    expect(validateVideoConfig({ resolver: { policy: 'yolo' } }).resolver.policy).toBe(
      'youtube-only',
    );
  });

  it('clamps the source aspect and the baked-in bar insets', () => {
    expect(validateVideoConfig({ youtube: { sourceAspect: 99 } }).youtube.sourceAspect).toBe(5);
    expect(validateVideoConfig({ youtube: { sourceAspect: 'auto' } }).youtube.sourceAspect).toBe(
      'auto',
    );
    expect(
      validateVideoConfig({ youtube: { sourceInset: { top: 9 } } }).youtube.sourceInset,
    ).toEqual({ top: 0.45, bottom: 0, left: 0, right: 0 });
  });

  it('drops unknown keys entirely', () => {
    const c = validateVideoConfig({ url: '', evil: 'payload' }) as unknown as Record<
      string,
      unknown
    >;
    expect(c['evil']).toBeUndefined();
  });
});

/**
 * The player-shape field, now that a person can set it again.
 *
 * It has always existed and the engine has always read it — what it lacked was a
 * control, so the only value any install could hold was the default. Restoring
 * the control in Advanced makes the validator load-bearing rather than
 * theoretical: whatever the segment writes has to survive a round trip through
 * localStorage, and whatever a fork or a future build writes has to land on the
 * safe end rather than anywhere.
 */
describe('the YouTube player shape', () => {
  it('round-trips both values a person can choose', () => {
    expect(validateVideoConfig({ youtube: { mode: 'square' } }).youtube.mode).toBe('square');
    expect(validateVideoConfig({ youtube: { mode: 'tight' } }).youtube.mode).toBe('tight');
  });

  it('falls back to the safe shape for anything else', () => {
    expect(DEFAULT_YOUTUBE.mode).toBe('square');
    expect(validateVideoConfig({ youtube: { mode: 'wide' } }).youtube.mode).toBe('square');
    expect(validateVideoConfig({ youtube: { mode: 7 } }).youtube.mode).toBe('square');
    expect(validateVideoConfig({}).youtube.mode).toBe('square');
  });
});

describe('§8.3 performance mode', () => {
  it('pulls the documented levers', () => {
    expect(perfProfile('performance')).toEqual({
      qualityFloorPx: 1280,
      geometryMode: 'tight',
      zoomMax: 1.5,
      allowCrossfade: false,
      posterMask: false,
      telemetryHz: 0.2,
    });
    expect(perfProfile('quality').qualityFloorPx).toBe(1920);
    expect(perfProfile('quality').geometryMode).toBe('square');
  });

  it('auto-promotes at a low target FPS or a starved achieved FPS', () => {
    expect(resolvePerfMode('auto', { targetFps: 1, achievedFps: 1 })).toBe('performance');
    expect(resolvePerfMode('auto', { targetFps: 40, achievedFps: 10 })).toBe('performance');
    expect(resolvePerfMode('auto', { targetFps: 40, achievedFps: 35 })).toBe('quality');
  });

  it('never overrides an explicit choice', () => {
    expect(resolvePerfMode('quality', { targetFps: 1, achievedFps: 1 })).toBe('quality');
    expect(resolvePerfMode('performance', { targetFps: 40, achievedFps: 40 })).toBe('performance');
  });
});

describe('createPerfPromoter (§8.3)', () => {
  it('passes an explicit mode straight through', () => {
    const p = createPerfPromoter({ now: () => 0 });
    expect(p.update('quality', { targetFps: 1, achievedFps: 0.5 })).toBe('quality');
    expect(p.update('performance', { targetFps: 40, achievedFps: 40 })).toBe('performance');
  });

  it('promotes IMMEDIATELY on a low targetFps — that is a setting, not a measurement', () => {
    const p = createPerfPromoter({ now: () => 0 });
    expect(p.update('auto', { targetFps: 10, achievedFps: 10 })).toBe('performance');
  });

  it('needs a sustained 10 s of low achieved FPS before promoting', () => {
    let clock = 0;
    const p = createPerfPromoter({ now: () => clock });
    const bad = { targetFps: 40, achievedFps: 10 };
    expect(p.update('auto', bad)).toBe('quality');
    clock += 9000;
    // One bad second during a seek must not flip the whole render path.
    expect(p.update('auto', bad)).toBe('quality');
    clock += 1500;
    expect(p.update('auto', bad)).toBe('performance');
  });

  it('forgets a candidate as soon as the signal recovers', () => {
    let clock = 0;
    const p = createPerfPromoter({ now: () => clock });
    p.update('auto', { targetFps: 40, achievedFps: 10 });
    clock += 9000;
    p.update('auto', { targetFps: 40, achievedFps: 39 });
    clock += 9000;
    expect(p.update('auto', { targetFps: 40, achievedFps: 10 })).toBe('quality');
  });

  it('demotes back to quality only after the same 10 s', () => {
    let clock = 0;
    const p = createPerfPromoter({ now: () => clock });
    p.update('auto', { targetFps: 40, achievedFps: 10 });
    clock += PERF_HYSTERESIS_MS;
    expect(p.update('auto', { targetFps: 40, achievedFps: 10 })).toBe('performance');
    const good = { targetFps: 40, achievedFps: 39 };
    expect(p.update('auto', good)).toBe('performance');
    clock += PERF_HYSTERESIS_MS + 1;
    expect(p.update('auto', good)).toBe('quality');
  });
});
