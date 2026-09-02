import { describe, expect, it } from 'vitest';

import {
  MAX_TEXT_LEN,
  SIZE_MAX,
  SIZE_MIN,
  TEXT_DEFAULTS,
  TEXT_FACES,
  TEXT_FONTS,
  TRACKING_MAX,
  TRACKING_MIN,
  normalizeHex,
  validateText,
} from './schema';

/**
 * `validate()` is the module's whole contract with storage, and storage hands
 * it whatever the last version of this app — or a fork's, or a corrupted
 * localStorage write — happened to put there. So it is tested as a TOTAL
 * function: every field, one bad value of every shape it could take, and the
 * assertion is always that the field falls back rather than that the call
 * throws something useful.
 */
describe('validateText', () => {
  it('accepts its own defaults, idempotently', () => {
    expect(validateText(TEXT_DEFAULTS)).toEqual(TEXT_DEFAULTS);
    expect(validateText(validateText(TEXT_DEFAULTS))).toEqual(TEXT_DEFAULTS);
  });

  it.each([undefined, null, 0, '', [], true, { deeply: { wrong: [1, 2] } }])(
    'returns the defaults for junk (%s)',
    (junk) => {
      expect(validateText(junk)).toEqual(TEXT_DEFAULTS);
    },
  );

  it('refuses a string longer than the cap, and keeps one exactly at it', () => {
    const atCap = 'x'.repeat(MAX_TEXT_LEN);
    expect(validateText({ text: atCap }).text).toBe(atCap);
    expect(validateText({ text: `${atCap}x` }).text).toBe(TEXT_DEFAULTS.text);
  });

  it('keeps the empty string, which is a deliberate value', () => {
    // A layer someone has emptied is not a layer someone has broken: the
    // editor's own way to blank a line is to clear the field.
    expect(validateText({ text: '' }).text).toBe('');
  });

  const BAD_ENUMS = [
    ['weight', 500],
    ['weight', '600'],
    ['font', 'comic'],
    ['font', 7],
    ['align', 'justify'],
    ['align', null],
  ] as const;

  it.each(BAD_ENUMS)('falls back when %s is %s', (key, value) => {
    expect(validateText({ [key]: value })[key]).toBe(TEXT_DEFAULTS[key]);
  });

  it.each([['#gggggg'], ['#12345'], ['ffffff'], ['rgb(1,2,3)'], [''], [12], [null]])(
    'falls back on the bad colour %s',
    (bad) => {
      expect(validateText({ color: bad }).color).toBe(TEXT_DEFAULTS.color);
    },
  );

  it('normalises a colour rather than merely accepting it', () => {
    expect(validateText({ color: '#FFF' }).color).toBe('#ffffff');
    expect(validateText({ color: '  #AaBbCc  ' }).color).toBe('#aabbcc');
    // …and normalising is what keeps the second pass identical to the first.
    expect(validateText(validateText({ color: '#FFF' }))).toEqual(
      validateText({ color: '#ffffff' }),
    );
  });

  it('clamps the numbers instead of dropping them', () => {
    expect(validateText({ size: 99 }).size).toBe(SIZE_MAX);
    expect(validateText({ size: -1 }).size).toBe(SIZE_MIN);
    expect(validateText({ letterSpacing: 99 }).letterSpacing).toBe(TRACKING_MAX);
    expect(validateText({ letterSpacing: -99 }).letterSpacing).toBe(TRACKING_MIN);
  });

  it.each([[Number.NaN], [Number.POSITIVE_INFINITY], ['0.2'], [null]])(
    'falls back when size is %s rather than clamping a non-number',
    (bad) => {
      expect(validateText({ size: bad }).size).toBe(TEXT_DEFAULTS.size);
    },
  );

  it('drops keys it does not know', () => {
    expect(validateText({ ...TEXT_DEFAULTS, sneaky: 'value' })).toEqual(TEXT_DEFAULTS);
  });
});

describe('normalizeHex', () => {
  it('expands three digits to six', () => {
    expect(normalizeHex('#abc', '#000000')).toBe('#aabbcc');
  });

  it('returns the fallback unchanged for anything else', () => {
    expect(normalizeHex('nope', '#123456')).toBe('#123456');
  });
});

describe('the seven faces', () => {
  it('all have a label and a stack', () => {
    for (const id of TEXT_FONTS) {
      expect(TEXT_FACES[id].label.length).toBeGreaterThan(0);
      expect(TEXT_FACES[id].stack.length).toBeGreaterThan(0);
    }
  });

  /**
   * The fallback is the whole reason a curated face is safe to load lazily: it
   * may never arrive (no network in CAM, a stylesheet that 404s), and the layer
   * still has to render legible text of roughly the right character.
   */
  it('every curated face names a fallback behind its own family', () => {
    for (const id of TEXT_FONTS) {
      if (id === 'system') continue;
      expect(TEXT_FACES[id].stack.split(',').length).toBeGreaterThan(1);
    }
  });

  it('names no external host — invariant 4', () => {
    for (const id of TEXT_FONTS) {
      expect(TEXT_FACES[id].stack).not.toMatch(/https?:/);
    }
  });
});
