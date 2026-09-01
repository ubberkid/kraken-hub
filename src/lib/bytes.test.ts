import { describe, expect, it } from 'vitest';

import { BYTES_PER_GB, BYTES_PER_KB, BYTES_PER_MB, formatBytes } from './bytes';

/**
 * The one byte formatter, and the two mistakes it exists to make unrepresentable.
 *
 * These assertions moved here from `libraryItems.test.ts` when the formatter
 * did (round 5, minors). The second one is not a style preference: it is the
 * `MB_DECIMALS = 0` copy the home screen shipped, which rendered every download
 * under half a megabyte as "0 MB" while the bytes were visibly climbing.
 */
describe('formatBytes', () => {
  it('renders an em dash rather than a fake zero', () => {
    expect(formatBytes(0)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('never rounds a real file down to "0.0 MB"', () => {
    expect(formatBytes(31_995)).toBe('31 kB');
    expect(formatBytes(2_097_152)).toBe('2.0 MB');
  });

  it('switches unit exactly at a megabyte, and keeps one decimal above it', () => {
    expect(formatBytes(BYTES_PER_MB - 1)).toMatch(/ kB$/);
    expect(formatBytes(BYTES_PER_MB)).toBe('1.0 MB');
  });

  /**
   * Round 6's minors, both ends of the range.
   *
   * Below a kilobyte the kB rung rounded toward zero, so a 70-byte file was
   * rendered as "0 kB" — the fake zero the em-dash rule above exists to
   * prevent, reached by a different route. Above a gigabyte there was no rung,
   * so the Library's quota meter read "4096.0 MB" at somebody whose browser
   * reports a 4 GB budget.
   */
  it('says bytes below a kilobyte rather than rounding a real file to zero', () => {
    expect(formatBytes(70)).toBe('70 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(BYTES_PER_KB - 1)).toBe('1023 B');
    expect(formatBytes(BYTES_PER_KB)).toBe('1 kB');
  });

  it('switches to gigabytes rather than printing four thousand megabytes', () => {
    expect(formatBytes(BYTES_PER_GB - 1)).toMatch(/ MB$/);
    expect(formatBytes(BYTES_PER_GB)).toBe('1.0 GB');
    expect(formatBytes(BYTES_PER_MB * 4096)).toBe('4.0 GB');
  });

  it('is binary at every rung, because every number it is read against is', () => {
    expect(BYTES_PER_GB).toBe(1024 * 1024 * 1024);
  });

  it('is binary, because every number it is read against is', () => {
    expect(BYTES_PER_MB).toBe(1024 * 1024);
  });
});
