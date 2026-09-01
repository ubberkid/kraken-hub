import { describe, expect, it } from 'vitest';

import { buildLibraryTiles } from './libraryItems';
import { libraryFromWire } from './wireLibrary';

import type { ClipRecord } from '../../modules/video/local/clipStore';

/**
 * The claim under test is not "it parses JSON" — it is **the phone's shelf and
 * CAM's shelf are the same shelf**.
 *
 * So the assertions build tiles from a stored record and from the wire row that
 * record produces, and demand the same tiles out. A second builder, or a second
 * tile shape, is how "the library is different" comes back.
 */

const STORED: ClipRecord = {
  id: 'abc',
  name: 'dunes.mp4',
  mime: 'video/mp4',
  size: 4_000_000,
  durationSec: 61.5,
  width: 1920,
  height: 1080,
  createdAt: 1_700_000_000_000,
  lastUsedAt: 1_700_000_000_000,
  thumbBlob: null,
  sha256Prefix: null,
  sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
  pinned: true,
};

/** What `toSummary(STORED)` puts on the wire, as JSON would deliver it. */
const WIRE: Record<string, unknown> = {
  id: 'abc',
  kind: 'clip',
  name: 'dunes.mp4',
  durationSec: 61.5,
  size: 4_000_000,
  pinned: true,
  createdAt: 1_700_000_000_000,
  sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
};

describe('libraryFromWire', () => {
  it('produces the same tile the stored record does', () => {
    const fromStore = buildLibraryTiles({
      clips: [STORED],
      images: [],
      downloads: [],
      dismissed: new Set(),
    });
    const fromWire = buildLibraryTiles(libraryFromWire({ items: [WIRE] }));

    expect(fromWire).toHaveLength(1);
    // Everything a tile RENDERS has to match. The pixel dimensions are the one
    // field the wire row no longer carries (B1) and the one field the tile has
    // not drawn since round 2's R7.
    const [store] = fromStore;
    const [wire] = fromWire;
    expect(wire?.key).toBe(store?.key);
    expect(wire?.name).toBe(store?.name);
    expect(wire?.kind).toBe(store?.kind);
    expect(wire?.state).toBe(store?.state);
    expect(wire?.durationSec).toBe(store?.durationSec);
    expect(wire?.sizeBytes).toBe(store?.sizeBytes);
    expect(wire?.pinned).toBe(store?.pinned);
    expect(wire?.sortAt).toBe(store?.sortAt);
    expect(wire?.sourceUrl).toBe(store?.sourceUrl);
  });

  it('spans both kinds, newest first, exactly like the stored shelf', () => {
    const tiles = buildLibraryTiles(
      libraryFromWire({
        items: [
          { ...WIRE, createdAt: 1000 },
          {
            id: 'i1',
            kind: 'image',
            name: 'wall.png',
            size: 1000,
            animated: true,
            createdAt: 2000,
          },
        ],
      }),
    );
    expect(tiles.map((t) => t.key)).toEqual(['image:i1', 'clip:abc']);
    expect(tiles[0]?.animated).toBe(true);
    expect(tiles[0]?.durationSec).toBeNull();
  });

  it('drops a half-read row rather than rendering a tile that does nothing', () => {
    // Written by a peer on a different build, or a fork. A tile with no id
    // cannot be played and a tile with no name cannot be recognised.
    const input = libraryFromWire({
      items: [
        WIRE,
        { name: 'no id' },
        { id: 'no name' },
        'not an object',
        null,
        { id: 'i', kind: 'image', name: 'ok', size: 1, animated: false, createdAt: 1 },
      ],
    });
    expect(input.clips).toHaveLength(1);
    expect(input.images).toHaveLength(1);
  });

  it('treats a missing packet as an empty shelf rather than throwing', () => {
    const input = libraryFromWire(null);
    expect(buildLibraryTiles(input)).toEqual([]);
  });

  it('ignores a packet whose lists are the wrong shape entirely', () => {
    const input = libraryFromWire({ items: 'nope', downloads: null });
    expect(buildLibraryTiles(input)).toEqual([]);
  });

  /**
   * A row with no `kind` is a clip.
   *
   * Every row this channel has ever carried was a clip, so a display running an
   * older build fills the shelf rather than emptying it — the same forwarding
   * courtesy `CmdOp` gets, applied to the packet.
   */
  it('reads a row with no kind as a clip', () => {
    const { kind: _kind, ...noKind } = WIRE;
    const input = libraryFromWire({ items: [noKind] });
    expect(input.clips).toHaveLength(1);
    expect(input.images).toHaveLength(0);
  });
});
