import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CliError, DEFAULT_MAX_CACHE_GB, defaultCacheDir, parseArgs } from '../src/cli.js';
import { DEFAULT_PORT } from '../src/server.js';

const GB = 1024 * 1024 * 1024;

describe('flag parsing', () => {
  it('defaults to the contract port and a 4 GB cache in the OS cache directory', () => {
    const opts = parseArgs([], {});
    expect(opts.port).toBe(DEFAULT_PORT);
    expect(opts.port).toBe(8976);
    expect(opts.maxCacheBytes).toBe(DEFAULT_MAX_CACHE_GB * GB);
    expect(opts.token).toBe('');
    expect(opts.cacheDir).toContain('kraken-hub-resolver');
  });

  it('reads every documented flag', () => {
    const opts = parseArgs(
      [
        '--port',
        '9999',
        '--cache-dir',
        '/tmp/clips',
        '--token',
        'sekrit',
        '--max-cache-gb',
        '0.5',
        '--yt-dlp',
        '/usr/local/bin/yt-dlp',
        '--log-level',
        'debug',
      ],
      {},
    );
    expect(opts).toMatchObject({
      port: 9999,
      cacheDir: '/tmp/clips',
      token: 'sekrit',
      maxCacheBytes: GB / 2,
      ytDlpPath: '/usr/local/bin/yt-dlp',
      logLevel: 'debug',
    });
  });

  it('accepts --port 0, which is how the e2e suite gets a free port', () => {
    expect(parseArgs(['--port', '0'], {}).port).toBe(0);
  });

  it('rejects nonsense rather than starting with a surprising default', () => {
    expect(() => parseArgs(['--port', '70000'], {})).toThrow(CliError);
    expect(() => parseArgs(['--port'], {})).toThrow(CliError);
    expect(() => parseArgs(['--max-cache-gb', '-2'], {})).toThrow(CliError);
    expect(() => parseArgs(['--log-level', 'loud'], {})).toThrow(CliError);
    expect(() => parseArgs(['--bind', '0.0.0.0'], {})).toThrow(/Unknown flag/);
  });

  it('takes a token from the environment so it need not appear in `ps`', () => {
    expect(parseArgs([], { KRAKEN_HUB_RESOLVER_TOKEN: 'from-env' }).token).toBe('from-env');
  });
});

describe('the default cache directory', () => {
  /**
   * The platform argument selects the *convention* (which directories to nest),
   * but `defaultCacheDir` assembles the result with `node:path`'s `join`, which
   * always emits the **host's** separator. So every expectation here is built
   * with the same `join` rather than with a literal `/` — otherwise the suite
   * passes on macOS and fails on the Windows runner for a reason that has
   * nothing to do with the code under test.
   */
  it('follows each platform’s convention', () => {
    expect(defaultCacheDir('darwin', {})).toBe(
      join(homedir(), 'Library', 'Caches', 'kraken-hub-resolver'),
    );
    expect(defaultCacheDir('win32', { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' })).toBe(
      join('C:\\Users\\x\\AppData\\Local', 'kraken-hub-resolver', 'Cache'),
    );
    expect(defaultCacheDir('linux', { XDG_CACHE_HOME: '/xdg' })).toBe(
      join('/xdg', 'kraken-hub-resolver'),
    );
    expect(defaultCacheDir('linux', {})).toBe(join(homedir(), '.cache', 'kraken-hub-resolver'));
  });
});
