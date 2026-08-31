import { describe, expect, it } from 'vitest';

import {
  base32Encode,
  deriveRoomKeys,
  deriveTopicId,
  fromBase64Url,
  open,
  seal,
  toBase64Url,
} from './crypto';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('topic derivation', () => {
  /**
   * A KNOWN VECTOR, not a round trip.
   *
   * `topicId` is the address a room lives at. If this value ever changes, every
   * paired display in the world silently stops hearing its remote — and the
   * failure looks like a network problem, not like a code change. So the digest
   * is pinned here rather than recomputed by the test.
   */
  it('is stable forever for a given code', async () => {
    await expect(deriveTopicId('ABCD1234')).resolves.toBe('2RTWGMJTZEQ5HGVV');
    await expect(deriveTopicId('00000000')).resolves.toBe('FR3HZPDG4FPRY625');
  });

  it('is 16 Crockford characters — 80 bits', async () => {
    const id = await deriveTopicId('ZZZZ9999');
    expect(id).toHaveLength(16);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
  });

  it('separates codes that differ by one character', async () => {
    const [a, b] = await Promise.all([deriveTopicId('ABCD1234'), deriveTopicId('ABCD1235')]);
    expect(a).not.toBe(b);
  });
});

describe('base32Encode', () => {
  it('packs whole bytes five bits at a time', () => {
    expect(base32Encode(new Uint8Array([0x00]))).toBe('00');
    expect(base32Encode(new Uint8Array([0xff, 0xff]))).toBe('ZZZG');
  });
});

describe('seal / open', () => {
  it('round-trips a payload', async () => {
    const keys = await deriveRoomKeys('ABCD1234');
    const plain = encoder.encode('{"hello":"world"}');
    const frame = await seal(keys, 'state', plain);
    expect(frame[0]).toBe(0x01);
    // A fresh 12-byte IV per message, plus the GCM tag.
    expect(frame.length).toBeGreaterThan(plain.length + 12);
    const opened = await open(keys, 'state', frame);
    expect(opened).not.toBeNull();
    expect(decoder.decode(opened ?? new Uint8Array())).toBe('{"hello":"world"}');
  });

  it('never produces the same ciphertext twice', async () => {
    const keys = await deriveRoomKeys('ABCD1234');
    const plain = encoder.encode('same input');
    const a = await seal(keys, 'state', plain);
    const b = await seal(keys, 'state', plain);
    expect(toBase64Url(a)).not.toBe(toBase64Url(b));
  });

  it('derives a DIFFERENT key per channel', async () => {
    const keys = await deriveRoomKeys('ABCD1234');
    const frame = await seal(keys, 'state', encoder.encode('secret'));
    // Same room, same key material, different channel: the AAD binds a
    // ciphertext to the channel it was sent on, so this must fail.
    await expect(open(keys, 'cmd', frame)).resolves.toBeNull();
    await expect(open(keys, 'tele', frame)).resolves.toBeNull();
  });

  it('rejects a payload sealed under another room code', async () => {
    const mine = await deriveRoomKeys('ABCD1234');
    const theirs = await deriveRoomKeys('ZZZZ9999');
    const frame = await seal(theirs, 'state', encoder.encode('not for you'));
    await expect(open(mine, 'state', frame)).resolves.toBeNull();
  });

  it('rejects tampering with any byte of the frame', async () => {
    const keys = await deriveRoomKeys('ABCD1234');
    const frame = await seal(keys, 'state', encoder.encode('authentic'));

    for (const index of [0, 1, 6, 13, frame.length - 1]) {
      const tampered = new Uint8Array(frame);
      tampered[index] = (tampered[index] ?? 0) ^ 0x01;
      await expect(open(keys, 'state', tampered)).resolves.toBeNull();
    }
  });

  it('rejects a truncated frame rather than throwing', async () => {
    const keys = await deriveRoomKeys('ABCD1234');
    await expect(open(keys, 'state', new Uint8Array([0x01, 0x02]))).resolves.toBeNull();
    await expect(open(keys, 'state', new Uint8Array())).resolves.toBeNull();
  });
});

describe('base64url', () => {
  it('round-trips arbitrary bytes without padding or URL-unsafe characters', () => {
    const bytes = new Uint8Array(300);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7) % 256;
    const text = toBase64Url(bytes);
    expect(text).not.toContain('=');
    expect(text).not.toContain('+');
    expect(text).not.toContain('/');
    expect(fromBase64Url(text)).toEqual(bytes);
  });

  it('returns null rather than throwing on rubbish', () => {
    expect(fromBase64Url('!!!! not base64 !!!!')).toBeNull();
  });
});
