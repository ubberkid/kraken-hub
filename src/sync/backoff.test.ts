import { describe, expect, it } from 'vitest';

import { BACKOFF_JITTER, BACKOFF_STEPS_MS, createBackoff } from './backoff';

describe('createBackoff', () => {
  it('walks the ladder and holds at the top', () => {
    // random() === 0.5 means no jitter, so the ladder is readable.
    const b = createBackoff({ random: () => 0.5 });
    const seen = BACKOFF_STEPS_MS.map(() => b.next());
    expect(seen).toEqual([...BACKOFF_STEPS_MS]);
    expect(b.next()).toBe(BACKOFF_STEPS_MS[BACKOFF_STEPS_MS.length - 1]);
    expect(b.next()).toBe(BACKOFF_STEPS_MS[BACKOFF_STEPS_MS.length - 1]);
  });

  it('applies at most ±20 % jitter', () => {
    const low = createBackoff({ random: () => 0 });
    const high = createBackoff({ random: () => 1 });
    const first = BACKOFF_STEPS_MS[0] ?? 0;
    expect(low.next()).toBe(Math.round(first * (1 - BACKOFF_JITTER)));
    expect(high.next()).toBe(Math.round(first * (1 + BACKOFF_JITTER)));
  });

  it('jitters, so a broker restart does not reconnect every display at once', () => {
    const b = createBackoff({ steps: [1000] });
    const delays = new Set(Array.from({ length: 20 }, () => b.next()));
    expect(delays.size).toBeGreaterThan(1);
  });

  it('resets to the first rung after a stable connection', () => {
    const b = createBackoff({ random: () => 0.5 });
    b.next();
    b.next();
    expect(b.attempt()).toBe(2);
    b.reset();
    expect(b.attempt()).toBe(0);
    expect(b.next()).toBe(BACKOFF_STEPS_MS[0]);
  });
});
