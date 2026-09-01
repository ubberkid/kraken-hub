import { describe, expect, it } from 'vitest';

import { MAX_ENVELOPE_BYTES } from '../sync/types';

import {
  CHUNK_CHARS,
  ENVELOPE_CAP_BYTES,
  createChunkAssembler,
  isTeleChunk,
  toTeleChunks,
} from './chunkedTele';

/**
 * The shared chunked-tele channel, exercised the way `diag/wire.test.ts`
 * exercises the diagnostics case it was extracted from — because the thumbnail
 * transfer that now rides it has exactly the same failure modes.
 */
describe('the envelope budget', () => {
  it('keeps its copy of MAX_ENVELOPE_BYTES honest', () => {
    // Copied rather than imported so this leaf never joins the `sync-core`
    // chunk's graph; this assertion is what stops the copy from drifting.
    expect(ENVELOPE_CAP_BYTES).toBe(MAX_ENVELOPE_BYTES);
  });

  it('budgets two bytes per character for JSON-in-JSON escaping', () => {
    // A payload nested inside another JSON document turns every `"` into `\"`,
    // so a pathological chunk very nearly doubles on the way into the envelope.
    expect(CHUNK_CHARS * 2).toBeLessThan(ENVELOPE_CAP_BYTES);
  });

  it('never exceeds the cap, even for an all-quotes payload', () => {
    const evil = '"'.repeat(CHUNK_CHARS * 3);
    for (const chunk of toTeleChunks({ kind: 'thumb', ts: 1, payload: evil })) {
      expect(
        JSON.stringify({ v: 1, ch: 'tele', src: 'abcdefghijkl', body: chunk }).length,
      ).toBeLessThanOrEqual(ENVELOPE_CAP_BYTES);
    }
  });
});

describe('chunking', () => {
  it('emits one part for a payload that fits — the shape is uniform', () => {
    // A receiver with no "was it chunked?" branch is a receiver with one fewer
    // thing to get wrong.
    const chunks = toTeleChunks({ kind: 'thumb', ts: 7, payload: 'hello' });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ part: 1, of: 1, ts: 7, kind: 'thumb' });
  });

  it('emits at least one part for an empty payload', () => {
    expect(toTeleChunks({ kind: 'thumb', ts: 1, payload: '' })).toHaveLength(1);
  });

  it('carries the id on every part, so a receiver can cache before reassembly', () => {
    const chunks = toTeleChunks({ kind: 'thumb', ts: 1, payload: 'abcdef', id: 'ff00', chars: 2 });
    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.id === 'ff00')).toBe(true);
  });

  it('shares one ts across every part of a capture', () => {
    const chunks = toTeleChunks({ kind: 'thumb', ts: 42, payload: 'abcdef', chars: 2 });
    expect(new Set(chunks.map((c) => c.ts))).toEqual(new Set([42]));
  });
});

describe('reassembly', () => {
  const split = (payload: string, ts = 1, id?: string) =>
    toTeleChunks({ kind: 'thumb', ts, payload, chars: 4, ...(id === undefined ? {} : { id }) });

  it('round-trips a payload', () => {
    const assembler = createChunkAssembler('thumb');
    const payload = 'data:image/webp;base64,AAAABBBBCCCC';
    let done = null;
    for (const chunk of split(payload)) done = assembler.accept(chunk);
    expect(done?.payload).toBe(payload);
    expect(done?.ts).toBe(1);
  });

  it('returns null until the LAST missing part arrives', () => {
    const assembler = createChunkAssembler('thumb');
    const chunks = split('abcdefghijkl');
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks.slice(0, -1)) expect(assembler.accept(chunk)).toBeNull();
    expect(assembler.accept(chunks[chunks.length - 1]!)?.payload).toBe('abcdefghijkl');
  });

  it('accepts parts out of order — two transports, one retained replay', () => {
    const assembler = createChunkAssembler('thumb');
    const chunks = split('abcdefghijkl');
    const reversed = [...chunks].reverse();
    let done = null;
    for (const chunk of reversed) done = assembler.accept(chunk);
    expect(done?.payload).toBe('abcdefghijkl');
  });

  /**
   * The `.fill()` in the assembler, proved. `new Array(n)` is SPARSE and
   * `Array.prototype.some` skips holes, so without it the completeness check
   * passes on the very first part and reassembles a truncated payload.
   */
  it('does not complete on the first part of a multi-part capture', () => {
    const assembler = createChunkAssembler('thumb');
    expect(assembler.accept(split('abcdefgh')[0]!)).toBeNull();
  });

  it('discards a half-arrived capture the moment a newer one starts', () => {
    const assembler = createChunkAssembler('thumb');
    const older = split('OLDOLDOLD', 1);
    const newer = split('NEWNEWNEW', 2);
    assembler.accept(older[0]!);
    let done = null;
    for (const chunk of newer) done = assembler.accept(chunk);
    expect(done?.payload).toBe('NEWNEWNEW');
    // The stragglers of the older capture must not be able to complete it.
    for (const chunk of older.slice(1)) expect(assembler.accept(chunk)).toBeNull();
  });

  it('ignores bodies of a different kind, so a caller can feed it everything', () => {
    const assembler = createChunkAssembler('thumb');
    expect(assembler.accept({ kind: 'videoStats', ts: 1, stats: {} })).toBeNull();
    expect(
      assembler.accept({ kind: 'diagReport', ts: 1, part: 1, of: 1, payload: 'x' }),
    ).toBeNull();
    expect(assembler.accept(null)).toBeNull();
    expect(assembler.accept('nope')).toBeNull();
  });

  it('surfaces the id with the completed payload', () => {
    const assembler = createChunkAssembler('thumb');
    let done = null;
    for (const chunk of split('abcdefgh', 3, 'deadbeef')) done = assembler.accept(chunk);
    expect(done?.id).toBe('deadbeef');
  });
});

describe('isTeleChunk', () => {
  it('rejects a part number outside its own range', () => {
    expect(isTeleChunk({ kind: 'thumb', ts: 1, part: 0, of: 2, payload: 'x' }, 'thumb')).toBe(
      false,
    );
    expect(isTeleChunk({ kind: 'thumb', ts: 1, part: 3, of: 2, payload: 'x' }, 'thumb')).toBe(
      false,
    );
    expect(isTeleChunk({ kind: 'thumb', ts: 1, part: 1, of: 2, payload: 'x' }, 'thumb')).toBe(true);
  });
});
