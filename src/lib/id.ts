/** Opaque id generation. Never used for anything security-bearing in M0. */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Lowercase alphanumeric id of `length` characters, from `crypto.getRandomValues`. */
export function randomId(length = 12): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length] ?? '0';
  return out;
}
