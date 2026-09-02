import { describe, expect, it } from 'vitest';

import { DEFAULT_MODULE_ID, defaultAppState } from './defaults';
import { BASE_LAYER_ID, IDENTITY, MAX_LAYERS, MAX_LOOK_BYTES, baseLook } from './look/types';
import { SCHEMA_VERSION } from './schema';
import { selectActiveModuleId } from './selectors';
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

/**
 * The document's `look` (schema 7).
 *
 * The validator's job here is REPAIR, not refusal: a look that arrived corrupt,
 * foreign, oversized or simply absent has to come back renderable, because the
 * alternative is a black panel on a machine nobody is watching. The second job
 * is reconciliation — for one release the base kind has two homes, and
 * `activeModuleId` is the one every writer still commits.
 */
describe('validateAppState — the look', () => {
  const overlay = (id: string, kind = 'stats'): Record<string, unknown> => ({
    id,
    kind,
    on: true,
    frame: { w: 1.6, h: 0.5, shape: 'square' },
    t: { x: 0, y: 0.6, s: 1, r: 0, a: 1 },
    cfg: {},
  });

  it('gives a fresh document a base-only look for the default module', () => {
    expect(defaultAppState().look).toEqual(baseLook(DEFAULT_MODULE_ID));
    expect(validateAppState({}).state.look).toEqual(baseLook(DEFAULT_MODULE_ID));
  });

  it('keeps a valid look, overlays and all', () => {
    const layers = [
      { id: BASE_LAYER_ID, kind: 'video', on: true, frame: 'panel', t: IDENTITY },
      overlay('lstats01'),
    ];
    const { state, notes } = validateAppState({ activeModuleId: 'video', look: { layers } });
    expect(state.look.layers).toHaveLength(2);
    expect(state.look.layers[1]?.id).toBe('lstats01');
    expect(notes).toEqual([]);
  });

  it('degrades a corrupt look to base-only rather than failing the load', () => {
    for (const junk of [null, 42, 'nope', [], { layers: 'no' }, { layers: [] }, { layers: [7] }]) {
      const { state } = validateAppState({ activeModuleId: 'clock', look: junk });
      expect(state.look).toEqual(baseLook('clock'));
    }
  });

  it('repairs a ninth layer by dropping the tail, and says so', () => {
    const layers = [
      { id: BASE_LAYER_ID, kind: 'video', on: true, frame: 'panel', t: IDENTITY },
      ...Array.from({ length: 8 }, (_, i) => overlay(`lover00${String(i)}`)),
    ];
    const { state, notes } = validateAppState({ activeModuleId: 'video', look: { layers } });
    expect(state.look.layers).toHaveLength(MAX_LAYERS);
    expect(notes.map((n) => n.path)).toContain('look.layers.length');
    // Never a truncated layer: what survives is whole.
    expect(state.look.layers[MAX_LAYERS - 1]).toEqual(layers[MAX_LAYERS - 1]);
  });

  it('notes an oversized look but keeps every layer — a drop would be data loss', () => {
    const layers = [
      { id: BASE_LAYER_ID, kind: 'video', on: true, frame: 'panel', t: IDENTITY },
      { ...overlay('lbig0001'), cfg: { text: 'x'.repeat(MAX_LOOK_BYTES) } },
    ];
    const { state, notes } = validateAppState({ activeModuleId: 'video', look: { layers } });
    expect(state.look.layers).toHaveLength(2);
    expect(notes.map((n) => n.path)).toContain('look.bytes');
  });

  it('reports a bad layer at its own path, so diagnostics can point at it', () => {
    const layers = [
      { id: BASE_LAYER_ID, kind: 'video', on: true, frame: 'panel', t: IDENTITY },
      { ...overlay('lclock01'), t: { x: 99, y: 0, s: 1, r: 0, a: 1 } },
    ];
    const { notes } = validateAppState({ activeModuleId: 'video', look: { layers } });
    expect(notes.map((n) => n.path)).toContain('look.layers[1].t.x');
  });

  it('reconciles the base kind with activeModuleId, keeping the overlays', () => {
    // What a module switch looks like for this release: a writer commits
    // `activeModuleId` and nothing else, and the base follows it.
    const layers = [
      { id: BASE_LAYER_ID, kind: 'video', on: true, frame: 'panel', t: IDENTITY },
      overlay('lstats01'),
    ];
    const { state } = validateAppState({ activeModuleId: 'clock', look: { layers } });
    expect(state.look.layers[0]?.kind).toBe('clock');
    expect(state.look.layers[1]?.id).toBe('lstats01');
    expect(selectActiveModuleId(state)).toBe('clock');
  });

  it('never leaves the two homes for the base kind disagreeing', () => {
    const inputs: unknown[] = [
      {},
      { activeModuleId: 'image' },
      { look: baseLook('stats') },
      { activeModuleId: 'A_B_C', look: baseLook('stats') },
      { activeModuleId: 'text', look: { layers: [{ id: 'nope', kind: 'shape' }] } },
    ];
    for (const input of inputs) {
      const { state } = validateAppState(input);
      expect(state.look.layers[0]?.kind).toBe(state.activeModuleId);
    }
  });

  it('is idempotent over the look, garbage included', () => {
    for (const junk of [
      {},
      { look: 'nope' },
      { activeModuleId: 'clock', look: { layers: [{}] } },
    ]) {
      const once = validateAppState(junk).state;
      expect(validateAppState(once).state).toEqual(once);
    }
  });
});

