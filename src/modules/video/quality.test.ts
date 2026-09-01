import { describe, expect, it } from 'vitest';

import {
  DEFAULT_QUALITY,
  QUALITY_LADDER,
  YT_BIAS_HEIGHTS,
  clipSourceKey,
  describeQuality,
  ladderUpTo,
  qualityControlFor,
  qualityFromOption,
  qualityOptionValue,
  qualityOptions,
  ytLadderFloorFor,
} from './quality';
import { VIDEO_DEFAULTS, validateVideoConfig } from './types';

import { videoModule } from './index';

describe('quality config', () => {
  it('defaults to auto with no pin', () => {
    expect(VIDEO_DEFAULTS.quality).toEqual({ mode: 'auto', height: null });
  });

  /**
   * The migration IS this: a document written before the setting existed comes
   * back with `{ mode: 'auto', height: null }`, which is exactly the behaviour
   * that installation already had. Nobody's picture changes on upgrade.
   */
  it('fills a missing quality from defaults, so an old config is unchanged in effect', () => {
    const legacy = { url: 'https://example.com/a.mp4', perf: 'quality' };
    expect(validateVideoConfig(legacy).quality).toEqual(DEFAULT_QUALITY);
  });

  it('bumped configVersion and ships the migration the bump requires', () => {
    expect(videoModule.configVersion).toBe(2);
    // `defineModule` fails loudly in DEV when a version above 1 has no
    // migration, so this is the assertion that keeps that contract honest.
    expect(typeof videoModule.migrateConfig).toBe('function');
  });

  it('migrating a v1 config produces a document that validates to the auto default', () => {
    const raw = videoModule.migrateConfig?.(1, { url: 'https://example.com/a.mp4' });
    expect(validateVideoConfig(raw).quality).toEqual(DEFAULT_QUALITY);
  });

  it('coerces junk rather than throwing, like every other validator here', () => {
    expect(validateVideoConfig({ quality: 'nope' }).quality).toEqual(DEFAULT_QUALITY);
    expect(validateVideoConfig({ quality: { mode: 'fixed', height: '1080' } }).quality).toEqual({
      mode: 'fixed',
      height: null,
    });
    expect(validateVideoConfig({ quality: { mode: 'wat', height: 1080 } }).quality).toEqual({
      mode: 'auto',
      height: 1080,
    });
  });

  it('clamps an out-of-range height into a plausible video range', () => {
    expect(validateVideoConfig({ quality: { mode: 'fixed', height: 99_999 } }).quality.height).toBe(
      4320,
    );
    expect(validateVideoConfig({ quality: { mode: 'fixed', height: 1 } }).quality.height).toBe(144);
  });

  it('round-trips a pinned height through validation', () => {
    const cfg = validateVideoConfig({ quality: { mode: 'fixed', height: 1080 } });
    expect(cfg.quality).toEqual({ mode: 'fixed', height: 1080 });
  });
});

describe('qualityControlFor', () => {
  it.each([
    ['hls', 'set'],
    ['dash', 'set'],
    ['twitch', 'set'],
    ['resolver', 'set'],
    ['youtube-embed', 'bias'],
    ['local-file', 'readonly'],
    ['direct-file', 'readonly'],
    ['reddit', 'readonly'],
  ] as const)('%s offers %s', (provider, expected) => {
    expect(qualityControlFor(provider)).toBe(expected);
  });

  it('knows nothing about a provider that has not mounted', () => {
    expect(qualityControlFor(null)).toBe('none');
  });
});

describe('ytLadderFloorFor', () => {
  /**
   * The bias ladder is the whole YouTube story: there is no cross-origin
   * quality API, only the width YouTube measures the player at.
   */
  it('maps the offered biases onto the three geometry rungs', () => {
    expect(ytLadderFloorFor(720)).toBe(1280);
    expect(ytLadderFloorFor(1080)).toBe(1920);
    expect(ytLadderFloorFor(1440)).toBe(2560);
  });

  it('floors below 720 at the smallest rung and above 1440 at the largest', () => {
    expect(ytLadderFloorFor(480)).toBe(1280);
    expect(ytLadderFloorFor(2160)).toBe(2560);
  });

  it('leaves the configured floor alone for Auto', () => {
    expect(ytLadderFloorFor(null)).toBeNull();
    expect(ytLadderFloorFor(0)).toBeNull();
    expect(ytLadderFloorFor(Number.NaN)).toBeNull();
  });

  it('offers exactly the three biases the picker shows', () => {
    expect([...YT_BIAS_HEIGHTS]).toEqual([720, 1080, 1440]);
    for (const h of YT_BIAS_HEIGHTS) expect(ytLadderFloorFor(h)).not.toBeNull();
  });
});

