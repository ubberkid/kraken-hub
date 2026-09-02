import { describe, expect, it } from 'vitest';

import {
  BRIGHTNESS_MAX,
  BRIGHTNESS_MIN,
  CUSTOM_PRESET_ID,
  DEFAULT_PRESET_ID,
  EFFECT_COLOUR_SLOTS,
  EFFECT_DEFAULTS,
  EFFECT_IDS,
  EFFECT_PRESET_IDS,
  SCALE_MAX,
  SCALE_MIN,
  SPEED_MAX,
  SPEED_MIN,
  effectEntropy,
  validateEffect,
  type EffectConfig,
} from './schema';

const HEX = /^#[0-9A-F]{6}$/;

describe('validateEffect', () => {
  it('fills a completely empty config from the defaults', () => {
    expect(validateEffect({})).toEqual(EFFECT_DEFAULTS);
  });

  it.each([undefined, null, 0, '', [], NaN, { deeply: { wrong: [1, 2] } }])(
    'never throws on %p',
    (junk) => {
      expect(() => validateEffect(junk)).not.toThrow();
      expect(validateEffect(junk)).toEqual(EFFECT_DEFAULTS);
    },
  );

  it('is idempotent', () => {
    const once = validateEffect({ effect: 'voronoi', speed: 9, colors: ['#abcdef'] });
    expect(validateEffect(once)).toEqual(once);
  });

  const table: {
    name: string;
    raw: Partial<Record<keyof EffectConfig, unknown>>;
    want: unknown;
  }[] = [
    { name: 'an unknown effect id', raw: { effect: 'lavalamp' }, want: { effect: 'plasma' } },
    {
      name: 'a preset from ANOTHER effect',
      // `classic` (the effect) has no Ice material; plasma does.
      raw: { effect: 'classic', preset: 'ice' },
      want: { preset: DEFAULT_PRESET_ID },
    },
    {
      name: 'a preset this effect does have',
      raw: { effect: 'plasma', preset: 'sunburst' },
      want: { preset: 'sunburst' },
    },
    {
      name: 'the custom sentinel',
      raw: { preset: CUSTOM_PRESET_ID },
      want: { preset: CUSTOM_PRESET_ID },
    },
    { name: 'a non-string preset', raw: { preset: 7 }, want: { preset: DEFAULT_PRESET_ID } },
    { name: 'speed over the top', raw: { speed: 40 }, want: { speed: SPEED_MAX } },
    { name: 'speed under the floor', raw: { speed: 0 }, want: { speed: SPEED_MIN } },
    { name: 'a speed of NaN', raw: { speed: NaN }, want: { speed: EFFECT_DEFAULTS.speed } },
    { name: 'a numeric string speed', raw: { speed: '1.5' }, want: { speed: 1 } },
    { name: 'scale over the top', raw: { scale: 99 }, want: { scale: SCALE_MAX } },
    { name: 'scale under the floor', raw: { scale: -3 }, want: { scale: SCALE_MIN } },
    {
      name: 'brightness over the top',
      raw: { brightness: 4 },
      want: { brightness: BRIGHTNESS_MAX },
    },
    {
      name: 'brightness under the floor',
      raw: { brightness: 0.1 },
      want: { brightness: BRIGHTNESS_MIN },
    },
    { name: 'a non-boolean switch', raw: { reactsToTemp: 'yes' }, want: { reactsToTemp: false } },
    { name: 'an unknown sensor', raw: { tempSource: 'pump' }, want: { tempSource: 'cpu' } },
    { name: 'a known sensor', raw: { tempSource: 'liquid' }, want: { tempSource: 'liquid' } },
  ];

  it.each(table)('coerces $name', ({ raw, want }) => {
    expect(validateEffect(raw)).toMatchObject(want as Record<string, unknown>);
  });
});

describe('validateEffect: the colour list', () => {
  it('pads a short list to the effect its slot count', () => {
    const cfg = validateEffect({ effect: 'plasma', colors: ['#112233'] });
    expect(cfg.colors).toHaveLength(EFFECT_COLOUR_SLOTS.plasma);
    expect(cfg.colors[0]).toBe('#112233');
    // The rest come from the defaults, in slot order.
    expect(cfg.colors[1]).toBe(EFFECT_DEFAULTS.colors[1]);
  });

  it('truncates a long list', () => {
    const cfg = validateEffect({
      colors: ['#000000', '#111111', '#222222', '#333333', '#444444', '#555555'],
    });
    expect(cfg.colors).toHaveLength(EFFECT_COLOUR_SLOTS[EFFECT_DEFAULTS.effect]);
  });

  it.each([['not a colour'], ['#fff'], ['#12345g'], [42], [null], [{}]])(
    'replaces the junk colour %p',
    (junk) => {
      const cfg = validateEffect({ colors: [junk, '#00FF00', '#0000FF', '#FFFFFF'] });
      expect(cfg.colors[0]).toBe(EFFECT_DEFAULTS.colors[0]);
      expect(cfg.colors[1]).toBe('#00FF00');
    },
  );

  it('normalises case, so two identical palettes compare equal', () => {
    expect(validateEffect({ colors: ['#aabbcc'] }).colors[0]).toBe('#AABBCC');
  });

  it('always returns well-formed hex, whatever it was handed', () => {
    for (const c of validateEffect({ colors: [1, 'x', null, undefined] }).colors) {
      expect(c).toMatch(HEX);
    }
  });

  it('gives every effect the slot count it declares', () => {
    for (const id of EFFECT_IDS) {
      expect(validateEffect({ effect: id }).colors).toHaveLength(EFFECT_COLOUR_SLOTS[id]);
    }
  });
});

describe('the eager tables', () => {
  it('lists every id exactly once', () => {
    expect(new Set(EFFECT_IDS).size).toBe(EFFECT_IDS.length);
  });

  it('gives every effect a Classic preset — the fallback depends on it', () => {
    for (const id of EFFECT_IDS) {
      expect(EFFECT_PRESET_IDS[id]).toContain(DEFAULT_PRESET_ID);
    }
  });

  it('accepts every preset it lists, for the effect that lists it', () => {
    for (const id of EFFECT_IDS) {
      for (const preset of EFFECT_PRESET_IDS[id]) {
        expect(validateEffect({ effect: id, preset }).preset).toBe(preset);
      }
    }
  });

  it('never names the custom sentinel as a real preset', () => {
    for (const id of EFFECT_IDS) {
      expect(EFFECT_PRESET_IDS[id]).not.toContain(CUSTOM_PRESET_ID);
    }
  });
});

describe('effectEntropy', () => {
  it('charges the two whole-frame movers as high', () => {
    expect(effectEntropy({ effect: 'colour-spiral' })).toBe('high');
    expect(effectEntropy({ effect: 'infinite-rings' })).toBe('high');
  });

  it('charges the smooth ones as mid', () => {
    expect(effectEntropy(EFFECT_DEFAULTS)).toBe('mid');
    expect(effectEntropy({ effect: 'voronoi' })).toBe('mid');
  });

  it('never throws on junk — the cost bar runs on every keystroke', () => {
    for (const junk of [undefined, null, 0, '', [], { effect: 9 }]) {
      expect(effectEntropy(junk)).toBe('mid');
    }
  });
});
