import { describe, expect, it } from 'vitest';

import {
  BUFFERING_ATTRIBUTION_MS,
  MIN_LOOKAHEAD_SEC,
  SILENT_SEEK_PROMOTION_CROSSINGS,
} from './LoopEngine';
import { CROSSING_TIMEOUT_MS, createPolledLoop, type PolledScheduler } from './PolledLoop';

/**
 * §3.4 — the polled loop's crossing math, on a fake clock and a fake player.
 *
 * The player here is a plain object whose clock only moves when the test moves
 * it, which is the only way to assert things like "the seam fires one lookahead
 * early" and "three clean crossings promote, one dirty one demotes" without
 * waiting on real time or a real network.
 */

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

class FakeSched implements PolledScheduler {
  t = 0;
  private next = 1;
  timers: Timer[] = [];
  rafPending: (() => void) | null = null;

  now(): number {
    return this.t;
  }

  raf(cb: () => void): number {
    this.rafPending = cb;
    return this.next++;
  }

  cancelRaf(): void {
    this.rafPending = null;
  }

  setTimer(fn: () => void, ms: number): never {
    const id = this.next++;
    this.timers.push({ id, at: this.t + ms, fn });
    return id as never;
  }

  clearTimer(handle: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== (handle as number));
  }

  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers
        .filter((x) => x.at <= target)
        .sort((a, b) => a.at - b.at)
        .at(0);
      if (due === undefined) break;
      this.timers = this.timers.filter((x) => x.id !== due.id);
      this.t = due.at;
      due.fn();
    }
    this.t = target;
  }
}

interface Harness {
  loop: ReturnType<typeof createPolledLoop>;
  sched: FakeSched;
  player: { t: number; rate: number; duration: number; loaded: number };
  seeks: { t: number; silentExpected: boolean }[];
  starts: boolean[];
  settled: boolean[];
  silentChanges: boolean[];
}

function setup(over: { loaded?: number; duration?: number } = {}): Harness {
  const sched = new FakeSched();
  const player = { t: 0, rate: 1, duration: over.duration ?? 100, loaded: over.loaded ?? 0 };
  const seeks: { t: number; silentExpected: boolean }[] = [];
  const starts: boolean[] = [];
  const settled: boolean[] = [];
  const silentChanges: boolean[] = [];

  const loop = createPolledLoop({
    scheduler: sched,
    host: {
      getCurrentTime: () => player.t,
      getRate: () => player.rate,
      getDuration: () => player.duration,
      getLoadedFraction: () => player.loaded,
      seek: (t, silentExpected) => {
        seeks.push({ t, silentExpected });
        player.t = t;
      },
    },
    onCrossingStart: (silentExpected) => starts.push(silentExpected),
    onCrossingSettled: (silent) => settled.push(silent),
    onSilentSeekChange: (v) => silentChanges.push(v),
  });
  return { loop, sched, player, seeks, starts, settled, silentChanges };
}

/** One full crossing: predict, seek, land past `start + 0.05`, settle. */
function cross(h: Harness, landAt: number, buffering = false): void {
  h.player.t = 9.99;
  h.loop.poll();
  if (buffering) h.loop.noteBuffering();
  h.player.t = landAt;
  h.loop.poll();
}

