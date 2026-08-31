import { describe, expect, it } from 'vitest';

import { defaultAppState } from './defaults';
import { SCHEMA_VERSION } from './schema';
import { validateAppState } from './validate';

describe('validateAppState', () => {
  it('round-trips the defaults unchanged (idempotence)', () => {
    const def = defaultAppState();
    const { state, notes } = validateAppState(def);
    expect(state).toEqual(def);
    expect(notes).toEqual([]);
    expect(validateAppState(state).state).toEqual(state);
  });

  it('round-trips through JSON', () => {
    const def = defaultAppState();
    expect(validateAppState(JSON.parse(JSON.stringify(def))).state).toEqual(def);
  });

  it('never throws on hostile input', () => {
    const inputs: unknown[] = [
      undefined,
      null,
      0,
      '',
      [],
      {},
      { deeply: { wrong: [1, 2] } },
      { render: 'not-an-object', modules: 42, playback: [] },
      { schema: 'one', rev: -5, activeModuleId: 'A_B_C' },
    ];
    for (const input of inputs) {
      expect(() => validateAppState(input)).not.toThrow();
      expect(validateAppState(input).state.schema).toBe(SCHEMA_VERSION);
    }
  });

  it('clamps out-of-range numbers and records a note', () => {
    const { state, notes } = validateAppState({ render: { zoom: 99 } });
    expect(state.render.zoom).toBe(4);
    expect(notes.map((n) => n.path)).toContain('render.zoom');
  });

  it('preserves an unknown module slot verbatim (a fork must survive us)', () => {
    const { state } = validateAppState({
      modules: { 'some-fork-module': { v: 7, cfg: { anything: ['at', 'all'] } } },
    });
    expect(state.modules['some-fork-module']).toEqual({
      v: 7,
      cfg: { anything: ['at', 'all'] },
    });
  });

  it('drops a module id that is not kebab-case', () => {
    const { state } = validateAppState({ modules: { 'NOT VALID': { v: 1, cfg: {} } } });
    expect(Object.keys(state.modules)).toEqual([]);
  });

  it('only accepts the four legal rotations', () => {
    expect(validateAppState({ render: { rotate: 270 } }).state.render.rotate).toBe(270);
    expect(validateAppState({ render: { rotate: 45 } }).state.render.rotate).toBe(0);
  });

  it('treats an absent field as a default, not as an error', () => {
    expect(validateAppState({ render: {} }).notes).toEqual([]);
  });
});
