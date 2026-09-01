import { describe, expect, it } from 'vitest';

import { legacyToMedia, mergeWithLegacy, newestFirst, planCopy } from './mediaStore';

import type { MediaRecord } from './mediaStore';

/**
 * The merge (C2), tested where its correctness actually lives.
 *
 * The migration deliberately has almost no logic in the database half: the
 * `versionchange` upgrade reads nothing, and the copy is a plain `readwrite`
 * transaction driven one id at a time. Everything that can be *wrong* about it —
 * whether it repeats work, whether an interruption loses a row, what a half-done
 * library looks like to a reader, whether a picture survives the round trip — is
 * in the four pure functions below, which is why they were factored out.
 *
 * The transactional half (bytes and metadata landing together, a delete removing
 * the legacy row so the fallback cannot resurrect it) is asserted against a real
 * IndexedDB in `tests/e2e/one-library.spec.ts`, because a real IndexedDB is the
 * only thing worth asserting it against.
 */

function media(id: string, over: Partial<MediaRecord> = {}): MediaRecord {
  return {
    id,
    kind: 'clip',
    name: `${id}.mp4`,
    mime: 'video/mp4',
    size: 100,
    width: 0,
    height: 0,
    createdAt: 1000,
    lastUsedAt: 0,
    thumbBlob: null,
    sourceUrl: null,
    pinned: false,
    durationSec: 10,
    sha256Prefix: null,
    animated: false,
    ...over,
  };
}

describe('one order, everywhere', () => {
  it('is newest first, and TOTAL — ties break on id', () => {
    const rows = [
      { id: 'b', createdAt: 5 },
      { id: 'a', createdAt: 5 },
      { id: 'c', createdAt: 9 },
    ];
    expect([...rows].sort(newestFirst).map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });

  it('never reports two distinct rows as equal', () => {
    // A comparator that returns 0 for different rows lets the shelf the Kraken
    // publishes and the shelf the phone draws disagree about two files written
    // in the same millisecond — which is exactly what an ingest loop does.
    expect(newestFirst({ id: 'a', createdAt: 5 }, { id: 'b', createdAt: 5 })).toBeLessThan(0);
    expect(newestFirst({ id: 'b', createdAt: 5 }, { id: 'a', createdAt: 5 })).toBeGreaterThan(0);
    expect(newestFirst({ id: 'a', createdAt: 5 }, { id: 'a', createdAt: 5 })).toBe(0);
  });
});

describe('legacyToMedia — both kinds round-trip', () => {
  it('carries a clip row across with its clip-only fields intact', () => {
    const row = legacyToMedia(
      {
        id: 'c1',
        name: 'dunes.mp4',
        mime: 'video/mp4',
        size: 4_000_000,
        width: 1920,
        height: 1080,
        createdAt: 7,
        lastUsedAt: 8,
        durationSec: 61.5,
        sha256Prefix: 'deadbeef',
        sourceUrl: 'https://example.invalid/dunes.mp4',
        pinned: true,
      },
      'clip',
    );
    expect(row).toMatchObject({
      id: 'c1',
      kind: 'clip',
      durationSec: 61.5,
      sha256Prefix: 'deadbeef',
      pinned: true,
      // …and the picture-only field gets the "not this kind" value rather than
      // being absent, so no reader has to branch on whether it is there.
      animated: false,
    });
  });

  it('carries a picture row across the same way', () => {
    const row = legacyToMedia(
      {
        id: 'i1',
        name: 'wall.png',
        mime: 'image/png',
        size: 45_678,
        width: 8,
        height: 8,
        createdAt: 7,
        lastUsedAt: 0,
        animated: true,
        sourceUrl: null,
        pinned: false,
      },
      'image',
    );
    expect(row).toMatchObject({
      id: 'i1',
      kind: 'image',
      animated: true,
      durationSec: 0,
      sha256Prefix: null,
      sourceUrl: null,
    });
  });

  it('refuses a row with no id rather than shelving something unaddressable', () => {
    // A tile with no id cannot be played, deleted or copied. A half-read row on
    // a shelf is worse than a missing one.
    expect(legacyToMedia({ name: 'orphan.mp4' }, 'clip')).toBeNull();
    expect(legacyToMedia({ id: 42 }, 'clip')).toBeNull();
  });

  it('falls back to the id for a nameless row, and to zero for junk numbers', () => {
    const row = legacyToMedia({ id: 'x', size: 'lots', createdAt: Number.NaN }, 'clip');
    expect(row?.name).toBe('x');
    expect(row?.size).toBe(0);
    expect(row?.createdAt).toBe(0);
  });
});

describe('planCopy — idempotence and restartability are one property', () => {
  it('copies every legacy row on a first run', () => {
    expect(planCopy(new Set(), ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op on a second run — a finished migration copies nothing', () => {
    expect(planCopy(new Set(['a', 'b', 'c']), ['a', 'b', 'c'])).toEqual([]);
  });

  it('resumes exactly where an interruption left off', () => {
    // The whole of the "an interruption just means not finished yet" claim: the
    // copy is driven by what is ALREADY in `media`, so a page closed halfway
    // through picks up the remainder and never redoes the front of the list.
    expect(planCopy(new Set(['a']), ['a', 'b', 'c'])).toEqual(['b', 'c']);
  });

  it('ignores rows in `media` that no legacy store claims', () => {
    // Rows written natively after the merge. They are not legacy rows and there
    // is nothing to copy for them.
    expect(planCopy(new Set(['new', 'a']), ['a'])).toEqual([]);
  });
});

describe('mergeWithLegacy — the shelf is complete at every point of the copy', () => {
  const copied = media('a', { createdAt: 3, pinned: true });
  const stale = media('a', { createdAt: 3, pinned: false });
  const notYet = media('b', { createdAt: 9, kind: 'image', animated: true });

  it('shows both halves before the copy has finished', () => {
    expect(mergeWithLegacy([copied], [stale, notYet]).map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('lets the merged row WIN, so a pin written after the copy is not shadowed', () => {
    // This is the whole correctness argument for "copy, don't move": once a row
    // is in `media` it is the row, and the original left behind in `clips` can
    // never take a later edit back.
    const [, winner] = mergeWithLegacy([copied], [stale, notYet]);
    expect(winner?.pinned).toBe(true);
  });

  it('is the same shelf before the copy starts and after it ends', () => {
    const before = mergeWithLegacy([], [stale, notYet]).map((r) => r.id);
    const after = mergeWithLegacy([stale, notYet], []).map((r) => r.id);
    expect(before).toEqual(after);
  });

  it('holds both kinds in one ordered list', () => {
    const shelf = mergeWithLegacy([copied], [notYet]);
    expect(shelf.map((r) => r.kind)).toEqual(['image', 'clip']);
  });
});
