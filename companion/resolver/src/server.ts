/**
 * The HTTP surface — `node:http`, five routes, **`127.0.0.1` only**.
 *
 * The bind address is the single most important line in this package. A
 * companion listening on `0.0.0.0` is a video-download service for everyone on
 * the network; a companion listening on loopback is a capability the user's own
 * browser has, which is the thing they actually consented to. It is also what
 * makes the whole design work at all: loopback is the one `http:` origin
 * Chromium treats as potentially trustworthy on kraken-hub's HTTPS page.
 *
 * CORS goes on **every** response including errors, `/stream` and `/thumb`
 * (§3) — the app fetches the stream into IndexedDB, and a missing
 * `Access-Control-Expose-Headers` costs it the progress bar's denominator.
 */

import { createReadStream } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import {
  CORS_HEADERS,
  RESOLVER_API_VERSION,
  type ResolverEnvelope,
  type ResolverErr,
  type ResolverErrorCode,
  type ResolverHealth,
} from './contract.js';
import { OPAQUE_ID_RE, type CacheEntry, type ClipCache } from './cache.js';
import { type Logger, silentLogger } from './log.js';
import { ResolveService } from './resolve.js';

import type { MediaDownloader } from './ytdlp.js';

export const LOOPBACK_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8976;
export const DEFAULT_MAX_HEIGHT = 2160;

export interface ResolverServerOptions {
  cache: ClipCache;
  downloader: MediaDownloader;
  port?: number;
  token?: string;
  maxHeight?: number;
  version?: string;
  log?: Logger;
  concurrency?: number;
  rateLimit?: { max: number; windowMs: number };
  retryAfterMs?: number;
  now?: () => number;
}

export interface ResolverServer {
  readonly server: Server;
  readonly service: ResolveService;
  /** The port actually bound — pass `0` to `listen` for an ephemeral one. */
  readonly port: number;
  readonly base: string;
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
}

function writeCors(res: ServerResponse): void {
  for (const [name, value] of Object.entries(CORS_HEADERS)) res.setHeader(name, value);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  writeCors(res);
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(payload)),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendError(
  res: ServerResponse,
  status: number,
  code: ResolverErrorCode,
  message: string,
): void {
  const body: ResolverErr = { status: 'error', code, message };
  sendJson(res, status, body);
}

