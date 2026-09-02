import { describe, expect, it } from 'vitest';

import { DEFAULT_MODULE_ID } from './defaults';
import { BASE_LAYER_ID, IDENTITY, baseLook } from './look/types';
import { MIGRATION_VERSIONS, migrate } from './migrations';
import { SCHEMA_HISTORY, SCHEMA_VERSION } from './schema';
import { validateAppState } from './validate';

describe('migrate', () => {
  it('passes a current-schema document straight through', () => {
    const doc = { schema: SCHEMA_VERSION, activeModuleId: 'clock' };
    const result = migrate(doc);
    expect(result.raw).toEqual(doc);
    expect(result.notes).toEqual([]);
    expect(result.future).toBeNull();
  });

  it('assumes v1 for a document with no schema field, then migrates it forward', () => {
    const result = migrate({ activeModuleId: 'stats' });
    expect(result.notes).toContain('missing-schema');
    expect((result.raw as { schema: number }).schema).toBe(SCHEMA_VERSION);
    expect((result.raw as { activeModuleId: string }).activeModuleId).toBe('stats');
  });

  it('carries a v1 document to the current schema without touching anything else', () => {
    const v1 = {
      schema: 1,
      activeModuleId: 'video',
      render: { fit: 'cover', zoom: 1 },
      modules: { video: { v: 1, cfg: { url: 'x' } } },
    };
    const result = migrate(v1);
    expect(result.notes).toEqual([]);
    expect(result.future).toBeNull();
    // The one thing every step ADDS is the look (6 → 7); nothing else moves.
    expect(result.raw).toEqual({ ...v1, schema: SCHEMA_VERSION, look: baseLook('video') });
  });

  it('preserves — never destroys — state written by a newer build', () => {
    const future = { schema: SCHEMA_VERSION + 5, somethingNew: true };
    const result = migrate(future);
    expect(result.notes).toContain('future-schema');
    expect(result.future).toBe(JSON.stringify(future));
    expect((result.raw as { schema: number }).schema).toBe(SCHEMA_VERSION);
  });

  it('renames the clock-lite placeholder to clock, carrying its config across', () => {
    const v3 = {
      schema: 3,
      activeModuleId: 'clock-lite',
      modules: {
        'clock-lite': { v: 1, cfg: { format: '12', showSeconds: false, color: '#fff' } },
        video: { v: 1, cfg: { url: 'x' } },
      },
    };
    const result = migrate(v3);
    const raw = result.raw as {
      activeModuleId: string;
      modules: Record<string, { v: number; cfg: Record<string, unknown> }>;
    };
    expect(result.notes).toEqual([]);
    expect(raw.activeModuleId).toBe('clock');
    expect(raw.modules['clock-lite']).toBeUndefined();
    expect(raw.modules['clock']?.cfg).toEqual({
      face: 'digital',
      hourFormat: '12',
      showSeconds: false,
    });
    // Every other module's slot is untouched.
    expect(raw.modules['video']).toEqual({ v: 1, cfg: { url: 'x' } });
  });

  it('leaves an existing clock slot alone — it is newer than the placeholder', () => {
    const result = migrate({
      schema: 3,
      activeModuleId: 'clock-lite',
      modules: {
        'clock-lite': { v: 1, cfg: { format: '12' } },
        clock: { v: 1, cfg: { face: 'analog' } },
      },
    });
    const raw = result.raw as { modules: Record<string, { cfg: unknown }> };
    expect(raw.modules['clock']?.cfg).toEqual({ face: 'analog' });
    expect(raw.modules['clock-lite']).toBeUndefined();
  });

  it('renames the active module even when no config slot exists', () => {
    const result = migrate({ schema: 3, activeModuleId: 'clock-lite' });
    expect((result.raw as { activeModuleId: string }).activeModuleId).toBe('clock');
  });

  it('degrades to defaults rather than throwing on non-objects', () => {
    for (const input of [null, 42, 'nope', []]) {
      const result = migrate(input);
      expect(result.notes).toContain('not-an-object');
      expect((result.raw as { schema: number }).schema).toBe(SCHEMA_VERSION);
    }
  });

  it('is idempotent', () => {
    const once = migrate({
      activeModuleId: 'clock-lite',
      modules: { 'clock-lite': { v: 1, cfg: {} } },
    });
    const twice = migrate(once.raw);
    expect(twice.raw).toEqual(once.raw);
  });
});

