#!/usr/bin/env node
/**
 * `kraken-hub-resolver` — the command line.
 *
 * Flag parsing is hand-written for one reason: this package ships with **zero
 * runtime dependencies**, and a program whose whole job is "download whatever
 * that page asked for" is exactly the wrong place to grow a dependency tree.
 * `node:http`, `node:crypto`, `node:fs`, `node:child_process` cover all of it.
 */

import { mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ClipCache } from './cache.js';
import { createLogger, isLogLevel, type LogLevel } from './log.js';
import { createResolverServer, DEFAULT_MAX_HEIGHT, DEFAULT_PORT } from './server.js';
import { createStubDownloader, createYtDlpDownloader, type MediaDownloader } from './ytdlp.js';

const PACKAGE_NAME = 'kraken-hub-resolver';
export const VERSION = '1.0.0';

const GB = 1024 * 1024 * 1024;
export const DEFAULT_MAX_CACHE_GB = 4;
/** How long a minted `/stream/<opaque>` id stays valid. */
export const DEFAULT_TTL_MS = 12 * 60 * 60_000;

export interface CliOptions {
  port: number;
  cacheDir: string;
  token: string;
  maxCacheBytes: number;
  maxHeight: number;
  ytDlpPath?: string;
  ffmpegPath?: string;
  logLevel: LogLevel;
  help: boolean;
  version: boolean;
}

/** The OS cache directory, per platform convention. */
export function defaultCacheDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = homedir();
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA'];
    return join(local !== undefined && local !== '' ? local : tmpdir(), PACKAGE_NAME, 'Cache');
  }
  if (platform === 'darwin') return join(home, 'Library', 'Caches', PACKAGE_NAME);
  const xdg = env['XDG_CACHE_HOME'];
  return join(xdg !== undefined && xdg !== '' ? xdg : join(home, '.cache'), PACKAGE_NAME);
}

export class CliError extends Error {}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new CliError(`${flag} needs a value.`);
  }
  return value;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const opts: CliOptions = {
    port: DEFAULT_PORT,
    cacheDir: defaultCacheDir(process.platform, env),
    token: env['KRAKEN_HUB_RESOLVER_TOKEN'] ?? '',
    maxCacheBytes: DEFAULT_MAX_CACHE_GB * GB,
    maxHeight: DEFAULT_MAX_HEIGHT,
    logLevel: 'info',
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--version':
      case '-v':
        opts.version = true;
        break;
      case '--port': {
        const port = Number(requireValue(argv, i, '--port'));
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new CliError('--port must be a port number (0 picks a free one).');
        }
        opts.port = port;
        i += 1;
        break;
      }
      case '--cache-dir':
        opts.cacheDir = requireValue(argv, i, '--cache-dir');
        i += 1;
        break;
      case '--token':
        opts.token = requireValue(argv, i, '--token');
        i += 1;
        break;
      case '--max-cache-gb': {
        const gb = Number(requireValue(argv, i, '--max-cache-gb'));
        if (!Number.isFinite(gb) || gb <= 0) throw new CliError('--max-cache-gb must be > 0.');
        opts.maxCacheBytes = Math.floor(gb * GB);
        i += 1;
        break;
      }
      case '--max-height': {
        const h = Number(requireValue(argv, i, '--max-height'));
        if (!Number.isInteger(h) || h < 144) throw new CliError('--max-height must be >= 144.');
        opts.maxHeight = h;
        i += 1;
        break;
      }
      case '--yt-dlp':
        opts.ytDlpPath = requireValue(argv, i, '--yt-dlp');
        i += 1;
        break;
      case '--ffmpeg':
        opts.ffmpegPath = requireValue(argv, i, '--ffmpeg');
        i += 1;
        break;
      case '--log-level': {
        const level = requireValue(argv, i, '--log-level');
        if (!isLogLevel(level))
          throw new CliError(`--log-level must be one of silent|error|warn|info|debug.`);
        opts.logLevel = level;
        i += 1;
        break;
      }
      default:
        throw new CliError(`Unknown flag: ${String(flag)}`);
    }
  }

  return opts;
}

