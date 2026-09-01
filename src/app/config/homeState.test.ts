import { beforeEach, describe, expect, it } from 'vitest';

import { DIAG_DISPLAY_SUFFIX, DIAG_SCHEMA_VERSION } from '../../diag/report';
import { TELE_SUFFIX } from '../../modules/video/telemetry/videoTelemetry';
import { removeRaw, writeRaw } from '../../platform/storage';

import {
  LOW_FPS_THRESHOLD,
  describeFlow,
  describeVideoStatus,
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

  it('names the embed path for YouTube only while no companion is answering', () => {
    expect(describeFlow({ url: YT, entries: [], ...noCompanion })?.stage).toBe('youtube-embed');
    // With one running, the display is about to publish a real job — telling the
    // user it is playing through YouTube's own player would be a lie.
    expect(describeFlow({ url: YT, entries: [], resolverHealthy: true })?.stage).toBe('accepted');
  });

  /**
   * The same gesture gets the same response.
   *
   * Design audit F4: a YouTube link produced three step-cards and an `.mp4`
   * produced *nothing at all* — the primary action, answered with silence. A
   * recognised link with no job yet is `accepted`, which is an acknowledgement
   * rather than a download story.
   */
  it('acknowledges a plain link with no job, and says nothing for a cancelled one', () => {
    expect(describeFlow({ url: MP4, entries: [], ...noCompanion })?.stage).toBe('accepted');
    // A job the user cancelled: a card explaining what they just did to
    // themselves is noise, so this one stays silent.
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

/**
 * Design audit F4 — the app's most common action, answered by name.
 *
 * `sourceName` used to take the last path segment unconditionally, and every
 * YouTube watch link in the world ends in `/watch`, so pasting one produced
 * "Ready to play **watch**". A Shorts link produced the raw video id.
 */
describe('sourceName — the provider, not the path', () => {
  const names = new Map<string, string>();

  it('names YouTube links by the site, never by the word "watch"', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    ]) {
      expect(sourceName(url, names)).toBe('a YouTube video');
    }
  });

  it('names the other providers the way a person would', () => {
    expect(sourceName('https://vimeo.com/123456789', names)).toBe('a Vimeo video');
    expect(sourceName('https://www.twitch.tv/somestreamer', names)).toBe('a Twitch stream');
  });

  it('upgrades to the real title the moment telemetry carries one', () => {
    expect(sourceName('https://www.youtube.com/watch?v=dQw4w9WgXcQ', names, 'Sunset loop')).toBe(
      'Sunset loop',
    );
    // Blank is not a title. Falling back is better than an empty bold word.
    expect(sourceName('https://www.youtube.com/watch?v=dQw4w9WgXcQ', names, '  ')).toBe(
      'a YouTube video',
    );
  });

  it('still uses a path segment when it is genuinely a filename', () => {
    expect(sourceName('https://example.test/clips/dunes.mp4?sig=xyz', names)).toBe('dunes.mp4');
  });
});

/**
 * Design audit F4 — the verb ladder.
 *
 * The old line had one rung and never left it: liveness required `tele.stats`
 * from a running display, so in the configuration browser the status was
 * permanently "Ready to play", describing something the app was *about* to do.
 */
describe('describeVideoStatus', () => {
  const YT_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const base = {
    url: YT_URL,
    loopEnabled: false,
    loopEnd: null,
    tele: null,
    clipNames: new Map<string, string>(),
    now: 10_000,
    downloading: false,
    displaySeen: true,
    streamingOnly: false,
  };

  function stats(over: Partial<{ currentTime: number; bufferedEnd: number; held: boolean }> = {}) {
    return { currentTime: 84, bufferedEnd: 182, held: false, ...over };
  }

  it('says Playing, with the display’s own clock, while telemetry is fresh', () => {
    const s = describeVideoStatus({ ...base, tele: { ts: 9000, stats: stats() } });
    expect(s.verb).toBe('Playing');
    expect(s.live).toBe(true);
    expect(s.detail).toBe('1:24 / 3:02');
  });

  it('says Holding — and drops the live dot — for a held player', () => {
    const s = describeVideoStatus({ ...base, tele: { ts: 9000, stats: stats({ held: true }) } });
    expect(s.verb).toBe('Holding');
    expect(s.live).toBe(false);
  });

  it('uses the title telemetry carried, over the detected provider', () => {
    const s = describeVideoStatus({
      ...base,
      tele: { ts: 9000, stats: stats(), title: 'lofi hip hop radio' },
    });
    expect(s.name).toBe('lofi hip hop radio');
  });

  it('names the stage the strip used to badge: keeping a copy of it', () => {
    expect(describeVideoStatus({ ...base, downloading: true }).verb).toBe('Keeping a copy of');
  });

  it('says Streaming only when nothing is being kept', () => {
    // A copy IS being kept, so the verb is the outcome, not the transport. This
    // pair is round 2's contradiction: the line said "Streaming clip.mp4" under
    // a permanent "Keeping a copy" badge.
    expect(describeVideoStatus(base).verb).toBe('Playing');
    expect(describeVideoStatus({ ...base, streamingOnly: true }).verb).toBe('Streaming');
    expect(
      describeVideoStatus({
        ...base,
        url: 'kraken-hub-clip:abcd1234',
        clipNames: new Map([['abcd1234', 'sunset loop']]),
      }),
    ).toMatchObject({ verb: 'Playing', name: 'sunset loop' });
  });

  it('is pre-flight only when nothing is genuinely happening', () => {
    // Nothing configured…
    expect(describeVideoStatus({ ...base, url: '' })).toMatchObject({
      verb: 'Ready to play',
      name: 'the demo clip',
    });
    // …or no Kraken has ever connected on this origin, which is the one case
    // where claiming "Streaming" would be a guess.
    expect(describeVideoStatus({ ...base, displaySeen: false }).verb).toBe('Ready to play');
    expect(describeVideoStatus({ ...base, displaySeen: false, streamingOnly: true }).verb).toBe(
      'Ready to play',
    );
  });

  it('goes quiet again when the telemetry mirror goes stale', () => {
    const s = describeVideoStatus({
      ...base,
      streamingOnly: true,
      tele: { ts: 1, stats: stats() },
      now: 100_000,
    });
    expect(s.verb).toBe('Streaming');
    expect(s.live).toBe(false);
  });
});