describe('ladderUpTo', () => {
  it('caps at the source height rather than promising rungs that do not exist', () => {
    expect(ladderUpTo(1080).map((l) => l.height)).toEqual([480, 720, 1080]);
  });

  it('adds a non-standard source height as its own rung', () => {
    expect(ladderUpTo(900).map((l) => l.height)).toEqual([480, 720, 900]);
  });

  it('falls back to the whole ladder when the source height is unknown', () => {
    expect(ladderUpTo(0).map((l) => l.height)).toEqual([...QUALITY_LADDER]);
  });
});

describe('describeQuality', () => {
  it('names what the provider chose, under Auto', () => {
    expect(
      describeQuality({ mode: 'auto', height: null }, { reported: { height: 720 }, local: false }),
    ).toBe('Auto — 720p right now');
  });

  it('says "local" when the bytes are on this PC', () => {
    expect(
      describeQuality({ mode: 'fixed', height: 1080 }, { reported: { height: 1080 }, local: true }),
    ).toBe('1080p · local');
  });

  /** Never claims a picture we have not been told about. */
  it('marks an unconfirmed pin as asked-for rather than achieved', () => {
    expect(describeQuality({ mode: 'fixed', height: 1080 }, { reported: null, local: false })).toBe(
      '1080p (asked)',
    );
  });

  /**
   * A resting state, not an apology (round 4, minors).
   *
   * "Auto — quality not reported yet" told the reader that a setting whose whole
   * meaning is *the display picks* had not yet been second-guessed. Auto is what
   * is true; the reading gains the resolution when there is one to gain.
   */
  it('says just Auto when nothing has been reported at all', () => {
    expect(describeQuality(DEFAULT_QUALITY, { reported: null, local: false })).toBe('Auto');
    expect(describeQuality(DEFAULT_QUALITY, { reported: null, local: true })).toBe('Auto · local');
  });
});

describe('the picker', () => {
  it('offers the reported levels, highest first, under an Auto entry', () => {
    const options = qualityOptions('set', [
      { height: 480, label: '480p' },
      { height: 1080, label: '1080p' },
    ]);
    expect(options.map((o) => o.value)).toEqual(['auto', '1080', '480']);
  });

  it('falls back to the standard ladder before any level has been reported', () => {
    expect(qualityOptions('set', []).length).toBe(QUALITY_LADDER.length + 1);
  });

  it('offers the bias values, not a ladder, where the provider cannot be told', () => {
    expect(qualityOptions('bias', []).map((o) => o.value)).toEqual(['auto', '720', '1080', '1440']);
  });

  it('round-trips through the select value', () => {
    const pinned = qualityFromOption('1080', DEFAULT_QUALITY);
    expect(pinned).toEqual({ mode: 'fixed', height: 1080 });
    expect(qualityOptionValue(pinned)).toBe('1080');
    expect(qualityOptionValue({ mode: 'auto', height: 1080 })).toBe('auto');
  });

  it('keeps the previous pin when switching back to Auto', () => {
    expect(qualityFromOption('auto', { mode: 'fixed', height: 1440 })).toEqual({
      mode: 'auto',
      height: 1440,
    });
  });

  it('ignores an unparseable option rather than un-pinning', () => {
    const previous = { mode: 'fixed', height: 1080 } as const;
    expect(qualityFromOption('banana', previous)).toEqual(previous);
  });
});

describe('clipSourceKey', () => {
  /**
   * Without this, the library lookup would keep finding the old file and the
   * quality change would appear to do nothing after one reload.
   */
  it('tags the key with a pinned height where the height is a real choice', () => {
    expect(clipSourceKey('https://x/v', { mode: 'fixed', height: 720 }, 'set')).toBe(
      'https://x/v#kh-q=720',
    );
  });

  it('leaves the key alone under Auto, so an existing download still matches', () => {
    expect(clipSourceKey('https://x/v', DEFAULT_QUALITY, 'set')).toBe('https://x/v');
  });

  it('never fragments the library for a provider with one resolution', () => {
    expect(clipSourceKey('https://x/v.mp4', { mode: 'fixed', height: 720 }, 'readonly')).toBe(
      'https://x/v.mp4',
    );
  });
});
