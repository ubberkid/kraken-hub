import { describe, expect, it } from 'vitest';

import { MAX_ENVELOPE_BYTES } from '../sync/types';

import { isTeleChunk } from './chunkedTele';
import {
  LIBRARY_BODY_BUDGET_BYTES,
  LIBRARY_CHUNK_KIND,
  LIBRARY_ITEM_MAX,
  bodyBytes,
  buildLibraryPacket,
  toMediaSummaries,
  trimLibrary,
} from './libraryPacket';

import type { MediaKind, MediaRecord } from '../platform/mediaStore';

/**
 * The arithmetic behind the silent scale cliff, and the one-shelf claim that
 * wave 2 makes of it.
 *
 * A 40-row clip index was ~8.2 KB against an 8 KB envelope, and `tele` is not
 * trimmed the way `state` is — the packet was dropped with a `log.warn` on a
 * hidden window nobody is watching, so a big library's shelf went blank on the
 * phone forever and invisibly. These tests are the reason that cannot come back.
 */

/**
 * A row of the MERGED store, which is what the packet is built from now.
 *
 * It used to be built from the two localStorage mirrors, and these helpers built
 * `ClipSummary`/`ImageSummary` to match. The rows the display actually has in
 * front of it are `MediaRecord`s — same shelf, one shape, `kind` on the row — so
 * the fixtures are those, and the assertions below are unchanged: what is being
 * pinned here is the wire's arithmetic, not where the display reads from.
 */
function row(kind: MediaKind, n: number, over: Partial<MediaRecord> = {}): MediaRecord {
  const isClip = kind === 'clip';
  return {
    id: `${isClip ? 'clip' : 'img'}-${String(n).padStart(4, '0')}`,
    kind,
    name: isClip ? `clip ${String(n)}.mp4` : `picture ${String(n)}.png`,
    mime: isClip ? 'video/mp4' : 'image/png',
    size: isClip ? 12_345_678 : 45_678,
    width: 640,
    height: 640,
    createdAt: 1_700_000_000_000 + n * 1000,
    lastUsedAt: 0,
    thumbBlob: null,
    sourceUrl: null,
    pinned: false,
    durationSec: isClip ? 61.5 : 0,
    sha256Prefix: null,
    animated: false,
    ...over,
  };
}

function clip(n: number, over: Partial<MediaRecord> = {}): MediaRecord {
  return row('clip', n, over);
}

function image(n: number, over: Partial<MediaRecord> = {}): MediaRecord {
  return row('image', n, over);
}

/**
 * The store hands back ONE list. The two arguments survive only because they
 * make the "shared across kinds" tests below read as what they assert.
 */
function shelf(clips: readonly MediaRecord[], images: readonly MediaRecord[] = []) {
  return toMediaSummaries([...clips, ...images]);
}

describe('one shelf on the wire', () => {
  it('carries kind as a property of the row, not as a second list', () => {
    const items = shelf([clip(1)], [image(1)]);
    expect(items.map((row) => row.kind)).toEqual(['clip', 'image']);
  });

  it('omits the fields that do not apply to a kind rather than sending zeroes', () => {
    const [aClip, aPicture] = shelf([clip(1)], [image(1, { animated: true })]);
    expect(aClip).not.toHaveProperty('animated');
    expect(aPicture).not.toHaveProperty('durationSec');
    expect(aPicture?.animated).toBe(true);
    // …and an unknown source is absent, not `null`: `"sourceUrl":null` is
    // seventeen bytes paid forty times for nothing.
    expect(aClip).not.toHaveProperty('sourceUrl');
  });
});

