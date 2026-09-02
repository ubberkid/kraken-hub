/**
 * A clock that only ever goes forward — the one a THROTTLE must be measured on.
 *
 * `Date.now()` is a wall clock, and a wall clock steps. NTP corrects it, a user
 * fixes their timezone-confused tablet, a Kraken with no RTC jumps the moment it
 * first reaches a time server. Every one of those can move it BACKWARDS.
 *
 * A throttle written as `Date.now() - lastRunAt` reads a negative elapsed after
 * such a step, and the two shapes that follow are both silent and both lethal:
 *
 *  - `if (elapsed >= THROTTLE)` is false, so the work is deferred;
 *  - `setTimeout(flush, THROTTLE - elapsed)` schedules it `|step|` in the
 *    FUTURE — an hour, for an hour-long step — and a `if (timer !== null) return`
 *    guard then swallows every request until it fires.
 *
 * Measured on the sync layer: a device whose clock stepped back an hour stopped
 * publishing state for an hour while still receiving, so the room split in two
 * with no outage, no error and no status change. The silence scaled linearly
 * with the size of the step.
 *
 * `performance.now()` is monotonic by specification and unaffected by wall-clock
 * changes, which is exactly the property a throttle needs — it never has to know
 * what time it is, only how long ago something happened. `Date.now()` is the
 * fallback for a host that has no `performance`, which is no browser this app
 * runs in but is cheap to be right about.
 */
export function monotonicNow(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  if (perf !== undefined && typeof perf.now === 'function') return perf.now();
  return Date.now();
}
