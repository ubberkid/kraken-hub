/**
 * Writing a loop point — the one guard, in a file of its own.
 *
 * It lived inside `LoopScrubber` as a closure, which is exactly why round 2's
 * fix for the invented hour covered the READOUT and missed the writes: a rule
 * you can only reach by driving a component is a rule nobody unit-tests. It is
 * a pure function now (and it has to be a separate module anyway — Fast Refresh
 * requires a `.tsx` to export components and nothing else).
 */

import { clamp } from '../../lib/clamp';

import type { VideoModuleConfig } from '../../modules/video/types';

/**
 * The next loop, or `null` when there is no scale to write against — F1.
 *
 * The same narrowing the quality ring got: **without a known duration the
 * control does not degrade, it withdraws.** Every path that could persist a loop
 * point — a drag, a keystroke, a tap on a handle — goes through here, so
 * "nothing is written from the fallback scale" is one guard rather than three
 * call sites that each have to remember. `loopPoints.test.ts` pins that by
 * calling it directly, which is the only assertion that cannot be defeated by
 * adding a fourth caller.
 */
export function nextLoop(
  loop: VideoModuleConfig['loop'],
  which: 'a' | 'b',
  seconds: number,
  bounds: { start: number; end: number; max: number; durationKnown: boolean },
): VideoModuleConfig['loop'] | null {
  if (!bounds.durationKnown || bounds.max <= 0) return null;
  /*
   * Moving a handle turns the loop on.
   *
   * A user dragging A and B and seeing nothing happen because a separate toggle
   * is off is the kind of correct-but-useless behaviour disclosure is supposed
   * to prevent. The toggle below still exists to turn it back off.
   */
  return which === 'a'
    ? { ...loop, enabled: true, start: clamp(seconds, 0, bounds.end) }
    : { ...loop, enabled: true, end: clamp(seconds, bounds.start, bounds.max) };
}
