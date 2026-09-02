/**
 * STEP 2 (docs/modules.md §4) — the pure logic: one `Date`, one preset and one
 * locale in, one line of text out.
 *
 * No DOM, no globals, no `Geometry`, and no `Date.now()` — the date is an
 * ARGUMENT, which is what makes the whole of this module's behaviour a
 * table-driven unit test in node rather than something that has to be checked
 * at midnight.
 *
 * ## Why `Intl`, and why `iso` does not use it
 *
 * Five of the six presets are the browser's own idea of how the reader's locale
 * writes a date — the panel says *2 Sep* where the machine says *2 Sep* and
 * *Sep 2* where it says *Sep 2*, and neither spelling is hardcoded here. The
 * sixth is `iso`, which is `YYYY-MM-DD` by definition: it is the one format
 * whose whole point is that it does NOT change with the locale, so it is
 * assembled from the date's own local fields and never goes near `Intl`.
 *
 * ## Unknown locales are tolerated, not rejected
 *
 * `new Intl.DateTimeFormat('xx-nonsense')` throws a `RangeError`. A tag that
 * arrives from a stored look composed on another machine is not a reason for a
 * layer to go blank, so a formatter that cannot be built falls back to the
 * browser's own locale — the same answer `'auto'` gives.
 */

/** The six presets, in the order the picker shows them. */
export type DateFormat =
  'weekday-day-month' | 'day-month-year' | 'month-day' | 'iso' | 'weekday' | 'day';

export const DATE_FORMATS: readonly DateFormat[] = [
  'weekday-day-month',
  'day-month-year',
  'month-day',
  'iso',
  'weekday',
  'day',
];

/**
 * What each preset is called — ONE set of labels, for the strip and the panel
 * both.
 *
 * Two label tables for one enumeration is the drift the strip contract exists
 * to end, so the words are short enough to be a segment under the halo and
 * plain enough to be a field in the inspector. They name what the preset SHOWS
 * rather than listing its fields, and none of them spells a date out: the
 * spelling is the locale's, not this table's.
 */
export const FORMAT_LABELS: Readonly<Record<DateFormat, string>> = {
  'weekday-day-month': 'Weekday + date',
  'day-month-year': 'Date + year',
  'month-day': 'Month + day',
  iso: 'ISO',
  weekday: 'Weekday',
  day: 'Day',
};

/** The `Intl` options each preset asks for. `iso` is not one of them. */
const OPTIONS: Readonly<Record<Exclude<DateFormat, 'iso'>, Intl.DateTimeFormatOptions>> = {
  'weekday-day-month': { weekday: 'short', day: 'numeric', month: 'short' },
  'day-month-year': { day: 'numeric', month: 'short', year: 'numeric' },
  'month-day': { month: 'long', day: 'numeric' },
  weekday: { weekday: 'long' },
  day: { day: 'numeric' },
};

/** The value that means "whatever this machine is set to". */
export const AUTO_LOCALE = 'auto';

/**
 * Built formatters, kept.
 *
 * `new Intl.DateTimeFormat(…)` is the expensive part of formatting a date and
 * the renderer asks for one line a minute, forever. The key is the pair that
 * decides the answer, so a config change makes a new formatter and a tick does
 * not.
 */
const CACHE = new Map<string, Intl.DateTimeFormat>();

function formatterFor(format: Exclude<DateFormat, 'iso'>, locale: string): Intl.DateTimeFormat {
  const key = `${locale}|${format}`;
  const hit = CACHE.get(key);
  if (hit !== undefined) return hit;

  const tag = locale === AUTO_LOCALE ? undefined : locale;
  let made: Intl.DateTimeFormat;
  try {
    made = new Intl.DateTimeFormat(tag, OPTIONS[format]);
  } catch {
    // An unknown or malformed tag is not a reason for the layer to go blank.
    made = new Intl.DateTimeFormat(undefined, OPTIONS[format]);
  }
  CACHE.set(key, made);
  return made;
}

/** Below this a month or a day needs its leading zero to be two digits. */
const TWO_DIGITS = 10;

function pad2(value: number): string {
  return value < TWO_DIGITS ? `0${String(value)}` : String(value);
}

/**
 * One line of date. Total: an invalid `Date` yields an empty string rather than
 * the word `Invalid Date` on somebody's cooler.
 */
export function formatDate(date: Date, format: DateFormat, locale: string): string {
  const at = date.getTime();
  if (!Number.isFinite(at)) return '';

  if (format === 'iso') {
    // The date's LOCAL fields, so the panel agrees with the wall clock beside
    // it. `toISOString()` would be UTC, and would print yesterday all evening
    // west of Greenwich.
    return `${String(date.getFullYear())}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  try {
    return formatterFor(format, locale).format(date);
  } catch {
    return '';
  }
}

/**
 * The minute this instant falls in.
 *
 * The renderer's repaint guard: a date changes once a day, and asking `Intl`
 * for a string forty times a second to find that out is the per-frame work
 * `cost().cadence: 'tick'` promises not to do. One integer compare per frame,
 * one format per minute.
 */
const MS_PER_MINUTE = 60_000;

export function minuteOf(atMs: number): number {
  return Math.floor(atMs / MS_PER_MINUTE);
}
