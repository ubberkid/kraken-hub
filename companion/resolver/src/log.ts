/**
 * A logger small enough to have no dependencies and loud enough to debug a
 * companion someone else is running on a machine you cannot see.
 *
 * Everything above `error` goes to stdout; errors and warnings go to stderr, so
 * `kraken-hub-resolver > resolver.log` keeps the useful half and still shows
 * failures in the terminal.
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export const LOG_LEVELS: readonly LogLevel[] = ['silent', 'error', 'warn', 'info', 'debug'];

const RANK: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export interface Logger {
  level: LogLevel;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

function stamp(): string {
  return new Date().toISOString().slice(11, 23);
}

export function createLogger(level: LogLevel = 'info'): Logger {
  const at = RANK[level];
  const emit = (rank: number, stream: NodeJS.WriteStream, tag: string, args: unknown[]): void => {
    if (rank > at) return;
    const text = args
      .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a)))
      .join(' ');
    stream.write(`${stamp()} ${tag} ${text}\n`);
  };
  return {
    level,
    error: (...args) => {
      emit(RANK.error, process.stderr, 'ERR ', args);
    },
    warn: (...args) => {
      emit(RANK.warn, process.stderr, 'WARN', args);
    },
    info: (...args) => {
      emit(RANK.info, process.stdout, 'INFO', args);
    },
    debug: (...args) => {
      emit(RANK.debug, process.stdout, 'DBG ', args);
    },
  };
}

/** For tests and for `--log-level silent`. */
export const silentLogger: Logger = createLogger('silent');
