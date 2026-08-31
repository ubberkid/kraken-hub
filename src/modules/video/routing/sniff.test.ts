import { describe, expect, it, vi } from 'vitest';

import { blindGuess, proxied, runFallbackChain, sniffBody, type ChainDeps } from './sniff';

/**
 * §7.3's chain, and the ORDER is the thing under test.
 *
 * The order is not an implementation detail: `<video>` goes first because plain
 * progressive playback needs no CORS at all, so it succeeds on links `fetch`
 * cannot even read. A chain that sniffed first would declare half the real
 * internet unplayable.
 */

function res(body: string, contentType: string | null, status = 206): Response {
  return {
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('sniffBody', () => {
  it('reads the HLS content types', () => {
    expect(sniffBody('application/vnd.apple.mpegurl', '')).toBe('hls');
    expect(sniffBody('audio/mpegurl; charset=utf-8', '')).toBe('hls');
    expect(sniffBody('application/x-mpegURL', '')).toBe('hls');
  });

  it('reads the DASH content type', () => {
    expect(sniffBody('application/dash+xml', '')).toBe('dash');
  });

  it('falls back to the magic bytes when the content type is useless', () => {
    // Real CDNs serve manifests as octet-stream constantly.
    expect(sniffBody('application/octet-stream', '#EXTM3U\n#EXT-X-VERSION:3')).toBe('hls');
    expect(sniffBody('application/octet-stream', '<?xml version="1.0"?><MPD xmlns="…">')).toBe(
      'dash',
    );
  });

  it('tolerates leading whitespace before the magic bytes', () => {
    expect(sniffBody(null, '\n  #EXTM3U')).toBe('hls');
  });

  it('recognises progressive media types', () => {
    expect(sniffBody('video/mp4', '')).toBe('progressive');
    expect(sniffBody('video/webm', '')).toBe('progressive');
  });

  it('gives up rather than guessing', () => {
    expect(sniffBody('text/html', '<!doctype html>')).toBe('unknown');
    expect(sniffBody(null, '')).toBe('unknown');
  });
});

describe('blindGuess', () => {
  it('guesses HLS from an m3u in the path', () => {
    expect(blindGuess('https://cdn.example.com/live/m3u8/index')).toBe('hls');
  });

  it('guesses DASH from mpd or manifest', () => {
    expect(blindGuess('https://cdn.example.com/x/manifest')).toBe('dash');
    expect(blindGuess('https://cdn.example.com/mpd/stream')).toBe('dash');
  });

  it('refuses to guess from nothing', () => {
    expect(blindGuess('https://cdn.example.com/abc123')).toBeNull();
  });
});

describe('proxied', () => {
  it('is null when no proxy is configured — the shipped default', () => {
    expect(proxied('', 'https://a.example/v.mp4')).toBeNull();
    expect(proxied('   ', 'https://a.example/v.mp4')).toBeNull();
  });

  it('url-encodes onto a `?url=` style base', () => {
    expect(proxied('https://p.example/raw?url=', 'https://a.example/v.mp4?x=1')).toBe(
      'https://p.example/raw?url=https%3A%2F%2Fa.example%2Fv.mp4%3Fx%3D1',
    );
  });

  it('concatenates onto a path-style base', () => {
    expect(proxied('https://p.example/', 'https://a.example/v.mp4')).toBe(
      'https://p.example/https://a.example/v.mp4',
    );
  });
});

describe('runFallbackChain', () => {
  const signal = new AbortController().signal;

  it('stops at the <video> attempt — the no-CORS step goes first', async () => {
    const probeVideo = vi.fn().mockResolvedValue(true);
    const fetchImpl = vi.fn();
    const out = await runFallbackChain(
      'https://cdn.example.com/opaque',
      { proxyBase: '', signal },
      { probeVideo, fetchImpl: fetchImpl },
    );
    expect(out.provider).toBe('direct-file');
    // The whole point: no network read was needed or attempted.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out.steps.map((s) => s.step)).toEqual(['direct:video']);
  });

  it('falls to the range probe and identifies HLS from the body', async () => {
    const deps: ChainDeps = {
      probeVideo: vi.fn().mockResolvedValue(false),
      fetchImpl: vi.fn().mockResolvedValue(res('#EXTM3U', 'application/octet-stream')),
    };
    const out = await runFallbackChain(
      'https://cdn.example.com/x',
      { proxyBase: '', signal },
      deps,
    );
    expect(out.provider).toBe('hls');
    expect(out.steps.map((s) => s.step)).toEqual(['direct:video', 'direct:range']);
  });

  it('treats a CORS rejection as expected, then blind-guesses from the path', async () => {
    const deps: ChainDeps = {
      probeVideo: vi.fn().mockResolvedValue(false),
      fetchImpl: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    };
    const out = await runFallbackChain(
      'https://cdn.example.com/live/master.m3u/index',
      { proxyBase: '', signal },
      deps,
    );
    expect(out.provider).toBe('hls');
    expect(out.steps.map((s) => s.step)).toEqual(['direct:video', 'direct:range', 'direct:blind']);
  });

  it('never touches a proxy when none is configured', async () => {
    const deps: ChainDeps = {
      probeVideo: vi.fn().mockResolvedValue(false),
      fetchImpl: vi.fn().mockResolvedValue(res('<!doctype html>', 'text/html')),
    };
    const out = await runFallbackChain(
      'https://cdn.example.com/x',
      { proxyBase: '', signal },
      deps,
    );
    expect(out.provider).toBeNull();
    expect(out.steps.at(-1)).toEqual({
      step: 'proxy',
      ok: false,
      reason: 'no proxy configured',
    });
  });

  it('retries the whole chain through a configured proxy, and only then', async () => {
    const probeVideo = vi
      .fn()
      .mockImplementation((url: string) => Promise.resolve(url.startsWith('https://p.example/')));
    const deps: ChainDeps = {
      probeVideo,
      fetchImpl: vi.fn().mockResolvedValue(res('', 'text/html')),
    };
    const out = await runFallbackChain(
      'https://cdn.example.com/x',
      { proxyBase: 'https://p.example/raw?url=', signal },
      deps,
    );
    expect(out.provider).toBe('direct-file');
    expect(out.url).toContain('https://p.example/raw?url=');
    // The proxy is genuinely last: three direct steps ran first.
    expect(out.steps.map((s) => s.step)).toEqual([
      'direct:video',
      'direct:range',
      'direct:blind',
      'proxy:video',
    ]);
  });

  it('stops when the 25 s budget is spent rather than sitting on a spinner', async () => {
    let clock = 0;
    const deps: ChainDeps = {
      probeVideo: vi.fn().mockImplementation(() => {
        clock += 30_000;
        return Promise.resolve(false);
      }),
      fetchImpl: vi.fn().mockResolvedValue(res('', 'text/html')),
      now: () => clock,
    };
    const out = await runFallbackChain(
      'https://cdn.example.com/x',
      { proxyBase: '', signal },
      deps,
    );
    expect(out.provider).toBeNull();
    // Only the first step got to run; the budget cut the rest off.
    expect(out.steps.filter((s) => s.step.startsWith('direct:'))).toHaveLength(1);
  });
});
