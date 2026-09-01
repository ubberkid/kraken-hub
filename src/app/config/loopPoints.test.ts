import { describe, expect, it } from 'vitest';

import { nextLoop } from './loopPoints';
import { LOOP_MAX_SEC } from './views/LoopScrubber';

import type { VideoModuleConfig } from '../../modules/video/types';

/**
 * Round 7's F1, as arithmetic: **nothing is written from a scale nobody
 * reported.**
 *
 * Round 2's R4 found `LOOP_MAX_SEC` printed as a duration — the remote's
 * scrubber read `0:00 / 60:00` for a video nobody had measured — and fixed the
 * READOUT. The number kept feeding the seek input's `max` and the handles'
 * range, so the invention simply moved: a tap two thirds along the bar reported
 * a playhead at forty minutes, and a drag on B persisted `loop.end = 2177`
 * into the synced document, where the display would honour it.
 *
 * A guard that lives in the component can only be checked by driving the
 * component, which is why it went unchecked through five rounds. It is one pure
 * function now, every gesture goes through it, and this calls it directly.
 */

const LOOP: VideoModuleConfig['loop'] = {
  enabled: false,
  start: 0,
  end: null,
  mode: 'hard',
  crossfadeMs: 0,
};

const SCALED = { start: 0, end: 120, max: 120, durationKnown: true };
const UNSCALED = { start: 0, end: LOOP_MAX_SEC, max: LOOP_MAX_SEC, durationKnown: false };

describe('nextLoop', () => {
  it('writes a loop point against a duration somebody reported', () => {
    expect(nextLoop(LOOP, 'b', 90, SCALED)).toEqual({ ...LOOP, enabled: true, end: 90 });
    expect(nextLoop(LOOP, 'a', 12, SCALED)).toEqual({ ...LOOP, enabled: true, start: 12 });
  });

  /** The bug, in one line: 2177 seconds of an hour nobody measured. */
  it('writes NOTHING against the fallback rail length', () => {
    expect(nextLoop(LOOP, 'b', 2177, UNSCALED)).toBeNull();
    expect(nextLoop(LOOP, 'a', 2177, UNSCALED)).toBeNull();
  });

  /**
   * A reported duration of zero is an absent one.
   *
   * `durationSec > 0` is what both callers test before setting `durationKnown`,
   * and this is the same rule where it cannot be skipped: a rail of length zero
   * has no scale either, and dividing by it is how a percentage becomes `NaN%`.
   */
  it('refuses a zero-length timeline even when it is called known', () => {
    expect(nextLoop(LOOP, 'b', 10, { start: 0, end: 0, max: 0, durationKnown: true })).toBeNull();
  });

  /**
   * Moving a handle turns the loop on — but only where it moved something.
   *
   * The `enabled: true` side effect is the whole reason the guard has to be
   * inside this function rather than at the call site: a refused drag that still
   * flipped the toggle would enable a loop with invented bounds, which is the
   * original bug with one field removed.
   */
  it('never enables a loop it did not set a point for', () => {
    expect(nextLoop({ ...LOOP, enabled: false }, 'b', 500, UNSCALED)).toBeNull();
    expect(nextLoop({ ...LOOP, enabled: false }, 'b', 60, SCALED)?.enabled).toBe(true);
  });

  it('keeps A before B and B after A, on a real scale', () => {
    const withEnd = { ...LOOP, end: 60 };
    // A cannot pass B…
    expect(nextLoop(withEnd, 'a', 90, { ...SCALED, end: 60 })?.start).toBe(60);
    // …and B cannot fall behind A, nor run past the reported duration.
    expect(nextLoop(withEnd, 'b', 10, { ...SCALED, start: 30 })?.end).toBe(30);
    expect(nextLoop(withEnd, 'b', 9_999, SCALED)?.end).toBe(120);
  });
});
