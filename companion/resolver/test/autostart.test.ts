import { describe, expect, it } from 'vitest';

import {
  AUTOSTART_REG_KEY,
  AUTOSTART_VALUE_NAME,
  AutostartError,
  autostartCommandLine,
  installCommand,
  isStandaloneExecutable,
  uninstallCommand,
} from '../src/autostart.js';
import { banner, parseArgs } from '../src/cli.js';

/**
 * These tests build `reg.exe` command lines and never run one. That is the
 * whole point of keeping construction in a pure module: the registry write is
 * the part nobody can inspect after the fact, so its argv is asserted here
 * rather than discovered on someone's machine.
 */
describe('the autostart flags', () => {
  it('parses --install-autostart and --uninstall-autostart', () => {
    expect(parseArgs(['--install-autostart'], {})).toMatchObject({
      installAutostart: true,
      uninstallAutostart: false,
    });
    expect(parseArgs(['--uninstall-autostart'], {})).toMatchObject({
      installAutostart: false,
      uninstallAutostart: true,
    });
  });

  it('defaults both to false, so a plain launch only ever starts the server', () => {
    expect(parseArgs([], {})).toMatchObject({
      installAutostart: false,
      uninstallAutostart: false,
    });
  });

  it('still rejects a near-miss rather than silently ignoring it', () => {
    expect(() => parseArgs(['--autostart'], {})).toThrow(/Unknown flag/);
  });
});

describe('working out what to start', () => {
  it('recognises the standalone exe by its own name', () => {
    expect(isStandaloneExecutable('C:\\Users\\x\\kraken-hub-resolver-win-x64.exe')).toBe(true);
    expect(isStandaloneExecutable('/Users/x/kraken-hub-resolver-macos-arm64')).toBe(true);
  });

  it('recognises a plain node interpreter, case and extension insensitively', () => {
    expect(isStandaloneExecutable('C:\\Program Files\\nodejs\\node.exe')).toBe(false);
    expect(isStandaloneExecutable('C:\\Program Files\\nodejs\\NODE.EXE')).toBe(false);
    expect(isStandaloneExecutable('/usr/local/bin/node')).toBe(false);
  });

  it('registers the exe alone when it is the standalone build', () => {
    expect(autostartCommandLine('C:\\Tools\\kraken-hub-resolver-win-x64.exe', undefined)).toBe(
      '"C:\\Tools\\kraken-hub-resolver-win-x64.exe"',
    );
  });

  it('registers interpreter + script when running from a clone', () => {
    expect(
      autostartCommandLine('C:\\Program Files\\nodejs\\node.exe', 'C:\\src\\dist\\cli.js'),
    ).toBe('"C:\\Program Files\\nodejs\\node.exe" "C:\\src\\dist\\cli.js"');
  });

  it('quotes both paths, because Program Files is the common case', () => {
    const line = autostartCommandLine(
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\My Files\\cli.js',
    );
    expect(line.startsWith('"')).toBe(true);
    expect(line).toContain('" "');
  });

  it('refuses rather than registering a half-command it cannot start', () => {
    expect(() => autostartCommandLine('C:\\nodejs\\node.exe', undefined)).toThrow(AutostartError);
    expect(() => autostartCommandLine('C:\\nodejs\\node.exe', '')).toThrow(AutostartError);
  });
});

describe('the reg.exe command lines', () => {
  it('writes a REG_SZ under the per-user Run key, overwriting silently', () => {
    const command = installCommand('"C:\\Tools\\kraken-hub-resolver-win-x64.exe"');
    expect(command.file).toBe('reg.exe');
    expect(command.args).toEqual([
      'add',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      '/v',
      'KrakenHubResolver',
      '/t',
      'REG_SZ',
      '/d',
      '"C:\\Tools\\kraken-hub-resolver-win-x64.exe"',
      '/f',
    ]);
  });

  it('targets HKCU, never HKLM: autostart must never need elevation', () => {
    expect(AUTOSTART_REG_KEY.startsWith('HKCU\\')).toBe(true);
    expect(AUTOSTART_REG_KEY).not.toContain('HKLM');
  });

  it('deletes exactly the value it created', () => {
    const command = uninstallCommand();
    expect(command.file).toBe('reg.exe');
    expect(command.args).toEqual(['delete', AUTOSTART_REG_KEY, '/v', AUTOSTART_VALUE_NAME, '/f']);
  });

  it('keeps the command line as one argv entry, so no shell ever sees it', () => {
    const command = installCommand('"C:\\a b\\x.exe" --port 8976');
    expect(command.args.filter((a) => a.includes('x.exe'))).toHaveLength(1);
  });
});

describe('the startup banner', () => {
  it('tells the reader the port, that nothing needs configuring, and what is next', () => {
    const text = banner(8976);
    expect(text).toContain('http://127.0.0.1:8976');
    expect(text).toContain('kraken-hub will detect this automatically');
    expect(text).toContain('--install-autostart');
  });
});
