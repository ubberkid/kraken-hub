/**
 * The extractor seam: everything that knows what `yt-dlp` is lives here, behind
 * a two-method interface the rest of the program can stub.
 *
 * Three rules this file exists to keep:
 *
 *  1. **The URL is never interpolated into a shell.** Every spawn is
 *     `spawn(bin, args, { shell: false })` with the URL as its own argv entry,
 *     last, after `--`. A URL is attacker-supplied by definition — the page that
 *     asked for it can be any page in the user's browser.
 *  2. **The binary is verified.** Auto-download fetches the platform asset *and*
 *     the release's `SHA2-256SUMS`, and refuses to install a byte that does not
 *     hash to the published digest.
 *  3. **Auto-download never happens in a test.** It is gated on an explicit
 *     `allowAutoDownload` flag that only `cli.ts` sets, and refused outright
 *     when `CI` or `KRAKEN_HUB_RESOLVER_NO_DOWNLOAD` is in the environment.
 */

import { chmod, copyFile, mkdir, open, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveFfmpeg, type FfmpegResolution } from './ffmpeg.js';
import { type Logger, silentLogger } from './log.js';
import {
  MediaError,
  autoDownloadRefused,
  digestFor,
  fetchVerifiedAsset,
  isExecutable,
  run,
  type RunResult,
  type Runner,
} from './exec.js';

import type { ResolverErrorCode, ResolverKind } from './contract.js';

// `resolve.ts`, the tests and the published types have imported these from here
// since v1. They live in `exec.ts` now because `ffmpeg.ts` needs them too;
// re-exporting keeps that an implementation detail.
export { MediaError, autoDownloadRefused, digestFor, run };
export type { RunResult, Runner };

export interface ProbeInfo {
  title?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  fps?: number;
  thumbUrl?: string;
}

export interface FetchRequest {
  url: string;
  maxHeight: number;
  audio: boolean;
  prefer: 'progressive' | 'any';
  /** Where the muxed file must end up. Minted by the cache, never by the caller. */
  destFile: string;
  signal?: AbortSignal;
}

export interface FetchResult extends ProbeInfo {
  file: string;
  mime: string;
  kind: ResolverKind;
  bytes: number;
}

export interface MediaDownloader {
  probe(url: string, signal?: AbortSignal): Promise<ProbeInfo>;
  fetch(req: FetchRequest): Promise<FetchResult>;
}

// ---------------------------------------------------------------------------
// Argument construction — pure, and therefore unit-testable
// ---------------------------------------------------------------------------

/**
 * The format ladder.
 *
 * ## The thing that makes this hard
 *
 * In yt-dlp's selector language `b` (`best`) does **not** mean "the best
 * format". It means "the best format that already contains both a video and an
 * audio stream". `bv*` means "the best format containing video, muxed or not".
 * That one letter is the difference between a working companion and this, which
 * is what users saw:
 *
 *     ERROR: Requested format is not available
 *
 * A present-day YouTube watch page commonly offers audio-only formats and
 * video-only formats and *nothing else* — not even the old 360p `itag 18`. Every
 * rung of the previous ladder (`best[…]/best[…]/best`) was a `best`, so every
 * rung matched nothing and yt-dlp exited non-zero with that message. There was
 * no bug in the height filter and no bug in the fallback chain; the chain simply
 * had no rung that could ever match an adaptive-only source.
 *
 * ## The rule this ladder keeps
 *
 * **While yt-dlp can see any format containing video, this must not fail.**
 * Every branch therefore ends in an unconstrained `bv*`. Quality degrades;
 * nothing errors. (A URL with no video stream at all still errors — handing a
 * `<video>` element an audio-only file is a black panel with no diagnostic,
 * which is worse than a message.)
 *
 * ## Why `audio` reorders rather than filters
 *
 * The Kraken panel has no speaker, so `audio=0` is the common case — and a
 * video-only format needs no merge, which means no ffmpeg, no second download
 * and no remux. Asking for video only when only video was wanted is both the
 * fastest path and the one most likely to succeed.
 *
 * `prefer` no longer changes the selector. Its purpose was "give me one file,
 * not a manifest", and an ffmpeg merge *produces* one file — the distinction
 * lives in the output, not in the format request.
 */
