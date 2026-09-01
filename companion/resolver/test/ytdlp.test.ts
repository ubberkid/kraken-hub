import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  META_PRINT_TEMPLATE,
  META_SEPARATOR,
  MediaError,
  autoDownloadRefused,
  classifyStderr,
  digestFor,
  downloadArgs,
  ensureYtDlpBinary,
  explainStderr,
  formatSelector,
  parseDownloadMeta,
  parseProbe,
  probeArgs,
  sniffContainerMime,
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

/**
 * The regression suite for the bug that shipped: every rung of the old ladder
 * was a `best`, which in yt-dlp's language means "a format that already carries
 * both video and audio". YouTube publishes no such format for most uploads, so
 * every rung missed and yt-dlp answered `Requested format is not available`.
 *
 * The invariant these cases exist to hold is one sentence: **no branch may end
 * in a rung that requires a muxed format.**
 */
describe('formatSelector — never demands a format the source cannot have', () => {
  const ALL = [
    { audio: false, hasFfmpeg: false },
    { audio: false, hasFfmpeg: true },
    { audio: true, hasFfmpeg: false },
    { audio: true, hasFfmpeg: true },
  ] as const;

  it.each(ALL)('ends in an unconstrained video rung (audio=$audio ffmpeg=$hasFfmpeg)', (c) => {
    const s = formatSelector({ maxHeight: 1080, prefer: 'progressive', ...c });
    const rungs = s.split('/');

    // The last rung must match "any format containing video", with no height
    // filter and no `+` — that is the rung that makes a hard failure impossible.
    expect(rungs.at(-1)).toBe('bv*');
    // And the ladder must contain a `bv*` rung that is not just the tail: the
    // capped video-only rung is what saves an adaptive-only source at the
    // requested quality rather than at whatever is left.
    expect(s).toContain('bv*[height<=?1080]');
  });

  it.each(ALL)('never emits the muxed-only `b` as a last resort ($audio/$hasFfmpeg)', (c) => {
    const rungs = formatSelector({ maxHeight: 720, prefer: 'progressive', ...c }).split('/');
    // `b` may appear — a single muxed file is the nicest outcome when one exists
    // — but it must never be the rung everything else falls through to.
    expect(rungs.at(-1)).not.toBe('b');
  });

  it('caps height with the `<=?` form, which also admits unknown heights', () => {
    const s = formatSelector({ maxHeight: 1080, audio: true, prefer: 'any', hasFfmpeg: true });
    expect(s).toContain('height<=?1080');
    // The bare form would drop every format whose height yt-dlp cannot read.
    expect(s).not.toContain('height<=1080]');
  });

  it('merges video and audio when ffmpeg is there and audio was asked for', () => {
    const s = formatSelector({ maxHeight: 1080, audio: true, prefer: 'any', hasFfmpeg: true });
    expect(s.startsWith('bv*[height<=?1080]+ba/b[height<=?1080]/')).toBe(true);
  });

  it('emits no `+` at all without ffmpeg — nothing would be there to join them', () => {
    for (const audio of [true, false]) {
      const s = formatSelector({ maxHeight: 720, audio, prefer: 'any', hasFfmpeg: false });
      expect(s).not.toContain('+');
    }
  });

  it('starts from the muxed rung without ffmpeg, since that is the only way to keep audio', () => {
    const s = formatSelector({ maxHeight: 720, audio: true, prefer: 'any', hasFfmpeg: false });
    expect(s).toBe('b[height<=?720]/bv*[height<=?720]/b/bv*');
  });

  it('skips audio entirely when the caller did not ask for it, ffmpeg or not', () => {
    const withFfmpeg = formatSelector({
      maxHeight: 480,
      audio: false,
      prefer: 'any',
      hasFfmpeg: true,
    });
    const without = formatSelector({
      maxHeight: 480,
      audio: false,
      prefer: 'any',
      hasFfmpeg: false,
    });
    // A muted panel needs no merge, so the ffmpeg branch is irrelevant here.
    expect(withFfmpeg).toBe('bv*[height<=?480]/b[height<=?480]/bv*');
    expect(without).toBe(withFfmpeg);
  });

  it('derives H by flooring, and never lets it reach zero', () => {
    expect(
      formatSelector({ maxHeight: 720.9, audio: true, prefer: 'any', hasFfmpeg: true }),
    ).toContain('height<=?720]');
    expect(formatSelector({ maxHeight: 0, audio: true, prefer: 'any', hasFfmpeg: true })).toContain(
      'height<=?1]',
    );
    expect(
      formatSelector({ maxHeight: -50, audio: true, prefer: 'any', hasFfmpeg: true }),
    ).toContain('height<=?1]');
  });

  it('reaches the download argv verbatim', () => {
    const selector = formatSelector({
      maxHeight: 1080,
      audio: true,
      prefer: 'any',
      hasFfmpeg: true,
    });
    const args = downloadArgs(
      {
        url: 'https://e.com/a',
        maxHeight: 1080,
        audio: true,
        prefer: 'any',
        destFile: join(dir, 'a.mp4'),
      },
      selector,
    );
    expect(args[args.indexOf('-f') + 1]).toBe(selector);
  });
});

