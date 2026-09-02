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

import { decodeStamp, type Stamp } from './hlc';
import {
  CHANNELS,
  MAX_ENVELOPE_BYTES,
  MAX_WIRE_STAMP_ENTRIES,
  PROTOCOL_VERSION,
  ROLES,
  type Envelope,
} from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const MAX_SRC_LEN = 64;
/** A leaf path like `modules.video.cfg.source.id` — generous, still bounded. */
const MAX_PATH_LEN = 128;

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
  /*
   * A protocol mismatch is a DROP, and at `v: 2` that is a decision rather than
   * a formality — see `Envelope.v`. A `v: 1` peer's frames carry no stamps and
   * would read as writes from the beginning of time; refusing them is what
   * turns a mixed-build room into a visibly dead connection instead of a phone
   * whose taps quietly stop taking.
   */
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

  const stamps = readStamps(o['stamps']);
  const clock = readClock(o['clock']);

  if (!('body' in o)) return null;

  return {
    v: PROTOCOL_VERSION,
    ch: ch as Envelope['ch'],
    ts,
    src,
    role: role as Envelope['role'],
    seq,
    ...(rev === undefined ? {} : { rev }),
    ...(stamps === null ? {} : { stamps }),
    ...(clock === null ? {} : { clock }),
    body: o['body'],
  };
}

/**
 * The stamp map, read the way every other field here is read: a malformed
 * ENTRY is dropped, and a malformed MAP becomes an absent one, rather than a
 * reason to drop the frame.
 *
 * Dropping the frame would be the wrong severity. A leaf with no stamp reads as
 * `EPOCH` — older than every real write — so the worst a lost entry can do is
 * make that leaf unable to win an argument, which is the same conservative
 * answer the receiver would give a value it had never heard of. Refusing the
 * whole envelope would instead make a snapshot from a peer with one corrupt
 * entry completely undeliverable.
 *
 * Entries are bounded by `MAX_WIRE_STAMP_ENTRIES`, which is a sanity bound
 * against a hostile peer rather than a trimming policy: an 8 kB envelope
 * cannot honestly hold that many. The SENDER no longer caps at all — see
 * `MAX_WIRE_STAMP_ENTRIES` for why a stampless value is a lie rather than an
 * omission.
 */
function readStamps(raw: unknown): Record<string, [number, number, string]> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const out: Record<string, [number, number, string]> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_WIRE_STAMP_ENTRIES) break;
    if (key.length === 0 || key.length > MAX_PATH_LEN) continue;
    const stamp = decodeStamp(value, MAX_SRC_LEN);
    if (stamp === null) continue;
    out[key] = [stamp.t, stamp.c, stamp.s];
    count += 1;
  }
  return count === 0 ? null : out;
}

/** The sender's clock. Same rule: unreadable becomes absent. */
function readClock(raw: unknown): [number, number, string] | null {
  const stamp = decodeStamp(raw, MAX_SRC_LEN);
  return stamp === null ? null : [stamp.t, stamp.c, stamp.s];
}

/** The stamps of a decoded envelope, as `Stamp` objects. Never throws. */
export function stampsOf(env: Envelope): Map<string, Stamp> {
  const out = new Map<string, Stamp>();
  if (env.stamps === undefined) return out;
  for (const [path, [t, c, s]] of Object.entries(env.stamps)) out.set(path, { t, c, s });
  return out;
}
