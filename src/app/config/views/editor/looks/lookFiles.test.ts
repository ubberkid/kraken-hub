import { describe, expect, it } from 'vitest';

import { MAX_LOOK_FILE_BYTES } from '../../../../../state/look/file';

import { lookFileName, looksReadable, MAX_READ_BYTES } from './lookFiles';

describe('what an exported Look is called', () => {
  it('keeps the name the user gave it', () => {
    expect(lookFileName('Slow tide')).toBe('Slow tide.krakenlook');
  });

  it('drops what a file system will not take, on any of the three', () => {
    expect(lookFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij.krakenlook');
  });

  it('never produces a name that is only an extension', () => {
    expect(lookFileName('   ')).toBe('look.krakenlook');
    expect(lookFileName('...')).toBe('look.krakenlook');
  });

  it('keeps letters that are not English', () => {
    expect(lookFileName('Sonnenuntergang über dem Meer')).toContain('über');
  });
});

describe('what is worth reading off a disk', () => {
  it('reads a Look by whatever name it arrived under', () => {
    for (const name of ['a.krakenlook', 'a.json', 'a.txt', 'a']) {
      expect(looksReadable({ name, type: '', size: 2_000 })).toBe(true);
    }
  });

  it('does not read a video as a string to be told it is not JSON', () => {
    expect(looksReadable({ name: 'clip.mp4', type: 'video/mp4', size: 4_000_000_000 })).toBe(false);
  });

  it('still reads an oversized Look, so the card can name the real limit', () => {
    // The read ceiling is comfortably above the format's cap on purpose: a file
    // just over the cap must reach the parser and get `too-big`, not vanish.
    expect(MAX_READ_BYTES).toBeGreaterThan(MAX_LOOK_FILE_BYTES);
    expect(looksReadable({ name: 'big.krakenlook', type: '', size: MAX_LOOK_FILE_BYTES + 1 })).toBe(
      true,
    );
  });
});
