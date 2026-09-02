import { describe, expect, it } from 'vitest';

import { DEFAULT_MODULE_ID } from '../defaults';

import {
  selectBaseKind,
  selectLayerConfig,
  selectOverlays,
  switchBase,
  withLayer,
  withLayerConfig,
  type LookState,
} from './selectors';
import {
  BASE_LAYER_ID,
  IDENTITY,
  LAYER_ID_RE,
  MAX_LAYERS,
  MAX_LAYER_NAME,
  MAX_LOOK_BYTES,
  baseLook,
  lookBytes,
  mintLayerId,
  toTemplates,
  withIds,
  type Layer,
  type Look,
} from './types';
import { DEFAULT_OVERLAY_FRAME, validateLook } from './validate';

/** A well-formed base, so each test can say only what it is about. */
function base(kind: string): Layer {
  return { id: BASE_LAYER_ID, kind, on: true, frame: 'panel', t: IDENTITY };
}

/** A well-formed overlay, so each test can say only what it is about. */
function overlay(id: string, over: Partial<Layer> = {}): Layer {
  return {
    id,
    kind: 'stats',
    on: true,
    frame: { w: 1.6, h: 0.5, shape: 'square' },
    t: { x: 0, y: 0.6, s: 1, r: 0, a: 1 },
    cfg: {},
    ...over,
  };
}

function look(...layers: Layer[]): Look {
  return { layers };
}

