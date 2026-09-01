import { describe, expect, it } from 'vitest';

import { buildLibraryTiles, formatBytes, formatDuration, tileDetail } from './libraryItems';

import type { ImageRecord } from '../../modules/image/imageStore';
import type { ClipRecord } from '../../modules/video/local/clipStore';
import type { DownloadEntry } from '../../modules/video/local/downloadManager';

/**
 * The Library page's one job: show what you have, once each, in a stable order,
 * with a job in flight sitting where the thing it becomes will sit.
 *
 * Every case below is a bug the four-section page actually had — a finished
 * download shown twice (once as a job, once as a clip), a job from the other
 * window that had already produced a clip, a tile that jumped to a different
 * section the instant it completed.
 */

function clip(over: Partial<ClipRecord> = {}): ClipRecord {
  return {
    id: 'c1',
    name: 'demo.mp4',
    mime: 'video/mp4',
    size: 2_097_152,
    durationSec: 94,
    width: 1080,
    height: 1080,
    createdAt: 1000,
    lastUsedAt: 1000,
    thumbBlob: null,
    sha256Prefix: null,
    sourceUrl: null,
    pinned: false,
    ...over,
  };
}

function image(over: Partial<ImageRecord> = {}): ImageRecord {
  return {
    id: 'i1',
    name: 'wallpaper.png',
    mime: 'image/png',
    size: 524_288,
    width: 1024,
    height: 1024,
    animated: false,
    createdAt: 900,
    lastUsedAt: 900,
    sourceUrl: null,
    pinned: false,
    ...over,
  };
}

function job(over: Partial<DownloadEntry> = {}): DownloadEntry {
  return {
    id: 'd1',
    url: 'https://example.test/a.mp4',
    sourceUrl: 'https://example.test/a.mp4',
    name: 'a.mp4',
    state: 'downloading',
    receivedBytes: 1000,
    totalBytes: 4000,
    attempt: 1,
    error: null,
    reason: null,
    clipId: null,
    startedAt: 2000,
    updatedAt: 2000,
    ...over,
  };
}

const NONE: ReadonlySet<string> = new Set();

describe('buildLibraryTiles', () => {
  it('puts clips, pictures and running jobs in one list, newest first', () => {
    const tiles = buildLibraryTiles({
      clips: [clip()],
      images: [image()],
      downloads: [job()],
      dismissed: NONE,
    });
    expect(tiles.map((t) => t.key)).toEqual([
      'job:https://example.test/a.mp4',
      'clip:c1',
      'image:i1',
    ]);
    expect(tiles.map((t) => t.state)).toEqual(['downloading', 'ready', 'ready']);
    expect(tiles.map((t) => t.kind)).toEqual(['clip', 'clip', 'image']);
  });

  it('replaces a job with its clip IN PLACE once the bytes exist', () => {
    const running = buildLibraryTiles({
      clips: [clip({ id: 'old', createdAt: 500 })],
      images: [],
      downloads: [job()],
      dismissed: NONE,
    });
    expect(running[0]?.state).toBe('downloading');

    // The display finished it: a clip row appears, and the mirrored job says
    // `done` with the clip id. One tile, in the same slot.
    const finished = buildLibraryTiles({
      clips: [
        clip({ id: 'new', createdAt: 2001, sourceUrl: 'https://example.test/a.mp4' }),
        clip({ id: 'old', createdAt: 500 }),
      ],
      images: [],
      downloads: [job({ state: 'done', clipId: 'new' })],
      dismissed: NONE,
    });
    expect(finished).toHaveLength(2);
    expect(finished[0]?.state).toBe('ready');
    expect(finished[0]?.id).toBe('new');
  });

  it('drops a job whose bytes are already a clip, matched by source url alone', () => {
    // The other window minted its own download id, so `clipId` is a stranger.
    const tiles = buildLibraryTiles({
      clips: [clip({ sourceUrl: 'https://example.test/a.mp4' })],
      images: [],
      downloads: [job({ id: 'other-window', clipId: 'not-this-one' })],
      dismissed: NONE,
    });
    expect(tiles).toHaveLength(1);
    expect(tiles[0]?.state).toBe('ready');
  });

  it('shows a failed job as a tile, and hides it once dismissed', () => {
    const failed = job({ state: 'error', reason: 'quota', error: 'Failed to fetch' });
    const tiles = buildLibraryTiles({
      clips: [],
      images: [],
      downloads: [failed],
      dismissed: NONE,
    });
    expect(tiles).toHaveLength(1);
    expect(tiles[0]?.state).toBe('failed');
    expect(tiles[0]?.download?.reason).toBe('quota');

    expect(
      buildLibraryTiles({
        clips: [],
        images: [],
        downloads: [failed],
        dismissed: new Set(['d1']),
      }),
    ).toEqual([]);
  });

  it('says nothing about a job the user cancelled', () => {
    expect(
      buildLibraryTiles({
        clips: [],
        images: [],
        downloads: [job({ state: 'aborted' })],
        dismissed: NONE,
      }),
    ).toEqual([]);
  });

  it('collapses repeated attempts at one link into the newest tile', () => {
    const tiles = buildLibraryTiles({
      clips: [],
      images: [],
      downloads: [
        job({ id: 'first', state: 'error', startedAt: 1000 }),
        job({ id: 'retry', state: 'downloading', startedAt: 3000 }),
      ],
      dismissed: NONE,
    });
    expect(tiles).toHaveLength(1);
    expect(tiles[0]?.download?.id).toBe('retry');
    expect(tiles[0]?.state).toBe('downloading');
  });
});

describe('tileDetail', () => {
  it('reads the real stored metadata for a clip', () => {
    const [tile] = buildLibraryTiles({
      clips: [clip()],
      images: [],
      downloads: [],
      dismissed: NONE,
    });
    expect(tileDetail(tile!)).toBe('1:34 · 1080×1080 · 2.0 MB');
  });

  it('omits the duration for a picture and names an animated one', () => {
    const [tile] = buildLibraryTiles({
      clips: [],
      images: [image({ animated: true })],
      downloads: [],
      dismissed: NONE,
    });
    expect(tileDetail(tile!)).toBe('1024×1024 · 512 kB · animated');
  });

  it('never renders 0×0 for something that has not been probed', () => {
    const [tile] = buildLibraryTiles({
      clips: [],
      images: [],
      downloads: [job()],
      dismissed: NONE,
    });
    expect(tileDetail(tile!)).not.toContain('0×0');
  });
});

describe('formatting', () => {
  it('renders an em dash rather than a fake zero', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
    expect(formatBytes(0)).toBe('—');
  });

  it('never rounds a real file down to "0.0 MB"', () => {
    expect(formatBytes(31_995)).toBe('31 kB');
    expect(formatBytes(2_097_152)).toBe('2.0 MB');
  });

  it('pads the seconds', () => {
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(600)).toBe('10:00');
  });
});
