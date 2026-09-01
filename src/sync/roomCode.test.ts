import { describe, expect, it } from 'vitest';

import {
  ROOM_ALPHABET,
  ROOM_CODE_HINT,
  ROOM_CODE_LENGTH,
  filterRoomCodeInput,
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

/**
 * The field filters as you type — round 5's S5.
 *
 * `normalizeRoomCode` has always folded the lookalikes, but it did so at the
 * END, which meant the box happily accepted characters that are not in the
 * alphabet and then silently rewrote them on submit. Folding on the keystroke
 * shows the user the code they are actually typing, and `U` — which Crockford
 * excludes and which has no lookalike to fold into — cannot be entered at all
 * rather than failing eight characters later.
 */
describe('filterRoomCodeInput', () => {
  it('uppercases and drops separators, so a code read aloud can be typed as heard', () => {
    expect(filterRoomCodeInput('abcd-2345')).toBe('ABCD2345');
    expect(filterRoomCodeInput('ab cd 23 45')).toBe('ABCD2345');
  });

  it('folds the lookalikes exactly as normalizeRoomCode does', () => {
    expect(filterRoomCodeInput('IO')).toBe('10');
    expect(filterRoomCodeInput('ill')).toBe('111');
    // The two must not disagree: what the field leaves behind has to be what
    // the submit path would have produced.
    expect(normalizeRoomCode(filterRoomCodeInput('io2345ab'))).toBe('102345AB');
  });

  it('refuses U, which has no lookalike and is simply not in the alphabet', () => {
    expect(filterRoomCodeInput('UUUU2345')).toBe('2345');
    expect(filterRoomCodeInput('ABUCD234')).toBe('ABCD234');
  });

  it('never grows past a code, because a ninth character can only be a mistake', () => {
    expect(filterRoomCodeInput('ABCD2345XYZ')).toHaveLength(ROOM_CODE_LENGTH);
  });

  it('never rejects: it is a filter, not a validator', () => {
    expect(filterRoomCodeInput('')).toBe('');
    expect(filterRoomCodeInput('!!!')).toBe('');
  });
});

/** The hint and the error are one sentence, so the rule is stated one way. */
describe('ROOM_CODE_HINT', () => {
  it('names the four excluded letters', () => {
    for (const letter of ['I', 'L', 'O', 'U']) expect(ROOM_CODE_HINT).toContain(letter);
    for (const letter of ['I', 'L', 'O', 'U']) expect(ROOM_ALPHABET).not.toContain(letter);
  });
});
