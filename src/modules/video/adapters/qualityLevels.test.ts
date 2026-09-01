import { describe, expect, it } from 'vitest';

import { ladderUpTo } from '../quality';

import { describeLevels as dashLevels } from './dash.adapter';
import { describeLevels as hlsLevels, pickLevel } from './hls.adapter';
import { describeTwitchLevels, pickTwitchQuality, TWITCH_AUTO_LABEL } from './twitch.adapter';
import { isAutoQualityHint, AUTO_QUALITY_HINT } from './VideoAdapter';

/**
 * Level reporting, per provider, against faked player payloads.
 *
 * These are the shapes the real libraries hand back — an hls.js `Level[]`, a
 * dash.js representation list, Twitch's array of label strings — reduced to the
 * fields the mapping reads. Faking them is the point: the alternative is a test
 * that needs a live manifest, which would make the level list untested in CI
 * forever, and the level list is what the whole quality picker is built on.
 */
describe('hls levels', () => {
  it('de-duplicates by height and sorts low to high', () => {
    // A real ladder routinely carries several bitrate variants per height; a
    // picker offering "1080p, 1080p, 1080p" is worse than useless.
    const levels = hlsLevels([
      { height: 1080 },
      { height: 720 },
      { height: 1080 },
      { height: 360 },
    ]);
    expect(levels).toEqual([
      { height: 360, label: '360p' },
      { height: 720, label: '720p' },
      { height: 1080, label: '1080p' },
    ]);
  });

  it('drops levels with no usable height rather than labelling them "0p"', () => {
    expect(hlsLevels([{ height: 0 }, { height: 720 }])).toEqual([{ height: 720, label: '720p' }]);
  });

  it('picks the highest level that fits under the ask', () => {
    const levels = [{ height: 360 }, { height: 720 }, { height: 1080 }];
    expect(pickLevel(levels, 1080)).toBe(2);
    expect(pickLevel(levels, 900)).toBe(1);
  });

  it('still gives a picture when the ladder starts above the ask', () => {
    expect(pickLevel([{ height: 720 }, { height: 1080 }], 480)).toBe(0);
  });
});

describe('dash levels', () => {
  it('reads representation heights the same way HLS reads level heights', () => {
    expect(dashLevels([{ height: 1080 }, { height: 480 }, { height: 1080 }])).toEqual([
      { height: 480, label: '480p' },
      { height: 1080, label: '1080p' },
    ]);
  });
});

describe('twitch levels', () => {
  it('keeps Twitch’s own labels, because that is what its player shows', () => {
    expect(describeTwitchLevels(['auto', '1080p60', '720p', '160p'])).toEqual([
      { height: 160, label: '160p' },
      { height: 720, label: '720p' },
      { height: 1080, label: '1080p60' },
    ]);
  });

  it('drops "auto" — it is not a rendition, and the picker has its own Auto', () => {
    expect(describeTwitchLevels([TWITCH_AUTO_LABEL]).length).toBe(0);
  });

  it('treats `chunked` as the source rendition', () => {
    expect(describeTwitchLevels(['chunked']).map((l) => l.height)).toEqual([1080]);
  });

  it('prefers an explicit rendition over `chunked` at the same height', () => {
    // `chunked` is the untranscoded source, so it carries the streamer's full
    // bitrate even when its resolution matches — and bitrate is what costs
    // frames on a panel behind a compressing capture pipeline.
    expect(pickTwitchQuality(['chunked', '1080p60'], 1080)).toBe('1080p60');
  });
});

describe('resolver levels', () => {
  /**
   * The resolver cannot enumerate renditions — yt-dlp already chose one — but
   * it reports the source height, which is a real ceiling: every rung below it
   * is obtainable by asking the companion again with a lower `maxHeight`.
   */
  it('offers the standard ladder capped at the reported source height', () => {
    expect(ladderUpTo(1080).map((l) => l.height)).toEqual([480, 720, 1080]);
  });
});

describe('the auto hint', () => {
  it('is a value every adapter can recognise without a second method', () => {
    expect(isAutoQualityHint(AUTO_QUALITY_HINT)).toBe(true);
    expect(isAutoQualityHint(0)).toBe(true);
    expect(isAutoQualityHint(Number.NaN)).toBe(true);
    expect(isAutoQualityHint(720)).toBe(false);
  });
});
