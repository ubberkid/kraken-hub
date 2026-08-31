/**
 * Topic derivation and payload encryption (design-architecture.md §5.2).
 *
 * The room code is the only secret. Everything else — the topic the messages
 * land on, the AES key that protects them, one key per channel — is derived
 * from it, so pairing is "type eight characters" and nothing has to be
 * exchanged out of band.
 *
 *   topicId = crockford32( SHA-256(code)[0..10] )              // 80 bits → 16 chars
 *   key(ch) = HKDF-SHA256( ikm=utf8(code), salt="kraken-hub/v1",
 *                          info="kraken-hub/v1/aes-256-gcm/<ch>" ) → AES-GCM-256
 *
 * Wire frame: `0x01 || iv[12] || ciphertext||tag`, with a fresh random IV per
 * message and **AAD = `<topicId>|<channel>`** so a ciphertext captured on one
 * channel cannot be replayed onto another.
 *
 * Honest limitation, repeated in docs/remote-control.md: 40 bits of room-code
 * entropy under a single HKDF pass is weak against an offline attacker who has
 * ALREADY located the topic. The mitigations are that the topic is itself
 * derived and unguessable, and that the contents are low-value — a media URL
 * and a seek position.
 */

import { ROOM_ALPHABET } from './roomCode';

import type { Channel } from './types';

/** Version byte. A frame that does not start with it is not ours. */
export const FRAME_VERSION = 0x01;
const IV_BYTES = 12;
const TOPIC_ID_BYTES = 10;
const KEY_BITS = 256;

const HKDF_SALT = 'kraken-hub/v1';
const HKDF_INFO_PREFIX = 'kraken-hub/v1/aes-256-gcm/';

const encoder = new TextEncoder();

export interface RoomKeys {
  topicId: string;
  /** One AES-GCM key per channel: a key is never reused across channels. */
  keys: Readonly<Record<Channel, CryptoKey>>;
}

/**
 * Crockford base32 over whole bytes.
 *
 * 10 bytes is 80 bits, an exact multiple of 5, so the encoding is 16 characters
 * with no padding and no partial group to reason about.
 */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ROOM_ALPHABET[(value >>> bits) & 31] ?? '0';
    }
  }
  if (bits > 0) out += ROOM_ALPHABET[(value << (5 - bits)) & 31] ?? '0';
  return out;
}

/** `base32(SHA-256(code)[0..10])` — the canonical topic id. Stable forever. */
export async function deriveTopicId(code: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(code));
  return base32Encode(new Uint8Array(digest).slice(0, TOPIC_ID_BYTES));
}

async function deriveChannelKey(base: CryptoKey, ch: Channel): Promise<CryptoKey> {
  return globalThis.crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(HKDF_SALT),
      info: encoder.encode(HKDF_INFO_PREFIX + ch),
    },
    base,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Everything a peer needs to talk in a room. Cheap enough to call once at start. */
export async function deriveRoomKeys(code: string): Promise<RoomKeys> {
  const topicId = await deriveTopicId(code);
  const base = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(code),
    'HKDF',
    false,
    ['deriveKey'],
  );
  const [state, cmd, tele] = await Promise.all([
    deriveChannelKey(base, 'state'),
    deriveChannelKey(base, 'cmd'),
    deriveChannelKey(base, 'tele'),
  ]);
  return { topicId, keys: { state, cmd, tele } };
}

/**
 * A standalone `ArrayBuffer` copy.
 *
 * WebCrypto's `BufferSource` will not accept a `Uint8Array` whose backing store
 * TypeScript cannot prove is a plain `ArrayBuffer` (it might be shared), and a
 * subarray view would hand the algorithm the wrong bytes anyway. Copying once
 * per message is cheaper than either bug.
 */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function aad(topicId: string, ch: Channel): ArrayBuffer {
  return toBuffer(encoder.encode(`${topicId}|${ch}`));
}

/** `0x01 || iv || ciphertext||tag`. A fresh IV per message, always. */
export async function seal(
  keys: RoomKeys,
  ch: Channel,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const iv = new Uint8Array(IV_BYTES);
  globalThis.crypto.getRandomValues(iv);
  const key = keys.keys[ch];
  const ct = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(keys.topicId, ch) },
    key,
    toBuffer(plaintext),
  );
  const out = new Uint8Array(1 + IV_BYTES + ct.byteLength);
  out[0] = FRAME_VERSION;
  out.set(iv, 1);
  out.set(new Uint8Array(ct), 1 + IV_BYTES);
  return out;
}

/**
 * Returns `null` on ANY failure — wrong key, wrong channel, truncated frame,
 * flipped bit. Callers count nulls rather than branching on why: telling an
 * attacker which part of a forgery was wrong is the classic mistake, and the
 * user-facing answer ("check the room code") is the same in every case.
 */
export async function open(
  keys: RoomKeys,
  ch: Channel,
  frame: Uint8Array,
): Promise<Uint8Array | null> {
  if (frame.length <= 1 + IV_BYTES || frame[0] !== FRAME_VERSION) return null;
  const iv = frame.slice(1, 1 + IV_BYTES);
  const ct = frame.slice(1 + IV_BYTES);
  try {
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad(keys.topicId, ch) },
      keys.keys[ch],
      toBuffer(ct),
    );
    return new Uint8Array(plain);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// base64url — the text encoding for transports that carry strings (ntfy, the
// localStorage bus, the fake broker). No padding, URL- and header-safe.
// ---------------------------------------------------------------------------

const CHUNK = 0x8000;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array | null {
  try {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