describe('error mapping onto the closed enum', () => {
  it.each([
    ['ERROR: Unsupported URL: https://example.com/x', 'unsupported-url'],
    ['ERROR: Video unavailable', 'not-found'],
    ['ERROR: [youtube] zzz: This video is unavailable', 'not-found'],
    ['ERROR: This video has been removed by the uploader', 'not-found'],
    ['ERROR: Private video. Sign in if you have been granted access', 'forbidden'],
    ['ERROR: something nobody has ever seen', 'upstream-failed'],
    // The bug report's own stderr. It is an upstream problem, not a bad URL and
    // not a missing video, so it must not be miscoded as either.
    [
      'ERROR: [youtube] abc: Requested format is not available. Use --list-formats for a list of available formats',
      'upstream-failed',
    ],
    ['ERROR: [generic] x: No video formats found!', 'upstream-failed'],
  ])('maps %s', (stderr, code) => {
    expect(classifyStderr(stderr)).toBe(code);
  });
});

describe('the message a person reads', () => {
  it('replaces the format failure with one that names the actual problem', () => {
    const message = explainStderr(
      'ERROR: [youtube] abc: Requested format is not available. Use --list-formats for a list of available formats',
    );
    expect(message).toContain('ffmpeg');
    // `--list-formats` is a yt-dlp flag; this program has no such thing, and
    // sending the reader to look for it is the opposite of a diagnosis.
    expect(message).not.toContain('--list-formats');
  });

  it('says so plainly when the page has no video at all', () => {
    expect(explainStderr('ERROR: No video formats found!')).toMatch(/no video/i);
  });

  it('names ffmpeg when yt-dlp itself complains it is missing', () => {
    expect(explainStderr('ERROR: You have requested merging but ffmpeg is not installed')).toMatch(
      /ffmpeg/,
    );
  });

  it('passes an unrecognised error through rather than replacing it with a guess', () => {
    expect(explainStderr('ERROR: something nobody has ever seen')).toBe(
      'ERROR: something nobody has ever seen',
    );
  });

  it('still says something when yt-dlp says nothing', () => {
    expect(explainStderr('   ')).toMatch(/without saying why/);
  });
});

describe('the metadata yt-dlp prints about what it actually downloaded', () => {
  const SEP = META_SEPARATOR;
  const line = (...fields: string[]): string => `KHMETA${SEP}${fields.join(SEP)}`;

  it('asks for the fields after the file has been moved into place', () => {
    expect(META_PRINT_TEMPLATE.startsWith('after_move:KHMETA')).toBe(true);
    expect(META_PRINT_TEMPLATE).toContain('%(height)s');
    expect(META_PRINT_TEMPLATE).toContain('%(filepath)s');
  });

  it('turns the printed line into the real height, not the page’s', () => {
    const meta = parseDownloadMeta(
      [
        '[download] Destination: /c/a.mp4',
        line('1280', '720', '24', '398+251', '150', 'https://i/t.webp', '/c/a.mp4', 'Caminandes 3'),
      ].join('\n'),
    );
    expect(meta).toEqual({
      width: 1280,
      height: 720,
      fps: 24,
      formatId: '398+251',
      durationSec: 150,
      thumbUrl: 'https://i/t.webp',
      filepath: '/c/a.mp4',
      title: 'Caminandes 3',
    });
  });

  it('drops yt-dlp’s `NA` rather than reporting it as a value', () => {
    const meta = parseDownloadMeta(line('NA', '360', 'NA', '18', 'NA', 'NA', '/c/a.mp4', 'NA'));
    expect(meta).toEqual({ height: 360, formatId: '18', filepath: '/c/a.mp4' });
  });

  it('keeps a title that contains the separator whole', () => {
    const meta = parseDownloadMeta(
      line('1280', '720', '24', '18', '10', 'NA', '/c/a.mp4', `odd${SEP}title`),
    );
    expect(meta?.title).toBe(`odd${SEP}title`);
    expect(meta?.height).toBe(720);
  });

  it('reports nothing at all rather than guessing when the line is absent', () => {
    expect(parseDownloadMeta('[download] 100% of 4MiB\n')).toBeNull();
  });
});

describe('the mime the companion promises', () => {
  it('reads the container off the file rather than assuming mp4', () => {
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom', 'ascii')]);
    expect(sniffContainerMime(mp4)).toBe('video/mp4');
    expect(sniffContainerMime(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02]))).toBe(
      'video/webm',
    );
  });

  it('falls back to what it asked for when the bytes say nothing', () => {
    expect(sniffContainerMime(Buffer.alloc(0))).toBe('video/mp4');
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
