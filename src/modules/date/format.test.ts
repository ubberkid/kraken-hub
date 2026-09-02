import { describe, expect, it } from 'vitest';

import { AUTO_LOCALE, DATE_FORMATS, FORMAT_LABELS, formatDate, minuteOf } from './format';

/**
 * A fixed instant, built from LOCAL fields.
 *
 * Wednesday 2 September 2026, midday. Local rather than a UTC string, and
 * midday rather than midnight, so the assertions are the same in every time
 * zone a contributor or a CI runner happens to be in — a `Date` parsed from
 * `'2026-09-02'` is UTC midnight, which is the 1st of September all evening
 * west of Greenwich, and that is a test that fails by geography.
 */
const AT = new Date(2026, 8, 2, 12, 0, 0);

const EN = 'en-US';

/**
 * Substrings rather than whole strings, on purpose.
 *
 * The exact spelling `Intl` produces — the comma, the order, whether the month
 * is `Sep` or `Sept` — is the browser's ICU data, and it moves between
 * versions. Pinning it would make this suite an assertion about the runner
 * rather than about this module. What IS this module's promise is which FIELDS
 * each preset shows, and that is what these assert.
 */
const CASES: readonly [(typeof DATE_FORMATS)[number], readonly string[], readonly string[]][] = [
  // preset, must contain, must NOT contain
  ['weekday-day-month', ['Wed', 'Sep', '2'], ['2026']],
  ['day-month-year', ['Sep', '2', '2026'], ['Wednesday']],
  ['month-day', ['September', '2'], ['2026']],
  ['weekday', ['Wednesday'], ['Sep', '2026']],
  ['day', ['2'], ['Sep', '2026']],
];

describe('formatDate', () => {
  it.each(CASES)('%s shows the fields it promises', (format, has, hasNot) => {
    const line = formatDate(AT, format, EN);
    for (const part of has) expect(line, `${format}: ${line}`).toContain(part);
    for (const part of hasNot) expect(line, `${format}: ${line}`).not.toContain(part);
  });

  it('writes iso exactly, and from the LOCAL fields', () => {
    // The one preset whose whole point is that it does not vary: `YYYY-MM-DD`,
    // zero-padded, never `Intl`, never UTC.
    expect(formatDate(AT, 'iso', EN)).toBe('2026-09-02');
    expect(formatDate(new Date(2026, 0, 5, 23, 30), 'iso', EN)).toBe('2026-01-05');
    // …and it is the same string whatever the locale says, which is the point.
    expect(formatDate(AT, 'iso', 'de-DE')).toBe('2026-09-02');
    expect(formatDate(AT, 'iso', AUTO_LOCALE)).toBe('2026-09-02');
  });

  it('formats every preset to something non-empty in every locale it is given', () => {
    for (const format of DATE_FORMATS) {
      for (const locale of [AUTO_LOCALE, EN, 'de-DE', 'ja-JP']) {
        expect(formatDate(AT, format, locale).length, `${format} / ${locale}`).toBeGreaterThan(0);
      }
    }
  });

  it('tolerates a locale this browser has never heard of', () => {
    // `new Intl.DateTimeFormat('xx-nonsense')` throws a RangeError. A stored
    // look composed on another machine is not a reason for the layer to blank.
    for (const format of DATE_FORMATS) {
      const line = formatDate(AT, format, 'zz-quux');
      expect(line.length, `${format}: ${line}`).toBeGreaterThan(0);
    }
  });

  it('is total: an invalid date is an empty line, not the words "Invalid Date"', () => {
    for (const format of DATE_FORMATS) {
      expect(formatDate(new Date(Number.NaN), format, EN)).toBe('');
    }
  });

  it('is deterministic: the same instant twice gives the same line', () => {
    for (const format of DATE_FORMATS) {
      expect(formatDate(AT, format, EN)).toBe(formatDate(new Date(AT.getTime()), format, EN));
    }
  });

  it('labels every preset, once', () => {
    const labels = DATE_FORMATS.map((f) => FORMAT_LABELS[f]);
    for (const label of labels) expect(label.length).toBeGreaterThan(0);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('minuteOf', () => {
  it('is the tick guard: it moves once a minute and not before', () => {
    const base = 1_800_000_000_000;
    expect(minuteOf(base)).toBe(minuteOf(base + 59_999));
    expect(minuteOf(base + 60_000)).toBe(minuteOf(base) + 1);
  });
});
