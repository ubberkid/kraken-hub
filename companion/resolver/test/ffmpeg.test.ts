import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FFMPEG_CHECKSUMS_FILE,
  ffmpegAssetName,
  ffmpegBinaryName,
  ffmpegOnPath,
  resolveFfmpeg,
} from '../src/ffmpeg.js';
import { MediaError, type Runner } from '../src/exec.js';

let dir = '';

/** PATH is the machine's, not the test's — every non-PATH case stubs it absent. */
const notOnPath: Runner = () => Promise.resolve({ code: 1, stdout: '', stderr: '' });
const onPath: Runner = () =>
  Promise.resolve({ code: 0, stdout: 'ffmpeg version 8.0.1', stderr: '' });

/** Reaching the network at all is the failure this suite is guarding against. */
const exploded = ((): Promise<Response> => {
  throw new Error('the network was contacted');
}) as unknown as typeof fetch;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kh-ffmpeg-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('which build gets installed', () => {
  it('installs only on Windows, and picks the static build for the architecture', () => {
    expect(ffmpegAssetName('win32', 'x64')).toBe('ffmpeg-master-latest-win64-gpl.zip');
    expect(ffmpegAssetName('win32', 'arm64')).toBe('ffmpeg-master-latest-winarm64-gpl.zip');
    expect(ffmpegAssetName('win32', 'ia32')).toBe('ffmpeg-master-latest-win32-gpl.zip');
    // `-shared` would drop a pile of DLLs next to the exe, any one of which
    // could go missing or be shadowed. A static build cannot be half-installed.
    expect(ffmpegAssetName('win32', 'x64')).not.toContain('shared');
    // Documented, deliberate: a package manager is the better route on Unix.
    expect(ffmpegAssetName('darwin', 'arm64')).toBeNull();
    expect(ffmpegAssetName('linux', 'x64')).toBeNull();
  });

  it('names the cached copy the way the platform expects', () => {
    expect(ffmpegBinaryName('win32')).toBe('ffmpeg.exe');
    expect(ffmpegBinaryName('darwin')).toBe('ffmpeg');
  });

  it('verifies against the release’s own manifest', () => {
    expect(FFMPEG_CHECKSUMS_FILE).toBe('checksums.sha256');
  });
});

describe('the PATH probe', () => {
  it('requires the binary to actually run, not merely to exist', async () => {
    await expect(ffmpegOnPath(onPath)).resolves.toBe('ffmpeg');
    await expect(ffmpegOnPath(notOnPath)).resolves.toBeNull();
    // A hung or crashing ffmpeg is "absent", not a failure halfway through the
    // first real merge.
    await expect(
      ffmpegOnPath(() => Promise.reject(new MediaError('upstream-failed', 'timed out'))),
    ).resolves.toBeNull();
  });
});

