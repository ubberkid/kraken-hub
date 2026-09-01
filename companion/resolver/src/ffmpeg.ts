/**
 * Finding — and, on Windows, installing — ffmpeg.
 *
 * ## Why the companion cares this much about ffmpeg
 *
 * YouTube no longer serves muxed video for most uploads. Not "rarely": a
 * present-day watch page typically offers audio-only formats and video-only
 * formats and **nothing else at all** — not even the old 360p `itag 18`. Real
 * quality therefore is not a format you can pick, it is a *merge*: best video
 * plus best audio, joined by ffmpeg. See
 * `docs/design/research/research-youtubePlayback.md`.
 *
 * A Windows user who double-clicks an exe has no ffmpeg and no reason to want
 * one. `ytdlp.ts` already degrades to a single-file format when ffmpeg is
 * missing, which never fails but caps them at whatever one file happens to be
 * available. So the companion fetches ffmpeg the same way it fetches yt-dlp:
 * from a named release, checksum-verified, never in CI, never without the
 * caller opting in.
 *
 * ## Resolution order
 *
 *  1. `--ffmpeg <path>` — an explicit path always wins, and a wrong one is a
 *     loud error rather than a silent fall-through.
 *  2. ffmpeg on `PATH`, verified by running it. The user's own install beats
 *     anything this tool downloaded for itself.
 *  3. A previously auto-downloaded copy in `<cache-dir>/bin`.
 *  4. A fresh, checksum-verified download — **Windows only**.
 *  5. Nothing. Which is not an error: the caller degrades instead.
 *
 * ## macOS and Linux
 *
 * Steps 1–3 only; there is no auto-download. The product target is Windows, and
 * on a Unix machine `brew install ffmpeg` / the distro package manager is both
 * the expected route and a better one — a system package gets security updates,
 * a blob in a cache directory does not.
 */

import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  MediaError,
  autoDownloadRefused,
  fetchVerifiedAsset,
  isExecutable,
  run,
  type Runner,
} from './exec.js';
import { extractZipEntry, readZipEntries } from './unzip.js';
import { type Logger, silentLogger } from './log.js';

/** The yt-dlp project's own ffmpeg builds — the ones yt-dlp documents and tests. */
export const FFMPEG_RELEASE_BASE =
  'https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download';

/** That release's checksum manifest; same `<sha256>␠␠<asset>` shape as yt-dlp's. */
export const FFMPEG_CHECKSUMS_FILE = 'checksums.sha256';

/** How long `ffmpeg -version` may take before the binary counts as absent. */
export const FFMPEG_PROBE_TIMEOUT_MS = 5000;

export const FFMPEG_PATH_COMMAND = 'ffmpeg';

/** What the auto-installed copy is called inside `<cache-dir>/bin`. */
export function ffmpegBinaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

/**
 * The release asset to install for this platform, or `null` where the companion
 * does not auto-install at all.
 *
 * The `-gpl` (static) builds are chosen over `-gpl-shared` deliberately: one
 * self-contained executable with no DLLs beside it cannot be half-installed,
 * and cannot pick up a stray DLL from somewhere else on the system.
 */
export function ffmpegAssetName(platform: NodeJS.Platform, arch: string): string | null {
  if (platform !== 'win32') return null;
  if (arch === 'arm64') return 'ffmpeg-master-latest-winarm64-gpl.zip';
  if (arch === 'ia32' || arch === 'x86') return 'ffmpeg-master-latest-win32-gpl.zip';
  if (arch === 'x64') return 'ffmpeg-master-latest-win64-gpl.zip';
  return null;
}

/**
 * Is there a working ffmpeg on PATH? "Present" is not enough — a stale shim or
 * a binary that cannot start would turn into a confusing failure halfway
 * through the first real merge, so the probe runs it and requires exit 0.
 *
 * Resolves to the *command name*, not a path: yt-dlp does its own PATH lookup,
 * so there is nothing to tell it.
 */
export async function ffmpegOnPath(runImpl: Runner = run): Promise<string | null> {
  const result = await runImpl(FFMPEG_PATH_COMMAND, ['-version'], {
    timeoutMs: FFMPEG_PROBE_TIMEOUT_MS,
  }).catch(() => null);
  if (result?.code !== 0) return null;
  return FFMPEG_PATH_COMMAND;
}

