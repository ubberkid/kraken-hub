import { describe, expect, it } from 'vitest';

import { applyResolverPolicy, detect } from './detect';
import { normalizeUrl, ytStartParam } from './patterns';

const YT_ID = 'dQw4w9WgXcQ';

describe('normalizeUrl', () => {
  it('trims, strips zero-width characters and upgrades http to https', () => {
    const n = normalizeUrl('  ​http://example.com/a.mp4⁠ ');
    expect(n.url).toBe('https://example.com/a.mp4');
    expect(n.upgraded).toBe(true);
    expect(n.isHttps).toBe(true);
  });

  it('lowercases the host but never the path', () => {
    const n = normalizeUrl(`https://WWW.YouTube.com/watch?v=${YT_ID}`);
    expect(n.url).toContain('www.youtube.com');
    expect(n.url).toContain(YT_ID);
  });

  it('removes exactly one trailing slash', () => {
    expect(normalizeUrl('https://twitch.tv/somebody/').url).toBe('https://twitch.tv/somebody');
  });

  it('leaves the local clip scheme alone', () => {
    const n = normalizeUrl('kraken-hub-clip:abcd1234efgh');
    expect(n.isLocalClip).toBe(true);
    expect(n.upgraded).toBe(false);
    expect(n.url).toBe('kraken-hub-clip:abcd1234efgh');
  });

  it('does not throw on unparseable input', () => {
    expect(() => normalizeUrl('https://[not a url')).not.toThrow();
  });
});

describe('ytStartParam', () => {
  it('reads a bare second count from t or start', () => {
    expect(ytStartParam(`https://youtu.be/${YT_ID}?t=90`)).toBe(90);
    expect(ytStartParam(`https://www.youtube.com/watch?v=${YT_ID}&start=42`)).toBe(42);
  });

  it('reads the 1h2m3s form', () => {
    expect(ytStartParam(`https://youtu.be/${YT_ID}?t=1h2m3s`)).toBe(3723);
    expect(ytStartParam(`https://youtu.be/${YT_ID}?t=2m`)).toBe(120);
  });

  it('reads a hash fragment time', () => {
    expect(ytStartParam(`https://youtu.be/${YT_ID}#t=15`)).toBe(15);
  });

  it('is 0 when absent or nonsense', () => {
    expect(ytStartParam(`https://youtu.be/${YT_ID}`)).toBe(0);
    expect(ytStartParam(`https://youtu.be/${YT_ID}?t=later`)).toBe(0);
  });
});

describe('hard rejects run first', () => {
  it.each([
    'https://example.com/movie.mkv',
    'https://example.com/audio.mka',
    'https://example.com/clip.avi',
    'https://example.com/old.flv',
    'https://example.com/old.wmv',
    'https://example.com/old.rmvb',
    'https://example.com/phone.3gp',
    'https://example.com/movie.mkv?token=abc',
  ])('rejects the container in %s', (url) => {
    const m = detect(url);
    expect(m.error).toBe('unsupported-container');
    expect(m.provider).toBeNull();
  });

  it.each([
    'https://www.reddit.com/r/videos/comments/abc/title/',
    'https://old.reddit.com/r/aww/comments/xyz/',
    'https://reddit.com/r/pics/',
  ])('rejects the reddit comment page %s', (url) => {
    const m = detect(url);
    expect(m.error).toBe('reddit-comment-url');
    expect(m.provider).toBeNull();
  });

  it('cannot be swallowed by the direct-file extension route', () => {
    // `.mkv` would otherwise fall through to the unmatched-https guess.
    expect(detect('https://cdn.example.com/a.mkv').provider).toBeNull();
  });
});

describe('local clips', () => {
  it('routes the canonical kraken-hub-clip scheme to local-file', () => {
    const m = detect('kraken-hub-clip:0123456789abcdef');
    expect(m.provider).toBe('local-file');
    expect(m.id).toBe('0123456789abcdef');
  });

  it('rejects the pre-canonical krakenhub-clip spelling', () => {
    expect(detect('krakenhub-clip:0123456789abcdef').provider).toBeNull();
  });

  it('requires at least 8 id characters', () => {
    expect(detect('kraken-hub-clip:short').provider).toBeNull();
  });
});

