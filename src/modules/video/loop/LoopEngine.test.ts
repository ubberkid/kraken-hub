import { describe, expect, it } from 'vitest';

import { DEFAULT_LOOP, LOOP_DEFAULTS } from '../types';

import {
  SilentSeekPromoter,
  clampCrossfadeMs,
  computeLookahead,
  crossfadeAllowed,
  crossingDelayMs,
  effectiveEnd,
  implicitLoop,
  isDurationKnown,
  isPrimed,
  loopPendingExpired,
  predictHtmlCrossing,
  predictPolledCrossing,
  remainingSec,
  shouldScheduleTimer,
  validateLoop,
} from './LoopEngine';

import type { LoopConfig } from '../types';

function loop(over: Partial<LoopConfig> = {}): LoopConfig {
  return { ...DEFAULT_LOOP, enabled: true, ...over };
}

describe('LOOP_DEFAULTS', () => {
  it('matches §3.1', () => {
    expect(LOOP_DEFAULTS).toEqual({ minSpanSec: 0.25, endGuardSec: 1, epsSec: 0.02 });
  });
});

describe('§3.2 validation', () => {
  it('clamps a negative start to 0', () => {
    expect(validateLoop(loop({ start: -5, end: 10 }), 60).start).toBe(0);
  });

  it('resolves a null end to duration - endGuardSec', () => {
    const v = validateLoop(loop({ start: 2, end: null }), 60);
    expect(v.status).toBe('active');
    expect(v.end).toBe(59);
  });

  it('never lets the end reach duration', () => {
    const v = validateLoop(loop({ start: 0, end: 60 }), 60);
    expect(v.end).toBe(59);
  });

  it('clamps start so the span is at least minSpanSec', () => {
    const v = validateLoop(loop({ start: 59, end: null }), 60);
    expect(v.start).toBeCloseTo(58.75, 6);
    expect(v.status).toBe('active');
  });

  it('widens a too-short span backwards rather than dropping it (step 3 before step 4)', () => {
    const v = validateLoop(loop({ start: 10, end: 10.1 }), 60);
    expect(v.status).toBe('active');
    expect(v.start).toBeCloseTo(9.85, 6);
    expect(v.end).toBeCloseTo(10.1, 6);
  });

  it('disables — never errors — when no span of 0.25 s exists at all', () => {
    // duration 1 s, end guard 1 s: the only legal end is 0, so there is nowhere
    // for a 0.25 s span to live.
    const v = validateLoop(loop({ start: 0, end: null }), 1);
    expect(v.status).toBe('disabled');
    expect(v.issue).toBe('loop-span-too-short');
    expect(v.notes).toContain('loop-span-too-short');
  });

  it('resets a start past the duration and says so', () => {
    const v = validateLoop(loop({ start: 500, end: null }), 60);
    expect(v.notes).toContain('loop-start-past-duration');
    expect(v.start).toBe(0);
    expect(v.status).toBe('active');
  });

  it('is disabled when the config says so', () => {
    const v = validateLoop(loop({ enabled: false, start: 1, end: 5 }), 60);
    expect(v.status).toBe('disabled');
    expect(v.issue).toBeNull();
  });

  it('honours custom guards', () => {
    const v = validateLoop(loop({ start: 0, end: null }), 60, { endGuardSec: 5 });
    expect(v.end).toBe(55);
  });
});