/**
 * What the format ladder needs to know.
 *
 * `location` is what goes to `--ffmpeg-location`, and is deliberately absent for
 * the PATH case: yt-dlp finds a PATH ffmpeg by itself, and pointing
 * `--ffmpeg-location` at a bare command name would break it.
 */
export interface FfmpegResolution {
  present: boolean;
  location?: string;
  /** For the log line, and for the README's troubleshooting section. */
  source: 'flag' | 'path' | 'cache' | 'download' | 'absent';
}

export interface ResolveFfmpegOptions {
  cacheDir: string;
  /** `--ffmpeg <path>`. */
  explicitPath?: string;
  allowAutoDownload: boolean;
  log?: Logger;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  runImpl?: Runner;
  platform?: NodeJS.Platform;
  arch?: string;
}

export async function resolveFfmpeg(opts: ResolveFfmpegOptions): Promise<FfmpegResolution> {
  const log = opts.log ?? silentLogger;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;

  if (opts.explicitPath !== undefined && opts.explicitPath !== '') {
    if (!(await isExecutable(opts.explicitPath))) {
      throw new MediaError('internal', `No ffmpeg at ${opts.explicitPath}.`);
    }
    return { present: true, location: opts.explicitPath, source: 'flag' };
  }

  if ((await ffmpegOnPath(opts.runImpl ?? run)) !== null) {
    log.debug('using the ffmpeg found on PATH');
    return { present: true, source: 'path' };
  }

  const binDir = join(opts.cacheDir, 'bin');
  const local = join(binDir, ffmpegBinaryName(platform));
  if (await isExecutable(local)) {
    log.debug(`using the cached ffmpeg at ${local}`);
    return { present: true, location: local, source: 'cache' };
  }

  const asset = ffmpegAssetName(platform, arch);
  const refusal = autoDownloadRefused(env);
  if (asset === null || !opts.allowAutoDownload || refusal !== null) {
    log.info(
      `no ffmpeg: ${
        asset === null
          ? 'this platform installs ffmpeg through its package manager'
          : `auto-download is disabled${refusal === null ? '' : ` (${refusal})`}`
      }. Falling back to single-file formats, which caps the quality this source can reach.`,
    );
    return { present: false, source: 'absent' };
  }

  // A failed install is not a failed resolve. Without ffmpeg the ladder in
  // `ytdlp.ts` still lands a playable file, so a GitHub outage must degrade the
  // quality, never break the feature.
  try {
    const path = await installFfmpeg({
      asset,
      binDir,
      destFile: local,
      log,
      fetchImpl: opts.fetchImpl ?? globalThis.fetch,
    });
    return { present: true, location: path, source: 'download' };
  } catch (cause) {
    log.warn(
      `could not install ffmpeg (${cause instanceof Error ? cause.message : String(cause)}); ` +
        'continuing without it, at reduced quality.',
    );
    return { present: false, source: 'absent' };
  }
}

/** The entry inside a FFmpeg-Builds archive, which nests everything under `bin/`. */
const FFMPEG_ZIP_ENTRY_SUFFIX = '/bin/ffmpeg.exe';

async function installFfmpeg(opts: {
  asset: string;
  binDir: string;
  destFile: string;
  log: Logger;
  fetchImpl: typeof fetch;
}): Promise<string> {
  opts.log.info(
    `downloading ${opts.asset} from the yt-dlp FFmpeg-Builds release (checksum-verified)…`,
  );
  const zip = await fetchVerifiedAsset({
    base: FFMPEG_RELEASE_BASE,
    asset: opts.asset,
    sumsFile: FFMPEG_CHECKSUMS_FILE,
    fetchImpl: opts.fetchImpl,
  });

  // Matched by exact suffix, never used as a path: a crafted archive must not
  // be able to name its own destination.
  const entry = readZipEntries(zip).find((e) => e.name.endsWith(FFMPEG_ZIP_ENTRY_SUFFIX));
  if (entry === undefined) {
    throw new MediaError(
      'upstream-failed',
      `${opts.asset} contains no ${FFMPEG_ZIP_ENTRY_SUFFIX}.`,
    );
  }

  await mkdir(opts.binDir, { recursive: true });
  const tmp = `${opts.destFile}.download`;
  try {
    await extractZipEntry(zip, entry, tmp);
    await rename(tmp, opts.destFile);
  } catch (cause) {
    await rm(tmp, { force: true });
    throw cause;
  }
  opts.log.info(`ffmpeg installed at ${opts.destFile}`);
  return opts.destFile;
}
