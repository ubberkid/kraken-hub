import { describe, expect, it } from 'vitest';

import { CLOCK_DEFAULTS, validateClock } from './schema';
import {
  DEG_PER_HOUR,
  DEG_PER_MINUTE,
  DEG_PER_SECOND,
  formatDate,
  formatTime,
  handAngles,
  paintKey,
  to12Hour,
} from './time';

/** Local time, deliberately: every getter the module uses is a local one. */
function at(h: number, m: number, s: number, day = 30, month = 7, year = 2026): Date {
  return new Date(year, month, day, h, m, s);
}

describe('formatTime', () => {
  it('zero-pads every field in 24-hour form', () => {
    expect(formatTime(at(3, 4, 5), { hourFormat: '24', showSeconds: true }).time).toBe('03:04:05');
    expect(formatTime(at(0, 0, 0), { hourFormat: '24', showSeconds: true }).time).toBe('00:00:00');
    expect(formatTime(at(23, 59, 59), { hourFormat: '24', showSeconds: true }).time).toBe(
      '23:59:59',
    );
  });

  it('drops the seconds field entirely when they are switched off', () => {
    expect(formatTime(at(13, 7, 42), { hourFormat: '24', showSeconds: false }).time).toBe('13:07');
  });

  it('does not pad the hour in 12-hour form, and reports the meridiem', () => {
    const morning = formatTime(at(9, 5, 0), { hourFormat: '12', showSeconds: false });
    expect(morning.time).toBe('9:05');
    expect(morning.meridiem).toBe('AM');

    const afternoon = formatTime(at(13, 5, 0), { hourFormat: '12', showSeconds: false });
    expect(afternoon.time).toBe('1:05');
    expect(afternoon.meridiem).toBe('PM');
  });

  it('reports no meridiem in 24-hour form', () => {
    expect(formatTime(at(13, 5, 0), { hourFormat: '24', showSeconds: false }).meridiem).toBeNull();
  });

  it('renders midnight and noon as 12, never 0', () => {
    expect(to12Hour(0)).toBe(12);
    expect(to12Hour(12)).toBe(12);
    expect(formatTime(at(0, 30, 0), { hourFormat: '12', showSeconds: false })).toEqual({
      time: '12:30',
      meridiem: 'AM',
    });
    expect(formatTime(at(12, 30, 0), { hourFormat: '12', showSeconds: false })).toEqual({
      time: '12:30',
      meridiem: 'PM',
    });
  });
});

describe('formatDate', () => {
  it('renders weekday, day, short month', () => {
    // 2026-08-30 is a Sunday.
    expect(formatDate(at(0, 0, 0, 30, 7))).toBe('Sun 30 Aug');
    expect(formatDate(at(0, 0, 0, 1, 0, 2026))).toBe('Thu 1 Jan');
  });
});

describe('handAngles', () => {
  it('uses degrees clockwise from twelve', () => {
    expect(DEG_PER_HOUR).toBe(30);
    expect(DEG_PER_MINUTE).toBe(6);
    expect(DEG_PER_SECOND).toBe(6);
  });

  it('puts all three hands at zero at midnight', () => {
    expect(handAngles(at(0, 0, 0), true)).toEqual({ hour: 0, minute: 0, second: 0 });
  });

  it('places the hour hand at 90 degrees at three o clock', () => {
    expect(handAngles(at(3, 0, 0), true).hour).toBe(90);
    expect(handAngles(at(15, 0, 0), true).hour).toBe(90);
  });

  it('creeps the hour hand with the minutes', () => {
    // Half past three: halfway between 3 and 4, i.e. 90 + 15 degrees.
    expect(handAngles(at(3, 30, 0), true).hour).toBeCloseTo(105, 10);
  });

  it('ticks the minute and second hands discretely', () => {
    expect(handAngles(at(10, 10, 30), true).second).toBe(180);
    expect(handAngles(at(10, 15, 0), true).minute).toBe(90);
    // The second hand does NOT drag the minute hand: minutes tick whole.
    expect(handAngles(at(10, 15, 59), true).minute).toBe(90);
  });

  it('omits the second hand when seconds are off', () => {
    expect(handAngles(at(10, 10, 30), false).second).toBeNull();
  });

  it('never returns an angle outside a single turn', () => {
    for (let h = 0; h < 24; h += 1) {
      for (const m of [0, 17, 59]) {
        const a = handAngles(at(h, m, 0), true);
        expect(a.hour).toBeGreaterThanOrEqual(0);
        expect(a.hour).toBeLessThan(360);
        expect(a.minute).toBeGreaterThanOrEqual(0);
        expect(a.minute).toBeLessThan(360);
      }
    }
  });
});

describe('paintKey', () => {
  it('is stable within a second and changes across one', () => {
    const cfg = { ...CLOCK_DEFAULTS, showSeconds: true };
    expect(paintKey(at(1, 2, 3), cfg)).toBe(paintKey(at(1, 2, 3), cfg));
    expect(paintKey(at(1, 2, 3), cfg)).not.toBe(paintKey(at(1, 2, 4), cfg));
  });

  it('is stable across a whole minute when seconds are off', () => {
    const cfg = { ...CLOCK_DEFAULTS, showSeconds: false };
    expect(paintKey(at(1, 2, 3), cfg)).toBe(paintKey(at(1, 2, 59), cfg));
    expect(paintKey(at(1, 2, 3), cfg)).not.toBe(paintKey(at(1, 3, 0), cfg));
  });

  it('changes when any config field that is painted changes', () => {
    const now = at(1, 2, 3);
    const base = paintKey(now, CLOCK_DEFAULTS);
    expect(paintKey(now, { ...CLOCK_DEFAULTS, face: 'analog' })).not.toBe(base);
    expect(paintKey(now, { ...CLOCK_DEFAULTS, theme: 'amber' })).not.toBe(base);
    expect(paintKey(now, { ...CLOCK_DEFAULTS, showDate: true })).not.toBe(base);
    expect(paintKey(now, { ...CLOCK_DEFAULTS, hourFormat: '12' })).not.toBe(base);
  });
});

describe('validateClock', () => {
  it('fills every field from defaults for junk input', () => {
    for (const junk of [undefined, null, 0, '', [], { face: 'sundial' }]) {
      expect(validateClock(junk)).toEqual(CLOCK_DEFAULTS);
    }
  });

  it('keeps valid fields and drops unknown ones', () => {
    expect(validateClock({ face: 'analog', theme: 'cyan', nonsense: 1 })).toEqual({
      ...CLOCK_DEFAULTS,
      face: 'analog',
      theme: 'cyan',
    });
  });
});