describe('validateLook', () => {
  it('is total: never throws, always yields a base', () => {
    const inputs: unknown[] = [
      undefined,
      null,
      0,
      '',
      'panel',
      [],
      {},
      { layers: null },
      { layers: 'nope' },
      { layers: [null, 3, 'x', []] },
      { layers: [{ deeply: { wrong: [1, 2] } }] },
      { layers: [{ id: 'base', kind: 42, on: 'yes', frame: 7, t: 'nope' }] },
      NaN,
      new Date(0),
    ];
    for (const input of inputs) {
      expect(() => validateLook(input)).not.toThrow();
      const { look: out } = validateLook(input);
      expect(out.layers.length).toBeGreaterThanOrEqual(1);
      expect(out.layers[0]?.id).toBe(BASE_LAYER_ID);
      expect(out.layers[0]?.frame).toBe('panel');
      expect(out.layers[0]?.t).toEqual(IDENTITY);
    }
  });

  it('defaults an empty or missing look to the default module base', () => {
    expect(validateLook(undefined).look).toEqual(baseLook(DEFAULT_MODULE_ID));
    expect(validateLook({}).look).toEqual(baseLook(DEFAULT_MODULE_ID));
    expect(validateLook({ layers: [] }).look).toEqual(baseLook(DEFAULT_MODULE_ID));
  });

  it('round-trips a valid look unchanged, with no notes', () => {
    const input = look(
      { id: BASE_LAYER_ID, kind: 'video', on: true, frame: 'panel', t: IDENTITY },
      overlay('lstats01', { name: 'CPU strip' }),
    );
    const { look: out, notes } = validateLook(input);
    expect(out).toEqual(input);
    expect(notes).toEqual([]);
  });

  it('is idempotent on junk', () => {
    const junk: unknown[] = [
      undefined,
      { layers: [{}, {}, {}] },
      { layers: [{ id: 'BASE', kind: 'video', cfg: { a: 1 }, v: 3, t: { x: 99, s: -4 } }] },
      { layers: [1, { id: 'lgood001', kind: 'clock' }, { id: '!!', kind: 'clock' }] },
    ];
    for (const input of junk) {
      const once = validateLook(input).look;
      const twice = validateLook(once).look;
      expect(twice).toEqual(once);
      expect(validateLook(twice).notes).toEqual([]);
    }
  });

  it('is idempotent on JSON round-trips', () => {
    const once = validateLook({
      layers: [{ kind: 'clock' }, { id: 'lover001', kind: 'image' }],
    }).look;
    expect(validateLook(JSON.parse(JSON.stringify(once))).look).toEqual(once);
  });

  // ---- positional base rules ------------------------------------------------

  it('strips a cfg (and v) from the base and notes it', () => {
    const { look: out, notes } = validateLook(
      look({
        id: BASE_LAYER_ID,
        kind: 'video',
        on: true,
        frame: 'panel',
        t: IDENTITY,
        cfg: { src: 'x' },
        v: 4,
      }),
    );
    expect(out.layers[0]).not.toHaveProperty('cfg');
    expect(out.layers[0]).not.toHaveProperty('v');
    expect(notes.map((n) => n.path)).toEqual(['look.layers[0].cfg', 'look.layers[0].v']);
    // idempotent: a second pass has nothing left to say
    expect(validateLook(out).notes).toEqual([]);
  });

  it('forces the base id, frame and transform', () => {
    const { look: out, notes } = validateLook(
      look({
        id: 'lnotbase1',
        kind: 'clock',
        on: true,
        frame: { w: 1, h: 1, shape: 'circle' },
        t: { x: 0.5, y: 0, s: 2, r: 10, a: 0.5 },
      }),
    );
    expect(out.layers[0]).toEqual({
      id: BASE_LAYER_ID,
      kind: 'clock',
      on: true,
      frame: 'panel',
      t: IDENTITY,
    });
    expect(notes.map((n) => n.path)).toEqual([
      'look.layers[0].id',
      'look.layers[0].frame',
      'look.layers[0].t',
    ]);
  });

  it('gives an overlay claiming frame:panel a box, and notes it', () => {
    const { look: out, notes } = validateLook(
      look(base('video'), overlay('lclock001', { frame: 'panel' })),
    );
    expect(out.layers[1]?.frame).toEqual(DEFAULT_OVERLAY_FRAME);
    expect(notes.map((n) => n.path)).toEqual(['look.layers[1].frame']);
    expect(validateLook(out).notes).toEqual([]);
  });

  it('gives an overlay with no cfg an empty one, and keeps a cfg verbatim', () => {
    const weird = { fork: { only: [1, { deep: true }] } };
    const { look: out } = validateLook(
      look(
        base('video'),
        overlay('lnocfg001', { cfg: undefined }),
        overlay('lforkcfg', { kind: 'not-ours', cfg: weird }),
      ),
    );
    expect(out.layers[1]?.cfg).toEqual({});
    expect(out.layers[2]?.cfg).toBe(weird);
    expect(out.layers[2]?.kind).toBe('not-ours'); // unknown kinds are preserved
  });

  // ---- per-layer coercion ---------------------------------------------------

  it('drops layers with a bad or duplicate id, and notes each one', () => {
    const { look: out, notes } = validateLook({
      layers: [
        { id: BASE_LAYER_ID, kind: 'video', on: true, frame: 'panel', t: IDENTITY },
        overlay('lkeep0001'),
        overlay('!!'),
        overlay('lkeep0001'),
        overlay(BASE_LAYER_ID),
      ],
    });
    expect(out.layers.map((l) => l.id)).toEqual([BASE_LAYER_ID, 'lkeep0001']);
    expect(notes.map((n) => n.path)).toEqual([
      'look.layers[2].id',
      'look.layers[3].id',
      'look.layers[4].id',
    ]);
  });

  it('clamps the transform to TRANSFORM_LIMITS', () => {
    const { look: out } = validateLook(
      look(base('video'), overlay('lclamp01', { t: { x: 9, y: -9, s: 100, r: 400, a: 5 } })),
    );
    expect(out.layers[1]?.t).toEqual({ x: 1.5, y: -1.5, s: 4, r: 180, a: 1 });
  });

  it('clamps a box frame and coerces its shape', () => {
    const { look: out } = validateLook(
      look(base('video'), overlay('lframe01', { frame: { w: 99, h: 0, shape: 'blob' } as never })),
    );
    expect(out.layers[1]?.frame).toEqual({ w: 3, h: 0.1, shape: 'square' });
  });

  it('truncates an over-long name', () => {
    const long = 'x'.repeat(MAX_LAYER_NAME + 10);
    const { look: out, notes } = validateLook(
      look(base('video'), overlay('lname001', { name: long })),
    );
    expect(out.layers[1]?.name).toHaveLength(MAX_LAYER_NAME);
    expect(notes.map((n) => n.path)).toEqual(['look.layers[1].name']);
  });

  // ---- caps -----------------------------------------------------------------

  it('drops the tail past MAX_LAYERS and notes it (9 layers in, 8 out)', () => {
    const layers: Layer[] = [base('video')];
    for (let i = 1; i <= MAX_LAYERS; i += 1) layers.push(overlay(`lover000${String(i)}`));
    expect(layers).toHaveLength(MAX_LAYERS + 1);

    const { look: out, notes } = validateLook({ layers });
    expect(out.layers).toHaveLength(MAX_LAYERS);
    expect(notes).toContainEqual({ path: 'look.layers.length', got: 9, used: MAX_LAYERS });
    expect(validateLook(out).notes).toEqual([]);
  });

  it('NOTES an oversized look and never drops a layer for it', () => {
    const fat = 'y'.repeat(MAX_LOOK_BYTES);
    const input = look(base('video'), overlay('lfat0001', { cfg: { text: fat } }));
    const { look: out, notes } = validateLook(input);
    expect(out.layers).toHaveLength(2);
    expect(out.layers[1]?.cfg).toEqual({ text: fat });
    expect(lookBytes(out)).toBeGreaterThan(MAX_LOOK_BYTES);
    expect(notes).toContainEqual({
      path: 'look.bytes',
      got: lookBytes(out),
      used: MAX_LOOK_BYTES,
    });
  });

  /**
   * `locked` (§2.2) — optional, which is why the schema stays at 7.
   *
   * Every document ever written is already valid with this field absent, and
   * absent means unlocked; the validator is the only gate the field has, so the
   * repair rules live here and nowhere else.
   */
  describe('locked', () => {
    it('keeps a `true`', () => {
      const { look: out, notes } = validateLook(
        look(base('video'), overlay('llock001', { locked: true })),
      );
      expect(out.layers[1]?.locked).toBe(true);
      expect(notes).toEqual([]);
    });

    it('drops a `false` — absent IS unlocked, and it is fewer bytes', () => {
      const { look: out, notes } = validateLook(
        look(base('video'), overlay('llock002', { locked: false })),
      );
      expect(Object.hasOwn(out.layers[1] ?? {}, 'locked')).toBe(false);
      expect(notes).toEqual([]);
    });

    it('repairs anything that is not a boolean, and says so', () => {
      const { look: out, notes } = validateLook({
        layers: [base('video'), { ...overlay('llock003'), locked: 'yes' }],
      });
      expect(Object.hasOwn(out.layers[1] ?? {}, 'locked')).toBe(false);
      // A corrupt value must never be able to lock somebody out of their own
      // layer, and it must not do it silently either.
      expect(notes).toContainEqual({ path: 'look.layers[1].locked', got: 'yes', used: undefined });
    });

    it('is idempotent, like every other field', () => {
      const once = validateLook(look(base('video'), overlay('llock004', { locked: true }))).look;
      expect(validateLook(once).look).toEqual(once);
      expect(validateLook(once).notes).toEqual([]);
    });

    it('rides the wire — it survives a JSON round trip', () => {
      const once = validateLook(look(base('video'), overlay('llock005', { locked: true }))).look;
      expect(validateLook(JSON.parse(JSON.stringify(once))).look).toEqual(once);
    });
  });
});

