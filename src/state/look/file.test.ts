import { describe, expect, it } from 'vitest';

import { LOCAL_IMAGE_SCHEME } from '../../modules/image/schema';
import { LOCAL_CLIP_SCHEME } from '../../modules/video/routing/patterns';
import { SCHEMA_VERSION } from '../schema';

import {
  BASE_ROLE,
  LOOK_FILE_EXTENSION,
  LOOK_FILE_FORMAT,
  MAX_LOOK_FILE_BYTES,
  applyLookFile,
  exportLook,
  lookFileBytes,
  parseLookFile,
  resolveMedia,
  serializeLookFile,
  type LookFile,
  type MediaEntry,
} from './file';
import { type LookState } from './selectors';
import { BASE_LAYER_ID, IDENTITY, MAX_LOOK_BYTES, type Layer } from './types';
import { validateLook } from './validate';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CREATED_AT = '2026-09-02T00:00:00.000Z';

function overlay(id: string, kind: string, cfg: unknown): Layer {
  return {
    id,
    kind,
    on: true,
    frame: { w: 1, h: 1, shape: 'square' },
    t: { ...IDENTITY },
    cfg,
    v: 1,
  };
}

function stateWith(baseKind: string, cfg: unknown, overlays: Layer[] = []): LookState {
  return {
    look: {
      layers: [
        { id: BASE_LAYER_ID, kind: baseKind, on: true, frame: 'panel', t: IDENTITY },
        ...overlays,
      ],
    },
    modules: { [baseKind]: { v: 1, cfg } },
  };
}

const CLIP: MediaEntry = {
  id: 'clip-abcd1234',
  kind: 'clip',
  name: 'sunset.mp4',
  hash: 'deadbeefcafe',
  sourceUrl: 'https://example.test/sunset.mp4',
};

const PICTURE: MediaEntry = {
  id: 'img-9999',
  kind: 'image',
  name: 'wall.png',
  hash: null,
  sourceUrl: null,
};

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

