import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetNamespace } from '../../../platform/storage';
import { QUALITY_FLOOR_PX_PERFORMANCE, YT_LADDER } from '../types';

import { WATCHDOG_ARM_MS } from './qualityPolicy';
import {
  NETWORK_LIMITED_WIDTH,
  clearLadderOverride,
  createQualityWatch,
  readLadderOverride,
  writeLadderOverride,
  type QualityWatchOptions,
} from './qualityWatch';

/**
 * §2.7 — the watchdog's *runtime*: when it is armed, what it counts, and what it
 * does with the one decision it is allowed to make. The decision function itself
 * is tested in `qualityPolicy.test.ts`; this file is about the wiring around it,
 * which is where the timing bugs live.
 */

class FakeClock {
  t = 0;
  now(): number {
    return this.t;
  }
}

interface Harness {
  watch: ReturnType<typeof createQualityWatch>;
  clock: FakeClock;
  steps: number[];
  telemetry: (string | null)[];
}

function setup(over: Partial<QualityWatchOptions> = {}): Harness {
  const clock = new FakeClock();
  const steps: number[] = [];
  const telemetry: (string | null)[] = [];
  const watch = createQualityWatch({
    initialWidth: 1920,
    perf: 'auto',
    ladder: YT_LADDER,
    getSignals: () => ({ loadedFraction: 0.9, duration: 300, currentTime: 10 }),
    onStep: (width) => steps.push(width),
    onTelemetry: (kind) => telemetry.push(kind),
    clock,
    ...over,
  });
  return { watch, clock, steps, telemetry };
}

beforeEach(() => {
  resetNamespace();
  clearLadderOverride();
});

describe('§2.7 arming', () => {
  it('does nothing at all before the first PLAYING', () => {
    const h = setup();
    h.watch.noteQuality('medium');
    h.clock.t = WATCHDOG_ARM_MS * 10;
    h.watch.tick();
    expect(h.steps).toEqual([]);
    expect(h.telemetry).toEqual([]);
  });

  it('waits the full 6 s after the first PLAYING before judging anything', () => {
    const h = setup();
    h.watch.notePlaying();
    h.watch.noteQuality('medium');

    h.clock.t = WATCHDOG_ARM_MS - 1;
    h.watch.tick();
    expect(h.steps).toEqual([]);

    h.clock.t = WATCHDOG_ARM_MS;
    h.watch.tick();
    expect(h.steps).toEqual([2560]);
  });

  it('arms on the FIRST playing only — a later one does not restart the clock', () => {
    const h = setup();
    h.watch.notePlaying();
    h.watch.noteQuality('medium');
    h.clock.t = WATCHDOG_ARM_MS - 100;
    h.watch.notePlaying();
    h.clock.t = WATCHDOG_ARM_MS + 1;
    h.watch.tick();
    expect(h.steps).toEqual([2560]);
  });
});

describe('§2.7 size-limited: step the ladder once', () => {
  it('steps 1920 → 2560 and remembers it for the session', () => {
    const h = setup();
    h.watch.notePlaying();
    h.watch.noteQuality('medium');
    h.clock.t = WATCHDOG_ARM_MS;
    h.watch.tick();

    expect(h.steps).toEqual([2560]);
    expect(h.watch.currentWidth()).toBe(2560);
    expect(readLadderOverride()).toBe(2560);
  });

  it('re-arms after the step, so the remounted player gets its own 6 s', () => {
    const h = setup();
    h.watch.notePlaying();
    h.watch.noteQuality('medium');
    h.clock.t = WATCHDOG_ARM_MS;
    h.watch.tick();

    // Without a fresh PLAYING nothing more happens, however long we wait.
    h.clock.t = WATCHDOG_ARM_MS * 10;
    h.watch.tick();
    expect(h.steps).toEqual([2560]);
  });

  it('stops escalating after one step and publishes quality-capped', () => {
    const h = setup();
    h.watch.notePlaying();
    h.watch.noteQuality('medium');
    h.clock.t = WATCHDOG_ARM_MS;
    h.watch.tick();

    // The remount happens, playback resumes, and the height is STILL low.
    h.watch.notePlaying();
    h.clock.t += WATCHDOG_ARM_MS;
    h.watch.tick();

    expect(h.steps).toEqual([2560]);
    expect(h.telemetry).toContain('quality-capped');
    expect(h.watch.sizeCapProven()).toBe(true);
  });

  it('publishes `quality` and stops watching once the served height is fine', () => {
    const h = setup();
    h.watch.notePlaying();
    h.watch.noteQuality('hd1080');
    h.clock.t = WATCHDOG_ARM_MS;
    h.watch.tick();
    expect(h.steps).toEqual([]);
    expect(h.telemetry).toEqual(['quality']);
    expect(h.watch.observedHeight()).toBe(1080);
  });
});