describe('§3.2 PENDING semantics when the duration is unknown', () => {
  it.each([Number.NaN, 0, Number.POSITIVE_INFINITY, -1])('duration %s stays pending', (d) => {
    const v = validateLoop(loop({ start: 3, end: 9 }), d);
    expect(v.status).toBe('pending');
    expect(Number.isNaN(v.end)).toBe(true);
    expect(v.issue).toBeNull();
    expect(v.start).toBe(3);
  });

  it('resolves once a duration arrives', () => {
    expect(validateLoop(loop({ start: 3, end: 9 }), Number.NaN).status).toBe('pending');
    expect(validateLoop(loop({ start: 3, end: 9 }), 60).status).toBe('active');
  });

  it('gives up after 10 s of no duration', () => {
    expect(loopPendingExpired(1000, 1000 + 9999)).toBe(false);
    expect(loopPendingExpired(1000, 1000 + 10_000)).toBe(true);
  });

  it('knows what a usable duration is', () => {
    expect(isDurationKnown(12)).toBe(true);
    expect(isDurationKnown(0)).toBe(false);
    expect(isDurationKnown(Number.NaN)).toBe(false);
    expect(isDurationKnown(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('§3.2 live sources never loop', () => {
  it('disables the loop and says why, whatever the config says', () => {
    const v = validateLoop(loop({ start: 1, end: 20 }), 3600, { isLive: true });
    expect(v.status).toBe('disabled');
    expect(v.issue).toBe('loop-unavailable-live');
  });
});

describe('end guard and the implicit loop (§2.6)', () => {
  it('never returns an end at or past the duration', () => {
    expect(effectiveEnd(60, null, 1)).toBe(59);
    expect(effectiveEnd(60, 100, 1)).toBe(59);
    expect(effectiveEnd(60, 30, 1)).toBe(30);
  });

  it('installs [0.05, duration - 1] when nothing is configured', () => {
    expect(implicitLoop(60)).toEqual({ start: 0.05, end: 59 });
  });
});

describe('§3.3 rAF-predictive crossing', () => {
  const base = { rate: 1, end: 10, seeking: false };

  it('fires one tick early rather than overshooting', () => {
    expect(predictHtmlCrossing({ ...base, currentTime: 9.97, dtSec: 1 / 60 })).toBe(true);
    expect(predictHtmlCrossing({ ...base, currentTime: 9.9, dtSec: 1 / 60 })).toBe(false);
  });

  it('uses at least one 60 Hz frame of lookahead even when dt is tiny', () => {
    expect(predictHtmlCrossing({ ...base, currentTime: 9.985, dtSec: 0 })).toBe(true);
  });

  it('scales the step by the playback rate', () => {
    expect(predictHtmlCrossing({ ...base, currentTime: 9.7, rate: 4, dtSec: 0.1 })).toBe(true);
    expect(predictHtmlCrossing({ ...base, currentTime: 9.7, rate: 0.25, dtSec: 0.1 })).toBe(false);
  });

  it('never fires while a seek is in flight — that is how seek storms start', () => {
    expect(predictHtmlCrossing({ ...base, currentTime: 9.99, dtSec: 1, seeking: true })).toBe(
      false,
    );
  });

  it('honours the epsilon', () => {
    expect(predictHtmlCrossing({ ...base, currentTime: 9.97, dtSec: 0, epsSec: 0.02 })).toBe(true);
    expect(predictHtmlCrossing({ ...base, currentTime: 9.97, dtSec: 0, epsSec: 0 })).toBe(false);
  });
});

describe('§3.4 polled crossing', () => {
  it('uses max(0.08, 2 x poll interval)', () => {
    expect(computeLookahead(0.016)).toBeCloseTo(0.08, 6);
    expect(computeLookahead(0.1)).toBeCloseTo(0.2, 6);
  });

  it('fires when the remaining time falls inside the lookahead', () => {
    expect(predictPolledCrossing({ currentTime: 9.95, rate: 1, end: 10, lookaheadSec: 0.08 })).toBe(
      true,
    );
    expect(predictPolledCrossing({ currentTime: 9.5, rate: 1, end: 10, lookaheadSec: 0.08 })).toBe(
      false,
    );
  });

  it('accounts for the rate', () => {
    expect(predictPolledCrossing({ currentTime: 9.5, rate: 8, end: 10, lookaheadSec: 0.08 })).toBe(
      true,
    );
  });

  it('schedules a sub-poll timer only inside the last 0.35 s', () => {
    expect(shouldScheduleTimer(remainingSec(9.8, 10, 1))).toBe(true);
    expect(shouldScheduleTimer(remainingSec(9.0, 10, 1))).toBe(false);
    expect(shouldScheduleTimer(remainingSec(10.5, 10, 1))).toBe(false);
    expect(crossingDelayMs(9.8, 10, 1)).toBeCloseTo(200, 6);
    expect(crossingDelayMs(11, 10, 1)).toBe(0);
  });
});

describe('§3.4 buffer priming', () => {
  it('is primed once the loop span is buffered', () => {
    expect(isPrimed({ loadedFraction: 0.5, duration: 100, end: 40, crossings: 0 })).toBe(true);
    expect(isPrimed({ loadedFraction: 0.2, duration: 100, end: 40, crossings: 0 })).toBe(false);
  });

  it('is primed after the first crossing regardless', () => {
    expect(isPrimed({ loadedFraction: 0, duration: 100, end: 40, crossings: 1 })).toBe(true);
  });

  it('is never primed while the duration is unknown', () => {
    expect(isPrimed({ loadedFraction: 1, duration: Number.NaN, end: 40, crossings: 0 })).toBe(
      false,
    );
  });
});

describe('§3.4 adaptive canSeekSilently', () => {
  it('promotes after three consecutive clean crossings', () => {
    const p = new SilentSeekPromoter();
    expect(p.record(false)).toBe(false);
    expect(p.record(false)).toBe(false);
    expect(p.record(false)).toBe(true);
    expect(p.canSeekSilently).toBe(true);
  });

  it('demotes on a single buffering crossing', () => {
    const p = new SilentSeekPromoter();
    p.record(false);
    p.record(false);
    p.record(false);
    expect(p.record(true)).toBe(false);
    expect(p.cleanCrossings).toBe(0);
  });

  it('resets', () => {
    const p = new SilentSeekPromoter();
    p.record(false);
    p.reset();
    expect(p.cleanCrossings).toBe(0);
    expect(p.canSeekSilently).toBe(false);
  });
});

describe('§3.6 crossfade', () => {
  it('clamps to 60..1000 ms', () => {
    expect(clampCrossfadeMs(10)).toBe(60);
    expect(clampCrossfadeMs(5000)).toBe(1000);
    expect(clampCrossfadeMs(250)).toBe(250);
  });

  it('is only available to file-based providers in quality mode at a usable FPS', () => {
    const base = { mode: 'crossfade', perf: 'quality', targetFps: 40 } as const;
    expect(crossfadeAllowed({ ...base, provider: 'local-file' })).toBe(true);
    expect(crossfadeAllowed({ ...base, provider: 'direct-file' })).toBe(true);
    expect(crossfadeAllowed({ ...base, provider: 'resolver' })).toBe(true);
    expect(crossfadeAllowed({ ...base, provider: 'youtube-embed' })).toBe(false);
    expect(crossfadeAllowed({ ...base, provider: 'local-file', perf: 'performance' })).toBe(false);
    expect(crossfadeAllowed({ ...base, provider: 'local-file', targetFps: 10 })).toBe(false);
    expect(crossfadeAllowed({ ...base, provider: 'local-file', mode: 'hard' })).toBe(false);
  });
});
