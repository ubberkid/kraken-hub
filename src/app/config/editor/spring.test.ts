import { describe, expect, it, vi } from 'vitest';

import { SPRING_EPSILON, settle, springAtRest, stepSpring, type SpringState } from './spring';

import type { FrameClock, FrameInfo } from '../../../platform/fpsGovernor';

/** A clock the test drives by hand, so a settle is deterministic. */
function manualClock(): { clock: FrameClock; tick: (dtMs?: number) => void; subs: number } {
  const subs = new Set<(f: FrameInfo) => void>();
  let t = 0;
  let frame = 0;
  const handle = {
    clock: {
      subscribe(cb: (f: FrameInfo) => void) {
        subs.add(cb);
        return () => {
          subs.delete(cb);
        };
      },
      pause: () => undefined,
      resume: () => undefined,
      stats: () => ({ achievedFps: 40, longFrames: 0, lastTickAt: t, paused: false, frame }),
      stop: () => undefined,
    } satisfies FrameClock,
    tick(dtMs = 25) {
      t += dtMs;
      frame += 1;
      for (const cb of [...subs]) {
        cb({ t, dt: dtMs, frame, targetFps: 40, budgetMs: 25, achievedFps: 40 });
      }
    },
    get subs() {
      return subs.size;
    },
  };
  return handle;
}

describe('the spring', () => {
  it('converges on its target', () => {
    let state: SpringState = { value: 0, velocity: 0 };
    for (let i = 0; i < 200 && !springAtRest(state, 1); i++) state = stepSpring(state, 1, 25);
    expect(springAtRest(state, 1)).toBe(true);
    expect(state.value).toBeCloseTo(1, 3);
  });

  /**
   * A frame that took a second is a stall, not a frame.
   *
   * Integrating one at face value multiplies the displacement by an enormous dt
   * and throws the object across the panel — which is exactly what a tab
   * returning from the background hands a naive integrator.
   */
  it('does not explode on a stalled frame', () => {
    const after = stepSpring({ value: 0, velocity: 0 }, 1, 5000);
    expect(Number.isFinite(after.value)).toBe(true);
    expect(Math.abs(after.value)).toBeLessThan(2);
  });

  it('settles on the clock and reports once at the end', () => {
    const { clock, tick } = manualClock();
    const frames: number[] = [];
    const done = vi.fn();
    settle({ clock, from: 0, to: 1, onFrame: (v) => frames.push(v), onDone: done });

    for (let i = 0; i < 200 && done.mock.calls.length === 0; i++) tick();

    expect(done).toHaveBeenCalledTimes(1);
    // Many frames, one commit — invariant I4 in one assertion.
    expect(frames.length).toBeGreaterThan(5);
    expect(frames.at(-1)).toBe(1);
  });

  it('unsubscribes from the clock when it lands', () => {
    const handle = manualClock();
    settle({ clock: handle.clock, from: 0, to: 1, onFrame: () => undefined });
    for (let i = 0; i < 200; i++) handle.tick();
    expect(handle.subs).toBe(0);
  });

  /** Reduced motion asks for NO motion, not less of it. */
  it('lands immediately under reduced motion, with no ticks at all', () => {
    const handle = manualClock();
    const frames: number[] = [];
    const done = vi.fn();
    settle({
      clock: handle.clock,
      from: 0,
      to: 1,
      reduced: true,
      onFrame: (v) => frames.push(v),
      onDone: done,
    });
    expect(frames).toEqual([1]);
    expect(done).toHaveBeenCalledTimes(1);
    expect(handle.subs).toBe(0);
  });

  /**
   * Cancelling hands the object over where it IS.
   *
   * Snapping to the target on cancel would make a second gesture begin with a
   * jump the finger never asked for.
   */
  it('stops without snapping when cancelled', () => {
    const handle = manualClock();
    const frames: number[] = [];
    const done = vi.fn();
    const cancel = settle({
      clock: handle.clock,
      from: 0,
      to: 1,
      onFrame: (v) => frames.push(v),
      onDone: done,
    });
    handle.tick();
    handle.tick();
    const mid = frames.at(-1) ?? 0;
    cancel();
    handle.tick();

    expect(frames.at(-1)).toBe(mid);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(done).not.toHaveBeenCalled();
    expect(handle.subs).toBe(0);
  });

  it('treats a zero-length settle as already done', () => {
    const handle = manualClock();
    const done = vi.fn();
    settle({ clock: handle.clock, from: 0.5, to: 0.5, onFrame: () => undefined, onDone: done });
    expect(done).toHaveBeenCalledTimes(1);
    expect(SPRING_EPSILON).toBeGreaterThan(0);
  });
});
