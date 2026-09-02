import { describe, expect, it } from 'vitest';

import { decodeEnvelope, encodeEnvelope, envelopeBytes, EnvelopeTooLargeError } from './envelope';
import {
  MAX_ENVELOPE_BYTES,
  MAX_WIRE_STAMP_ENTRIES,
  PROTOCOL_VERSION,
  type Envelope,
} from './types';

function env(overrides: Partial<Envelope> = {}): Envelope {
  return {
    v: PROTOCOL_VERSION,
    ch: 'state',
    ts: 1_700_000_000_000,
    src: 'abc123def456',
    role: 'config',
    seq: 7,
    rev: 42,
    body: { hello: 'world' },
    ...overrides,
  };
}

describe('encodeEnvelope', () => {
  it('round-trips through decode', () => {
    const original = env();
    const decoded = decodeEnvelope(encodeEnvelope(original));
    expect(decoded).toEqual(original);
  });

  it('throws with a diagnostic above the 8 KB cap', () => {
    const huge = env({ body: { blob: 'x'.repeat(MAX_ENVELOPE_BYTES) } });
    expect(() => encodeEnvelope(huge)).toThrow(EnvelopeTooLargeError);

    const caught = ((): EnvelopeTooLargeError | null => {
      try {
        encodeEnvelope(huge);
        return null;
      } catch (err) {
        return err instanceof EnvelopeTooLargeError ? err : null;
      }
    })();

    expect(caught).not.toBeNull();
    expect(caught?.bytes).toBeGreaterThan(MAX_ENVELOPE_BYTES);
    expect(caught?.channel).toBe('state');
    // The message must say what to do, not just that something is wrong.
    expect(caught?.message).toContain('full snapshot');
  });

  it('accepts a payload exactly at the cap', () => {
    // Grow a body until the encoded envelope lands on the boundary.
    let body = 'x';
    while (envelopeBytes(env({ body })) < MAX_ENVELOPE_BYTES) body += 'x';
    while (envelopeBytes(env({ body })) > MAX_ENVELOPE_BYTES) body = body.slice(1);
    expect(envelopeBytes(env({ body }))).toBe(MAX_ENVELOPE_BYTES);
    expect(() => encodeEnvelope(env({ body }))).not.toThrow();
  });
});

describe('decodeEnvelope', () => {
  const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

  it('returns null for anything malformed rather than throwing', () => {
    expect(decodeEnvelope(new Uint8Array())).toBeNull();
    expect(decodeEnvelope(new TextEncoder().encode('not json'))).toBeNull();
    expect(decodeEnvelope(encode([1, 2, 3]))).toBeNull();
    expect(decodeEnvelope(encode('a string'))).toBeNull();
    expect(decodeEnvelope(encode(null))).toBeNull();
  });

  it('rejects a protocol version it does not speak', () => {
    expect(decodeEnvelope(encode({ ...env(), v: 1 }))).toBeNull();
    expect(decodeEnvelope(encode({ ...env(), v: '1' }))).toBeNull();
  });

  it('rejects unknown channels and roles', () => {
    expect(decodeEnvelope(encode({ ...env(), ch: 'chat' }))).toBeNull();
    expect(decodeEnvelope(encode({ ...env(), role: 'admin' }))).toBeNull();
  });

  it('rejects a missing or absurd src, ts or seq', () => {
    expect(decodeEnvelope(encode({ ...env(), src: '' }))).toBeNull();
    expect(decodeEnvelope(encode({ ...env(), src: 'x'.repeat(65) }))).toBeNull();
    expect(decodeEnvelope(encode({ ...env(), ts: 'now' }))).toBeNull();
    expect(decodeEnvelope(encode({ ...env(), seq: -1 }))).toBeNull();
    expect(decodeEnvelope(encode({ ...env(), seq: Number.NaN }))).toBeNull();
  });

  it('rejects an envelope with no body at all', () => {
    const { body: _body, ...rest } = env();
    expect(decodeEnvelope(encode(rest))).toBeNull();
  });

  it('accepts a state envelope with no rev, and rejects a non-numeric one', () => {
    const { rev: _rev, ...rest } = env();
    expect(decodeEnvelope(encode(rest))?.rev).toBeUndefined();
    expect(decodeEnvelope(encode({ ...env(), rev: 'high' }))).toBeNull();
  });

  it('refuses an oversized frame without parsing it', () => {
    const oversized = new Uint8Array(MAX_ENVELOPE_BYTES + 1);
    expect(decodeEnvelope(oversized)).toBeNull();
  });
});

