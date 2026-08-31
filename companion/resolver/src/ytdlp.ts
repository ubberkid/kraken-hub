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

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type Logger, silentLogger } from './log.js';

import type { ResolverErrorCode, ResolverKind } from './contract.js';

/** A failure that already knows which contract code it maps onto. */
export class MediaError extends Error {
  readonly code: ResolverErrorCode;

  constructor(code: ResolverErrorCode, message: string) {
    super(message);
    this.name = 'MediaError';
    this.code = code;
  }
}

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
 * §6 of the protocol: *best progressive ≤ maxHeight; when only adaptive formats
 * exist, mux with ffmpeg if it is there, otherwise fall back to the best
 * progressive rather than failing.*
 *
 * `best[height<=?H]` is yt-dlp's "prefer, do not require" form, so a source
 * whose only rendition is taller still plays instead of 404-ing.
 */
export function formatSelector(args: {
  maxHeight: number;
  audio: boolean;
  prefer: 'progressive' | 'any';
  hasFfmpeg: boolean;
}): string {
  const h = String(Math.max(1, Math.floor(args.maxHeight)));
  const progressive = args.audio
    ? `best[height<=?${h}][vcodec!=none][acodec!=none]`
    : `best[height<=?${h}][vcodec!=none]`;
  const muxed = `bestvideo[height<=?${h}]+bestaudio`;

  if (!args.hasFfmpeg) return `${progressive}/best[height<=?${h}]/best`;
  if (args.prefer === 'progressive') return `${progressive}/${muxed}/best[height<=?${h}]/best`;
  return `${muxed}/${progressive}/best`;
}

/** `-J --no-playlist` metadata probe. The URL is the final, separate argv. */
export function probeArgs(url: string): string[] {
  return ['-J', '--no-playlist', '--no-warnings', '--no-progress', '--', url];
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
    '--',
    req.url,
  ];
}

// ---------------------------------------------------------------------------
// Process plumbing
// ---------------------------------------------------------------------------

const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 45_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  bin: string,
  args: string[],
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    // `shell: false` is the default and is spelled out because the whole
    // security story of this file rests on it.
    const child = spawn(bin, args, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const onAbort = (): void => {
      child.kill('SIGKILL');
      finish(() => {
        reject(new MediaError('internal', 'Cancelled.'));
      });
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => {
        reject(new MediaError('upstream-failed', 'yt-dlp timed out.'));
      });
    }, opts.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_STDOUT_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDOUT_BYTES) stderr += chunk.toString('utf8');
    });
    child.on('error', (err: Error) => {
      finish(() => {
        reject(new MediaError('upstream-failed', `yt-dlp could not be started: ${err.message}`));
      });
    });
    child.on('close', (code) => {
      finish(() => {
        resolve({ code, stdout, stderr });
      });
    });

    opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** yt-dlp says a lot; only a few things are worth a distinct contract code. */
export function classifyStderr(stderr: string): ResolverErrorCode {
  const text = stderr.toLowerCase();
  if (text.includes('unsupported url') || text.includes('is not a valid url')) {
    return 'unsupported-url';
  }
  if (
    text.includes('video unavailable') ||
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

/**
 * The `SHA2-256SUMS` file the release ships: `<sha256>␠␠<asset>` per line.
 * Returns `null` when the asset is absent, which must be treated as a failure —
 * "no digest published" is never a reason to install the bytes anyway.
 */
export function digestFor(sums: string, asset: string): string | null {
  for (const line of sums.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1] === asset && typeof parts[0] === 'string') {
      return parts[0].toLowerCase();
    }
  }
  return null;
}

export const YT_DLP_RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';

/** The shape of {@link run}, so the PATH probe can be stubbed in a unit test. */
export type Runner = (
  bin: string,
  args: string[],
  opts: { timeoutMs: number; signal?: AbortSignal },
) => Promise<RunResult>;

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