export function formatSelector(args: {
  maxHeight: number;
  audio: boolean;
  prefer: 'progressive' | 'any';
  hasFfmpeg: boolean;
}): string {
  const h = String(Math.max(1, Math.floor(args.maxHeight)));
  // `<=?` lets a format through when its height is unknown. It is a hard cap on
  // known heights, which is why every branch needs an uncapped rung after it:
  // a source whose smallest rendition is taller than `h` must still play.
  const cap = `[height<=?${h}]`;

  // No trailing `/b`: every muxed format contains video, so an uncapped `bv*`
  // has already matched anything an uncapped `b` could. A rung that can never
  // fire is a rung the next reader has to reason about for nothing.
  if (!args.audio) return `bv*${cap}/b${cap}/bv*`;
  // Without ffmpeg a `+` cannot be honoured, so no rung may contain one: the
  // best available is a single file that already carries its own audio.
  if (!args.hasFfmpeg) return `b${cap}/bv*${cap}/b/bv*`;
  return `bv*${cap}+ba/b${cap}/bv*${cap}/bv*+ba/b/bv*`;
}

/** `-J --no-playlist` metadata probe. The URL is the final, separate argv. */
export function probeArgs(url: string): string[] {
  return ['-J', '--no-playlist', '--no-warnings', '--no-progress', '--', url];
}

/**
 * A line yt-dlp prints once the file is in its final place, describing **what it
 * actually got** rather than what the page advertises.
 *
 * This is load-bearing for honesty. The old code re-probed the URL after the
 * download and reported the *source's* dimensions, so a companion that had
 * fallen back to a 360p rendition still told the app "1080p". Now the app can
 * show the height it really has.
 *
 * `\x1f` (ASCII unit separator) is the delimiter because it cannot occur in any
 * of these fields, unlike a space, a tab or a pipe — video titles contain all
 * three.
 */
export const META_SENTINEL = 'KHMETA';
export const META_SEPARATOR = '\u001f';

/**
 * `after_move:` runs after the merge and the remux, so `filepath` is the real
 * final name — which matters, because a merge yt-dlp cannot fit into mp4 lands
 * beside `destFile` under a different extension.
 */
export const META_PRINT_TEMPLATE = [
  `after_move:${META_SENTINEL}`,
  '%(width)s',
  '%(height)s',
  '%(fps)s',
  '%(format_id)s',
  '%(duration)s',
  '%(thumbnail)s',
  '%(filepath)s',
  // Last, so a title containing the separator cannot shift any other field.
  '%(title)s',
].join(META_SEPARATOR);

export interface DownloadMeta extends ProbeInfo {
  formatId?: string;
  filepath?: string;
}

function field(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  // yt-dlp writes the literal string `NA` for a field it does not have.
  return text === '' || text === 'NA' ? undefined : text;
}