/**
 * 5 → 6, the settings census.
 *
 * The design audit killed six controls and cut a seven-option picker to three.
 * A stored value with no control is worse than no value at all: it keeps
 * changing what the cooler renders with nothing on screen able to change it
 * back. Every key below is DELETED so the module's own validator refills it
 * with the default the audit named.
 */
describe('migrate 5 → 6 — the settings census', () => {
  function v5(cfg: Record<string, unknown>, id = 'video') {
    return { schema: 5, activeModuleId: id, modules: { [id]: { v: 2, cfg } } };
  }

  function cfgOf(result: ReturnType<typeof migrate>, id = 'video'): Record<string, unknown> {
    const raw = result.raw as { modules: Record<string, { cfg: Record<string, unknown> }> };
    return raw.modules[id]?.cfg ?? {};
  }

  it('retires every control the census killed', () => {
    const out = cfgOf(
      migrate(
        v5({
          url: 'https://example.test/a.mp4',
          perf: 'performance',
          loop: { enabled: true, start: 18, end: 42, mode: 'crossfade', crossfadeMs: 400 },
          youtube: {
            sourceAspect: 'auto',
            mode: 'tight',
            portraitWidth: 1440,
            pauseStrategy: 'maskedPause',
            maskColor: '#000000',
          },
        }),
      ),
    );

    expect(out['perf']).toBeUndefined();
    expect(out['loop']).toEqual({ enabled: true, start: 18, end: 42 });
    expect(out['youtube']).toEqual({ sourceAspect: 'auto', maskColor: '#000000' });
    // The link itself is never touched. This step retires controls, not content.
    expect(out['url']).toBe('https://example.test/a.mp4');
  });

  it('collapses an aspect the three-segment override cannot show', () => {
    // 4:3 — one of the four exotic ratios the picker no longer offers. Leaving
    // it stored would render the control with nothing selected.
    const out = cfgOf(migrate(v5({ youtube: { sourceAspect: 4 / 3 } })));
    expect((out['youtube'] as Record<string, unknown>)['sourceAspect']).toBeUndefined();
  });

  it('keeps the two ratios the override still offers, and keeps auto', () => {
    for (const aspect of ['auto', 16 / 9, 9 / 16] as const) {
      const out = cfgOf(migrate(v5({ youtube: { sourceAspect: aspect } })));
      expect((out['youtube'] as Record<string, unknown>)['sourceAspect']).toBe(aspect);
    }
  });

  it('drops the image module’s background colour field', () => {
    const out = cfgOf(migrate(v5({ url: 'x', background: '#112233' }, 'image')), 'image');
    expect(out).toEqual({ url: 'x' });
  });

  it('leaves a document that never used any of them completely untouched', () => {
    const doc = v5({ url: 'x', loop: { enabled: false, start: 0, end: null } });
    expect(migrate(doc).raw).toEqual({
      ...doc,
      schema: SCHEMA_VERSION,
      look: baseLook('video'),
    });
  });

  it('survives a document whose module slots are nonsense', () => {
    expect(migrate({ schema: 5, modules: { video: 7, image: null } }).notes).toEqual([]);
    expect(migrate({ schema: 5, modules: 'nope' }).notes).toEqual([]);
  });
});

/**
 * 6 → 7, looks.
 *
 * The single module a v6 document could name becomes the one layer of a look:
 * base, whole panel, identity, no `cfg`. Everything interesting about this step
 * is that it is DETERMINISTIC — two CAM browsers migrate the same retained
 * snapshot independently, and a generated id would make last-writer-wins pick
 * one of them at random — and TOTAL: there is no shape of v6 document, however
 * corrupt, that comes out the other side without a renderable base.
 */