describe('the shared 40-item budget', () => {
  it('is shared across kinds rather than granted per kind', () => {
    const items = trimLibrary(
      shelf(
        Array.from({ length: 30 }, (_, i) => clip(i)),
        Array.from({ length: 30 }, (_, i) => image(i)),
      ),
    );
    expect(items).toHaveLength(LIBRARY_ITEM_MAX);
    // …and BOTH kinds are represented: a per-kind cap would have published
    // forty clips and no pictures at all, which is the half-a-collection bug.
    expect(items.some((row) => row.kind === 'clip')).toBe(true);
    expect(items.some((row) => row.kind === 'image')).toBe(true);
  });

  it('keeps the newest things, not the first twenty of each', () => {
    // Every picture is newer than every clip.
    const items = trimLibrary(
      shelf(
        Array.from({ length: 40 }, (_, i) => clip(i)),
        Array.from({ length: 10 }, (_, i) => image(i, { createdAt: 1_800_000_000_000 + i * 1000 })),
      ),
    );
    expect(items.filter((row) => row.kind === 'image')).toHaveLength(10);
    expect(items.filter((row) => row.kind === 'clip')).toHaveLength(30);
    // The oldest clips are what fell off the end.
    expect(items.some((row) => row.id === 'clip-0000')).toBe(false);
    expect(items.some((row) => row.id === 'clip-0039')).toBe(true);
  });

  it('orders newest first with a TOTAL order, so both ends agree', () => {
    // Two rows written in the same millisecond. Without the id tiebreak the
    // Kraken and the sofa can put them in different places.
    const items = trimLibrary(
      shelf([clip(1, { createdAt: 5 }), clip(2, { createdAt: 5 })], [image(3, { createdAt: 5 })]),
    );
    expect(items.map((row) => row.id)).toEqual(['clip-0001', 'clip-0002', 'img-0003']);
  });

  it('is a no-op for a library that fits', () => {
    expect(trimLibrary(shelf([clip(1)], [image(1)]))).toHaveLength(2);
  });
});

describe('buildLibraryPacket', () => {
  const ts = 1_700_000_000_000;

  it('sends an ordinary library in one envelope', () => {
    const packet = buildLibraryPacket({
      items: shelf(
        Array.from({ length: 10 }, (_, i) => clip(i)),
        Array.from({ length: 10 }, (_, i) => image(i)),
      ),
      downloads: [],
      ts,
    });
    expect(packet.chunks).toBeNull();
    expect(packet.body.kind).toBe('library');
    expect(bodyBytes(packet.body)).toBeLessThanOrEqual(LIBRARY_BODY_BUDGET_BYTES);
  });

  it('keeps a FULL forty-item shelf inside the envelope', () => {
    // The row shrink (B1) is what buys this: the same forty rows carrying
    // `mime`, `width` and `height` measured over the 8 KB ceiling.
    const packet = buildLibraryPacket({
      items: shelf(Array.from({ length: 40 }, (_, i) => clip(i))),
      downloads: [],
      ts,
    });
    expect(packet.chunks).toBeNull();
    expect(packet.body.items).toHaveLength(LIBRARY_ITEM_MAX);
    expect(bodyBytes(packet.body)).toBeLessThan(MAX_ENVELOPE_BYTES);
  });

  it('PAGES rather than silently dropping when the rows are long', () => {
    // Forty long names plus forty source URLs: within the item budget, over the
    // byte budget. This is the case that used to vanish with a `log.warn`.
    const long = 'a-really-quite-long-filename-somebody-actually-has'.repeat(2);
    const packet = buildLibraryPacket({
      items: shelf(
        Array.from({ length: 40 }, (_, i) =>
          clip(i, {
            name: `${long}-${String(i)}.mp4`,
            sourceUrl: `https://example.invalid/${long}/${String(i)}.mp4`,
          }),
        ),
      ),
      downloads: [],
      ts,
    });

    expect(packet.chunks).not.toBeNull();
    const chunks = packet.chunks ?? [];
    expect(chunks.length).toBeGreaterThan(1);
    // Nothing was thrown away to make it fit: every row is still in there.
    expect(packet.body.items).toHaveLength(40);

    for (const chunk of chunks) {
      expect(isTeleChunk(chunk, LIBRARY_CHUNK_KIND)).toBe(true);
      expect(chunk.ts).toBe(ts);
      // Each part has to fit the envelope on its own, which is the only thing
      // that makes paging better than not paging.
      expect(bodyBytes(chunk)).toBeLessThan(MAX_ENVELOPE_BYTES);
    }

    // …and the parts reassemble into exactly the one-envelope body.
    const rejoined: unknown = JSON.parse(chunks.map((c) => c.payload).join(''));
    expect(rejoined).toEqual(packet.body);
  });
});