function numeric(value: string | undefined): number | undefined {
  const text = field(value);
  if (text === undefined) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

/** Pulls {@link META_PRINT_TEMPLATE}'s line back out of a download's stdout. */
export function parseDownloadMeta(stdout: string): DownloadMeta | null {
  const prefix = `${META_SENTINEL}${META_SEPARATOR}`;
  const line = stdout
    .split('\n')
    .reverse()
    .find((l) => l.trimStart().startsWith(prefix));
  if (line === undefined) return null;

  const parts = line.trimStart().slice(prefix.length).split(META_SEPARATOR);
  const meta: DownloadMeta = {};
  const width = numeric(parts[0]);
  const height = numeric(parts[1]);
  const fps = numeric(parts[2]);
  const formatId = field(parts[3]);
  const durationSec = numeric(parts[4]);
  const thumbUrl = field(parts[5]);
  const filepath = field(parts[6]);
  // Anything past the last field is a title that contained the separator.
  const title = field(parts.slice(7).join(META_SEPARATOR));

  if (width !== undefined) meta.width = width;
  if (height !== undefined) meta.height = height;
  if (fps !== undefined) meta.fps = fps;
  if (formatId !== undefined) meta.formatId = formatId;
  if (durationSec !== undefined) meta.durationSec = durationSec;
  if (thumbUrl !== undefined) meta.thumbUrl = thumbUrl;
  if (filepath !== undefined) meta.filepath = filepath;
  if (title !== undefined) meta.title = title;
  return meta;
}

export function downloadArgs(req: FetchRequest, selector: string, ffmpegPath?: string): string[] {
  return [
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--no-part',
    '--no-continue',
    '--force-overwrites',
    '--merge-output-format',
    'mp4',
    ...(ffmpegPath === undefined ? [] : ['--ffmpeg-location', ffmpegPath]),
    '-f',
    selector,
    '-o',
    req.destFile,
    // `--print` implies `--simulate`; `--no-simulate` takes the download back.
    // Order does not matter to yt-dlp, but keeping them adjacent keeps the pair
    // from being split up by a later edit.
    '--no-simulate',
    '--print',
    META_PRINT_TEMPLATE,
    '--',
    req.url,
  ];
}

// ---------------------------------------------------------------------------
// Process plumbing
// ---------------------------------------------------------------------------

const PROBE_TIMEOUT_MS = 45_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

/** yt-dlp says a lot; only a few things are worth a distinct contract code. */
export function classifyStderr(stderr: string): ResolverErrorCode {
  const text = stderr.toLowerCase();
  if (text.includes('unsupported url') || text.includes('is not a valid url')) {
    return 'unsupported-url';
  }
  if (
    text.includes('video unavailable') ||
    text.includes('this video is unavailable') ||
    text.includes('404') ||
    text.includes('does not exist') ||
    text.includes('removed by the uploader')
  ) {
    return 'not-found';
  }
  if (
    text.includes('private video') ||
    text.includes('sign in') ||
    text.includes('age-restricted') ||
    text.includes('members-only')
  ) {
    return 'forbidden';
  }
  return 'upstream-failed';
}

/**
 * The message a person reads. Raw yt-dlp stderr is written for someone
 * debugging yt-dlp, and the format failures in particular ("Requested format is
 * not available. Use --list-formats…") send the reader off to a flag that does
 * not exist on this program.
 *
 * Only the cases where the raw text actively misleads are rewritten. Everything
 * else is passed through, trimmed, because a real error message beats a vague
 * one that was written months before the failure.
 */
export function explainStderr(stderr: string): string {
  const text = stderr.toLowerCase();
  if (text.includes('requested format is not available') || text.includes('requested format not')) {
    return (
      'That source offers no format this companion can use. This is usually a sign that ' +
      'ffmpeg is missing and the site only publishes separate video and audio streams — ' +
      'install ffmpeg, or pass --ffmpeg <path>, and try again.'
    );
  }
  if (text.includes('no video formats found') || text.includes('no formats found')) {
    return 'That page has no video on it that yt-dlp can see.';
  }
  if (text.includes('ffmpeg is not installed') || text.includes('ffmpeg not found')) {
    return 'This download needed ffmpeg to join its video and audio streams, and ffmpeg is not installed.';
  }
  const trimmed = stderr.trim();
  return trimmed === '' ? 'yt-dlp failed without saying why.' : trimmed.slice(0, 300);
}

/** Both halves of a yt-dlp failure, mapped onto the contract in one place. */
function failure(stderr: string): MediaError {
  return new MediaError(classifyStderr(stderr), explainStderr(stderr));
}

interface RawInfo {
  title?: unknown;
  duration?: unknown;
  width?: unknown;
  height?: unknown;
  fps?: unknown;
  thumbnail?: unknown;
}

export function parseProbe(stdout: string): ProbeInfo {
  let raw: RawInfo;
  try {
    raw = JSON.parse(stdout) as RawInfo;
  } catch {
    throw new MediaError('upstream-failed', 'yt-dlp returned metadata that is not JSON.');
  }
  const info: ProbeInfo = {};
  if (typeof raw.title === 'string' && raw.title !== '') info.title = raw.title;
  if (typeof raw.duration === 'number' && Number.isFinite(raw.duration)) {
    info.durationSec = raw.duration;
  }
  if (typeof raw.width === 'number') info.width = raw.width;
  if (typeof raw.height === 'number') info.height = raw.height;
  if (typeof raw.fps === 'number') info.fps = raw.fps;
  if (typeof raw.thumbnail === 'string' && raw.thumbnail !== '') info.thumbUrl = raw.thumbnail;
  return info;
}

// ---------------------------------------------------------------------------
// What actually landed on disk
// ---------------------------------------------------------------------------

/**
 * The container, read from the file's own first bytes.
 *
 * The companion used to hard-code `video/mp4` on every fetch. `--merge-output-format
 * mp4` makes that true almost always — but "almost" is the problem: when ffmpeg
 * cannot put the chosen codecs in an mp4 it writes a Matroska instead, and a
 * `<video>` element told `video/mp4` about a WebM fails at playback time, on the
 * panel, with no diagnostic. Reading the magic bytes costs one 16-byte read and
 * removes the possibility of lying.
 */
export function sniffContainerMime(head: Uint8Array): string {
  if (head.length >= 8) {
    const brand = Buffer.from(head.subarray(4, 8)).toString('ascii');
    if (brand === 'ftyp') return 'video/mp4';
  }
  // EBML — Matroska and WebM share it. WebM is the one browsers accept.
  if (
    head.length >= 4 &&
    head[0] === 0x1a &&
    head[1] === 0x45 &&
    head[2] === 0xdf &&
    head[3] === 0xa3
  ) {
    return 'video/webm';
  }
  return 'video/mp4';
}

async function readHead(path: string, bytes = 16): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Binary discovery and verified auto-download
// ---------------------------------------------------------------------------

/** The official release asset for this platform. */
export function ytDlpAssetName(platform: NodeJS.Platform, arch: string): string {
  if (platform === 'win32') return 'yt-dlp.exe';
  if (platform === 'darwin') return 'yt-dlp_macos';
  if (arch === 'arm64' || arch === 'aarch64') return 'yt-dlp_linux_aarch64';
  if (arch === 'arm') return 'yt-dlp_linux_armv7l';
  return 'yt-dlp_linux';
}

export const YT_DLP_RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
export const YT_DLP_SUMS_FILE = 'SHA2-256SUMS';

export interface EnsureBinaryOptions {
  cacheDir: string;
  /** `--yt-dlp <path>`. An explicit path always wins. */
  binaryPath?: string;
  allowAutoDownload: boolean;
  log?: Logger;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** Injection seam for the PATH probe; defaults to a real `spawn`. */
  runImpl?: Runner;
}

/** How long the `yt-dlp --version` PATH probe may take before it counts as absent. */
export const PATH_PROBE_TIMEOUT_MS = 5000;

/** The name spawned when yt-dlp is taken from PATH; libuv does the lookup. */
export const YT_DLP_PATH_COMMAND = 'yt-dlp';

/**
 * Is there a working `yt-dlp` on PATH? "Present" is not enough — the probe runs
 * it with `--version` and requires exit 0, so a stale shim, a wrapper that
 * cannot start, or a hung binary is treated as absent rather than becoming a
 * confusing failure on the first real extraction.
 */
export async function ytDlpOnPath(runImpl: Runner = run): Promise<string | null> {
  const result = await runImpl(YT_DLP_PATH_COMMAND, ['--version'], {
    timeoutMs: PATH_PROBE_TIMEOUT_MS,
  }).catch(() => null);
  if (result?.code !== 0) return null;
  return YT_DLP_PATH_COMMAND;
}

/**
 * Resolve the yt-dlp binary, in this order:
 *
 *  1. an explicit `--yt-dlp <path>`;
 *  2. a working `yt-dlp` on PATH (verified with `--version`) — the user's own
 *     install always beats a copy this tool downloaded for itself;
 *  3. a previously auto-downloaded copy in the cache dir;
 *  4. a fresh, checksum-verified download;
 *  5. refusal, with the reason.
 */
export async function ensureYtDlpBinary(opts: EnsureBinaryOptions): Promise<string> {
  if (opts.binaryPath !== undefined && opts.binaryPath !== '') {
    if (!(await isExecutable(opts.binaryPath))) {
      throw new MediaError('internal', `No yt-dlp at ${opts.binaryPath}.`);
    }
    return opts.binaryPath;
  }

  const log = opts.log ?? silentLogger;
  const env = opts.env ?? process.env;

  const onPath = await ytDlpOnPath(opts.runImpl ?? run);
  if (onPath !== null) {
    log.debug(`using the yt-dlp found on PATH (${onPath})`);
    return onPath;
  }

  const asset = ytDlpAssetName(process.platform, process.arch);
  const binDir = join(opts.cacheDir, 'bin');
  const local = join(binDir, asset);
  if (await isExecutable(local)) return local;

  const refusal = autoDownloadRefused(env);
  if (!opts.allowAutoDownload || refusal !== null) {
    throw new MediaError(
      'internal',
      `yt-dlp is not installed and auto-download is disabled${
        refusal === null ? '' : ` (${refusal})`
      }. Put yt-dlp on PATH, or pass --yt-dlp <path>.`,
    );
  }

  log.info(`downloading ${asset} from the yt-dlp release (checksum-verified)…`);
  const bytes = await fetchVerifiedAsset({
    base: YT_DLP_RELEASE_BASE,
    asset,
    sumsFile: YT_DLP_SUMS_FILE,
    fetchImpl: opts.fetchImpl ?? globalThis.fetch,
  });

  await mkdir(binDir, { recursive: true });
  const tmp = `${local}.download`;
  await writeFile(tmp, bytes);
  await chmod(tmp, 0o755);
  await rename(tmp, local);
  log.info(`yt-dlp installed at ${local}`);
  return local;
}

export interface YtDlpOptions {
  cacheDir: string;
  binaryPath?: string;
  ffmpegPath?: string;
  allowAutoDownload: boolean;
  log?: Logger;
}

export function createYtDlpDownloader(opts: YtDlpOptions): MediaDownloader {
  const log = opts.log ?? silentLogger;
  let binary: Promise<string> | null = null;
  let ffmpeg: Promise<FfmpegResolution> | null = null;

  const bin = (): Promise<string> => {
    binary ??= ensureYtDlpBinary({
      cacheDir: opts.cacheDir,
      allowAutoDownload: opts.allowAutoDownload,
      log,
      ...(opts.binaryPath === undefined ? {} : { binaryPath: opts.binaryPath }),
    });
    return binary;
  };

  const ff = (): Promise<FfmpegResolution> => {
    ffmpeg ??= resolveFfmpeg({
      cacheDir: opts.cacheDir,
      allowAutoDownload: opts.allowAutoDownload,
      log,
      ...(opts.ffmpegPath === undefined ? {} : { explicitPath: opts.ffmpegPath }),
    });
    return ffmpeg;
  };

  const probe = async (url: string, signal?: AbortSignal): Promise<ProbeInfo> => {
    const result = await run(await bin(), probeArgs(url), {
      timeoutMs: PROBE_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.code !== 0) throw failure(result.stderr);
    return parseProbe(result.stdout);
  };

  return {
    probe,

    async fetch(req) {
      const ffmpegInfo = await ff();
      const selector = formatSelector({
        maxHeight: req.maxHeight,
        audio: req.audio,
        prefer: req.prefer,
        hasFfmpeg: ffmpegInfo.present,
      });
      const args = downloadArgs(req, selector, ffmpegInfo.location);
      log.debug(`yt-dlp -f ${selector} (ffmpeg: ${ffmpegInfo.source})`);
      const result = await run(await bin(), args, {
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        ...(req.signal === undefined ? {} : { signal: req.signal }),
      });
      if (result.code !== 0) throw failure(result.stderr);

      // yt-dlp reports where the file ended up. Trust that over `destFile`: a
      // merge it could not fit into mp4 writes a sibling with another extension,
      // and stat-ing the name we asked for would report "produced no file".
      const printed = parseDownloadMeta(result.stdout);
      const file = printed?.filepath ?? req.destFile;
      const info = await stat(file).catch(() => null);
      if (info === null || info.size === 0) {
        throw new MediaError('upstream-failed', 'yt-dlp produced no file.');
      }

      // The print line already carries the *selected* format's dimensions, which
      // is what the app should display. Only fall back to a second network round
      // trip when yt-dlp printed nothing at all.
      const meta: ProbeInfo =
        printed ?? (await probe(req.url, req.signal).catch((): ProbeInfo => ({})));

      return {
        ...meta,
        file,
        mime: sniffContainerMime(await readHead(file)),
        kind: 'progressive',
        bytes: info.size,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The stub — the ONLY downloader tests and e2e ever see
// ---------------------------------------------------------------------------

export interface StubOptions {
  /** Milliseconds to pretend the download takes, so `202` → `/job` is real. */
  delayMs?: number;
  title?: string;
  log?: Logger;
}

/**
 * Copies a fixture file into the cache instead of extracting anything.
 *
 * `cli.ts` wires this up when `KRAKEN_HUB_RESOLVER_STUB=<path>` is set, which is
 * how the web app's e2e suite drives a *real* companion process with no network
 * and no yt-dlp anywhere.
 */
export function createStubDownloader(fixture: string, opts: StubOptions = {}): MediaDownloader {
  const delay = opts.delayMs ?? 0;
  const info: ProbeInfo = {
    title: opts.title ?? 'stub-clip.mp4',
    durationSec: 4,
    width: 640, // device-size-ok: the fixture's own dimensions, not a panel size.
    height: 640, // device-size-ok: the fixture's own dimensions, not a panel size.
    fps: 30,
  };

  return {
    probe: () => Promise.resolve(info),
    async fetch(req) {
      if (delay > 0) await new Promise<void>((r) => setTimeout(r, delay));
      await copyFile(fixture, req.destFile);
      const stats = await stat(req.destFile);
      return {
        ...info,
        file: req.destFile,
        mime: 'video/mp4',
        kind: 'progressive',
        bytes: stats.size,
      };
    },
  };
}