describe('§3.4 lookahead', () => {
  it('crosses one lookahead EARLY, not at t >= end', () => {
    const h = setup();
    h.loop.setSpan(2, 10);

    // 0.10 s of span left: further out than the 0.08 s lookahead.
    h.player.t = 9.9;
    h.loop.poll();
    expect(h.seeks).toHaveLength(0);
    expect(MIN_LOOKAHEAD_SEC).toBe(0.08);

    // 0.07 s left: inside it. The seam fires here, not at t >= 10.
    h.player.t = 9.93;
    h.loop.poll();
    expect(h.seeks).toEqual([{ t: 2, silentExpected: false }]);
  });

  it('scales the lookahead with the poll interval', () => {
    const sched = new FakeSched();
    const player = { t: 0 };
    const seeks: number[] = [];
    const loop = createPolledLoop({
      scheduler: sched,
      pollIntervalSec: 0.1, // a 10 Hz poll => 0.2 s lookahead
      host: {
        getCurrentTime: () => player.t,
        getRate: () => 1,
        getDuration: () => 100,
        getLoadedFraction: () => 0,
        seek: (t) => {
          seeks.push(t);
          player.t = t;
        },
      },
    });
    loop.setSpan(0, 10);
    // 0.25 s left is outside a 0.2 s lookahead but well inside where a 0.08 s
    // one would already have fired — this is the difference the poll rate makes.
    player.t = 9.75;
    loop.poll();
    expect(seeks).toHaveLength(0);
    player.t = 9.85;
    loop.poll();
    expect(seeks).toEqual([0]);
  });

  it('honours the playback rate: a 2x rate crosses twice as early', () => {
    const h = setup();
    h.loop.setSpan(0, 10);
    h.player.rate = 2;
    // 0.14 s of span left, but at 2x that is 0.07 s of wall time — inside the
    // lookahead, where at 1x the same position would not have crossed yet.
    h.player.t = 9.86;
    h.loop.poll();
    expect(h.seeks).toHaveLength(1);

    const slow = setup();
    slow.loop.setSpan(0, 10);
    slow.player.t = 9.86;
    slow.loop.poll();
    expect(slow.seeks).toHaveLength(0);
  });
});

describe('§3.4 sub-poll precision', () => {
  it('schedules a timer at the predicted instant when inside 0.35 s', () => {
    const h = setup();
    h.loop.setSpan(0, 10);
    h.loop.start();

    h.player.t = 9.8; // 0.2 s out — inside the sub-poll window, past no lookahead
    h.loop.poll();
    expect(h.seeks).toHaveLength(0);
    expect(h.sched.timers).toHaveLength(1);

    // The timer fires at the crossing instant even if no poll runs in between,
    // which is the whole point on a display clocked at 1 FPS.
    h.sched.advance(200);
    expect(h.seeks).toEqual([{ t: 0, silentExpected: false }]);
  });

  it('does not stack timers across polls', () => {
    const h = setup();
    h.loop.setSpan(0, 10);
    h.loop.start();
    h.player.t = 9.8;
    h.loop.poll();
    h.loop.poll();
    h.loop.poll();
    expect(h.sched.timers).toHaveLength(1);
  });
});

describe('§3.4 crossing flow', () => {
  it('counts a crossing and settles once the clock is past start + 0.05', () => {
    const h = setup();
    h.loop.setSpan(2, 10);

    h.player.t = 9.99;
    h.loop.poll();
    expect(h.loop.crossings()).toBe(1);
    expect(h.starts).toEqual([false]);
    expect(h.settled).toEqual([]);

    // Still landing: nothing settles, and no second crossing is counted.
    h.player.t = 2.0;
    h.loop.poll();
    expect(h.settled).toEqual([]);
    expect(h.loop.crossings()).toBe(1);

    h.player.t = 2.06;
    h.loop.poll();
    expect(h.settled).toEqual([false]);
  });

  it('force-settles a crossing the player silently dropped, and counts it dirty', () => {
    const h = setup();
    h.loop.setSpan(2, 10);
    h.player.t = 9.99;
    h.loop.poll();

    h.player.t = 9.99; // the seek did nothing
    h.sched.t += CROSSING_TIMEOUT_MS + 1;
    h.loop.poll();
    expect(h.settled).toEqual([false]);
    expect(h.loop.canSeekSilently()).toBe(false);
  });
});

describe('§3.4 buffer priming', () => {
  it('is not primed before the first crossing when the span is not buffered', () => {
    const h = setup({ loaded: 0.05, duration: 100 });
    h.loop.setSpan(2, 10);
    expect(h.loop.primed()).toBe(false);
  });

  it('is primed when the loaded fraction already covers the span end', () => {
    const h = setup({ loaded: 0.5, duration: 100 });
    h.loop.setSpan(2, 10);
    expect(h.loop.primed()).toBe(true);
  });

  it('is primed after one crossing regardless of the loaded fraction', () => {
    const h = setup({ loaded: 0 });
    h.loop.setSpan(2, 10);
    cross(h, 2.06);
    expect(h.loop.primed()).toBe(true);
  });
});

