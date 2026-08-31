import { describe, expect, it } from 'vitest';

import {
  MAX_EXTRAPOLATION_SEC,
  POSITION_STALE_SEC,
  anchorPosition,
  samplePosition,
} from './position';

const NOW = 1_700_000_000_000;

describe('anchorPosition', () => {
  it('advances a playing sample by the elapsed wall time', () => {
    const anchored = anchorPosition({ posSec: 10, posAtTs: NOW - 3000, paused: false }, NOW);
    expect(anchored.posSec).toBeCloseTo(13);
    expect(anchored.stale).toBe(false);
  });

  it('does not advance a paused sample', () => {
    const anchored = anchorPosition({ posSec: 10, posAtTs: NOW - 60_000, paused: true }, NOW);
    expect(anchored.posSec).toBe(10);
  });

  it('clamps extrapolation, so a display waking from a long sleep cannot seek absurdly', () => {
    const anchored = anchorPosition({ posSec: 10, posAtTs: NOW - 3_600_000, paused: false }, NOW);
    expect(anchored.posSec).toBe(10 + MAX_EXTRAPOLATION_SEC);
    expect(anchored.stale).toBe(true);
    expect(anchored.staleSec).toBeCloseTo(3600);
  });

  it('treats negative clock skew as zero rather than seeking backwards', () => {
    // The phone's clock is two seconds ahead of the display's. Without this,
    // every message from it would nudge playback backwards.
    const anchored = anchorPosition({ posSec: 10, posAtTs: NOW + 2000, paused: false }, NOW);
    expect(anchored.posSec).toBe(10);
    expect(anchored.staleSec).toBe(0);
  });

  it('never exceeds a known duration', () => {
    const anchored = anchorPosition({ posSec: 58, posAtTs: NOW - 10_000, paused: false }, NOW, 60);
    expect(anchored.posSec).toBe(60);
  });

  it('scales the extrapolation by the sampled rate', () => {
    const half = anchorPosition({ posSec: 10, posAtTs: NOW - 4000, paused: false, rate: 0.5 }, NOW);
    expect(half.posSec).toBeCloseTo(12);
    const double = anchorPosition({ posSec: 10, posAtTs: NOW - 4000, paused: false, rate: 2 }, NOW);
    expect(double.posSec).toBeCloseTo(18);
  });

  it('treats an absent, zero or non-finite rate as 1× rather than as a stop', () => {
    for (const rate of [undefined, 0, -1, Number.NaN]) {
      const anchored = anchorPosition(
        { posSec: 10, posAtTs: NOW - 3000, paused: false, ...(rate === undefined ? {} : { rate }) },
        NOW,
      );
      expect(anchored.posSec).toBeCloseTo(13);
    }
  });

  it('flags a sample older than the staleness threshold', () => {
    const justInside = anchorPosition(
      { posSec: 0, posAtTs: NOW - (POSITION_STALE_SEC - 1) * 1000, paused: true },
      NOW,
    );
    const justOutside = anchorPosition(
      { posSec: 0, posAtTs: NOW - (POSITION_STALE_SEC + 1) * 1000, paused: true },
      NOW,
    );
    expect(justInside.stale).toBe(false);
    expect(justOutside.stale).toBe(true);
  });
});

describe('samplePosition', () => {
  it('always stamps the sample, so a bare position never travels', () => {
    const sample = samplePosition(12.5, false, NOW);
    expect(sample).toEqual({ posSec: 12.5, posAtTs: NOW, paused: false });
    expect(anchorPosition(sample, NOW).posSec).toBe(12.5);
  });
});
