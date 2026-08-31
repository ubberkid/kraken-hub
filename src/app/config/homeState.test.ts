import { beforeEach, describe, expect, it } from 'vitest';

import { DIAG_DISPLAY_SUFFIX, DIAG_SCHEMA_VERSION } from '../../diag/report';
import { TELE_SUFFIX } from '../../modules/video/telemetry/videoTelemetry';
import { removeRaw, writeRaw } from '../../platform/storage';

import {
  LOW_FPS_THRESHOLD,
  formatSeconds,
  isLowFps,
  pickMirrorPreset,
  readDisplayFacts,
  sourceName,
} from './homeState';

/** A report is only trusted when the DISPLAY wrote it — see `readDisplayFacts`. */
function seedReport(device: Record<string, unknown>, mode = 'display'): void {
  writeRaw(
    DIAG_DISPLAY_SUFFIX,
    JSON.stringify({ schemaVersion: DIAG_SCHEMA_VERSION, mode, device }),
  );
}

function seedTele(display: { w: number; h: number; shape: string; targetFps: number }): void {
  writeRaw(TELE_SUFFIX, JSON.stringify({ ch: 'tele', kind: 'videoStats', ts: 1, display }));
}

describe('readDisplayFacts', () => {
  beforeEach(() => {
    removeRaw(DIAG_DISPLAY_SUFFIX);
    removeRaw(TELE_SUFFIX);
  });

  it('is null when the display has published nothing — this window never guesses', () => {
    expect(readDisplayFacts()).toBeNull();
  });

  it('prefers what CAM injected over what the geometry engine resolved', () => {
    seedReport({
      width: 640,
      height: 640,
      shape: 'circle',
      targetFps: 30,
      nzxtRaw: { width: 320, height: 320, shape: 'circle', targetFps: 1 },
    });
    expect(readDisplayFacts()).toEqual({
      width: 320,
      height: 320,
      shape: 'circle',
      targetFps: 1,
      source: 'diag',
    });
  });

  it('falls back to the video telemetry mirror, which exists during ordinary use', () => {
    seedTele({ w: 240, h: 240, shape: 'square', targetFps: 25 });
    expect(readDisplayFacts()).toEqual({
      width: 240,
      height: 240,
      shape: 'square',
      targetFps: 25,
      source: 'tele',
    });
  });

  it('ignores a report the CONFIG page wrote about itself', () => {
    seedReport({ width: 640, height: 640, shape: 'circle', targetFps: 1, nzxtRaw: null }, 'config');
    expect(readDisplayFacts()).toBeNull();
  });
});

describe('pickMirrorPreset', () => {
  it('matches the real panel', () => {
    expect(
      pickMirrorPreset({ width: 240, height: 240, shape: 'square', targetFps: 25, source: 'diag' }),
    ).toBe('kraken2023');
    expect(
      pickMirrorPreset({ width: 320, height: 320, shape: 'circle', targetFps: 1, source: 'tele' }),
    ).toBe('z');
  });

  it('falls back to the Elite — the common panel, and the safe way to guess', () => {
    expect(pickMirrorPreset(null)).toBe('elite');
    expect(
      pickMirrorPreset({ width: 777, height: 777, shape: 'circle', targetFps: 40, source: 'diag' }),
    ).toBe('elite');
  });
});

describe('isLowFps', () => {
  it('never warns without a number from the display', () => {
    expect(isLowFps(null)).toBe(false);
  });

  it('warns at and below the threshold only', () => {
    const at = { width: 640, height: 640, shape: 'circle', source: 'diag' } as const;
    expect(isLowFps({ ...at, targetFps: 1 })).toBe(true);
    expect(isLowFps({ ...at, targetFps: LOW_FPS_THRESHOLD })).toBe(true);
    expect(isLowFps({ ...at, targetFps: LOW_FPS_THRESHOLD + 1 })).toBe(false);
    expect(isLowFps({ ...at, targetFps: 40 })).toBe(false);
  });
});

describe('formatSeconds', () => {
  it('pads to m:ss and refuses to render nonsense', () => {
    expect(formatSeconds(0)).toBe('0:00');
    expect(formatSeconds(9)).toBe('0:09');
    expect(formatSeconds(94.7)).toBe('1:34');
    expect(formatSeconds(3600)).toBe('60:00');
    expect(formatSeconds(null)).toBe('—');
    expect(formatSeconds(Number.NaN)).toBe('—');
    expect(formatSeconds(-1)).toBe('—');
  });
});

describe('sourceName', () => {
  const names = new Map([['abcd1234', 'sunset loop']]);

  it('names a local clip from the published index', () => {
    expect(sourceName('kraken-hub-clip:abcd1234', names)).toBe('sunset loop');
    expect(sourceName('kraken-hub-clip:zzzzzzzz', names)).toBe('a local clip');
  });

  it('names a remote url by the part a human recognises', () => {
    expect(sourceName('https://example.test/clips/dunes.mp4?sig=xyz', names)).toBe('dunes.mp4');
    expect(sourceName('https://example.test/', names)).toBe('example.test');
  });

  it('calls an empty source what it is', () => {
    expect(sourceName('   ', names)).toBe('the demo clip');
  });
});