describe('look types', () => {
  it('baseLook is deterministic and cfg-less', () => {
    expect(baseLook('clock')).toEqual(baseLook('clock'));
    expect(baseLook('clock').layers[0]).not.toHaveProperty('cfg');
  });

  it('withIds mints base at 0 and valid unique ids above it, toTemplates strips them', () => {
    const templates = toTemplates([base('video'), overlay('lone0001'), overlay('ltwo0001')]);
    expect(templates.every((t) => !('id' in t))).toBe(true);

    const layers = withIds(templates);
    expect(layers[0]?.id).toBe(BASE_LAYER_ID);
    expect(new Set(layers.map((l) => l.id)).size).toBe(3);
    for (const l of layers) expect(LAYER_ID_RE.test(l.id)).toBe(true);
    expect(validateLook({ layers }).notes).toEqual([]);
  });

  it('mints overlay ids at the one length the editor also uses', () => {
    // `l` + 7, matching `addLayer` in src/app/config/editor/ops.ts. One id
    // length in the document, so nothing downstream learns to read a shape.
    const minted = withIds(toTemplates([base('video'), overlay('lx00001')])).slice(1);
    for (const id of [mintLayerId(), ...minted.map((l) => l.id)]) {
      expect(id).toHaveLength(8);
      expect(id.startsWith('l')).toBe(true);
      expect(LAYER_ID_RE.test(id)).toBe(true);
    }
  });

  it('lookBytes is the JSON length', () => {
    const l = baseLook('video');
    expect(lookBytes(l)).toBe(JSON.stringify(l).length);
  });
});

