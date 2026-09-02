import { describe, expect, it } from 'vitest';

import {
  NO_PAINT,
  OPACITY_MAX,
  OPACITY_MIN,
  RADIUS_MAX,
  RADIUS_MIN,
  SHAPE_DEFAULTS,
  STROKE_MAX,
  STROKE_MIN,
  normalizePaint,
  validateShape,
} from './schema';

/**
 * `validate()` as a TOTAL function — the module's whole contract with storage,
 * which hands it whatever the last version of this app, a fork, or a corrupted
 * write happened to leave there.
 */
describe('validateShape', () => {
  it('accepts its own defaults, idempotently', () => {
    expect(validateShape(SHAPE_DEFAULTS)).toEqual(SHAPE_DEFAULTS);
    expect(validateShape(validateShape(SHAPE_DEFAULTS))).toEqual(SHAPE_DEFAULTS);
  });

  it.each([undefined, null, 0, '', [], true, { deeply: { wrong: [1, 2] } }])(
    'returns the defaults for junk (%s)',
    (junk) => {
      expect(validateShape(junk)).toEqual(SHAPE_DEFAULTS);
    },
  );

  it.each([['triangle'], ['RECT'], [4], [null]])('falls back on the bad shape %s', (bad) => {
    expect(validateShape({ shape: bad }).shape).toBe(SHAPE_DEFAULTS.shape);
  });

  it.each([['#gggggg'], ['#12345'], ['ffffff'], ['transparent'], [12], [null]])(
    'falls back on the bad paint %s',
    (bad) => {
      expect(validateShape({ fill: bad }).fill).toBe(SHAPE_DEFAULTS.fill);
      expect(validateShape({ stroke: bad }).stroke).toBe(SHAPE_DEFAULTS.stroke);
    },
  );

  it('keeps "none", which is a value and not a failure', () => {
    expect(validateShape({ fill: NO_PAINT }).fill).toBe(NO_PAINT);
    expect(validateShape({ stroke: 'NONE' }).stroke).toBe(NO_PAINT);
  });

  it('normalises a colour rather than merely accepting it', () => {
    expect(validateShape({ fill: '#ABC' }).fill).toBe('#aabbcc');
    expect(validateShape({ stroke: ' #FFFFFF ' }).stroke).toBe('#ffffff');
  });

  it('clamps every length into its declared range', () => {
    expect(validateShape({ strokeWidth: 99 }).strokeWidth).toBe(STROKE_MAX);
    expect(validateShape({ strokeWidth: -1 }).strokeWidth).toBe(STROKE_MIN);
    expect(validateShape({ radius: 99 }).radius).toBe(RADIUS_MAX);
    expect(validateShape({ radius: -1 }).radius).toBe(RADIUS_MIN);
    expect(validateShape({ fillOpacity: 99 }).fillOpacity).toBe(OPACITY_MAX);
    expect(validateShape({ fillOpacity: -1 }).fillOpacity).toBe(OPACITY_MIN);
  });

  it.each([[Number.NaN], [Number.POSITIVE_INFINITY], ['0.02'], [null]])(
    'falls back when a length is %s rather than clamping a non-number',
    (bad) => {
      expect(validateShape({ strokeWidth: bad }).strokeWidth).toBe(SHAPE_DEFAULTS.strokeWidth);
    },
  );

  it('falls back on a non-boolean dash', () => {
    expect(validateShape({ dash: 'yes' }).dash).toBe(SHAPE_DEFAULTS.dash);
  });

  it('drops keys it does not know', () => {
    expect(validateShape({ ...SHAPE_DEFAULTS, sneaky: 'value' })).toEqual(SHAPE_DEFAULTS);
  });
});

describe('normalizePaint', () => {
  it('expands three digits to six', () => {
    expect(normalizePaint('#abc', '#000000')).toBe('#aabbcc');
  });

  it('returns the fallback for anything it does not recognise', () => {
    expect(normalizePaint('chartreuse', '#123456')).toBe('#123456');
  });
});
