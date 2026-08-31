/**
 * Envelope encode/decode and the 8 KB cap (invariant I6).
 *
 * `decodeEnvelope` never throws and never trusts its input: every field that
 * the service later branches on is checked here, once, so the rest of the sync
 * layer can treat an `Envelope` as a fact. Anything malformed becomes `null`,
 * which the caller counts and drops.
 *
 * `encodeEnvelope` DOES throw when the payload is over the cap, with a
 * diagnostic naming the actual size — this one is a programming error on our
 * own side (a module stuffed something enormous into its config) and silently
 * truncating it would produce a display that is subtly wrong forever.
 */

import { CHANNELS, MAX_ENVELOPE_BYTES, PROTOCOL_VERSION, ROLES, type Envelope } from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const MAX_SRC_LEN = 64;

export class EnvelopeTooLargeError extends Error {
  constructor(
    public readonly bytes: number,
    public readonly channel: string,
  ) {
    super(
      `kraken-hub: a '${channel}' sync payload is ${String(bytes)} bytes, over the ` +
        `${String(MAX_ENVELOPE_BYTES)} byte cap (invariant I6). State is a full snapshot, ` +
        'so the fix is to shrink the snapshot (drop inactive modules) — never to send a delta.',
    );
    this.name = 'EnvelopeTooLargeError';
  }
}

/** UTF-8 JSON. Throws `EnvelopeTooLargeError` above the cap. */
export function encodeEnvelope(env: Envelope): Uint8Array {
  const bytes = encoder.encode(JSON.stringify(env));
  if (bytes.length > MAX_ENVELOPE_BYTES) {
    throw new EnvelopeTooLargeError(bytes.length, env.ch);
  }
  return bytes;
}

/** Size of an envelope on the wire, without committing to sending it. */
export function envelopeBytes(env: Envelope): number {
  return encoder.encode(JSON.stringify(env)).length;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Parse + validate. `null` for anything we would not want to act on. */
export function decodeEnvelope(frame: Uint8Array): Envelope | null {
  if (frame.length === 0 || frame.length > MAX_ENVELOPE_BYTES) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(frame));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const o = parsed as Record<string, unknown>;
  if (o['v'] !== PROTOCOL_VERSION) return null;

  const ch = o['ch'];
  if (typeof ch !== 'string' || !(CHANNELS as readonly string[]).includes(ch)) return null;

  const role = o['role'];
  if (typeof role !== 'string' || !(ROLES as readonly string[]).includes(role)) return null;

  const src = o['src'];
  if (typeof src !== 'string' || src.length === 0 || src.length > MAX_SRC_LEN) return null;

  const ts = o['ts'];
  const seq = o['seq'];
  if (!isFiniteNumber(ts) || !isFiniteNumber(seq) || seq < 0) return null;

  const rev = o['rev'];
  if (rev !== undefined && !isFiniteNumber(rev)) return null;

  if (!('body' in o)) return null;

  return {
    v: PROTOCOL_VERSION,
    ch: ch as Envelope['ch'],
    ts,
    src,
    role: role as Envelope['role'],
    seq,
    ...(rev === undefined ? {} : { rev }),
    body: o['body'],
  };
}
