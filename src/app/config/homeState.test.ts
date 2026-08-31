import { beforeEach, describe, expect, it } from 'vitest';

import { DIAG_DISPLAY_SUFFIX, DIAG_SCHEMA_VERSION } from '../../diag/report';
import { TELE_SUFFIX } from '../../modules/video/telemetry/videoTelemetry';
import { removeRaw, writeRaw } from '../../platform/storage';

import {
  LOW_FPS_THRESHOLD,
  describeFlow,
  failureLine,
  formatSeconds,
  isLowFps,
  pickMirrorPreset,
  readDisplayFacts,
  resolverHealthyFromTele,
  sourceName,
} from './homeState';

import type { DownloadEntry } from '../../modules/video/local/downloadManager';

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

/**
 * The regression these pin, in the words of the person who reported it: *"Any
 * youtube or direct link I put in there just gives me an error saying it can't
 * do it. Saying it can't do a cross origin read."*
 *
 * Nothing was broken about playback — the display was playing every one of
 * those links. The home screen was showing the FIRST entry of an unpruned
 * download mirror, forever, with the browser's own `TypeError` as its copy. One
 * CORS-less MP4 therefore made every later paste look like a failure, including
 * a YouTube link that never starts a download at all and a later download that
 * actually succeeded.
 */
describe('describeFlow', () => {
  const MP4 = 'https://cdn.example.test/clip.mp4';
  const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

  function entry(over: Partial<DownloadEntry> = {}): DownloadEntry {
    return {
      id: 'a',
      url: MP4,
      sourceUrl: MP4,
      name: 'clip.mp4',
      state: 'downloading',
      receivedBytes: 10,
      totalBytes: 100,
      attempt: 1,
      error: null,
      reason: null,
      clipId: null,
      startedAt: 1,
      updatedAt: 2,
      ...over,
    };
  }

  const noCompanion = { resolverHealthy: false };

  it('says nothing at all for the demo, a local clip, or an empty box', () => {
    expect(describeFlow({ url: '', entries: [], ...noCompanion })).toBeNull();
    expect(
      describeFlow({ url: 'kraken-hub-clip:abcd1234', entries: [], ...noCompanion }),
    ).toBeNull();
  });

  it('tells the story of the CURRENT url, never of a job three pastes ago', () => {
    const stale = entry({ state: 'error', reason: 'cors', error: 'Failed to fetch' });
    // The exact shape of the bug: a dead entry for another link, and a YouTube
    // url on screen. It must not borrow that entry's failure.
    const flow = describeFlow({ url: YT, entries: [stale], ...noCompanion });
    expect(flow?.stage).toBe('youtube-embed');
    expect(flow?.entry).toBeNull();
  });

  it('does not let a failed entry outrank a newer successful one', () => {
    const done = entry({ id: 'b', state: 'done', clipId: 'c1', startedAt: 9 });
    const failed = entry({ id: 'a', state: 'error', reason: 'cors', startedAt: 1 });
    // Newest first, the order `listDownloads()` publishes.
    expect(describeFlow({ url: MP4, entries: [done, failed], ...noCompanion })?.stage).toBe(
      'stored',
    );
  });

  it('calls a CORS refusal what it is — streaming, not failure', () => {
    const flow = describeFlow({
      url: MP4,
      entries: [entry({ state: 'error', reason: 'cors', error: 'Failed to fetch' })],
      ...noCompanion,
    });
    expect(flow?.stage).toBe('streaming');
  });

  it('separates a genuine keep failure from a CORS refusal', () => {
    expect(
      describeFlow({
        url: MP4,
        entries: [entry({ state: 'error', reason: 'quota', error: 'no room' })],
        ...noCompanion,
      })?.stage,
    ).toBe('unsaved');
  });

  it('matches the resolver path by the url the user pasted, not the loopback one', () => {
    const job = entry({
      url: 'http://127.0.0.1:8976/stream/opaque',
      sourceUrl: YT,
      state: 'downloading',
    });
    expect(describeFlow({ url: YT, entries: [job], resolverHealthy: true })?.stage).toBe(
      'downloading',
    );
  });

  it('offers the downloader for YouTube only while no companion is answering', () => {
    expect(describeFlow({ url: YT, entries: [], ...noCompanion })?.stage).toBe('youtube-embed');
    // With one running, the display is about to publish a real job — inviting
    // the user to install what they already installed would be a lie.
    expect(describeFlow({ url: YT, entries: [], resolverHealthy: true })).toBeNull();
  });

  it('says nothing for a plain link with no job, and nothing for a cancelled one', () => {
    expect(describeFlow({ url: MP4, entries: [], ...noCompanion })).toBeNull();
    expect(
      describeFlow({ url: MP4, entries: [entry({ state: 'aborted' })], ...noCompanion }),
    ).toBeNull();
  });

  it('reads companion health only from what the DISPLAY published', () => {
    expect(resolverHealthyFromTele(null)).toBe(false);
    expect(resolverHealthyFromTele({ resolver: { healthy: false } })).toBe(false);
    expect(resolverHealthyFromTele({ resolver: { healthy: true } })).toBe(true);
  });

  it('never puts the browser’s own words on the home screen', () => {
    const line = failureLine(
      entry({ state: 'error', reason: 'network', error: 'Failed to fetch' }),
    );
    expect(line).not.toContain('Failed to fetch');
    expect(line).toContain('playing it from the link');
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
