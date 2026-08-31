import { describe, expect, it } from 'vitest';

import { detect } from '../routing/detect';

import { isFetchableProvider, progressPct, shouldAutoDownload } from './downloadManager';
import { isRejectedContainer } from './ingest';

import type { DownloadEntry } from './downloadManager';

function entry(received: number, total: number | null): DownloadEntry {
  return {
    id: 'x',
    url: 'https://example.com/a.mp4',
    name: 'a.mp4',
    state: 'downloading',
    receivedBytes: received,
    totalBytes: total,
    attempt: 1,
    error: null,
    clipId: null,
    startedAt: 0,
    updatedAt: 0,
  };
}

/**
 * The ingestion policy is the one piece of the download-first flow that is pure,
 * and it decides whether a paste ends up in the clip library or streams. Getting
 * it wrong is invisible until someone's LCD stops working offline.
 */
describe('shouldAutoDownload', () => {
  it('downloads a direct progressive file in auto mode', () => {
    expect(shouldAutoDownload(detect('https://example.com/clip.mp4'), 'auto')).toBe(true);
  });

  it('never downloads in stream-only mode', () => {
    expect(shouldAutoDownload(detect('https://example.com/clip.mp4'), 'stream-only')).toBe(false);
  });

  it('leaves a clip that is already local alone', () => {
    expect(shouldAutoDownload(detect('kraken-hub-clip:abcd1234'), 'auto')).toBe(false);
  });

  it('does not download a manifest — an .m3u8 is a playlist, not a video', () => {
    expect(shouldAutoDownload(detect('https://example.com/live.m3u8'), 'auto')).toBe(false);
    expect(shouldAutoDownload(detect('https://example.com/v.mpd'), 'auto')).toBe(false);
  });

  it('does not download YouTube without the resolver companion', () => {
    const match = detect('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(match.provider).toBe('youtube-embed');
    expect(shouldAutoDownload(match, 'auto')).toBe(false);
  });

  it('refuses a hard-rejected container', () => {
    expect(shouldAutoDownload(detect('https://example.com/movie.mkv'), 'auto')).toBe(false);
  });

  it('downloads a v.redd.it source (it sends ACAO: *)', () => {
    expect(shouldAutoDownload(detect('https://v.redd.it/abc123'), 'auto')).toBe(true);
  });
});

describe('isFetchableProvider', () => {
  it('knows which providers a plain fetch can reach', () => {
    expect(isFetchableProvider('direct-file')).toBe(true);
    expect(isFetchableProvider('resolver')).toBe(true);
    expect(isFetchableProvider('youtube-embed')).toBe(false);
    expect(isFetchableProvider(null)).toBe(false);
  });
});

describe('progressPct', () => {
  it('is null when the server sent no Content-Length', () => {
    expect(progressPct(entry(1024, null))).toBeNull();
  });

  it('reports a percentage and never exceeds 100', () => {
    expect(progressPct(entry(50, 200))).toBe(25);
    expect(progressPct(entry(300, 200))).toBe(100);
  });
});

describe('isRejectedContainer', () => {
  it('rejects every container Chromium cannot demux', () => {
    for (const name of ['a.mkv', 'a.MKV', 'b.avi', 'c.flv', 'd.wmv', 'e.mka']) {
      expect(isRejectedContainer(name)).toBe(true);
    }
  });

  it('accepts the containers that actually play', () => {
    for (const name of ['a.mp4', 'b.webm', 'c.mov']) {
      expect(isRejectedContainer(name)).toBe(false);
    }
  });
});