describe('serializeLookFile', () => {
  it('sorts keys at every depth and ends with one newline', () => {
    const state = stateWith('clock', { theme: 'mono', face: 'digital' });
    const text = serializeLookFile(exportLook(state, { name: 'A', createdAt: CREATED_AT }));
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.indexOf('"author"')).toBe(-1); // absent stays absent, not `undefined`
    const keys = [...text.matchAll(/^ {2}"(\w+)"/gm)].map((m) => m[1]);
    expect(keys).toEqual([...keys].sort());
    expect(text).toContain('"face": "digital"');
    expect(text.indexOf('"face"')).toBeLessThan(text.indexOf('"theme"'));
  });

  it('measures a file in the same unit as the cap', () => {
    const file = exportLook(stateWith('clock', {}), { name: 'A', createdAt: CREATED_AT });
    // Compact, like `lookBytes`: the pretty file on disk is larger, and both
    // are comfortably inside the cap.
    expect(lookFileBytes(file)).toBe(JSON.stringify(JSON.parse(serializeLookFile(file))).length);
    expect(lookFileBytes(file)).toBeLessThan(serializeLookFile(file).length);
    expect(serializeLookFile(file).length).toBeLessThan(MAX_LOOK_FILE_BYTES);
  });

  it('names the extension once', () => {
    expect(LOOK_FILE_EXTENSION).toBe('.krakenlook');
  });
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

describe('export → import → export', () => {
  it('is byte-identical', () => {
    const state = stateWith('effect', { effect: 'plasma', preset: 'classic' }, [
      overlay('lclock', 'clock', { face: 'analog' }),
    ]);
    const first = serializeLookFile(
      exportLook(state, {
        name: 'Round trip',
        author: 'someone',
        description: 'A Look that survives a file.',
        createdAt: CREATED_AT,
      }),
    );
    const parsed = parseLookFile(first);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.notes).toEqual([]);
    expect(serializeLookFile(parsed.file)).toBe(first);
  });

  it('is stable across a second lap', () => {
    const one = serializeLookFile(
      exportLook(stateWith('stats', { layout: 'triple' }), { name: 'S', createdAt: CREATED_AT }),
    );
    const two = parseLookFile(one);
    expect(two.ok).toBe(true);
    if (!two.ok) return;
    const three = parseLookFile(serializeLookFile(two.file));
    expect(three.ok).toBe(true);
    if (!three.ok) return;
    expect(serializeLookFile(three.file)).toBe(one);
  });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

describe('exportLook', () => {
  it('carries the base kind config, because the base wears the bank', () => {
    const state = stateWith('clock', { face: 'analog' });
    const file = exportLook(state, { name: 'Clock', createdAt: CREATED_AT });
    expect(file.configs).toEqual({ clock: { face: 'analog' } });
    expect(file.configVersions).toEqual({ clock: 1 });
    expect(file.look.layers[0]?.cfg).toBeUndefined();
  });

  it('lifts a local clip into the media table by hash, and empties the url', () => {
    const state = stateWith('video', {
      url: `${LOCAL_CLIP_SCHEME}${CLIP.id}`,
      demoWhenEmpty: false,
    });
    const file = exportLook(state, { name: 'V', createdAt: CREATED_AT }, [CLIP]);
    expect(file.media).toEqual([
      { role: BASE_ROLE, kind: 'hash', value: CLIP.hash, name: CLIP.name },
    ]);
    expect(file.configs['video']).toEqual({ url: '', demoWhenEmpty: false });
  });

  it('falls back to the source url when the library knows no hash', () => {
    const noHash: MediaEntry = { ...CLIP, hash: null };
    const state = stateWith('video', { url: `${LOCAL_CLIP_SCHEME}${CLIP.id}` });
    const file = exportLook(state, { name: 'V', createdAt: CREATED_AT }, [noHash]);
    expect(file.media[0]).toEqual({
      role: BASE_ROLE,
      kind: 'url',
      value: CLIP.sourceUrl,
      name: CLIP.name,
    });
    // A URL is portable, so it stays in the config rather than being emptied.
    expect(file.configs['video']).toEqual({ url: CLIP.sourceUrl });
  });

  it('records an unresolvable local id anyway, so the import can name it', () => {
    const state = stateWith('image', { url: `${LOCAL_IMAGE_SCHEME}${PICTURE.id}` });
    const file = exportLook(state, { name: 'P', createdAt: CREATED_AT }, [PICTURE]);
    expect(file.media[0]).toEqual({
      role: BASE_ROLE,
      kind: 'hash',
      value: PICTURE.id,
      name: PICTURE.name,
    });
  });

  it('keeps a remote url exactly where it was', () => {
    const url = 'https://example.test/clip.mp4';
    const file = exportLook(stateWith('video', { url }), { name: 'V', createdAt: CREATED_AT });
    expect(file.media).toEqual([{ role: BASE_ROLE, kind: 'url', value: url }]);
    expect(file.configs['video']).toEqual({ url });
  });

  it('lifts an overlay by its layer id', () => {
    const state = stateWith('clock', {}, [
      overlay('limage', 'image', { url: `${LOCAL_IMAGE_SCHEME}${PICTURE.id}` }),
    ]);
    const file = exportLook(state, { name: 'O', createdAt: CREATED_AT }, [PICTURE]);
    expect(file.media[0]?.role).toBe('limage');
    expect(file.look.layers[1]?.cfg).toEqual({ url: '' });
  });

  it('truncates over-long metadata rather than refusing to export', () => {
    const file = exportLook(stateWith('clock', {}), {
      name: 'n'.repeat(500),
      author: 'a'.repeat(500),
      description: 'd'.repeat(500),
      createdAt: CREATED_AT,
    });
    expect(file.name.length).toBe(60);
    expect(file.author?.length).toBe(200);
    expect(file.description?.length).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('parseLookFile refusals', () => {
  it('refuses bytes that are not JSON', () => {
    const r = parseLookFile('{not json');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason.code).toBe('not-json');
  });

  it('refuses a value that is not an object', () => {
    expect(parseLookFile('[]')).toEqual({ ok: false, reason: { code: 'not-an-object' } });
    expect(parseLookFile('42')).toEqual({ ok: false, reason: { code: 'not-an-object' } });
  });

  it('refuses a foreign format', () => {
    const r = parseLookFile(JSON.stringify({ format: 'some-other-app', version: 7 }));
    expect(r).toEqual({ ok: false, reason: { code: 'wrong-format', got: 'some-other-app' } });
  });

  it('refuses a payload over the file cap, before parsing it', () => {
    const r = parseLookFile('x'.repeat(MAX_LOOK_FILE_BYTES + 1));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toEqual({
      code: 'too-big',
      bytes: MAX_LOOK_FILE_BYTES + 1,
      max: MAX_LOOK_FILE_BYTES,
    });
  });

  it('refuses an oversized already-parsed object too', () => {
    const r = parseLookFile({ format: LOOK_FILE_FORMAT, pad: 'x'.repeat(MAX_LOOK_FILE_BYTES) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason.code).toBe('too-big');
  });

  it('refuses a file from a newer build rather than guessing at it', () => {
    const r = parseLookFile(
      JSON.stringify({ format: LOOK_FILE_FORMAT, version: SCHEMA_VERSION + 1 }),
    );
    expect(r).toEqual({
      ok: false,
      reason: { code: 'future-version', got: SCHEMA_VERSION + 1, max: SCHEMA_VERSION },
    });
  });

  it('refuses a structure JSON cannot express', () => {
    const cyclic: Record<string, unknown> = { format: LOOK_FILE_FORMAT };
    cyclic['self'] = cyclic;
    const r = parseLookFile(cyclic);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason.code).toBe('not-json');
  });
});

// ---------------------------------------------------------------------------
// Totality
// ---------------------------------------------------------------------------

describe('parseLookFile totality', () => {
  const cyclic: Record<string, unknown> = { format: LOOK_FILE_FORMAT };
  cyclic['loop'] = cyclic;

  const FUZZ: unknown[] = [
    undefined,
    null,
    0,
    -1,
    Number.NaN,
    '',
    '{',
    '[]',
    '"a string"',
    'null',
    {},
    [],
    { format: LOOK_FILE_FORMAT },
    { format: LOOK_FILE_FORMAT, version: 'seven' },
    { format: LOOK_FILE_FORMAT, version: 7, look: 'not a look' },
    { format: LOOK_FILE_FORMAT, version: 7, look: { layers: [1, 2, 3] } },
    { format: LOOK_FILE_FORMAT, version: 7, configs: [] },
    { format: LOOK_FILE_FORMAT, version: 7, configs: { 'NOT A KIND': {} } },
    { format: LOOK_FILE_FORMAT, version: 7, media: 'nope' },
    { format: LOOK_FILE_FORMAT, version: 7, media: [null, {}, { role: 1 }] },
    { format: LOOK_FILE_FORMAT, version: 0.5, name: 12, createdAt: false, author: [] },
    { format: LOOK_FILE_FORMAT, version: 7, look: { layers: [{ kind: 'stats', cfg: { a: 1 } }] } },
    cyclic,
  ];

  const REFUSALS = ['not-json', 'not-an-object', 'wrong-format', 'too-big', 'future-version'];

  /**
   * Both outcomes reduced to one shape, so the whole claim is a single
   * assertion: EITHER a known refusal, OR a file that is canonical, carries at
   * least a base layer, needs no further repair, and survives its serialiser.
   */
  function outcomeOf(input: unknown): Record<string, unknown> {
    const r = parseLookFile(input);
    if (!r.ok) return { refused: REFUSALS.includes(r.reason.code) };
    const text = serializeLookFile(r.file);
    return {
      refused: false,
      format: r.file.format,
      version: r.file.version,
      name: typeof r.file.name,
      hasBase: r.file.look.layers.length >= 1,
      // The repaired look is already clean: validating again changes nothing.
      clean: validateLook(r.file.look).notes,
      media: Array.isArray(r.file.media),
      stable: text === serializeLookFile(r.file),
    };
  }

  const PARSED = {
    refused: false,
    format: LOOK_FILE_FORMAT,
    version: SCHEMA_VERSION,
    name: 'string',
    hasBase: true,
    clean: [],
    media: true,
    stable: true,
  };

  it.each(FUZZ.map((input, i) => [i, input] as const))('survives fuzz input %i', (_i, input) => {
    const outcome = outcomeOf(input);
    // A refusal reduces to `{ refused: true }` — and reduces to `{ refused:
    // false }`, which does NOT match, if the code was not one of the five.
    expect(outcome).toEqual(outcome['refused'] === true ? { refused: true } : PARSED);
  });

  it('counts twenty-odd inputs, so the table is not quietly emptied', () => {
    expect(FUZZ.length).toBeGreaterThanOrEqual(20);
  });
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

describe('parseLookFile migration', () => {
  it('turns a v6 file, which predates looks, into a one-layer look', () => {
    const r = parseLookFile(
      JSON.stringify({
        format: LOOK_FILE_FORMAT,
        version: 6,
        name: 'Old clock',
        createdAt: CREATED_AT,
        configs: { clock: { face: 'analog' } },
        media: [],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file.version).toBe(SCHEMA_VERSION);
    expect(r.file.look.layers).toHaveLength(1);
    expect(r.file.look.layers[0]).toMatchObject({ id: BASE_LAYER_ID, kind: 'clock' });
    expect(r.file.configs).toEqual({ clock: { face: 'analog' } });
    expect(r.notes.some((n) => n.path === 'version')).toBe(true);
  });

  it('reuses the document migration rather than forking it (v5 settings census)', () => {
    const r = parseLookFile({
      format: LOOK_FILE_FORMAT,
      version: 5,
      name: 'Old video',
      createdAt: CREATED_AT,
      configs: { video: { url: 'https://example.test/a.mp4', perf: 'performance' } },
      configVersions: { video: 1 },
      media: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // `perf` is a control the census retired; the shared migration drops it.
    expect(r.file.configs['video']).toEqual({ url: 'https://example.test/a.mp4' });
    expect(r.file.look.layers[0]?.kind).toBe('video');
  });

  it('does not migrate a current file, so a round trip stays byte-identical', () => {
    const file = exportLook(stateWith('clock', { face: 'analog' }), {
      name: 'Now',
      createdAt: CREATED_AT,
    });
    const r = parseLookFile(serializeLookFile(file));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.notes).toEqual([]);
  });

  it('clamps a nonsense version into the ladder instead of losing the look', () => {
    const r = parseLookFile({ format: LOOK_FILE_FORMAT, version: -3, name: 'x' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file.version).toBe(SCHEMA_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Repair notes
// ---------------------------------------------------------------------------

describe('parseLookFile repairs', () => {
  it('never rejects on an optional field, and notes what it did', () => {
    const r = parseLookFile({
      format: LOOK_FILE_FORMAT,
      version: SCHEMA_VERSION,
      name: 'n'.repeat(400),
      author: 7,
      description: null,
      createdAt: undefined,
      unknownFieldFromTheFuture: { anything: true },
      look: { layers: [{ id: 'base', kind: 'stats', on: true, frame: 'panel', t: IDENTITY }] },
      configs: { stats: { layout: 'grid' } },
      media: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file.name.length).toBe(60);
    expect(r.file.author).toBeUndefined();
    expect(r.file.createdAt).toBe(new Date(0).toISOString());
    expect(r.notes.map((n) => n.path)).toEqual(
      expect.arrayContaining(['name', 'author', 'description', 'createdAt']),
    );
  });

  it('drops a malformed media entry and keeps the good ones', () => {
    const r = parseLookFile({
      format: LOOK_FILE_FORMAT,
      version: SCHEMA_VERSION,
      name: 'M',
      createdAt: CREATED_AT,
      media: [
        { role: 'base', kind: 'hash', value: 'abc', name: 'a.mp4' },
        { role: 'base', kind: 'telepathy', value: 'abc' },
        'not an object',
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file.media).toEqual([{ role: 'base', kind: 'hash', value: 'abc', name: 'a.mp4' }]);
  });
});

// ---------------------------------------------------------------------------
// Media resolution
// ---------------------------------------------------------------------------

describe('resolveMedia', () => {
  function fileWith(media: LookFile['media'], baseKind = 'video'): LookFile {
    return {
      format: LOOK_FILE_FORMAT,
      version: SCHEMA_VERSION,
      name: 'M',
      createdAt: CREATED_AT,
      look: {
        layers: [{ id: BASE_LAYER_ID, kind: baseKind, on: true, frame: 'panel', t: IDENTITY }],
      },
      configs: { [baseKind]: { url: '' } },
      media,
    };
  }

  it('substitutes the library id when the hash is present', () => {
    const r = resolveMedia(fileWith([{ role: BASE_ROLE, kind: 'hash', value: CLIP.hash ?? '' }]), [
      CLIP,
    ]);
    expect(r.configs['video']).toEqual({ url: `${LOCAL_CLIP_SCHEME}${CLIP.id}` });
    expect(r.placeholders).toEqual([]);
  });

  it('keeps a url as a source when the library has never seen it', () => {
    const url = 'https://example.test/remote.mp4';
    const r = resolveMedia(fileWith([{ role: BASE_ROLE, kind: 'url', value: url }]), []);
    expect(r.configs['video']).toEqual({ url });
    expect(r.placeholders).toEqual([]);
  });

  it('prefers the local copy of a url the library already holds', () => {
    const r = resolveMedia(
      fileWith([{ role: BASE_ROLE, kind: 'url', value: CLIP.sourceUrl ?? '' }]),
      [CLIP],
    );
    expect(r.configs['video']).toEqual({ url: `${LOCAL_CLIP_SCHEME}${CLIP.id}` });
  });

  it('records a placeholder for a hash nobody has, and empties the url', () => {
    const ref = { role: BASE_ROLE, kind: 'hash' as const, value: 'nobody-has-this', name: 'x.mp4' };
    const r = resolveMedia(fileWith([ref]), [CLIP]);
    expect(r.configs['video']).toEqual({ url: '' });
    expect(r.placeholders).toEqual([{ layerId: BASE_LAYER_ID, ref, reason: 'not-in-library' }]);
  });

  it('resolves an overlay by its layer id', () => {
    const file = fileWith([{ role: 'limage', kind: 'hash', value: 'missing' }], 'clock');
    file.look.layers.push(overlay('limage', 'image', { url: '' }));
    const r = resolveMedia(file, []);
    expect(r.placeholders[0]?.layerId).toBe('limage');
    expect(r.look.layers[1]?.cfg).toEqual({ url: '' });
  });

  it('ignores a reference to a role that is not in the look', () => {
    const r = resolveMedia(fileWith([{ role: 'lghost', kind: 'hash', value: 'missing' }]), []);
    expect(r.placeholders).toEqual([]);
    expect(r.look.layers).toHaveLength(1);
  });

  it('leaves the look untouched when there is no media at all', () => {
    const file = fileWith([]);
    const r = resolveMedia(file);
    expect(r.look).toBe(file.look);
    expect(r.configs).toEqual(file.configs);
  });
});

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

describe('applyLookFile', () => {
  const state: LookState = {
    look: { layers: [{ id: BASE_LAYER_ID, kind: 'video', on: true, frame: 'panel', t: IDENTITY }] },
    modules: {
      video: { v: 2, cfg: { url: 'https://example.test/mine.mp4' } },
      clock: { v: 1, cfg: { face: 'analog' } },
    },
  };

  it('writes the look and only the kinds the file carried', () => {
    const file = exportLook(stateWith('stats', { layout: 'grid' }), {
      name: 'S',
      createdAt: CREATED_AT,
    });
    const patch = applyLookFile(state, resolveMedia(file));
    expect(patch.look.layers[0]?.kind).toBe('stats');
    expect(patch.modules['stats']).toEqual({ v: 1, cfg: { layout: 'grid' } });
    // Every other kind's bank entry is exactly where it was.
    expect(patch.modules['video']).toBe(state.modules['video']);
    expect(patch.modules['clock']).toBe(state.modules['clock']);
  });

  it('keeps the file layer ids, so an import is deterministic', () => {
    const file = exportLook(
      stateWith('clock', {}, [overlay('lstrip', 'stats', { layout: 'strip' })]),
      {
        name: 'D',
        createdAt: CREATED_AT,
      },
    );
    const a = applyLookFile(state, resolveMedia(file));
    const b = applyLookFile(state, resolveMedia(file));
    expect(a.look.layers.map((l) => l.id)).toEqual([BASE_LAYER_ID, 'lstrip']);
    expect(a.look).toEqual(b.look);
  });

  it('falls back to the receiving document config version when the file has none', () => {
    const file: LookFile = {
      format: LOOK_FILE_FORMAT,
      version: SCHEMA_VERSION,
      name: 'V',
      createdAt: CREATED_AT,
      look: {
        layers: [{ id: BASE_LAYER_ID, kind: 'video', on: true, frame: 'panel', t: IDENTITY }],
      },
      configs: { video: { url: '' } },
      media: [],
    };
    const patch = applyLookFile(state, resolveMedia(file));
    expect(patch.modules['video']).toEqual({ v: 2, cfg: { url: '' } });
  });

  it('assumes version 1 for a kind the document has never held', () => {
    const file = exportLook(stateWith('shape', { shape: 'ring' }), {
      name: 'R',
      createdAt: CREATED_AT,
    });
    delete file.configVersions;
    const patch = applyLookFile(state, resolveMedia(file));
    expect(patch.modules['shape']).toEqual({ v: 1, cfg: { shape: 'ring' } });
  });

  it('produces a look inside the document cap', () => {
    const file = exportLook(stateWith('stats', {}), { name: 'S', createdAt: CREATED_AT });
    const patch = applyLookFile(state, resolveMedia(file));
    expect(JSON.stringify(patch.look).length).toBeLessThanOrEqual(MAX_LOOK_BYTES);
  });
});

// ---------------------------------------------------------------------------
// The two restated constants
// ---------------------------------------------------------------------------

describe('local media schemes', () => {
  it('match the modules that own them', () => {
    // `file.ts` restates these so core state does not import a module; if either
    // module ever renames its scheme, this is the failure that says so.
    const file = exportLook(stateWith('video', { url: `${LOCAL_CLIP_SCHEME}${CLIP.id}` }), {
      name: 'V',
      createdAt: CREATED_AT,
    });
    expect(file.media[0]).toEqual({ role: BASE_ROLE, kind: 'hash', value: CLIP.id });

    const picture = exportLook(stateWith('image', { url: `${LOCAL_IMAGE_SCHEME}${PICTURE.id}` }), {
      name: 'P',
      createdAt: CREATED_AT,
    });
    expect(picture.media[0]).toEqual({ role: BASE_ROLE, kind: 'hash', value: PICTURE.id });
  });
});
