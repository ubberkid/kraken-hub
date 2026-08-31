import { describe, expect, it } from 'vitest';

import {
  ROOM_ALPHABET,
  ROOM_CODE_LENGTH,
  formatRoomCode,
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
} from './roomCode';

describe('room code alphabet', () => {
  it('is Crockford base32 — no I, L, O or U', () => {
    expect(ROOM_ALPHABET).toHaveLength(32);
    expect(new Set(ROOM_ALPHABET).size).toBe(32);
    for (const ambiguous of ['I', 'L', 'O', 'U']) {
      expect(ROOM_ALPHABET).not.toContain(ambiguous);
    }
  });

  it('generates codes drawn only from the alphabet', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateRoomCode();
      expect(code).toHaveLength(ROOM_CODE_LENGTH);
      expect(isValidRoomCode(code)).toBe(true);
      for (const ch of code) expect(ROOM_ALPHABET).toContain(ch);
    }
  });

  it('does not always produce the same code', () => {
    const codes = new Set(Array.from({ length: 50 }, generateRoomCode));
    expect(codes.size).toBeGreaterThan(1);
  });
});

describe('normalizeRoomCode', () => {
  it('uppercases, strips separators and folds the ambiguous glyphs', () => {
    // The whole point of the alphabet: someone reading a code off a screen
    // cannot tell these apart, so we decide for them instead of rejecting.
    expect(normalizeRoomCode('abcd-1234')).toBe('ABCD1234');
    expect(normalizeRoomCode('ab cd 12 34')).toBe('ABCD1234');
    expect(normalizeRoomCode('IOIO2345')).toBe('10102345');
    expect(normalizeRoomCode('llll2345')).toBe('11112345');
  });

  it('is idempotent on an already-canonical code', () => {
    const code = generateRoomCode();
    expect(normalizeRoomCode(code)).toBe(code);
    expect(normalizeRoomCode(normalizeRoomCode(code) ?? '')).toBe(code);
  });

  it('rejects anything that is not eight characters after folding', () => {
    expect(normalizeRoomCode('')).toBeNull();
    expect(normalizeRoomCode('ABC')).toBeNull();
    expect(normalizeRoomCode('ABCD12345')).toBeNull();
    expect(normalizeRoomCode('!!!!!!!!')).toBeNull();
    // U is not in the alphabet and is NOT folded — it is simply not a code.
    expect(normalizeRoomCode('UUUU1234')).toBeNull();
  });

  it('rejects a code that only reaches the right length via junk', () => {
    expect(normalizeRoomCode('AB!!CD!!')).toBeNull();
  });
});

describe('formatRoomCode', () => {
  it('groups in fours for reading aloud, and never changes the value', () => {
    expect(formatRoomCode('ABCD1234')).toBe('ABCD 1234');
    expect(normalizeRoomCode(formatRoomCode('ABCD1234'))).toBe('ABCD1234');
  });
});
