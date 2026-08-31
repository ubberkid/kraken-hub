import { describe, expect, it, vi } from 'vitest';

import { AUDIO_FAILURE_LIMIT, failingMediaType, isFatalDashError } from './dash.adapter';
import { pickLevel } from './hls.adapter';
import {
  REDDIT_LADDER,
  probeRedditLadder,
  redditLadderUrls,
  redditManifestUrl,
  redditRenditionUrl,
} from './reddit.adapter';

/**
 * The pure halves of the three library-backed providers. Everything here is the
 * bit that decides *which bytes we ask for*, which is exactly the bit a
 * refactor can break invisibly — a wrong rendition still plays, it just plays
 * at the wrong quality or costs three times the frame budget.
 */

describe('hls: pickLevel', () => {
  const ladder = [{ height: 360 }, { height: 720 }, { height: 1080 }, { height: 2160 }];

  it('takes the highest level that fits under the crop', () => {
    expect(pickLevel(ladder, 1080)).toBe(2);
    expect(pickLevel(ladder, 900)).toBe(1);
  });

  it('takes the lowest level when nothing fits, rather than the biggest', () => {
    // Asking for 240p on a ladder that starts at 360p should still give a
    // picture — and must never fall UP into a 2160p decode.
    expect(pickLevel(ladder, 240)).toBe(0);
  });

  it('returns the ABR sentinel for an empty ladder', () => {
    expect(pickLevel([], 1080)).toBe(-1);
  });
});

describe('dash: the v.redd.it audio tolerance (§1.5)', () => {
  it('finds the media type wherever dash.js put it', () => {
    expect(failingMediaType({ event: { request: { mediaType: 'audio' } } })).toBe('audio');
    expect(failingMediaType({ event: { id: 'video' } })).toBe('video');
    expect(failingMediaType({})).toBeNull();
    expect(failingMediaType(null)).toBeNull();
  });

  it('treats a download error as recoverable and everything else as fatal', () => {
    // This is the whole rule: an audio AdaptationSet 403ing must not kill the
    // video on a display that is always muted anyway.
    expect(isFatalDashError({ error: 'download' })).toBe(false);
    expect(isFatalDashError({ error: 'mediasource' })).toBe(true);
    expect(isFatalDashError({ error: { code: 25 } })).toBe(true);
  });

  it('gives audio two chances before dropping it', () => {
    expect(AUDIO_FAILURE_LIMIT).toBe(2);
  });
});

describe('reddit: the DASH_<h>.mp4 ladder (§1.5)', () => {
  it('probes highest first', () => {
    expect(REDDIT_LADDER).toEqual([1080, 720, 480, 360]);
  });

  it('builds the rendition and manifest URLs Reddit actually serves', () => {
    expect(redditRenditionUrl('https://v.redd.it/abc123', 720)).toBe(
      'https://v.redd.it/abc123/DASH_720.mp4',
    );
    // A trailing slash from the normalizer must not produce a double slash.
    expect(redditRenditionUrl('https://v.redd.it/abc123/', 720)).toBe(
      'https://v.redd.it/abc123/DASH_720.mp4',
    );
    expect(redditManifestUrl('https://v.redd.it/abc123')).toBe(
      'https://v.redd.it/abc123/DASHPlaylist.mpd',
    );
  });

  it('walks the whole ladder in order', () => {
    expect(redditLadderUrls('https://v.redd.it/x')).toEqual([
      'https://v.redd.it/x/DASH_1080.mp4',
      'https://v.redd.it/x/DASH_720.mp4',
      'https://v.redd.it/x/DASH_480.mp4',
      'https://v.redd.it/x/DASH_360.mp4',
    ]);
  });

  it('stops at the first rung that answers, and does not probe below it', async () => {
    const probe = vi
      .fn()
      .mockImplementation((url: string) => Promise.resolve(url.includes('DASH_720')));
    const out = await probeRedditLadder('https://v.redd.it/x', new AbortController().signal, {
      probe,
    });
    expect(out).toBe('https://v.redd.it/x/DASH_720.mp4');
    // 1080 then 720; 480 and 360 are never touched.
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('returns null when every rung fails, so the caller can fall to dash.js', async () => {
    const probe = vi.fn().mockResolvedValue(false);
    const out = await probeRedditLadder('https://v.redd.it/x', new AbortController().signal, {
      probe,
    });
    expect(out).toBeNull();
    expect(probe).toHaveBeenCalledTimes(REDDIT_LADDER.length);
  });

  it('abandons the ladder when the mount is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const probe = vi.fn();
    expect(await probeRedditLadder('https://v.redd.it/x', controller.signal, { probe })).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });
});