describe('youtube', () => {
  it.each([
    [`https://www.youtube.com/watch?v=${YT_ID}`, false],
    [`https://m.youtube.com/watch?v=${YT_ID}`, false],
    [`https://music.youtube.com/watch?v=${YT_ID}`, false],
    [`https://www.youtube.com/embed/${YT_ID}`, false],
    [`https://www.youtube-nocookie.com/embed/${YT_ID}`, false],
    [`https://www.youtube.com/v/${YT_ID}`, false],
    [`https://www.youtube.com/live/${YT_ID}`, false],
    [`https://www.youtube.com/shorts/${YT_ID}`, true],
    [`https://youtu.be/${YT_ID}`, false],
  ])('matches %s', (url, portrait) => {
    const m = detect(url);
    expect(m.provider).toBe('youtube-embed');
    expect(m.id).toBe(YT_ID);
    expect(m.meta.portrait ?? false).toBe(portrait);
  });

  it('extracts the start parameter through the routing table', () => {
    expect(detect(`https://youtu.be/${YT_ID}?t=30`).meta.start).toBe(30);
    expect(detect(`https://www.youtube.com/watch?v=${YT_ID}&t=61`).meta.start).toBe(61);
  });

  it('matches a watch URL with parameters before v=', () => {
    const m = detect(`https://www.youtube.com/watch?app=desktop&v=${YT_ID}`);
    expect(m.provider).toBe('youtube-embed');
    expect(m.id).toBe(YT_ID);
  });

  it('warns about a playlist without changing the provider', () => {
    const m = detect(`https://www.youtube.com/watch?v=${YT_ID}&list=PL123`);
    expect(m.provider).toBe('youtube-embed');
    expect(m.warnings).toContain('youtube-playlist-ignored');
  });

  it('does not match an id of the wrong length', () => {
    expect(detect('https://www.youtube.com/watch?v=tooshort').provider).not.toBe('youtube-embed');
  });
});

describe('vimeo', () => {
  it('matches a plain video', () => {
    const m = detect('https://vimeo.com/123456789');
    expect(m.provider).toBe('vimeo');
    expect(m.id).toBe('123456789');
    expect(m.meta.hash).toBeUndefined();
  });

  it('captures the unlisted hash', () => {
    const m = detect('https://vimeo.com/123456789/abc123def4');
    expect(m.provider).toBe('vimeo');
    expect(m.id).toBe('123456789');
    expect(m.meta.hash).toBe('abc123def4');
  });

  it('matches the player and /video/ forms', () => {
    expect(detect('https://player.vimeo.com/video/987654321').id).toBe('987654321');
  });
});

describe('twitch', () => {
  it('matches a vod', () => {
    const m = detect('https://www.twitch.tv/videos/1234567890');
    expect(m.provider).toBe('twitch');
    expect(m.meta.kind).toBe('vod');
    expect(m.id).toBe('1234567890');
  });

  it('matches both clip forms', () => {
    expect(detect('https://clips.twitch.tv/SomeClipSlug').meta.kind).toBe('clip');
    expect(detect('https://www.twitch.tv/streamer/clip/SomeClipSlug').meta.kind).toBe('clip');
  });

  it('matches a bare channel as live', () => {
    const m = detect('https://twitch.tv/somestreamer');
    expect(m.meta.kind).toBe('channel');
    expect(m.meta.live).toBe(true);
  });

  it('does not treat a deeper channel path as a channel', () => {
    expect(detect('https://twitch.tv/somestreamer/about').meta.kind).toBeUndefined();
  });
});

describe('streamable and reddit', () => {
  it('matches streamable, with and without the embed prefix', () => {
    expect(detect('https://streamable.com/abc12').provider).toBe('streamable');
    expect(detect('https://streamable.com/e/abc12').id).toBe('abc12');
  });

  it('routes v.redd.it to the reddit provider', () => {
    const m = detect('https://v.redd.it/abc123xyz');
    expect(m.provider).toBe('reddit');
    expect(m.id).toBe('abc123xyz');
  });
});

describe('extension routes', () => {
  it.each([
    ['https://cdn.example.com/master.m3u8', 'hls'],
    ['https://cdn.example.com/master.m3u', 'hls'],
    ['https://cdn.example.com/manifest.mpd', 'dash'],
    ['https://cdn.example.com/a.mp4', 'direct-file'],
    ['https://cdn.example.com/a.m4v', 'direct-file'],
    ['https://cdn.example.com/a.webm', 'direct-file'],
    ['https://cdn.example.com/a.ogv', 'direct-file'],
    ['https://cdn.example.com/a.mp4?sig=1', 'direct-file'],
  ])('%s -> %s', (url, provider) => {
    const m = detect(url);
    expect(m.provider).toBe(provider);
    expect(m.confidence).toBe(1);
    expect(m.needsFallbackChain).toBe(false);
  });

  it('warns on .mov but still plays it', () => {
    const m = detect('https://cdn.example.com/a.mov');
    expect(m.provider).toBe('direct-file');
    expect(m.warnings).toContain('mov-codec-risk');
  });
});

