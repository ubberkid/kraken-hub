/**
 * Reconnect backoff (design-architecture.md §5.4).
 *
 * mqtt.js is configured with `reconnectPeriod: 0` on purpose: we own the retry
 * schedule, because the retry schedule is also the failover trigger. A library
 * quietly reconnecting in the background would hide the exact signal ("three
 * consecutive failures inside a minute") that promotes ntfy into the network
 * slot.
 *
 * The jitter is not decoration. A public broker restarting reconnects every
 * kraken-hub display in the world at the same instant otherwise.
 */

const SEC = 1000;
export const BACKOFF_STEPS_MS: readonly number[] = [
  1 * SEC,
  2 * SEC,
  4 * SEC,
  8 * SEC,
  15 * SEC,
  30 * SEC,
  60 * SEC,
];

/** ±20 %. */
export const BACKOFF_JITTER = 0.2;

/** A connection that survives this long resets the ladder to its first rung. */
export const BACKOFF_STABLE_MS = 30_000;

export interface Backoff {
  /** Next delay in ms, with jitter applied, advancing the ladder. */
  next(): number;
  reset(): void;
  /** How many delays have been handed out since the last reset. */
  attempt(): number;
}

export function createBackoff(
  opts: { random?: () => number; steps?: readonly number[] } = {},
): Backoff {
  const random = opts.random ?? Math.random;
  const steps = opts.steps ?? BACKOFF_STEPS_MS;
  let index = 0;

  return {
    next() {
      const base = steps[Math.min(index, steps.length - 1)] ?? steps[steps.length - 1] ?? SEC;
      index += 1;
      const jitter = 1 + (random() * 2 - 1) * BACKOFF_JITTER;
      return Math.round(base * jitter);
    },
    reset() {
      index = 0;
    },
    attempt() {
      return index;
    },
  };
}