describe('migrate 6 → 7 — the look', () => {
  function v6(activeModuleId: unknown): Record<string, unknown> {
    return { schema: 6, activeModuleId, modules: { video: { v: 2, cfg: { url: 'x' } } } };
  }

  function lookOfRaw(raw: unknown): unknown {
    return (raw as { look: unknown }).look;
  }

  it('projects each module a v6 document could name into a base-only look', () => {
    for (const kind of ['video', 'clock', 'stats', 'image', 'text', 'shape', 'effect']) {
      expect(lookOfRaw(migrate(v6(kind)).raw)).toEqual({
        layers: [{ id: BASE_LAYER_ID, kind, on: true, frame: 'panel', t: IDENTITY }],
      });
    }
  });

  it('keeps the modules bank untouched — the base wears it, it does not move', () => {
    const raw = migrate(v6('video')).raw as { modules: unknown; look: { layers: unknown[] } };
    expect(raw.modules).toEqual({ video: { v: 2, cfg: { url: 'x' } } });
    expect(raw.look.layers[0]).not.toHaveProperty('cfg');
  });

  it('keeps activeModuleId as the mirrored write path for one more release', () => {
    expect((migrate(v6('clock')).raw as { activeModuleId: string }).activeModuleId).toBe('clock');
  });

  it('falls back to the default module for an unusable active id', () => {
    for (const junk of [undefined, null, 42, '', 'NOT VALID', {}, ['clock']]) {
      expect(lookOfRaw(migrate(v6(junk)).raw)).toEqual(baseLook(DEFAULT_MODULE_ID));
    }
  });

  it('is deterministic: the same v6 document migrates to the same bytes every time', () => {
    const doc = v6('stats');
    expect(JSON.stringify(migrate(doc).raw)).toBe(JSON.stringify(migrate(doc).raw));
  });

  it('is idempotent: migrate(migrate(x)) deep-equals migrate(x)', () => {
    const inputs: unknown[] = [
      v6('clock'),
      v6(null),
      { schema: 1, activeModuleId: 'clock-lite' },
      { activeModuleId: 'image' },
      'nonsense',
      null,
      [],
    ];
    for (const input of inputs) {
      const once = migrate(input);
      expect(migrate(once.raw).raw).toEqual(once.raw);
    }
  });

  it('leaves a look a newer peer already wrote alone', () => {
    const look = {
      layers: [
        { id: BASE_LAYER_ID, kind: 'video', on: true, frame: 'panel', t: IDENTITY },
        { id: 'lstats01', kind: 'stats', on: true, frame: { w: 1.6, h: 0.5, shape: 'square' } },
      ],
    };
    expect(lookOfRaw(migrate({ ...v6('clock'), look }).raw)).toEqual(look);
  });

  it('hands the validator something it repairs rather than rejects', () => {
    // The migration is structural; the repair is the validator's job. This is
    // the seam, so it is asserted at the seam.
    const { state } = validateAppState(migrate(v6('clock')).raw);
    expect(state.look).toEqual(baseLook('clock'));
    expect(state.activeModuleId).toBe('clock');
  });
});

describe('SCHEMA_HISTORY', () => {
  it('has a one-line description for every version, 1 to the current one', () => {
    for (let v = 1; v <= SCHEMA_VERSION; v += 1) {
      expect(typeof SCHEMA_HISTORY[v]).toBe('string');
      expect(SCHEMA_HISTORY[v]).toBeTruthy();
    }
  });

  it('is contiguous and stops at the current version — no gaps, no futures', () => {
    expect(Object.keys(SCHEMA_HISTORY).map(Number)).toEqual(
      Array.from({ length: SCHEMA_VERSION }, (_, i) => i + 1),
    );
  });

  it('covers every version a migration steps to', () => {
    expect(MIGRATION_VERSIONS).toEqual(Array.from({ length: SCHEMA_VERSION - 1 }, (_, i) => i + 1));
    for (const from of MIGRATION_VERSIONS) expect(SCHEMA_HISTORY[from + 1]).toBeTruthy();
  });
});
