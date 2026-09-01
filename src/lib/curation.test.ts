import { describe, expect, it } from 'vitest';

import {
  CURATION_MAX_IDS,
  MEDIA_NAME_MAX,
  cleanMediaName,
  parseDeleteMedia,
  parseRenameMedia,
  parseSetPinned,
} from './curation';

/**
 * The curation arguments arrive over a channel any peer holding the room key can
 * write to, and that peer may be a different build of this app, or a fork. So
 * the parsers are the boundary: everything downstream treats their output as a
 * fact, which is only safe if nothing malformed can get through them.
 *
 * The three properties worth pinning are the three the design turns on —
 * absolute rather than relative, batched, idempotent — plus the one that made
 * batching necessary in the first place (`sendCmd` drops, so the batch has to
 * fit in one command).
 */

describe('setPinned', () => {
  it('carries an absolute value, and refuses anything that is not one', () => {
    expect(parseSetPinned({ ids: ['a'], kind: 'clip', pinned: true })).toEqual({
      ids: ['a'],
      kind: 'clip',
      pinned: true,
    });
    // No toggle, ever: the `cmd` channel is redelivered by a replaying transport
    // and "flip it" applied twice is the `seekBy` hazard.
    expect(parseSetPinned({ ids: ['a'], kind: 'clip' })).toBeNull();
    expect(parseSetPinned({ ids: ['a'], kind: 'clip', pinned: 'yes' })).toBeNull();
  });

  it('refuses an unknown kind and an empty batch', () => {
    expect(parseSetPinned({ ids: ['a'], kind: 'sound', pinned: true })).toBeNull();
    expect(parseSetPinned({ ids: [], kind: 'clip', pinned: true })).toBeNull();
    expect(parseSetPinned({ ids: 'a', kind: 'clip', pinned: true })).toBeNull();
    expect(parseSetPinned(null)).toBeNull();
    expect(parseSetPinned([1, 2])).toBeNull();
  });
});

describe('deleteMedia', () => {
  it('de-duplicates a batch, because applying the same row twice buys nothing', () => {
    expect(parseDeleteMedia({ ids: ['a', 'b', 'a', 'b', 'c'] })).toEqual({ ids: ['a', 'b', 'c'] });
  });

  it('drops rows that are not addressable rather than half-reading them', () => {
    expect(parseDeleteMedia({ ids: ['a', '', 7, null, 'b'] })).toEqual({ ids: ['a', 'b'] });
    expect(parseDeleteMedia({ ids: ['', null] })).toBeNull();
  });

  it('caps the batch at the size of the shelf itself', () => {
    const ids = Array.from({ length: CURATION_MAX_IDS + 20 }, (_, i) => `id-${String(i)}`);
    expect(parseDeleteMedia({ ids })?.ids).toHaveLength(CURATION_MAX_IDS);
  });
});

describe('renameMedia', () => {
  it('takes one id and one name — a new name cannot apply to five rows', () => {
    expect(parseRenameMedia({ id: 'a', name: '  Sunset  ' })).toEqual({ id: 'a', name: 'Sunset' });
    expect(parseRenameMedia({ id: 'a', name: '   ' })).toBeNull();
    expect(parseRenameMedia({ id: '', name: 'x' })).toBeNull();
    expect(parseRenameMedia({ name: 'x' })).toBeNull();
  });

  it('strips control characters instead of refusing the rename', () => {
    // A name pasted from somewhere strange should arrive tidy, not fail: the
    // tile renders one line, and a newline in it is a layout bug forever.
    expect(cleanMediaName('holiday\n\tclip')).toBe('holiday  clip');
  });

  it('caps the name at something a tile can render', () => {
    const long = 'x'.repeat(MEDIA_NAME_MAX + 50);
    expect(cleanMediaName(long)).toHaveLength(MEDIA_NAME_MAX);
  });
});
