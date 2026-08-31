/**
 * Room codes: 8 characters of Crockford base32.
 *
 * The alphabet is the whole point. A room code is read off a screen and typed
 * into a phone, so `I`/`l`/`1` and `O`/`0` must not be distinguishable choices —
 * Crockford drops `I`, `L`, `O` and `U` (the last to avoid accidental obscenity)
 * and `normalizeRoomCode` folds the lookalikes back in rather than rejecting
 * them. Someone who types `IO` gets `10`, which is what they meant.
 *
 * 8 characters = 40 bits. That is deliberately a convenience secret, not a
 * cryptographic one; the honest threat model is in docs/remote-control.md.
 */

/** Crockford base32: no I, L, O, U. */
export const ROOM_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const ROOM_CODE_LENGTH = 8;

/** A canonical code: uppercase, exactly `ROOM_CODE_LENGTH`, alphabet-only. */
const CANONICAL_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/**
 * 40 bits from `crypto.getRandomValues`.
 *
 * `byte % 32` is unbiased here because 256 is an exact multiple of 32 — no
 * rejection sampling needed, and no modulo skew to apologise for.
 */
export function generateRoomCode(): string {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ROOM_ALPHABET[b % ROOM_ALPHABET.length] ?? '0';
  return out;
}

/**
 * Fold a human-typed string into canonical form, or `null` if it cannot be one.
 *
 * Order matters: strip separators first (people type `ABCD-EFGH`), then
 * uppercase, then map the ambiguous glyphs, and only then check the shape.
 */
export function normalizeRoomCode(raw: string): string | null {
  const stripped = raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  return CANONICAL_RE.test(stripped) ? stripped : null;
}

export function isValidRoomCode(raw: string): boolean {
  return CANONICAL_RE.test(raw);
}

/** `ABCD EFGH` — display form only. Never store or transmit the spaced form. */
export function formatRoomCode(code: string): string {
  const half = ROOM_CODE_LENGTH / 2;
  return `${code.slice(0, half)} ${code.slice(half)}`;
}