describe('the stamp map', () => {
  const stamped = (stamps: Record<string, [number, number, string]>): Envelope => env({ stamps });

  it('round-trips', () => {
    const decoded = decodeEnvelope(
      encodeEnvelope(stamped({ 'render.fit': [1_700_000_000_001, 0, 'phonepeer001'] })),
    );
    expect(decoded?.stamps).toEqual({ 'render.fit': [1_700_000_000_001, 0, 'phonepeer001'] });
  });

  it('is absent on a frame from a peer that sends none', () => {
    expect(decodeEnvelope(encodeEnvelope(env()))?.stamps).toBeUndefined();
  });

  it('drops a junk entry rather than the whole frame', () => {
    /*
     * A leaf with no stamp reads as the beginning of time, which is the same
     * conservative answer the receiver would give a value it had never heard
     * of. Refusing the envelope would instead make a whole snapshot from a peer
     * with one corrupt entry undeliverable.
     */
    const frame = new TextEncoder().encode(
      JSON.stringify({
        ...env(),
        stamps: {
          'render.fit': [1, 0, 'peer'],
          'render.zoom': 'nonsense',
          'render.rotate': [1, 0],
          'render.offsetX': [-1, 0, 'peer'],
          'render.offsetY': [1, 0, ''],
        },
      }),
    );
    expect(decodeEnvelope(frame)?.stamps).toEqual({ 'render.fit': [1, 0, 'peer'] });
  });

  it('collapses an all-junk map to an absent one', () => {
    const frame = new TextEncoder().encode(JSON.stringify({ ...env(), stamps: { a: 1, b: null } }));
    const decoded = decodeEnvelope(frame);
    expect(decoded).not.toBeNull();
    expect(decoded?.stamps).toBeUndefined();
  });

  it('keeps every stamp a legal frame can carry — a dropped one would read as EPOCH', () => {
    /*
     * The receive side must NOT trim. A value in the body whose stamp was
     * dropped reads as `EPOCH`, the beginning of time, which is a positive
     * claim that nobody ever wrote that leaf — so a receiver that trims is a
     * receiver that manufactures the strongest possible lie about the frame it
     * was handed. What bounds the map is the 8 kB envelope cap, not a policy.
     */
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 200; i += 1) many[`r.k${String(i)}`] = [i + 1, 0, 'p'];
    const frame = new TextEncoder().encode(JSON.stringify({ ...env(), stamps: many }));
    expect(frame.length).toBeLessThanOrEqual(MAX_ENVELOPE_BYTES);
    expect(Object.keys(decodeEnvelope(frame)?.stamps ?? {})).toHaveLength(200);
  });

  it('still bounds a hostile map, above anything 8 kB can hold', () => {
    /*
     * The remaining cap is a sanity bound, not a trimmer: the smallest legal
     * entry is about 16 bytes, so an 8 kB frame tops out well under it and no
     * honest sender can ever reach it.
     */
    expect(MAX_WIRE_STAMP_ENTRIES).toBeGreaterThan(MAX_ENVELOPE_BYTES / 16);
  });

  it('leaves room inside the 8 KB cap at its worst', () => {
    // Thirty-two contested leaves: more than a room ever has in play at once.
    const CONTESTED = 32;
    const many: Record<string, [number, number, string]> = {};
    for (let i = 0; i < CONTESTED; i += 1) {
      many[`modules.video.cfg.render.someLongLeafName${String(i)}`] = [
        1_700_000_000_000,
        9,
        'phonepeer001',
      ];
    }
    // Room for the body: the worst legal one is about 3.3 kB (§6.2).
    expect(envelopeBytes(stamped(many))).toBeLessThan(MAX_ENVELOPE_BYTES - 4500);
  });
});

describe("the sender's clock", () => {
  it('round-trips', () => {
    const decoded = decodeEnvelope(encodeEnvelope(env({ clock: [17, 3, 'configpeer01'] })));
    expect(decoded?.clock).toEqual([17, 3, 'configpeer01']);
  });

  it('becomes absent rather than fatal when it is malformed', () => {
    const frame = new TextEncoder().encode(JSON.stringify({ ...env(), clock: ['nope'] }));
    const decoded = decodeEnvelope(frame);
    expect(decoded).not.toBeNull();
    expect(decoded?.clock).toBeUndefined();
  });
});