/** The environment kill switches. Both mean "never touch the network". */
export function autoDownloadRefused(env: NodeJS.ProcessEnv): string | null {
  if (env['KRAKEN_HUB_RESOLVER_NO_DOWNLOAD'] === '1') {
    return 'KRAKEN_HUB_RESOLVER_NO_DOWNLOAD=1';
  }
  if (typeof env['CI'] === 'string' && env['CI'] !== '' && env['CI'] !== 'false') {
    return 'CI';
  }
  return null;
}

async function isExecutable(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isFile(),
    () => false,
  );
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

  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  log.info(`downloading ${asset} from the yt-dlp release (checksum-verified)…`);

  const sumsRes = await doFetch(`${YT_DLP_RELEASE_BASE}/SHA2-256SUMS`);
  if (!sumsRes.ok) {
    throw new MediaError('upstream-failed', 'Could not fetch the yt-dlp checksum file.');
  }
  const expected = digestFor(await sumsRes.text(), asset);
  if (expected === null) {
    throw new MediaError('upstream-failed', `The release publishes no digest for ${asset}.`);
  }

  const binRes = await doFetch(`${YT_DLP_RELEASE_BASE}/${asset}`);
  if (!binRes.ok) {
    throw new MediaError('upstream-failed', `Could not download ${asset}.`);
  }
  const bytes = Buffer.from(await binRes.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    throw new MediaError(
      'upstream-failed',
      `Checksum mismatch for ${asset} — refusing to install it.`,
    );
  }

  await mkdir(binDir, { recursive: true });
  const tmp = `${local}.download`;
  await writeFile(tmp, bytes);
  await chmod(tmp, 0o755);
  await rename(tmp, local);
  log.info(`yt-dlp installed at ${local}`);
  return local;
}

async function findFfmpeg(explicit?: string): Promise<string | undefined> {
  if (explicit !== undefined && explicit !== '') return explicit;
  const result = await run(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], {
    timeoutMs: 5000,
  }).catch(() => null);
  const first = result?.stdout.split('\n')[0]?.trim();
  return result?.code === 0 && first !== undefined && first !== '' ? first : undefined;
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
  let ffmpeg: Promise<string | undefined> | null = null;

  const bin = (): Promise<string> => {
    binary ??= ensureYtDlpBinary({
      cacheDir: opts.cacheDir,
      allowAutoDownload: opts.allowAutoDownload,
      log,
      ...(opts.binaryPath === undefined ? {} : { binaryPath: opts.binaryPath }),
    });
    return binary;
  };

  const probe = async (url: string, signal?: AbortSignal): Promise<ProbeInfo> => {
    const result = await run(await bin(), probeArgs(url), {
      timeoutMs: PROBE_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.code !== 0) {
      throw new MediaError(classifyStderr(result.stderr), result.stderr.trim().slice(0, 300));
    }
    return parseProbe(result.stdout);
  };

  return {
    probe,

    async fetch(req) {
      ffmpeg ??= findFfmpeg(opts.ffmpegPath);
      const ffmpegPath = await ffmpeg;
      const selector = formatSelector({
        maxHeight: req.maxHeight,
        audio: req.audio,
        prefer: req.prefer,
        hasFfmpeg: ffmpegPath !== undefined,
      });
      const args = downloadArgs(req, selector, ffmpegPath);
      log.debug('yt-dlp', selector);
      const result = await run(await bin(), args, {
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        ...(req.signal === undefined ? {} : { signal: req.signal }),
      });
      if (result.code !== 0) {
        throw new MediaError(classifyStderr(result.stderr), result.stderr.trim().slice(0, 300));
      }
      const info = await stat(req.destFile).catch(() => null);
      if (info === null || info.size === 0) {
        throw new MediaError('upstream-failed', 'yt-dlp produced no file.');
      }
      const meta = await probe(req.url, req.signal).catch((): ProbeInfo => ({}));
      return {
        ...meta,
        file: req.destFile,
        mime: 'video/mp4',
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
