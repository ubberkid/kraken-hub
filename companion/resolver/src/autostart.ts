/**
 * "Start with Windows", without a native dependency.
 *
 * The companion ships as a single standalone `.exe` and CAM is a Windows-only
 * product, so autostart is a Windows-only feature. The mechanism is the plainest
 * one Windows offers: a string value under the per-user Run key, written with
 * the `reg.exe` that has shipped in every Windows since NT. No COM, no shortcut
 * (.lnk) parsing, no elevation — `HKCU` is the current user's own hive, so this
 * never prompts for admin.
 *
 * Everything here is pure: the module builds argument vectors and returns them.
 * Actually spawning `reg.exe` happens in the CLI, which means the command
 * construction — the part that is easy to get wrong and impossible to see once
 * it has run — is unit-testable without ever touching a real registry.
 */

/** The per-user "run at logon" key. Per-user, so no elevation is ever needed. */
export const AUTOSTART_REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

/** The value name we own under that key. Stable: uninstall must find it again. */
export const AUTOSTART_VALUE_NAME = 'KrakenHubResolver';

export interface RegCommand {
  readonly file: string;
  readonly args: readonly string[];
}

/**
 * Is this process the standalone single-executable build, or `node script.js`?
 *
 * Asked by looking at the executable's own name rather than by importing
 * `node:sea`, because that keeps the answer a pure function of a string and so
 * keeps it testable on a machine that is not Windows and not a SEA.
 *
 * The last path segment is found by hand, splitting on **both** separators:
 * `node:path`'s `basename` follows the host platform, so on a Mac it would read
 * `C:\nodejs\node.exe` as one long filename and these tests would pass for the
 * wrong reason while the Windows behaviour went unchecked.
 */
export function isStandaloneExecutable(execPath: string): boolean {
  const segments = execPath.split(/[\\/]/);
  const name = (segments[segments.length - 1] ?? '').toLowerCase().replace(/\.exe$/, '');
  return name !== 'node' && name !== 'node_g';
}

/**
 * The command line Windows should run at logon.
 *
 * For the standalone exe that is the exe itself. For a `node dist/cli.js`
 * checkout it is both paths, because the script alone is not executable. Each
 * path is quoted: `C:\Program Files\…` is the common case, not the exotic one.
 */
export function autostartCommandLine(execPath: string, scriptPath: string | undefined): string {
  if (isStandaloneExecutable(execPath)) return `"${execPath}"`;
  if (scriptPath === undefined || scriptPath === '') {
    throw new AutostartError('Cannot work out what to start: no script path on argv[1].');
  }
  return `"${execPath}" "${scriptPath}"`;
}

export class AutostartError extends Error {}

/** `reg add …` — the exact argv, ready to hand to `spawnSync`. */
export function installCommand(commandLine: string): RegCommand {
  return {
    file: 'reg.exe',
    args: [
      'add',
      AUTOSTART_REG_KEY,
      '/v',
      AUTOSTART_VALUE_NAME,
      '/t',
      'REG_SZ',
      '/d',
      commandLine,
      // Overwrite silently: re-running --install-autostart after moving the exe
      // should fix the entry, not ask a question no one is there to answer.
      '/f',
    ],
  };
}

/** `reg delete …` — idempotent enough that a missing value is not an error we raise. */
export function uninstallCommand(): RegCommand {
  return {
    file: 'reg.exe',
    args: ['delete', AUTOSTART_REG_KEY, '/v', AUTOSTART_VALUE_NAME, '/f'],
  };
}

/** What to say on macOS and Linux, where this feature deliberately does not exist. */
export const UNSUPPORTED_PLATFORM_MESSAGE =
  'Autostart is Windows-only (CAM is a Windows product). On this platform, start the companion yourself — or add it to your login items / systemd user units.';