describe('§2.7 network-limited: never step up, step down under auto', () => {
  const starved = { loadedFraction: 0.01, duration: 300, currentTime: 10 };

  it('steps DOWN to the 1280 performance floor, not merely one rung', () => {
    const h = setup({ getSignals: () => starved });
    h.watch.notePlaying();
    h.watch.noteQuality('medium');
    h.clock.t = WATCHDOG_ARM_MS;
    h.watch.tick();

    expect(h.steps).toEqual([NETWORK_LIMITED_WIDTH]);
    expect(NETWORK_LIMITED_WIDTH).toBe(QUALITY_FLOOR_PX_PERFORMANCE);
    expect(h.telemetry).toContain('network-limited');
  });

  it('holds instead of stepping down when the user pinned quality mode', () => {
    const h = setup({ getSignals: () => starved, perf: 'quality' });
    h.watch.notePlaying();
    h.watch.noteQuality('medium');
    h.clock.t = WATCHDOG_ARM_MS;
    h.watch.tick();
    expect(h.steps).toEqual([]);
    expect(h.telemetry).toContain('network-limited');
  });

  it('counts repeated buffering inside the 30 s window as network pressure', () => {
    // Healthy buffer, so only the buffering counter can make this network-limited.
    const h = setup();
    h.watch.notePlaying();
    h.watch.noteQuality('medium');
    h.watch.noteBuffering();
    h.watch.noteBuffering();
    h.clock.t = WATCHDOG_ARM_MS;
    h.watch.tick();
    expect(h.steps).toEqual([NETWORK_LIMITED_WIDTH]);
  });

  it('forgets buffering events older than the 30 s window', () => {
    const h = setup();
    h.watch.noteBuffering();
    h.watch.noteBuffering();
    h.clock.t = 31_000;
    h.watch.notePlaying();
    h.watch.noteQuality('medium');
    h.clock.t += WATCHDOG_ARM_MS;
    h.watch.tick();
    // The stale buffering is gone, so this reads as size-limited again.
    expect(h.steps).toEqual([2560]);
  });
});

describe('§2.7 quality-unknown', () => {
  it('re-arms rather than deciding on no evidence, and does not spam telemetry', () => {
    const h = setup();
    h.watch.notePlaying();
    h.clock.t = WATCHDOG_ARM_MS;
    h.watch.tick();
    h.watch.tick();
    h.watch.tick();
    expect(h.telemetry).toEqual(['quality-unknown']);
    expect(h.steps).toEqual([]);

    // Another full window later it looks again — and now a label has arrived.
    h.watch.noteQuality('medium');
    h.clock.t += WATCHDOG_ARM_MS;
    h.watch.tick();
    expect(h.steps).toEqual([2560]);
  });
});

describe('§2.7 ladder persistence', () => {
  it('round-trips through the session store under the canonical prefix', () => {
    expect(readLadderOverride()).toBeNull();
    writeLadderOverride(2560);
    expect(readLadderOverride()).toBe(2560);
    clearLadderOverride();
    expect(readLadderOverride()).toBeNull();
  });

  it('rejects a value a fork or a future version may have written', () => {
    writeLadderOverride(999_999);
    expect(readLadderOverride()).toBeNull();
  });
});

describe('quality reporting', () => {
  it('forwards every label change with its height', () => {
    const onQuality = vi.fn();
    const h = setup({ onQuality });
    h.watch.noteQuality('hd720');
    h.watch.noteQuality('nonsense-label');
    expect(onQuality).toHaveBeenNthCalledWith(1, 720, 'hd720');
    // An unknown label reports `null` rather than guessing — and does not
    // overwrite the last height we actually understood.
    expect(onQuality).toHaveBeenNthCalledWith(2, null, 'nonsense-label');
    expect(h.watch.observedHeight()).toBe(720);
  });
});
