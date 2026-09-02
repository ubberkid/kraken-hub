/**
 * A number for READING, with a real minus sign — round 11's M-f.
 *
 * `String(-12)` gives U+002D HYPHEN-MINUS, which is a hyphen: it is short, it
 * sits low, and in the tabular figures the editor's readouts are set in it is
 * visibly not the sign it is standing in for. U+2212 MINUS SIGN is the
 * character the glyph is for, and it is the one every digit in `.kh-tnum` was
 * cut to sit beside. The drag HUD read `x 0 · y −68` with a hyphen in it and
 * the strip's opacity readout did the same, one line below a size stepper whose
 * own button has said `−` since it shipped.
 *
 * Display only, and deliberately so: an `<input type="number">` still writes and
 * reads ASCII, because U+2212 is not a number to any parser on earth. The rule
 * is that the app SHOWS U+2212 and STORES U+002D, and this is the one function
 * that crosses that line.
 *
 * Pure and DOM-free.
 */

/** U+2212, named once. */
export const MINUS = '−';

/** `-12` → `−12`. A non-negative number is returned unchanged. */
export function signed(n: number): string {
  return n < 0 ? `${MINUS}${String(Math.abs(n))}` : String(n);
}

/** The same rule for an already-formatted decimal — `(-0.25).toFixed(2)`. */
export function signedText(text: string): string {
  return text.startsWith('-') ? `${MINUS}${text.slice(1)}` : text;
}