/** Constant-time, and length-safe: `timingSafeEqual` throws on a length mismatch. */
function tokenMatches(expected: string, given: string | null): boolean {
  if (given === null) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** `bytes=0-`, `bytes=100-199`, `bytes=-500`. Anything else is unsatisfiable. */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | 'invalid' {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return 'invalid';
  const [, rawStart = '', rawEnd = ''] = match;
  if (rawStart === '' && rawEnd === '') return 'invalid';

  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (suffix <= 0) return 'invalid';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === '' ? size - 1 : Number(rawEnd);
  if (start >= size || start > end) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

/** `/stream/<32 hex>.mp4` → the id, or `null` for anything else at all. */
export function opaqueIdFrom(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const id = rest.includes('.') ? rest.slice(0, rest.indexOf('.')) : rest;
  return OPAQUE_ID_RE.test(id) ? id : null;
}

export function createResolverServer(opts: ResolverServerOptions): ResolverServer {
  const log = opts.log ?? silentLogger;
  const token = opts.token ?? '';
  const maxHeight = opts.maxHeight ?? DEFAULT_MAX_HEIGHT;
  const version = opts.version ?? '1.0.0';
  let bound = opts.port ?? DEFAULT_PORT;

  const base = (): string => `http://${LOOPBACK_HOST}:${String(bound)}`;

  const service = new ResolveService({
    cache: opts.cache,
    downloader: opts.downloader,
    publicBase: base,
    token,
    maxHeightCap: maxHeight,
    log,
    ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
    ...(opts.rateLimit === undefined ? {} : { rateLimit: opts.rateLimit }),
    ...(opts.retryAfterMs === undefined ? {} : { retryAfterMs: opts.retryAfterMs }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });

  function serveFile(req: IncomingMessage, res: ServerResponse, entry: CacheEntry): void {
    const size = entry.bytes;
    const range = parseRange(req.headers.range, size);
    writeCors(res);
    opts.cache.touch(entry.id);

    if (range === 'invalid') {
      res.writeHead(416, {
        'Content-Range': `bytes */${String(size)}`,
        'Content-Type': 'application/json; charset=utf-8',
      });
      res.end(JSON.stringify({ status: 'error', code: 'not-found', message: 'Bad range.' }));
      return;
    }

    if (range === null) {
      res.writeHead(200, { 'Content-Type': entry.mime, 'Content-Length': String(size) });
      createReadStream(entry.file).pipe(res);
      return;
    }

    res.writeHead(206, {
      'Content-Type': entry.mime,
      'Content-Range': `bytes ${String(range.start)}-${String(range.end)}/${String(size)}`,
      'Content-Length': String(range.end - range.start + 1),
    });
    createReadStream(entry.file, { start: range.start, end: range.end }).pipe(res);
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', base());
    const path = url.pathname;

    // Preflight, before anything else, and without a token: a browser cannot
    // put a header on a preflight, so demanding one here would deadlock CORS.
    if (req.method === 'OPTIONS') {
      writeCors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, 'unsupported-url', 'Only GET is supported.');
      return;
    }

    if (token !== '') {
      const header = req.headers['x-krakenhub-token'];
      const given = typeof header === 'string' ? header : (url.searchParams.get('token') ?? null);
      if (!tokenMatches(token, given)) {
        // 401 with the contract's `forbidden` code: the enum is closed, and
        // "you did not authenticate" is the closest member of it.
        sendError(res, 401, 'forbidden', 'A resolver token is required.');
        return;
      }
    }

    if (path === '/health') {
      const health: ResolverHealth = {
        ok: true,
        name: 'kraken-hub-resolver',
        version,
        api: RESOLVER_API_VERSION,
        capabilities: ['resolve', 'stream', 'probe'],
        maxHeight,
      };
      sendJson(res, 200, health);
      return;
    }

    if (path === '/resolve') {
      const answer = service.resolve({
        url: url.searchParams.get('url'),
        maxHeight: url.searchParams.get('maxHeight'),
        prefer: url.searchParams.get('prefer'),
        audio: url.searchParams.get('audio'),
        client: req.socket.remoteAddress ?? 'unknown',
      });
      log.debug('resolve', String(answer.status), url.searchParams.get('url') ?? '');
      sendJson(res, answer.status, answer.body);
      return;
    }

    if (path.startsWith('/job/')) {
      const id = decodeURIComponent(path.slice('/job/'.length));
      const answer = service.job(id);
      sendJson(res, answer.status, answer.body);
      return;
    }

    if (path.startsWith('/stream/')) {
      const id = opaqueIdFrom(path, '/stream/');
      // A caller-supplied path is never a file path here: only ids this
      // process minted resolve to anything. That is the "never a general
      // proxy" rule, enforced rather than promised.
      const entry = id === null ? null : opts.cache.get(id);
      if (entry === null) {
        sendError(res, 404, 'not-found', 'No such stream.');
        return;
      }
      serveFile(req, res, entry);
      return;
    }

    if (path.startsWith('/thumb/')) {
      const id = opaqueIdFrom(path, '/thumb/');
      const entry = id === null ? null : opts.cache.get(id);
      if (entry?.thumbFile === undefined) {
        sendError(res, 404, 'not-found', 'No such thumbnail.');
        return;
      }
      writeCors(res);
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      createReadStream(entry.thumbFile).pipe(res);
      return;
    }

    sendError(res, 404, 'not-found', 'No such endpoint.');
  });

  return {
    server,
    service,
    get port() {
      return bound;
    },
    get base() {
      return base();
    },
    listen(port = opts.port ?? DEFAULT_PORT) {
      return new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        // LOOPBACK ONLY. Never 0.0.0.0, never an interface address.
        server.listen(port, LOOPBACK_HOST, () => {
          const address = server.address();
          bound = typeof address === 'object' && address !== null ? address.port : port;
          server.removeListener('error', reject);
          resolve(bound);
        });
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

/** Exported for tests that want to assert on the envelope union directly. */
export type { ResolverEnvelope };
