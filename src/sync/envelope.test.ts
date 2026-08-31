import { describe, expect, it } from 'vitest';

import { decodeEnvelope, encodeEnvelope, envelopeBytes, EnvelopeTooLargeError } from './envelope';
import { MAX_ENVELOPE_BYTES, type Envelope } from './types';

function env(overrides: Partial<Envelope> = {}): Envelope {
  return {
    v: 1,
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
    expect(decodeEnvelope(encode({ ...env(), v: 2 }))).toBeNull();
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
