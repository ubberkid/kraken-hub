/**
 * One `requestAnimationFrame` loop for the entire page, gated to the panel's
 * `targetFps`.
 *
 * CAM captures and *compresses* every frame, so rendering faster than the
 * slider setting is pure waste — and at `targetFps = 1` (CAM's factory default)
 * an ungated rAF loop would burn a core to produce 59 discarded frames a second.
 *
 * Invariant I4: no React state update may originate inside a tick. The
 * `inFrame` flag below is what the DEV-only store guard reads to enforce it.
 */

import { createLogger } from '../lib/log';

const log = createLogger('platform/fps');

export interface FrameInfo {
  /** `performance.now()` at the tick. */
  t: number;
  /** ms since the previous delivered tick. */
  dt: number;
  frame: number;
  targetFps: number;
  budgetMs: number;
  achievedFps: number;
}

export interface FrameClockStats {
  achievedFps: number;
  longFrames: number;
  lastTickAt: number;
  paused: boolean;
  frame: number;
}

export interface FrameClock {
  subscribe(cb: (f: FrameInfo) => void): () => void;
  pause(reason: string): void;
  resume(reason: string): void;
  stats(): FrameClockStats;
  stop(): void;
}

let inFrame = false;

/** True while a `FrameClock` callback is executing (invariant I4 guard). */
export function isInFrame(): boolean {
  return inFrame;
}

const EMA_WINDOW_MS = 2000;
const MAX_CONSECUTIVE_THROWS = 3;

export function createFrameClock(getTargetFps: () => number): FrameClock {
  const subs = new Set<(f: FrameInfo) => void>();
  const throwCounts = new Map<(f: FrameInfo) => void, number>();

  let raf = 0;
  let paused = false;
  let frame = 0;
  let nextAt = 0;
  let lastTickAt = 0;
  let achievedFps = 0;
  let longFrames = 0;

  const tick = (now: number): void => {
    raf = requestAnimationFrame(tick);
    if (paused) return;

    const targetFps = Math.min(Math.max(Math.round(getTargetFps()), 1), 60);
    const interval = 1000 / targetFps;
    if (nextAt === 0) nextAt = now;
    if (now < nextAt) return;
    // Never catch up more than one interval: a stall must not produce a burst.
    nextAt = Math.max(nextAt + interval, now - interval);

    const dt = lastTickAt === 0 ? interval : now - lastTickAt;
    lastTickAt = now;
    frame += 1;

    const instant = dt > 0 ? 1000 / dt : targetFps;
    const alpha = Math.min(dt / EMA_WINDOW_MS, 1);
    achievedFps = achievedFps === 0 ? instant : achievedFps + alpha * (instant - achievedFps);

    const info: FrameInfo = { t: now, dt, frame, targetFps, budgetMs: interval, achievedFps };

    inFrame = true;
    const startedAt = performance.now();
    for (const cb of subs) {
      try {
        cb(info);
        throwCounts.set(cb, 0);
      } catch (err) {
        const count = (throwCounts.get(cb) ?? 0) + 1;
        throwCounts.set(cb, count);
        log.error(
          `frame subscriber threw (${String(count)}/${String(MAX_CONSECUTIVE_THROWS)})`,
          err,
        );
        if (count >= MAX_CONSECUTIVE_THROWS) {
          subs.delete(cb);
          log.error('frame subscriber unsubscribed after repeated throws');
        }
      }
    }
    inFrame = false;
    if (performance.now() - startedAt > interval) longFrames += 1;
  };

  raf = requestAnimationFrame(tick);

  return {
    subscribe(cb) {
      subs.add(cb);
      return () => {
        subs.delete(cb);
        throwCounts.delete(cb);
      };
    },
    pause(reason) {
      if (paused) return;
      paused = true;
      log.debug(`paused: ${reason}`);
    },
    resume(reason) {
      if (!paused) return;
      paused = false;
      nextAt = 0;
      lastTickAt = 0;
      log.debug(`resumed: ${reason}`);
    },
    stats() {
      return { achievedFps, longFrames, lastTickAt, paused, frame };
    },
    stop() {
      cancelAnimationFrame(raf);
      subs.clear();
      throwCounts.clear();
    },
  };
}
