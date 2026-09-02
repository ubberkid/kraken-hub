import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { EFFECT_CATALOG, EFFECT_LIST, matchPreset, presetColours } from './catalog';
import { EFFECT_COLOUR_SLOTS, EFFECT_IDS, EFFECT_PRESET_IDS, validateEffect } from './schema';

const HEX = /^#[0-9A-F]{6}$/;

describe('the effect catalogue', () => {
  it('describes every registered id, in picker order', () => {
    expect(EFFECT_LIST.map((d) => d.id)).toEqual([...EFFECT_IDS]);
  });

  it.each(EFFECT_IDS)('%s has a human name and one label per colour slot', (id) => {
    const d = EFFECT_CATALOG[id];
    expect(d.name.length).toBeGreaterThan(0);
    // "plasma" is a source file's name, not a thing a person chose to look at.
    expect(d.name).not.toBe(id);
    expect(d.slots).toHaveLength(EFFECT_COLOUR_SLOTS[id]);
    for (const slot of d.slots) expect(slot.length).toBeGreaterThan(0);
  });

  it.each(EFFECT_IDS)('%s ships at least one preset, all well-formed', (id) => {
    const d = EFFECT_CATALOG[id];
    expect(d.presets.length).toBeGreaterThan(0);
    for (const preset of d.presets) {
      expect(preset.name.length).toBeGreaterThan(0);
      expect(preset.id).toBe(preset.name.toLowerCase());
      expect(preset.colors).toHaveLength(EFFECT_COLOUR_SLOTS[id]);
      for (const colour of preset.colors) expect(colour).toMatch(HEX);
    }
  });

  it.each(EFFECT_IDS)('%s: the eager id table and the catalogue agree', (id) => {
    // The two are read by different halves of the app — `validate()` decides
    // what is ACCEPTED, the catalogue decides what is PAINTED — so a drift
    // between them is a preset you can store and never choose.
    expect(EFFECT_CATALOG[id].presets.map((p) => p.id)).toEqual([...EFFECT_PRESET_IDS[id]]);
  });

  it.each(EFFECT_IDS)('%s: every preset survives validate() unchanged', (id) => {
    for (const preset of EFFECT_CATALOG[id].presets) {
      const cfg = validateEffect({ effect: id, preset: preset.id, colors: [...preset.colors] });
      expect(cfg.preset).toBe(preset.id);
      expect(cfg.colors).toEqual([...preset.colors]);
    }
  });

  it('has no duplicate preset ids inside one effect', () => {
    for (const id of EFFECT_IDS) {
      const ids = EFFECT_CATALOG[id].presets.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe('presetColours / matchPreset', () => {
  it('round-trips every preset', () => {
    for (const id of EFFECT_IDS) {
      for (const preset of EFFECT_CATALOG[id].presets) {
        const colours = presetColours(id, preset.id);
        expect(colours).not.toBeNull();
        expect(matchPreset(id, colours ?? [])).toBe(preset.id);
      }
    }
  });

  it('answers null for a preset this effect does not have', () => {
    expect(presetColours('classic', 'ice')).toBeNull();
    expect(presetColours('plasma', 'custom')).toBeNull();
  });

  it('says custom the moment one well is edited, and unsays it on undo', () => {
    const classic = presetColours('plasma', 'classic') ?? [];
    const edited = [...classic];
    edited[0] = '#123456';
    expect(matchPreset('plasma', edited)).toBe('custom');
    edited[0] = classic[0] ?? '';
    expect(matchPreset('plasma', edited)).toBe('classic');
  });

  it('ignores case, so a stored lower-case palette still matches its material', () => {
    const classic = (presetColours('plasma', 'classic') ?? []).map((c) => c.toLowerCase());
    expect(matchPreset('plasma', classic)).toBe('classic');
  });
});

/**
 * The vocabulary spine, for this module (`docs/design/design-editor-ux.md` §1).
 *
 * The user-facing word is **Effect**, always. The technical one is allowed in a
 * comment — this file's own header is full of it — and nowhere a person can
 * read, so the check is on STRING LITERALS with comments stripped, which is the
 * difference between a rule and a grep that punishes documentation.
 */
describe('the word a user reads', () => {
  const FORBIDDEN = /shader/i;

  const source = (name: string): string =>
    readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8');

  /** Blanks comments, then returns every quoted run left standing. */
  function stringLiterals(text: string): string[] {
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .map((line) => line.replace(/(?<!:)\/\/.*$/, ''))
      .join('\n');
    return [...code.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)].map(
      (m) => m[1] ?? m[2] ?? m[3] ?? '',
    );
  }

  it.each(['ConfigPanel.tsx', 'catalog.ts', 'schema.ts', 'index.ts'])(
    '%s never puts the technical word in front of a user',
    (file) => {
      for (const literal of stringLiterals(source(file))) {
        expect(literal).not.toMatch(FORBIDDEN);
      }
    },
  );

  it('never names one in the catalogue', () => {
    for (const d of EFFECT_LIST) {
      expect(d.name).not.toMatch(FORBIDDEN);
      for (const slot of d.slots) expect(slot).not.toMatch(FORBIDDEN);
      for (const p of d.presets) expect(p.name).not.toMatch(FORBIDDEN);
    }
  });
});
