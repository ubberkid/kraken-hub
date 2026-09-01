import { describe, expect, it } from 'vitest';

import { middleEllipsis } from './text';

describe('middleEllipsis', () => {
  it('leaves a name that already fits completely alone', () => {
    expect(middleEllipsis('demo.mp4', 16)).toBe('demo.mp4');
    expect(middleEllipsis('demo.mp4', 8)).toBe('demo.mp4');
  });

  it('never exceeds the budget it was given', () => {
    for (const max of [2, 3, 5, 8, 13, 21]) {
      expect(
        Array.from(middleEllipsis('long-holiday-video-2019.mp4', max)).length,
      ).toBeLessThanOrEqual(max);
    }
  });

  /**
   * The whole point: a filename's two informative ends are its start and its
   * extension, and a tail truncation throws the extension away.
   */
  it('keeps both ends, so the extension survives', () => {
    const out = middleEllipsis('long-holiday-video-2019.mp4', 15);
    expect(out.startsWith('long-ho')).toBe(true);
    expect(out.endsWith('.mp4')).toBe(true);
    expect(out).toContain('…');
  });

  it('shortens the compact halo’s photographed case rather than wrapping it', () => {
    // 64 px of bezel is about seven characters. The bug drew "dem / o.mp / 4".
    expect(middleEllipsis('demo.mp4', 7)).toBe('dem…mp4');
  });

  it('uses one ellipsis character, not three dots', () => {
    expect(middleEllipsis('abcdefghij', 5)).not.toContain('...');
  });

  it('does not split a character in half', () => {
    // Four astral code points — eight UTF-16 code units. A naive `.slice`
    // leaves a lone surrogate and the browser draws a replacement glyph.
    const out = middleEllipsis('🐙🐙🐙🐙', 3);
    expect(out).toBe('🐙…🐙');
    expect(out).not.toContain('�');
  });

  it('degrades to the ellipsis alone rather than to nothing', () => {
    expect(middleEllipsis('anything', 1)).toBe('…');
    expect(middleEllipsis('anything', 0)).toBe('…');
    expect(middleEllipsis('anything', Number.NaN)).toBe('…');
  });
});