export const USAGE = `${PACKAGE_NAME} ${VERSION}

  The optional kraken-hub companion: it turns a page URL into a plain video file
  on 127.0.0.1 so the app can download it into its own clip library.

  Usage: npx ${PACKAGE_NAME} [options]

  --port <n>            Port to bind on 127.0.0.1 (default ${String(DEFAULT_PORT)}; 0 = pick a free one)
  --cache-dir <path>    Where clips are kept (default: the OS cache directory)
  --max-cache-gb <n>    LRU eviction ceiling (default ${String(DEFAULT_MAX_CACHE_GB)})
  --token <secret>      Require ?token= / X-Krakenhub-Token on every request
  --max-height <n>      The tallest rendition this companion will produce (default ${String(DEFAULT_MAX_HEIGHT)})
  --yt-dlp <path>       Use this yt-dlp binary instead of downloading one
  --ffmpeg <path>       Use this ffmpeg binary for muxing adaptive formats
  --log-level <level>   silent | error | warn | info | debug (default info)
  --version, --help

  It binds 127.0.0.1 ONLY. Read the security note in the README before you
  install it: any page in your browser can ask a running companion to download
  a video.
`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n\n${USAGE}`);
    return 2;
  }

  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (opts.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const log = createLogger(opts.logLevel);
  await mkdir(opts.cacheDir, { recursive: true });
  const cache = new ClipCache({
    dir: opts.cacheDir,
    maxBytes: opts.maxCacheBytes,
    ttlMs: DEFAULT_TTL_MS,
  });
  await cache.init();

  // The e2e hook: with a fixture path in the environment, the companion runs
  // for real — real HTTP, real cache, real job queue — but never spawns an
  // extractor and never touches the network. Tests and CI use this; nothing
  // else should.
  const stub = process.env['KRAKEN_HUB_RESOLVER_STUB'];
  let downloader: MediaDownloader;
  if (stub !== undefined && stub !== '') {
    const delay = Number(process.env['KRAKEN_HUB_RESOLVER_STUB_DELAY_MS'] ?? '0');
    log.warn(`STUB MODE: serving ${stub} for every resolve. Not for real use.`);
    downloader = createStubDownloader(stub, {
      delayMs: Number.isFinite(delay) ? delay : 0,
      log,
    });
  } else {
    downloader = createYtDlpDownloader({
      cacheDir: opts.cacheDir,
      allowAutoDownload: true,
      log,
      ...(opts.ytDlpPath === undefined ? {} : { binaryPath: opts.ytDlpPath }),
      ...(opts.ffmpegPath === undefined ? {} : { ffmpegPath: opts.ffmpegPath }),
    });
  }

  const app = createResolverServer({
    cache,
    downloader,
    port: opts.port,
    token: opts.token,
    maxHeight: opts.maxHeight,
    version: VERSION,
    log,
  });

  try {
    const port = await app.listen(opts.port);
    log.info(`${PACKAGE_NAME} ${VERSION} listening on http://127.0.0.1:${String(port)}`);
    log.info(`cache: ${opts.cacheDir} (max ${String(opts.maxCacheBytes / GB)} GB)`);
    if (opts.token !== '') log.info('token required on every request');
  } catch (cause) {
    log.error(`could not bind port ${String(opts.port)}: ${String(cause)}`);
    return 1;
  }

  const shutdown = (): void => {
    log.info('shutting down');
    void cache.flush().then(() => app.close());
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return 0;
}

// `import.meta.url` vs argv[1] is the ESM way to ask "was I run, or imported?".
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().then(
    (code) => {
      if (code !== 0) process.exitCode = code;
    },
    (cause: unknown) => {
      process.stderr.write(`${String(cause)}\n`);
      process.exitCode = 1;
    },
  );
}
