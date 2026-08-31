import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MediaError,
  autoDownloadRefused,
  classifyStderr,
  digestFor,
  downloadArgs,
  ensureYtDlpBinary,
  formatSelector,
  parseProbe,
  probeArgs,
  ytDlpAssetName,
  ytDlpOnPath,
  type Runner,
} from '../src/ytdlp.js';

let dir = '';

/**
 * PATH is the machine's, not the test's, so every `ensureYtDlpBinary` case that
 * is not about PATH stubs the probe to "absent". Without this a developer who
 * happens to have yt-dlp installed would see different results from CI.
 */
const notOnPath: Runner = () => Promise.resolve({ code: 1, stdout: '', stderr: '' });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kh-ytdlp-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('argument construction', () => {
  it('passes the URL as its own argv entry, after --, and never in a template', () => {
    const nasty = 'https://example.com/watch?v=x&y=$(rm -rf ~)`whoami`;id';
    const args = downloadArgs(
      {
        url: nasty,
        maxHeight: 1080,
        audio: false,
        prefer: 'progressive',
        destFile: join(dir, 'out.mp4'),
      },
      'best',
    );

    expect(args[args.length - 1]).toBe(nasty);
    expect(args[args.length - 2]).toBe('--');
    // The URL appears exactly once, whole, and nothing else contains a fragment
    // of it — no concatenation, no quoting, nothing for a shell to reinterpret.
    expect(args.filter((a) => a.includes('example.com'))).toHaveLength(1);
  });

  it('writes exactly where the cache told it to', () => {
    const dest = join(dir, 'abc.mp4');
    const args = downloadArgs(
      {
        url: 'https://e.com/a',
        maxHeight: 720,
        audio: false,
        prefer: 'progressive',
        destFile: dest,
      },
      'best',
    );
    expect(args[args.indexOf('-o') + 1]).toBe(dest);
  });

  it('adds --ffmpeg-location only when a binary was found', () => {
    const req = {
      url: 'https://e.com/a',
      maxHeight: 720,
      audio: false,
      prefer: 'progressive' as const,
      destFile: join(dir, 'a.mp4'),
    };
    expect(downloadArgs(req, 'best')).not.toContain('--ffmpeg-location');
    expect(downloadArgs(req, 'best', '/usr/bin/ffmpeg')).toContain('/usr/bin/ffmpeg');
  });

  it('probes metadata only, one video, URL last', () => {
    const args = probeArgs('https://example.com/watch?v=x');
    expect(args).toContain('-J');
    expect(args).toContain('--no-playlist');
    expect(args[args.length - 2]).toBe('--');
    expect(args[args.length - 1]).toBe('https://example.com/watch?v=x');
  });
});

describe('formatSelector (§6 — progressive first, mux only if ffmpeg is there)', () => {
  it('never asks for a rendition taller than maxHeight as a hard requirement', () => {
    const s = formatSelector({
      maxHeight: 1080,
      audio: false,
      prefer: 'progressive',
      hasFfmpeg: true,
    });
    expect(s).toContain('height<=?1080');
    expect(s).not.toContain('height<=1080]'); // the hard form would 404 tall-only sources
  });

  it('falls back to the best progressive rather than failing when ffmpeg is absent', () => {
    const s = formatSelector({
      maxHeight: 720,
      audio: false,
      prefer: 'progressive',
      hasFfmpeg: false,
    });
    expect(s).not.toContain('+bestaudio');
    expect(s.endsWith('/best')).toBe(true);
  });

  it('prefers the muxed pair when the caller asked for any and ffmpeg exists', () => {
    const s = formatSelector({ maxHeight: 2160, audio: true, prefer: 'any', hasFfmpeg: true });
    expect(s.startsWith('bestvideo[height<=?2160]+bestaudio')).toBe(true);
  });

  it('requires an audio track only when audio was opted in', () => {
    const muted = formatSelector({
      maxHeight: 1080,
      audio: false,
      prefer: 'progressive',
      hasFfmpeg: true,
    });
    const loud = formatSelector({
      maxHeight: 1080,
      audio: true,
      prefer: 'progressive',
      hasFfmpeg: true,
    });
    expect(muted).not.toContain('acodec!=none');
    expect(loud).toContain('acodec!=none');
  });
});

describe('error mapping onto the closed enum', () => {
  it.each([
    ['ERROR: Unsupported URL: https://example.com/x', 'unsupported-url'],
    ['ERROR: Video unavailable', 'not-found'],
    ['ERROR: This video has been removed by the uploader', 'not-found'],
    ['ERROR: Private video. Sign in if you have been granted access', 'forbidden'],
    ['ERROR: something nobody has ever seen', 'upstream-failed'],
  ])('maps %s', (stderr, code) => {
    expect(classifyStderr(stderr)).toBe(code);
  });
});

describe('probe parsing', () => {
  it('keeps only the fields the contract advertises', () => {
    const info = parseProbe(
      JSON.stringify({
        title: 'A clip',
        duration: 12.5,
        width: 1920,
        height: 1080,
        fps: 30,
        thumbnail: 'https://x/y.jpg',
        formats: [],
      }),
    );
    expect(info).toEqual({
      title: 'A clip',
      durationSec: 12.5,
      width: 1920,
      height: 1080,
      fps: 30,
      thumbUrl: 'https://x/y.jpg',
    });
  });

  it('turns unparseable output into an upstream-failed MediaError', () => {
    expect(() => parseProbe('not json')).toThrow(MediaError);
  });

  it('tolerates missing metadata rather than inventing it', () => {
    expect(parseProbe('{}')).toEqual({});
  });
});