describe('look selectors', () => {
  const state: LookState = {
    look: look(base('video'), overlay('lstats01')),
    modules: { video: { v: 2, cfg: { src: 'demo' } }, stats: { v: 1, cfg: { layout: 'dial' } } },
  };

  it('reads the base kind and the overlays', () => {
    expect(selectBaseKind(state)).toBe('video');
    expect(selectOverlays(state).map((l) => l.id)).toEqual(['lstats01']);
  });

  it('reads the base config from the bank and an overlay config from the layer', () => {
    expect(selectLayerConfig(state, state.look.layers[0]!)).toEqual({ src: 'demo' });
    expect(
      selectLayerConfig(
        {
          ...state,
          look: look(state.look.layers[0]!, overlay('lstats01', { cfg: { a: 1 } })),
        },
        overlay('lstats01', { cfg: { a: 1 } }),
      ),
    ).toEqual({ a: 1 });
  });

  it('writes the base config to the bank and an overlay config to the layer', () => {
    const banked = withLayerConfig(state, BASE_LAYER_ID, 3, { src: 'other' });
    expect(banked.modules['video']).toEqual({ v: 3, cfg: { src: 'other' } });
    expect(banked.look.layers[0]).not.toHaveProperty('cfg');

    const inline = withLayerConfig(state, 'lstats01', 5, { layout: 'strip' });
    expect(inline.look.layers[1]?.cfg).toEqual({ layout: 'strip' });
    expect(inline.look.layers[1]?.v).toBe(5);
    expect(inline.modules).toBe(state.modules);
  });

  it('switchBase keeps overlays and the outgoing config in the bank', () => {
    const next = switchBase(state, 'clock');
    expect(selectBaseKind(next)).toBe('clock');
    expect(next.look.layers[1]).toEqual(state.look.layers[1]);
    expect(next.modules['video']).toEqual({ v: 2, cfg: { src: 'demo' } });
    expect(validateLook(next.look).notes).toEqual([]);
  });

  it('withLayer refuses to give the base a frame, transform or cfg', () => {
    const next = withLayer(state, BASE_LAYER_ID, {
      on: false,
      frame: { w: 1, h: 1, shape: 'circle' },
      t: { x: 1, y: 1, s: 2, r: 90, a: 0.5 },
      cfg: { sneaky: true },
    });
    expect(next.look.layers[0]).toEqual({
      id: BASE_LAYER_ID,
      kind: 'video',
      on: false,
      frame: 'panel',
      t: IDENTITY,
    });
  });
});
