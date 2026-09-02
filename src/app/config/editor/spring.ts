/**
 * One spring curve, driven by the frame clock — principle 11, "buttery".
 *
 * Two rules, and they are the whole file:
 *
 *  1. **One curve.** Every settle in the editor uses the same stiffness and
 *     damping, so a released drag, a released rotate and a released scale all
 *     feel like the same object. A second curve somewhere else is how an
 *     interface starts feeling assembled rather than designed.
 *  2. **Never React per frame** (invariant I4). A spring produces a value per
 *     tick; `onFrame` is handed that value and writes it straight to the DOM —
 *     one `style.transform` on the host — and React hears about the settle
 *     exactly once, when it is over.
 *
 * `prefers-reduced-motion` is honoured by construction: `settle()` with
 * `reduced: true` jumps to the target and calls `onDone` on the next tick. It
 * does not merely shorten the animation, because a shortened spring is still
 * motion, and the setting is a request for none.
 *
 * Pure enough to test: the integrator is a plain function of state and dt, and
 * the clock is injected.
 */

import type { FrameClock } from '../../../platform/fpsGovernor';

/**
 * Critically-ish damped: `zeta ≈ 0.9`, settling in ~250 ms at 40 fps.
 *
 * Slightly under 1 on purpose — a hair of overshoot is what reads as "sprung"
 * rather than "eased", and at this stiffness the overshoot is under a pixel on
 * a 400 px halo, so it is felt and not seen.
 */
export const SPRING_STIFFNESS = 220;
export const SPRING_DAMPING = 26;
/** Below this distance AND this speed, the spring is done. Units, per second. */
export const SPRING_EPSILON = 0.0005;
/** A frame longer than this is a stall, not a frame; integrating it explodes. */
const MAX_STEP_MS = 64;

export interface SpringState {
  value: number;
  velocity: number;
}

/** One integration step. Exported so the settle can be tested without a clock. */
export function stepSpring(state: SpringState, target: number, dtMs: number): SpringState {
  const dt = Math.min(dtMs, MAX_STEP_MS) / 1000;
  const displacement = state.value - target;
  const acceleration = -SPRING_STIFFNESS * displacement - SPRING_DAMPING * state.velocity;
  const velocity = state.velocity + acceleration * dt;
  return { value: state.value + velocity * dt, velocity };
}

export function springAtRest(state: SpringState, target: number): boolean {
  return (
    Math.abs(state.value - target) < SPRING_EPSILON && Math.abs(state.velocity) < SPRING_EPSILON
  );
}

export interface SettleOptions {
  clock: FrameClock;
  /** Where the value is now, and where it should end up. */
  from: number;
  to: number;
  /** Called every tick with the current value. Write to the DOM here. */
  onFrame: (value: number) => void;
  /** Called once, after the last `onFrame`. Commit to React here. */
  onDone?: () => void;
  /** `true` → land immediately. The setting asks for no motion, not less. */
  reduced?: boolean;
}

/**
 * Spring `from` to `to` on the frame clock. Returns a canceller.
 *
 * Cancelling does NOT snap to the target: a settle interrupted by a new gesture
 * should hand the object over where it is, or the second gesture starts with a
 * jump the finger did not ask for.
 */
export function settle(opts: SettleOptions): () => void {
  const { clock, from, to, onFrame, onDone, reduced = false } = opts;

  if (reduced || from === to) {
    onFrame(to);
    onDone?.();
    return () => undefined;
  }

  let state: SpringState = { value: from, velocity: 0 };
  let stopped = false;
  let last = 0;

  const off = clock.subscribe((f) => {
    if (stopped) return;
    const dt = last === 0 ? f.dt : f.t - last;
    last = f.t;
    state = stepSpring(state, to, dt);
    if (springAtRest(state, to)) {
      stopped = true;
      onFrame(to);
      off();
      onDone?.();
      return;
    }
    onFrame(state.value);
  });

  return () => {
    if (stopped) return;
    stopped = true;
    off();
  };
}

/** Does this window want motion at all? Read once per gesture, never cached. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