describe('resolution order: --ffmpeg, then PATH, then the cache, then a download', () => {
  it('takes the explicit path first and never probes anything', async () => {
    const explicit = join(dir, 'my-ffmpeg');
    await writeFile(explicit, '#!/bin/sh\n');
    let probed = false;
    const runImpl: Runner = () => {
      probed = true;
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    };

    await expect(
      resolveFfmpeg({
        cacheDir: dir,
        explicitPath: explicit,
        allowAutoDownload: false,
        env: {},
        runImpl,
        fetchImpl: exploded,
      }),
    ).resolves.toEqual({ present: true, location: explicit, source: 'flag' });
    expect(probed).toBe(false);
  });

  it('refuses an explicit --ffmpeg that is not there rather than silently ignoring it', async () => {
    await expect(
      resolveFfmpeg({
        cacheDir: dir,
        explicitPath: join(dir, 'nope'),
        allowAutoDownload: false,
        env: {},
        runImpl: notOnPath,
      }),
    ).rejects.toThrow(/No ffmpeg at/);
  });

  it('prefers the user’s own PATH install over anything it could download', async () => {
    const found = await resolveFfmpeg({
      cacheDir: dir,
      allowAutoDownload: true,
      env: {},
      runImpl: onPath,
      fetchImpl: exploded,
      platform: 'win32',
      arch: 'x64',
    });
    expect(found.present).toBe(true);
    expect(found.source).toBe('path');
    // yt-dlp does its own PATH lookup, so there is nothing to hand
    // --ffmpeg-location. Passing a bare command name there would break it.
    expect(found.location).toBeUndefined();
  });

  it('falls through to a previously downloaded copy when PATH has nothing', async () => {
    await mkdir(join(dir, 'bin'), { recursive: true });
    const cached = join(dir, 'bin', 'ffmpeg.exe');
    await writeFile(cached, 'binary');

    await expect(
      resolveFfmpeg({
        cacheDir: dir,
        allowAutoDownload: true,
        env: {},
        runImpl: notOnPath,
        fetchImpl: exploded,
        platform: 'win32',
        arch: 'x64',
      }),
    ).resolves.toEqual({ present: true, location: cached, source: 'cache' });
  });

  it('never touches the network in CI, or when the kill switch is set', async () => {
    for (const env of [{ CI: 'true' }, { KRAKEN_HUB_RESOLVER_NO_DOWNLOAD: '1' }]) {
      await expect(
        resolveFfmpeg({
          cacheDir: dir,
          allowAutoDownload: true,
          env,
          runImpl: notOnPath,
          fetchImpl: exploded,
          platform: 'win32',
          arch: 'x64',
        }),
      ).resolves.toEqual({ present: false, source: 'absent' });
    }
  });

  it('never downloads without the caller opting in', async () => {
    await expect(
      resolveFfmpeg({
        cacheDir: dir,
        allowAutoDownload: false,
        env: {},
        runImpl: notOnPath,
        fetchImpl: exploded,
        platform: 'win32',
        arch: 'x64',
      }),
    ).resolves.toEqual({ present: false, source: 'absent' });
  });

  it('does not download on a platform with no published asset', async () => {
    await expect(
      resolveFfmpeg({
        cacheDir: dir,
        allowAutoDownload: true,
        env: {},
        runImpl: notOnPath,
        fetchImpl: exploded,
        platform: 'darwin',
        arch: 'arm64',
      }),
    ).resolves.toEqual({ present: false, source: 'absent' });
  });
});

describe('a download that goes wrong', () => {
  it('refuses to install bytes whose digest does not match', async () => {
    const asset = 'ffmpeg-master-latest-win64-gpl.zip';
    const fetchImpl = ((input: string | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith(FFMPEG_CHECKSUMS_FILE)) {
        return Promise.resolve(new Response(`0000000000000000  ${asset}\n`, { status: 200 }));
      }
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    }) as unknown as typeof fetch;

    const found = await resolveFfmpeg({
      cacheDir: dir,
      allowAutoDownload: true,
      env: {},
      runImpl: notOnPath,
      fetchImpl,
      platform: 'win32',
      arch: 'x64',
    });

    // A bad download must degrade the quality, never break the feature: the
    // format ladder still lands a playable file without ffmpeg.
    expect(found).toEqual({ present: false, source: 'absent' });
    await expect(rm(join(dir, 'bin', 'ffmpeg.exe'))).rejects.toThrow();
  });

  it('does not install anything when the release publishes no digest for the asset', async () => {
    const fetchImpl = ((input: string | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith(FFMPEG_CHECKSUMS_FILE)) {
        return Promise.resolve(new Response('aaaa  something-else.zip\n', { status: 200 }));
      }
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    }) as unknown as typeof fetch;

    await expect(
      resolveFfmpeg({
        cacheDir: dir,
        allowAutoDownload: true,
        env: {},
        runImpl: notOnPath,
        fetchImpl,
        platform: 'win32',
        arch: 'x64',
      }),
    ).resolves.toEqual({ present: false, source: 'absent' });
  });
});