describe('the auto-downloaded binary (§6 — checksum-verified)', () => {
  it('picks the official asset for each platform', () => {
    expect(ytDlpAssetName('win32', 'x64')).toBe('yt-dlp.exe');
    expect(ytDlpAssetName('darwin', 'arm64')).toBe('yt-dlp_macos');
    expect(ytDlpAssetName('linux', 'x64')).toBe('yt-dlp_linux');
    expect(ytDlpAssetName('linux', 'arm64')).toBe('yt-dlp_linux_aarch64');
  });

  it('reads the digest out of the release SHA2-256SUMS file', () => {
    const sums = ['aaaa  yt-dlp', 'bbbbbbbb  yt-dlp_linux', 'cccccccc  yt-dlp.exe'].join('\n');
    expect(digestFor(sums, 'yt-dlp_linux')).toBe('bbbbbbbb');
    expect(digestFor(sums, 'yt-dlp_not_a_thing')).toBeNull();
  });

  it('refuses to install bytes whose digest does not match', async () => {
    const asset = ytDlpAssetName(process.platform, process.arch);
    const fetchImpl = ((input: string | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('SHA2-256SUMS')) {
        return Promise.resolve(new Response(`0000000000000000  ${asset}\n`, { status: 200 }));
      }
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    }) as unknown as typeof fetch;

    await expect(
      ensureYtDlpBinary({
        cacheDir: dir,
        allowAutoDownload: true,
        fetchImpl,
        env: {},
        runImpl: notOnPath,
      }),
    ).rejects.toThrow(/Checksum mismatch/);
  });

  it('never touches the network in CI, or when the kill switch is set', async () => {
    expect(autoDownloadRefused({ CI: 'true' })).toBe('CI');
    expect(autoDownloadRefused({ KRAKEN_HUB_RESOLVER_NO_DOWNLOAD: '1' })).toBe(
      'KRAKEN_HUB_RESOLVER_NO_DOWNLOAD=1',
    );
    expect(autoDownloadRefused({})).toBeNull();

    const exploded = ((): Promise<Response> => {
      throw new Error('the network was contacted');
    }) as unknown as typeof fetch;

    await expect(
      ensureYtDlpBinary({
        cacheDir: dir,
        allowAutoDownload: true,
        fetchImpl: exploded,
        env: { CI: 'true' },
        runImpl: notOnPath,
      }),
    ).rejects.toThrow(/auto-download is disabled \(CI\)/);
  });

  it('refuses an explicit --yt-dlp path that is not there', async () => {
    await expect(
      ensureYtDlpBinary({
        cacheDir: dir,
        binaryPath: join(dir, 'nope'),
        allowAutoDownload: false,
        env: {},
      }),
    ).rejects.toThrow(/No yt-dlp at/);
  });
});

describe('resolution order: --yt-dlp, then PATH, then the cached download', () => {
  it('probes PATH with --version and uses the binary it finds', async () => {
    const calls: { bin: string; args: string[]; timeoutMs: number }[] = [];
    const runImpl: Runner = (bin, args, opts) => {
      calls.push({ bin, args, timeoutMs: opts.timeoutMs });
      return Promise.resolve({ code: 0, stdout: '2025.09.26\n', stderr: '' });
    };

    // `allowAutoDownload: false` and an exploding fetch: reaching PATH is the
    // only way this call can succeed at all.
    const exploded = ((): Promise<Response> => {
      throw new Error('the network was contacted');
    }) as unknown as typeof fetch;

    await expect(
      ensureYtDlpBinary({
        cacheDir: dir,
        allowAutoDownload: false,
        env: {},
        fetchImpl: exploded,
        runImpl,
      }),
    ).resolves.toBe('yt-dlp');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.bin).toBe('yt-dlp');
    expect(calls[0]?.args).toEqual(['--version']);
    // A hung binary must not hang the resolver.
    expect(calls[0]?.timeoutMs).toBeGreaterThan(0);
    expect(calls[0]?.timeoutMs).toBeLessThanOrEqual(10_000);
  });

  it('treats a non-zero --version, and a probe that throws, as no yt-dlp on PATH', async () => {
    await expect(ytDlpOnPath(notOnPath)).resolves.toBeNull();
    await expect(
      ytDlpOnPath(() => Promise.reject(new MediaError('upstream-failed', 'yt-dlp timed out.'))),
    ).resolves.toBeNull();
    await expect(
      ytDlpOnPath(() => Promise.resolve({ code: 0, stdout: '2025.09.26', stderr: '' })),
    ).resolves.toBe('yt-dlp');
  });

  it('never probes PATH when --yt-dlp names a real file', async () => {
    const explicit = join(dir, 'my-yt-dlp');
    await writeFile(explicit, '#!/bin/sh\n');
    let probed = false;
    const runImpl: Runner = () => {
      probed = true;
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    };

    await expect(
      ensureYtDlpBinary({
        cacheDir: dir,
        binaryPath: explicit,
        allowAutoDownload: false,
        env: {},
        runImpl,
      }),
    ).resolves.toBe(explicit);
    expect(probed).toBe(false);
  });

  it('falls through to the cached copy when PATH has nothing', async () => {
    const asset = ytDlpAssetName(process.platform, process.arch);
    await mkdir(join(dir, 'bin'), { recursive: true });
    const cached = join(dir, 'bin', asset);
    await writeFile(cached, 'binary');

    await expect(
      ensureYtDlpBinary({
        cacheDir: dir,
        allowAutoDownload: false,
        env: {},
        runImpl: notOnPath,
      }),
    ).resolves.toBe(cached);
  });
});
