/**
 * STEP 2 (docs/modules.md §4) — every decision the clock makes that does not
 * touch the DOM. Pure, and unit-tested in `time.test.ts`.
 *
 * Two deliberate absences:
 *
 *  - **No `Intl`.** `Intl.DateTimeFormat` drags a large ICU surface onto the
 *    display path and its output depends on the host locale, which inside CAM's
 *    headless webview is neither controllable nor testable. Digits are formatted
 *    by hand and the date line is built from two short tables.
 *  - **No sub-second anything.** Every value here is a function of the wall
 *    clock alone, so the module looks identical at `targetFps = 1` and at 40 —
 *    the only difference is how soon after a tick the panel catches up. A
 *    sweeping second hand at 1 FPS is a stuttering second hand; a *ticking* one
 *    is what a clock means anyway.
 */

import type { ClockConfig } from './schema';

const PAD_BELOW = 10;
const HOURS_ON_FACE = 12;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const FULL_TURN_DEG = 360;

/** Degrees the hour hand advances per hour, per minute of the current hour. */
export const DEG_PER_HOUR = FULL_TURN_DEG / HOURS_ON_FACE;
export const DEG_PER_MINUTE = FULL_TURN_DEG / MINUTES_PER_HOUR;
export const DEG_PER_SECOND = FULL_TURN_DEG / SECONDS_PER_MINUTE;

function pad2(n: number): string {
  return n < PAD_BELOW ? `0${String(n)}` : String(n);
}

/** 0..23 → 1..12. Midnight and noon are both 12, never 0. */
export function to12Hour(hours24: number): number {
  const h = hours24 % HOURS_ON_FACE;
  return h === 0 ? HOURS_ON_FACE : h;
}

export interface ClockTimeText {
  /** `13:04:07`, or `1:04:07` in 12-hour form — the hour is never zero-padded there. */
  time: string;
  /** `AM` / `PM`, or `null` in 24-hour form. */
  meridiem: 'AM' | 'PM' | null;
}

/**
 * The digits, exactly as painted.
 *
 * 12-hour form deliberately does NOT pad the hour: `1:04` is how a clock reads,
 * and dropping the leading zero buys a materially larger font on a 240 px panel.
 */
export function formatTime(
  date: Date,
  cfg: Pick<ClockConfig, 'hourFormat' | 'showSeconds'>,
): ClockTimeText {
  const h24 = date.getHours();
  const twelve = cfg.hourFormat === '12';
  const hours = twelve ? to12Hour(h24) : h24;
  const parts = [twelve ? String(hours) : pad2(hours), pad2(date.getMinutes())];
  if (cfg.showSeconds) parts.push(pad2(date.getSeconds()));
  return {
    time: parts.join(':'),
    meridiem: twelve ? (h24 < HOURS_ON_FACE ? 'AM' : 'PM') : null,
  };
}

const WEEKDAYS: readonly string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const MONTHS: readonly string[] = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** `Mon 30 Aug`. Day-before-month: unambiguous, and short enough for 240 px. */
export function formatDate(date: Date): string {
  const weekday = WEEKDAYS[date.getDay()] ?? '';
  const month = MONTHS[date.getMonth()] ?? '';
  return `${weekday} ${String(date.getDate())} ${month}`;
}

export interface HandAngles {
  /** Degrees clockwise from 12 o'clock. */
  hour: number;
  minute: number;
  /** `null` when seconds are switched off — the hand is then not drawn at all. */
  second: number | null;
}

/**
 * The three hand angles.
 *
 * The hour hand creeps with the minutes (a real clock's does); the minute and
 * second hands tick discretely. That combination is what makes the analog face
 * read correctly at 1 FPS: nothing is mid-transition at any moment we sample.
 */
export function handAngles(date: Date, showSeconds: boolean): HandAngles {
  const seconds = date.getSeconds();
  const minutes = date.getMinutes();
  const hours = date.getHours() % HOURS_ON_FACE;
  return {
    hour: (hours + minutes / MINUTES_PER_HOUR) * DEG_PER_HOUR,
    minute: minutes * DEG_PER_MINUTE,
    second: showSeconds ? seconds * DEG_PER_SECOND : null,
  };
}

/**
 * A short string that identifies everything the face would paint.
 *
 * `frame()` runs up to 40 times a second and the clock changes once a second
 * (once a minute with seconds off). Comparing this against the last one is what
 * turns 39 of every 40 ticks into a single string compare and *zero* DOM
 * mutations — which is the difference between a compressor with nothing to
 * encode and one re-encoding the whole panel.
 */
export function paintKey(date: Date, cfg: ClockConfig): string {
  const { time, meridiem } = formatTime(date, cfg);
  const dateText = cfg.showDate ? formatDate(date) : '';
  return `${cfg.face}|${cfg.theme}|${time}|${meridiem ?? ''}|${dateText}`;
}
