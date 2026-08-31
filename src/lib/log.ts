/**
 * Ring-buffered logger.
 *
 * The display page runs unattended for weeks on a panel nobody can read, so
 * every log line has to survive somewhere a human can retrieve it later: the
 * ring buffer is surfaced by the debug overlay and by the diagnostics report.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface LogEntry {
  at: number;
  level: LogLevel;
  scope: string;
  msg: string;
  detail?: string;
}

export interface Logger {
  error(msg: string, detail?: unknown): void;
  warn(msg: string, detail?: unknown): void;
  info(msg: string, detail?: unknown): void;
  debug(msg: string, detail?: unknown): void;
}

const RING_SIZE = 64;
const ring: LogEntry[] = [];

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
let threshold: LogLevel = 'info';

/** Raise or lower the console threshold. The ring buffer always records everything. */
export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

/** Newest-last snapshot of the ring buffer. */
export function logRing(): readonly LogEntry[] {
  return ring.slice();
}

function describe(detail: unknown): string | undefined {
  if (detail === undefined) return undefined;
  if (detail instanceof Error) return `${detail.name}: ${detail.message}`;
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return Object.prototype.toString.call(detail);
  }
}

function record(level: LogLevel, scope: string, msg: string, detail: unknown): void {
  const described = describe(detail);
  const entry: LogEntry = { at: Date.now(), level, scope, msg };
  if (described !== undefined) entry.detail = described;
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
  if (ORDER[level] > ORDER[threshold]) return;
  const line = `[kraken-hub:${scope}] ${msg}`;
  if (level === 'error') console.error(line, detail ?? '');
  else if (level === 'warn') console.warn(line, detail ?? '');
  else console.log(line, detail ?? '');
}

/** A logger bound to a subsystem name, e.g. `createLogger('platform/nzxt')`. */
export function createLogger(scope: string): Logger {
  return {
    error: (msg, detail) => {
      record('error', scope, msg, detail);
    },
    warn: (msg, detail) => {
      record('warn', scope, msg, detail);
    },
    info: (msg, detail) => {
      record('info', scope, msg, detail);
    },
    debug: (msg, detail) => {
      record('debug', scope, msg, detail);
    },
  };
}