describe('annotations', () => {
  it('warns about expiring discord links', () => {
    const m = detect('https://cdn.discordapp.com/attachments/1/2/clip.mp4');
    expect(m.provider).toBe('direct-file');
    expect(m.warnings).toContain('discord-expiring-url');
  });

  it('warns about imgur', () => {
    const m = detect('https://i.imgur.com/abc.mp4');
    expect(m.warnings).toContain('imgur-unreliable');
  });
});

describe('the unmatched-https fallback', () => {
  it('guesses direct-file with low confidence and asks for the fallback chain', () => {
    const m = detect('https://example.com/watch/some-video');
    expect(m.provider).toBe('direct-file');
    expect(m.confidence).toBeCloseTo(0.2, 6);
    expect(m.needsFallbackChain).toBe(true);
  });

  it('flags an unsupported scheme instead of guessing', () => {
    for (const url of ['file:///Users/me/a.mp4', 'data:video/mp4;base64,AAA', 'ftp://x/a.mp4']) {
      const m = detect(url);
      expect(m.provider).toBeNull();
      expect(m.unsupportedScheme).toBe(true);
    }
  });

  it('reports the http upgrade so validation can explain it', () => {
    expect(detect('http://example.com/a.mp4').upgradedFromHttp).toBe(true);
    expect(detect('https://example.com/a.mp4').upgradedFromHttp).toBe(false);
  });

  it('flags an over-long url', () => {
    const long = `https://example.com/${'a'.repeat(2100)}.mp4`;
    expect(detect(long).tooLong).toBe(true);
  });
});

describe('resolver policy (§1.4)', () => {
  const yt = detect(`https://youtu.be/${YT_ID}`);
  const file = detect('https://cdn.example.com/a.mp4');

  it('never fires when off or unhealthy', () => {
    expect(applyResolverPolicy(yt, 'off', { healthy: true }).provider).toBe('youtube-embed');
    expect(applyResolverPolicy(yt, 'youtube-only', { healthy: false }).provider).toBe(
      'youtube-embed',
    );
  });

  it('swaps only youtube under youtube-only', () => {
    expect(applyResolverPolicy(yt, 'youtube-only', { healthy: true }).provider).toBe('resolver');
    expect(applyResolverPolicy(file, 'youtube-only', { healthy: true }).provider).toBe(
      'direct-file',
    );
  });

  it('swaps any chrome-painting or quality-locked provider under preferred', () => {
    const caps = { hasOwnChrome: true, canSetQuality: false };
    expect(applyResolverPolicy(yt, 'preferred', { healthy: true, caps }).provider).toBe('resolver');
    const clean = { hasOwnChrome: false, canSetQuality: true };
    expect(applyResolverPolicy(file, 'preferred', { healthy: true, caps: clean }).provider).toBe(
      'direct-file',
    );
  });

  it('leaves the match alone under fallback — that is the adapter error path', () => {
    expect(applyResolverPolicy(yt, 'fallback', { healthy: true }).provider).toBe('youtube-embed');
  });

  it('never diverts a local clip', () => {
    const clip = detect('kraken-hub-clip:0123456789abcdef');
    expect(applyResolverPolicy(clip, 'preferred', { healthy: true }).provider).toBe('local-file');
  });
});

/**
 * Loopback http is a *potentially trustworthy* origin (§6) and is therefore
 * exempt from Chromium's mixed-content blocking. It is where the resolver
 * companion lives and where a LAN dev server is reached, so upgrading it to
 * https — as every other http url is — would break the one http origin that
 * genuinely works.
 */
describe('loopback http', () => {
  it('is not upgraded to https', () => {
    const m = detect('http://127.0.0.1:8976/stream/abc.mp4');
    expect(m.upgradedFromHttp).toBe(false);
    expect(m.url).toBe('http://127.0.0.1:8976/stream/abc.mp4');
  });

  it('still routes by extension', () => {
    expect(detect('http://localhost:4173/demo/demo.mp4').provider).toBe('direct-file');
    expect(detect('http://127.0.0.1:8976/s/x.m3u8').provider).toBe('hls');
  });

  it('is not treated as an unsupported scheme', () => {
    expect(detect('http://127.0.0.1:5173/a.mp4').unsupportedScheme).toBe(false);
  });

  it('leaves any other http url on the upgrade path', () => {
    const m = detect('http://example.com/a.mp4');
    expect(m.upgradedFromHttp).toBe(true);
    expect(m.url.startsWith('https://')).toBe(true);
  });
});