/**
 * The carousel (§4) — the first additive field that did NOT move the schema.
 *
 * `schema.ts` carries the argument; these are the properties that argument
 * rests on. The field is optional, absent by default, and repaired down to
 * absent whenever what is left could not rotate — so nothing downstream ever has
 * to ask whether a "carousel" with one entry is a carousel.
 */
describe('the carousel field', () => {
  it('is absent from a document that never had one', () => {
    const { state } = validateAppState({});
    expect(Object.hasOwn(state, 'carousel')).toBe(false);
    // …and stays absent through a round trip, which is what keeps the stored
    // document from growing a key that means nothing.
    expect(JSON.stringify(state)).not.toContain('carousel');
  });

  it('keeps a rotation of two or more, clamping the interval', () => {
    const { state } = validateAppState({
      carousel: { lookIds: ['a', 'b', 'c'], intervalSec: 999_999 },
    });
    expect(state.carousel).toEqual({ lookIds: ['a', 'b', 'c'], intervalSec: 3600 });
  });

  it('turns itself off rather than rotating between one Look and itself', () => {
    for (const junk of [
      { lookIds: ['only-one'], intervalSec: 60 },
      { lookIds: [], intervalSec: 60 },
      { lookIds: 'nope' },
      'not an object',
      null,
    ]) {
      expect(validateAppState({ carousel: junk }).state.carousel).toBeUndefined();
    }
  });

  it('drops an id that is not one, and a duplicate, keeping the rest', () => {
    const { state } = validateAppState({
      carousel: { lookIds: ['a', 'a', 'has spaces', 'b', 42], intervalSec: 60 },
    });
    expect(state.carousel?.lookIds).toEqual(['a', 'b']);
  });

  it('says what it repaired', () => {
    const { notes } = validateAppState({ carousel: { lookIds: ['a'], intervalSec: 60 } });
    expect(notes.some((n) => n.path === 'carousel')).toBe(true);
  });

  it('is idempotent, like every other section', () => {
    for (const input of [
      { carousel: { lookIds: ['a', 'b'], intervalSec: 45 } },
      { carousel: { lookIds: ['a'], intervalSec: 45 } },
      {},
    ]) {
      const once = validateAppState(input).state;
      expect(validateAppState(once).state).toEqual(once);
    }
  });
});