describe('§3.4 adaptive canSeekSilently', () => {
  it('promotes after three clean crossings and publishes the observed value', () => {
    const h = setup({ loaded: 1 });
    h.loop.setSpan(2, 10);

    for (let i = 0; i < SILENT_SEEK_PROMOTION_CROSSINGS; i++) {
      expect(h.loop.canSeekSilently()).toBe(false);
      cross(h, 2.06);
    }
    expect(h.loop.canSeekSilently()).toBe(true);
    expect(h.silentChanges).toEqual([true]);

    // The next crossing is now told to expect silence, which is what lets the
    // mask be a 100 ms flash rather than a wait for PLAYING.
    cross(h, 2.06);
    expect(h.starts.at(-1)).toBe(true);
  });

  it('demotes on a single crossing that buffered', () => {
    const h = setup({ loaded: 1 });
    h.loop.setSpan(2, 10);
    for (let i = 0; i < SILENT_SEEK_PROMOTION_CROSSINGS; i++) cross(h, 2.06);
    expect(h.loop.canSeekSilently()).toBe(true);

    cross(h, 2.06, true);
    expect(h.loop.canSeekSilently()).toBe(false);
    expect(h.silentChanges).toEqual([true, false]);
  });

  it('attributes a BUFFERING within 600 ms AFTER a crossing to that crossing', () => {
    const h = setup({ loaded: 1 });
    h.loop.setSpan(2, 10);
    for (let i = 0; i < SILENT_SEEK_PROMOTION_CROSSINGS; i++) cross(h, 2.06);

    // A crossing that settles, then buffers a moment later: still that seam.
    h.player.t = 9.99;
    h.loop.poll();
    h.player.t = 2.06;
    h.loop.poll();
    h.sched.t += BUFFERING_ATTRIBUTION_MS - 1;
    h.loop.noteBuffering();
    // The NEXT crossing carries the dirt forward — the promoter demotes on it.
    cross(h, 2.06, true);
    expect(h.loop.canSeekSilently()).toBe(false);
  });

  it('resets everything learned when the span changes', () => {
    const h = setup({ loaded: 1 });
    h.loop.setSpan(2, 10);
    for (let i = 0; i < SILENT_SEEK_PROMOTION_CROSSINGS; i++) cross(h, 2.06);
    expect(h.loop.canSeekSilently()).toBe(true);

    // A new span is a new buffered region: nothing observed about the old seam
    // predicts the new one.
    h.loop.setSpan(40, 50);
    expect(h.loop.canSeekSilently()).toBe(false);
    expect(h.loop.crossings()).toBe(0);
  });
});

describe('§3.4 lifecycle', () => {
  it('does nothing while disabled', () => {
    const h = setup();
    h.loop.setSpan(2, 10);
    h.loop.disable();
    h.player.t = 9.99;
    h.loop.poll();
    expect(h.seeks).toHaveLength(0);
    expect(h.loop.isActive()).toBe(false);
  });

  it('treats a NaN end as disabled', () => {
    const h = setup();
    h.loop.setSpan(2, Number.NaN);
    expect(h.loop.isActive()).toBe(false);
    h.player.t = 999;
    h.loop.poll();
    expect(h.seeks).toHaveLength(0);
  });

  it('stops the rAF chain and cancels a pending sub-poll timer', () => {
    const h = setup();
    h.loop.setSpan(0, 10);
    h.loop.start();
    h.player.t = 9.8;
    h.loop.poll();
    expect(h.sched.timers).toHaveLength(1);

    h.loop.stop();
    expect(h.sched.timers).toHaveLength(0);
    expect(h.sched.rafPending).toBeNull();
  });
});
