import { describe, expect, it } from 'vitest';

import { migrate } from './migrations';
import { SCHEMA_VERSION } from './schema';

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
    expect(result.raw).toEqual({ ...v1, schema: SCHEMA_VERSION });
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
    expect(migrate(doc).raw).toEqual({ ...doc, schema: SCHEMA_VERSION });
  });

  it('survives a document whose module slots are nonsense', () => {
    expect(migrate({ schema: 5, modules: { video: 7, image: null } }).notes).toEqual([]);
    expect(migrate({ schema: 5, modules: 'nope' }).notes).toEqual([]);
  });
});
