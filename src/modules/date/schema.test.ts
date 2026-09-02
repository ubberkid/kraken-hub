import { describe, expect, it } from 'vitest';

import { AUTO_LOCALE, DATE_FORMATS } from './format';
import {
  DATE_DEFAULTS,
  DATE_WEIGHTS,
  SIZE_MAX,
  SIZE_MIN,
  normalizeLocale,
  validateDate,
} from './schema';

describe('validateDate', () => {
  it('never throws, whatever storage hands it', () => {
    for (const junk of [undefined, null, 0, '', [], {}, { deeply: { wrong: [1, 2] } }, NaN]) {
      expect(() => validateDate(junk)).not.toThrow();
    }
  });

  it('is idempotent on its own defaults', () => {
    expect(validateDate(DATE_DEFAULTS)).toEqual(DATE_DEFAULTS);
    expect(validateDate(validateDate(DATE_DEFAULTS))).toEqual(DATE_DEFAULTS);
  });

  const CASES: readonly [string, unknown, Partial<typeof DATE_DEFAULTS>][] = [
    ['keeps a known preset', { format: 'iso' }, { format: 'iso' }],
    ['drops an unknown preset', { format: 'julian' }, { format: DATE_DEFAULTS.format }],
    ['keeps a language tag, lowercased', { locale: 'en-GB' }, { locale: 'en-gb' }],
    ['keeps auto', { locale: AUTO_LOCALE }, { locale: AUTO_LOCALE }],
    ['rejects a sentence as a locale', { locale: 'the british one' }, { locale: AUTO_LOCALE }],
    ['rejects an over-long locale', { locale: 'a'.repeat(40) }, { locale: AUTO_LOCALE }],
    ['clamps a size below the floor', { size: 0 }, { size: SIZE_MIN }],
    ['clamps a size above the ceiling', { size: 9 }, { size: SIZE_MAX }],
    ['keeps a known weight', { weight: 800 }, { weight: 800 }],
    ['drops an unknown weight', { weight: 550 }, { weight: DATE_DEFAULTS.weight }],
    ['expands a short hex', { color: '#ABC' }, { color: '#aabbcc' }],
    ['rejects a colour word', { color: 'red' }, { color: DATE_DEFAULTS.color }],
    ['keeps an uppercase flag', { uppercase: true }, { uppercase: true }],
    ['rejects a non-boolean flag', { uppercase: 1 }, { uppercase: DATE_DEFAULTS.uppercase }],
  ];

  it.each(CASES)('%s', (_name, raw, expected) => {
    expect(validateDate(raw)).toEqual({ ...DATE_DEFAULTS, ...expected });
  });

  it('accepts every preset it offers', () => {
    for (const format of DATE_FORMATS) {
      expect(validateDate({ format }).format).toBe(format);
    }
  });

  it('accepts every weight it offers', () => {
    for (const weight of DATE_WEIGHTS) {
      expect(validateDate({ weight }).weight).toBe(weight);
    }
  });
});

describe('normalizeLocale', () => {
  it('keeps a plausible tag and falls back on anything else', () => {
    expect(normalizeLocale('de', 'auto')).toBe('de');
    expect(normalizeLocale('  PT-BR ', 'auto')).toBe('pt-br');
    expect(normalizeLocale('zz-quux', 'auto')).toBe('zz-quux');
    // Plausible-but-unknown is accepted here and tolerated by `formatDate()`;
    // implausible is not a tag at all.
    expect(normalizeLocale('!', 'auto')).toBe('auto');
    expect(normalizeLocale(42, 'auto')).toBe('auto');
  });
});
