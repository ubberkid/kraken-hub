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
