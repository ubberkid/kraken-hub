import { describe, expect, it } from 'vitest';

import {
  NO_PENDING,
  RECONCILE_GRACE_MS,
  applyPending,
  reconcilePending,
  rejectionNotice,
  type Pending,
} from './curationOptimistic';

import type { LibraryTile } from './libraryItems';

/**
 * Optimistic curation, as arithmetic.
 *
 * The behaviour this pins is the one that is otherwise only observable as "the
 * shelf flickered": a tile that disappears, comes back a heartbeat later because
 * a packet that was already in flight described the old shelf, and then
 * disappears again when the display's own republish lands. Every branch below is
 * one of the three outcomes — too soon, converged, rejected — and the grace
 * window is what separates the first from the other two.
 */

function tile(id: string, over: Partial<LibraryTile> = {}): LibraryTile {
  return {
    key: `clip:${id}`,
    kind: 'clip',
    state: 'ready',
    id,
    name: id,
    sizeBytes: 100,
    durationSec: 10,
    width: 0,
    height: 0,
    pinned: false,
    animated: false,
    sourceUrl: null,
    sortAt: 1,
    thumbBlob: null,
    download: null,
    ...over,
  };
}

const NOW = 1_000_000;

describe('applyPending', () => {
  it('is the identity when nothing is in flight', () => {
    const tiles = [tile('a'), tile('b')];
    expect(applyPending(tiles, NO_PENDING)).toEqual(tiles);
  });

  it('removes a deleted row the instant it is confirmed', () => {
    const pending: Pending[] = [
      { kind: 'delete', ids: ['a', 'c'], names: { a: 'A', c: 'C' }, at: NOW },
    ];
    expect(applyPending([tile('a'), tile('b'), tile('c')], pending).map((t) => t.id)).toEqual([
      'b',
    ]);
  });

  it('overlays a pin and a rename without touching anything else', () => {
    const pending: Pending[] = [
      { kind: 'pin', ids: ['a'], kindOf: 'clip', names: { a: 'A' }, pinned: true, at: NOW },
      { kind: 'rename', id: 'b', name: 'Sunset', at: NOW },
    ];
    const out = applyPending([tile('a'), tile('b')], pending);
    expect(out[0]?.pinned).toBe(true);
    expect(out[1]?.name).toBe('Sunset');
    expect(out[0]?.name).toBe('a');
  });

  it('a delete wins over a rename of the same row', () => {
    // Order matters: a rename applied after a delete would resurrect the tile.
    const pending: Pending[] = [
      { kind: 'rename', id: 'a', name: 'Sunset', at: NOW },
      { kind: 'delete', ids: ['a'], names: { a: 'a' }, at: NOW },
    ];
    expect(applyPending([tile('a')], pending)).toEqual([]);
  });

  it('leaves a download in flight alone — it has no id to act on', () => {
    const job = tile('x', { id: null, key: 'job:https://e/x', state: 'downloading' });
    const pending: Pending[] = [{ kind: 'delete', ids: ['a'], names: {}, at: NOW }];
    expect(applyPending([job], pending)).toEqual([job]);
  });
});

describe('reconcilePending', () => {
  const del: Pending = { kind: 'delete', ids: ['a'], names: { a: 'A' }, at: NOW };

  it('ignores a packet that cannot possibly have known', () => {
    // The library is re-announced every five minutes and on demand, so a packet
    // already on the wire when the command left still describes the old shelf.
    const result = reconcilePending([del], [tile('a')], NOW + RECONCILE_GRACE_MS - 1);
    expect(result.pending).toEqual([del]);
    expect(result.rejected).toEqual([]);
  });

  it('forgets a change the packet agrees with, silently', () => {
    const result = reconcilePending([del], [tile('b')], NOW + RECONCILE_GRACE_MS);
    expect(result.pending).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it('rolls a delete back, by name, when the Kraken still has the row', () => {
    const result = reconcilePending([del], [tile('a')], NOW + RECONCILE_GRACE_MS);
    expect(result.pending).toEqual([]);
    expect(result.rejected).toEqual(['A']);
  });

  it('judges a pin on the value, not on the row still existing', () => {
    const pin: Pending = {
      kind: 'pin',
      ids: ['a'],
      kindOf: 'clip',
      names: { a: 'A' },
      pinned: true,
      at: NOW,
    };
    const late = NOW + RECONCILE_GRACE_MS;
    expect(reconcilePending([pin], [tile('a', { pinned: true })], late).rejected).toEqual([]);
    expect(reconcilePending([pin], [tile('a', { pinned: false })], late).rejected).toEqual(['A']);
    // A row that vanished entirely is not a disagreement about pinning: it was
    // deleted somewhere else, and there is nothing left to argue about.
    expect(reconcilePending([pin], [], late).rejected).toEqual([]);
  });

  it('judges a rename on the name the packet carries', () => {
    const ren: Pending = { kind: 'rename', id: 'a', name: 'Sunset', at: NOW };
    const late = NOW + RECONCILE_GRACE_MS;
    expect(reconcilePending([ren], [tile('a', { name: 'Sunset' })], late).rejected).toEqual([]);
    expect(reconcilePending([ren], [tile('a', { name: 'a' })], late).rejected).toEqual(['a']);
  });

  it('keeps the young entries and settles the old ones in one pass', () => {
    const young: Pending = { kind: 'delete', ids: ['b'], names: { b: 'B' }, at: NOW + 2000 };
    const result = reconcilePending([del, young], [tile('a'), tile('b')], NOW + RECONCILE_GRACE_MS);
    expect(result.pending).toEqual([young]);
    expect(result.rejected).toEqual(['A']);
  });
});

describe('rejectionNotice', () => {
  it('names what did not change, and stops', () => {
    expect(rejectionNotice([])).toBe('');
    expect(rejectionNotice(['A'])).toBe('Your Kraken did not change “A”.');
    expect(rejectionNotice(['A', 'B'])).toBe('Your Kraken did not change “A” or 1 other item.');
    expect(rejectionNotice(['A', 'B', 'C'])).toBe(
      'Your Kraken did not change “A” or 2 other items.',
    );
  });
});
