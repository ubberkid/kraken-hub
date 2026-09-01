import { describe, expect, it } from 'vitest';

import { VALIDATION_MESSAGES, primaryIssue, severityOf, validateUrl } from './validate';

import type { ValidationCode } from './validate';

const YT = 'https://youtu.be/dQw4w9WgXcQ';

function codes(url: string, opts?: Parameters<typeof validateUrl>[1]): ValidationCode[] {
  return validateUrl(url, opts).issues.map((i) => i.code);
}

describe('§7.1 message table', () => {
  it('carries the exact mixed-content note', () => {
    expect(VALIDATION_MESSAGES['mixed-content-http']).toBe(
      'Upgraded to https:// — GitHub Pages is HTTPS-only and browsers block http:// media.',
    );
  });

  it('carries the exact ffmpeg remux command for .mkv', () => {
    expect(VALIDATION_MESSAGES['unsupported-container']).toBe(
      ".mkv can't be played — Chromium has no Matroska support in `<video>`, and no library fixes that. Remux to MP4: `ffmpeg -i in.mkv -c copy out.mp4`.",
    );
    expect(VALIDATION_MESSAGES['unsupported-container']).toContain('ffmpeg -i in.mkv -c copy');
  });

  it('carries the exact Discord expiry note', () => {
    expect(VALIDATION_MESSAGES['discord-expiring-url']).toBe(
      'Discord links are signed and expire in about 24 hours — this will stop working. Download the file and add it to your library.',
    );
  });

  it('carries the remaining doc messages verbatim', () => {
    expect(VALIDATION_MESSAGES['http-not-upgradable']).toBe(
      'This link is http:// only. Your Kraken is served over HTTPS, so the browser will block it. Download the file and add it to your library instead.',
    );
    expect(VALIDATION_MESSAGES['imgur-unreliable']).toBe(
      "Imgur redirects hotlinked videos to its homepage; this often won't load.",
    );
    expect(VALIDATION_MESSAGES['reddit-comment-url']).toBe(
      'Paste the `v.redd.it/…` link (open the video, copy the video link), not the comments page.',
    );
    expect(VALIDATION_MESSAGES['youtube-playlist-ignored']).toBe(
      "Playlists aren't supported in v1 — only this video will play.",
    );
    expect(VALIDATION_MESSAGES['url-too-long']).toBe(
      "That link is unusually long and won't survive the sync channel.",
    );
    expect(VALIDATION_MESSAGES['mov-codec-risk']).toBe(
      '`.mov` files often contain ProRes or HEVC, which may not decode. MP4/H.264 is safest.',
    );
    expect(VALIDATION_MESSAGES['codec-unsupported']).toBe(
      "Your PC can't decode this file (HEVC needs GPU support Chromium won't emulate).",
    );
  });

  it('gives every code a non-empty message', () => {
    for (const message of Object.values(VALIDATION_MESSAGES)) {
      expect(message.length).toBeGreaterThan(0);
    }
  });
});

describe('severity model', () => {
  it('treats the documented warnings as warnings', () => {
    for (const code of [
      'discord-expiring-url',
      'imgur-unreliable',
      'youtube-playlist-ignored',
      'mov-codec-risk',
    ] as const) {
      expect(severityOf(code)).toBe('warn');
    }
  });

  it('treats the documented blockers as errors', () => {
    for (const code of [
      'http-not-upgradable',
      'unsupported-container',
      'reddit-comment-url',
      'local-clip-remote-context',
      'url-too-long',
      'codec-unsupported',
    ] as const) {
      expect(severityOf(code)).toBe('error');
    }
  });

  it('treats the https upgrade as an auto-fix, not a problem', () => {
    expect(severityOf('mixed-content-http')).toBe('auto-fix');
  });
});

describe('warnings never block', () => {
  it.each([
    'https://cdn.discordapp.com/attachments/1/2/clip.mp4',
    'https://i.imgur.com/abc.mp4',
    'https://cdn.example.com/a.mov',
    `https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1`,
  ])('%s stays saveable', (url) => {
    const r = validateUrl(url);
    expect(r.issues.length).toBeGreaterThan(0);
    expect(r.blocking).toBe(false);
    expect(r.ok).toBe(true);
  });
});

describe('errors block config-save', () => {
  it('blocks .mkv with the remux command', () => {
    const r = validateUrl('https://example.com/a.mkv');
    expect(r.blocking).toBe(true);
    expect(codes('https://example.com/a.mkv')).toContain('unsupported-container');
    expect(primaryIssue(r)?.message).toContain('ffmpeg');
  });

  it('blocks a reddit comments page', () => {
    expect(codes('https://www.reddit.com/r/videos/comments/a/b/')).toContain('reddit-comment-url');
  });

  it('blocks an over-long url', () => {
    const long = `https://example.com/${'a'.repeat(2100)}.mp4`;
    expect(codes(long)).toContain('url-too-long');
    expect(validateUrl(long).blocking).toBe(true);
  });

  it('blocks an unsupported scheme', () => {
    expect(codes('file:///Users/me/a.mp4')).toContain('unsupported-scheme');
  });
});

describe('the http upgrade', () => {
  it('is an auto-fix that does not block, and rewrites the url', () => {
    const r = validateUrl('http://example.com/a.mp4');
    expect(codes('http://example.com/a.mp4')).toContain('mixed-content-http');
    expect(r.blocking).toBe(false);
    expect(r.url.startsWith('https:')).toBe(true);
  });

  it('becomes a blocking error once the caller reports the probe failed', () => {
    const r = validateUrl('http://example.com/a.mp4', { httpsProbeFailed: true });
    expect(r.issues.map((i) => i.code)).toContain('http-not-upgradable');
    expect(r.blocking).toBe(true);
  });

  it('says nothing at all about an https url', () => {
    expect(validateUrl('https://example.com/a.mp4').issues).toEqual([]);
  });
});

describe('local clips across contexts (§5.1)', () => {
  const clip = 'kraken-hub-clip:0123456789abcdef';

  it('is fine in the config browser with no library hint', () => {
    expect(validateUrl(clip, { context: 'config' }).blocking).toBe(false);
  });

  it('is fine when the id is in the library', () => {
    const r = validateUrl(clip, { context: 'display', knownClipIds: ['0123456789abcdef'] });
    expect(r.blocking).toBe(false);
  });

  it('errors when the display does not have the clip', () => {
    const r = validateUrl(clip, { context: 'display', knownClipIds: ['other'] });
    expect(r.issues.map((i) => i.code)).toContain('local-clip-remote-context');
    expect(r.blocking).toBe(true);
  });

  it('errors on the remote page, which has a different storage partition', () => {
    expect(codes(clip, { context: 'remote' })).toContain('local-clip-remote-context');
  });
});

describe('primaryIssue', () => {
  it('prefers an error over a warning', () => {
    const r = validateUrl('https://cdn.discordapp.com/attachments/1/2/clip.mkv');
    expect(primaryIssue(r)?.code).toBe('unsupported-container');
  });

  it('is null for a clean url', () => {
    expect(primaryIssue(validateUrl(YT))).toBeNull();
  });
});
