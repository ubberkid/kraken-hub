import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';

import { qrMatrix, remoteLinkUrl } from './qr';

/**
 * The round trip: OUR encoder out, a third-party decoder back in.
 *
 * The hand-rolled encoder used to emit codes that lenient desktop readers
 * accepted and an iPhone camera would not even see — the format-information
 * bits were written in reverse order and the split between the two copies was
 * 8/7 instead of 7/8, which overwrote the always-dark module at
 * (size - 8, 8). Nothing in a "does it produce a matrix" test can catch that;
 * only a real decoder can. `jsQR` is a devDependency for exactly this, and it
 * never ships: it is imported by this file alone.
 *
 * The image is synthesised here rather than drawn on a canvas — a QR is a grid
 * of squares, so a nested loop over an `Uint8ClampedArray` is the whole
 * rasteriser, and it keeps the unit project free of a DOM.
 */
const SCALE = 8;
const QUIET = 4;

function rasterise(matrix: boolean[][]): {
  data: Uint8ClampedArray;
  width: number;
  height: number;
} {
  const side = (matrix.length + QUIET * 2) * SCALE;
  // Start all-white (0xff in R, G, B and A), then paint the dark modules black.
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let r = 0; r < matrix.length; r += 1) {
    const row = matrix[r];
    if (row === undefined) continue;
    for (let c = 0; c < row.length; c += 1) {
      if (row[c] !== true) continue;
      for (let y = 0; y < SCALE; y += 1) {
        for (let x = 0; x < SCALE; x += 1) {
          const px = (((r + QUIET) * SCALE + y) * side + (c + QUIET) * SCALE + x) * 4;
          data[px] = 0;
          data[px + 1] = 0;
          data[px + 2] = 0;
        }
      }
    }
  }
  return { data, width: side, height: side };
}

function decode(text: string): string | null {
  const { data, width, height } = rasterise(qrMatrix(text));
  return jsQR(data, width, height)?.data ?? null;
}

describe('qrMatrix round-trips through a real decoder', () => {
  it('decodes a realistic pairing URL', () => {
    const url = remoteLinkUrl('https://ubberkid.github.io/kraken-hub/', 'ABCD1234');
    expect(url.length).toBeGreaterThanOrEqual(55);
    expect(decode(url)).toBe(url);
  });

  it('decodes the longest plausible pairing URL', () => {
    const url = remoteLinkUrl(
      'https://someone-with-a-long-username.github.io/kraken-hub-fork-for-my-custom-build/',
      'ABCD1234',
    );
    expect(url.length).toBeGreaterThanOrEqual(100);
    expect(decode(url)).toBe(url);
  });

  it('decodes a short URL', () => {
    const url = remoteLinkUrl('https://k.tt/', 'ABCD1234');
    expect(decode(url)).toBe(url);
  });

  /**
   * Every version the encoder can select, decoded.
   *
   * The lengths walk 1 → 271 bytes, which crosses every version boundary in
   * `SPECS` — including version 10, the only one with two block groups, where
   * the interleaving has a second shape. A code that only ever gets exercised
   * at one length is a code whose block splitting is untested.
   */
  it('decodes at every payload length the encoder accepts', () => {
    for (let n = 1; n <= 271; n += 7) {
      const text = `https://x.tt/#/remote?room=${'A'.repeat(Math.max(1, n - 27))}`.slice(0, n);
      expect({ n, decoded: decode(text) }).toEqual({ n, decoded: text });
    }
  });

  /**
   * A pairing URL is only openable from a camera app if it carries a scheme —
   * `example.test/#/remote?room=…` decodes as plain text and iOS shows no
   * banner to tap. The payload is built from `location`, so this is a property
   * of `remoteLinkUrl` rather than of the encoder, and it is pinned here
   * alongside the bytes that actually reach the camera.
   */
  it('carries an absolute https URL through the scan', () => {
    const url = remoteLinkUrl('https://ubberkid.github.io/kraken-hub/', 'ABCD1234');
    const scanned = decode(url);
    expect(scanned).not.toBeNull();
    expect(scanned?.startsWith('https://')).toBe(true);
    expect(new URL(scanned ?? '').protocol).toBe('https:');
  });
});
