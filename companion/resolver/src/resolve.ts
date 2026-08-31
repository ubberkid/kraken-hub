/**
 * URL policy, the rate limiter, and the job queue — everything between "a page
 * asked for a URL" and "there are bytes on disk".
 *
 * The shape of this file is dictated by one sentence in the protocol: *"Answers
 * 202 + `/job` polling while a download is in flight — never blocks a request
 * for minutes."* So `/resolve` does almost nothing: it validates, rate-limits,
 * checks the cache, and otherwise hands the work to a queue two jobs wide and
 * answers `202` immediately.
 *
 * The URL policy is the other half, and it is the security-relevant half.
 * Installing this companion means **any page in the user's browser can ask this
 * machine to download a video** (§5). `validateTargetUrl` is what stops that
 * from also meaning "…or to read this machine's filesystem, or to port-scan its
 * LAN".
 */

import { extname } from 'node:path';

import {
  DEFAULT_RETRY_AFTER_MS,
  HEIGHT_LADDER,
  type ResolverEnvelope,
  type ResolverErr,
  type ResolverErrorCode,
  type ResolverOk,
} from './contract.js';
import { type Logger, silentLogger } from './log.js';
import { type ClipCache } from './cache.js';
import { MediaError, type MediaDownloader } from './ytdlp.js';

// ---------------------------------------------------------------------------
// URL policy (§5)
// ---------------------------------------------------------------------------

export interface UrlRefusal {
  ok: false;
  status: number;
  code: ResolverErrorCode;
  message: string;
}

export type UrlVerdict = { ok: true; url: URL } | UrlRefusal;

/**
 * Schemes that are not "a web page somewhere" but "something on this machine".
 * These get `403 forbidden` rather than `400 unsupported-url`, because the
 * distinction the user needs is *refused on purpose*, not *not implemented*.
 */
const LOCAL_SCHEMES = new Set(['file:', 'data:', 'blob:', 'javascript:', 'ftp:', 'chrome:']);

const LOOPBACK_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  // This is the REFUSAL list, not a bind address: the lint rule below exists to
  // stop the companion *listening* on the wildcard, and a target we refuse to
  // fetch has to be spelled out somewhere.
  '0.0.0.0', // eslint-disable-line no-restricted-syntax -- refused, never bound

  '::',
]);

/** Extensions that are obviously not video. A companion is not a downloader. */
const NON_VIDEO_EXTENSIONS = new Set([
  '.exe',
  '.msi',
  '.dmg',
  '.pkg',
  '.deb',
  '.rpm',
  '.apk',
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.iso',
  '.img',
  '.bin',
  '.sh',
  '.bat',
  '.ps1',
  '.js',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
]);

/** RFC1918 + link-local + CGNAT + `.local`, i.e. "somebody else on this LAN". */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4 === null) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function validateTargetUrl(raw: string | null): UrlVerdict {
  if (raw === null || raw.trim() === '') {
    return { ok: false, status: 400, code: 'unsupported-url', message: 'No url parameter.' };
  }

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, status: 400, code: 'unsupported-url', message: 'That is not a URL.' };
  }

  if (LOCAL_SCHEMES.has(url.protocol)) {
    return {
      ok: false,
      status: 403,
      code: 'forbidden',
      message: `${url.protocol} targets are refused: the companion never reads this machine.`,
    };
  }

  if (url.protocol !== 'https:') {
    return {
      ok: false,
      status: 400,
      code: 'unsupported-url',
      message: 'Only https: page URLs are accepted.',
    };
  }

  if (isPrivateHost(url.hostname)) {
    return {
      ok: false,
      status: 403,
      code: 'forbidden',
      message: 'Loopback and private-network targets are refused.',
    };
  }

  const ext = extname(url.pathname).toLowerCase();
  if (NON_VIDEO_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      status: 400,
      code: 'unsupported-url',
      message: `${ext} is not a video.`,
    };
  }

  return { ok: true, url };
}

// ---------------------------------------------------------------------------
// Rate limiting (§5 — "about 10 resolves/minute")
// ---------------------------------------------------------------------------

export interface RateVerdict {
  allowed: boolean;
  retryAfterMs: number;
}

/** A sliding window, per caller. Small enough to keep exact timestamps. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string): RateVerdict {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => t - at < this.windowMs);
    if (recent.length >= this.max) {
      const oldest = recent[0] ?? t;
      this.hits.set(key, recent);
      return { allowed: false, retryAfterMs: Math.max(1, this.windowMs - (t - oldest)) };
    }
    recent.push(t);
    this.hits.set(key, recent);
    return { allowed: true, retryAfterMs: 0 };
  }
}

// ---------------------------------------------------------------------------
// maxHeight
// ---------------------------------------------------------------------------

const DEFAULT_MAX_HEIGHT = 1080;
const MIN_MAX_HEIGHT = 144;

/** Clamped to what this companion advertises, then snapped down onto the ladder. */
export function normaliseMaxHeight(raw: string | null, cap: number): number {
  const parsed = raw === null ? Number.NaN : Number(raw);
  const wanted = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_HEIGHT;
  const clamped = Math.min(cap, Math.max(MIN_MAX_HEIGHT, Math.floor(wanted)));
  const rungs = [...HEIGHT_LADDER].filter((h) => h <= clamped);
  return rungs.length === 0 ? clamped : (rungs[rungs.length - 1] ?? clamped);
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface ResolveParams {
  url: string | null;
  maxHeight: string | null;
  prefer: string | null;
  audio: string | null;
  /** The rate-limit bucket — the peer address, since we only ever hear loopback. */
  client: string;
}

export interface HttpAnswer {
  status: number;
  body: ResolverEnvelope;
}

export interface ResolveServiceOptions {
  cache: ClipCache;
  downloader: MediaDownloader;
  /** `http://127.0.0.1:<port>`, filled in once the server knows its port. */
  publicBase: () => string;
  /** Appended to `streamUrl`/`thumbUrl` when set, so `/stream` can demand it. */
  token: string;
  maxHeightCap: number;
  concurrency?: number;
  rateLimit?: { max: number; windowMs: number };
  retryAfterMs?: number;
  log?: Logger;
  now?: () => number;
}

type JobState =
  | { state: 'pending' }
  | { state: 'done'; envelope: ResolverOk }
  | { state: 'error'; envelope: ResolverErr; status: number };

interface Job {
  id: string;
  key: string;
  createdAt: number;
  run: () => Promise<void>;
  result: JobState;
}

export const DEFAULT_RATE_LIMIT = { max: 10, windowMs: 60_000 };
export const DEFAULT_CONCURRENCY = 2;
/** How long a settled job stays pollable before it is forgotten. */
export const JOB_RETENTION_MS = 10 * 60_000;

function err(
  status: number,
  code: ResolverErrorCode,
  message: string,
  retryAfterMs?: number,
): HttpAnswer {
  const body: ResolverErr = { status: 'error', code, message };
  if (retryAfterMs !== undefined) body.retryAfterMs = retryAfterMs;
  return { status, body };
}

export class ResolveService {
  private readonly jobs = new Map<string, Job>();
  private readonly byKey = new Map<string, string>();
  private readonly queue: Job[] = [];
  private running = 0;

  private readonly limiter: RateLimiter;
  private readonly concurrency: number;
  private readonly retryAfterMs: number;
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(private readonly opts: ResolveServiceOptions) {
    const rate = opts.rateLimit ?? DEFAULT_RATE_LIMIT;
    this.now = opts.now ?? Date.now;
    this.limiter = new RateLimiter(rate.max, rate.windowMs, this.now);
    this.concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
    this.retryAfterMs = opts.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
    this.log = opts.log ?? silentLogger;
  }

  /** `GET /resolve` — never blocks; either answers from cache or queues a job. */
  resolve(params: ResolveParams): HttpAnswer {
    const rate = this.limiter.take(params.client);
    if (!rate.allowed) {
      return err(429, 'rate-limited', 'Too many resolves; slow down.', rate.retryAfterMs);
    }

    const verdict = validateTargetUrl(params.url);
    if (!verdict.ok) return err(verdict.status, verdict.code, verdict.message);

    const maxHeight = normaliseMaxHeight(params.maxHeight, this.opts.maxHeightCap);
    const prefer = params.prefer === 'any' ? 'any' : 'progressive';
    const audio = params.audio === '1';
    const key = `${verdict.url.toString()}|${String(maxHeight)}|${prefer}|${audio ? '1' : '0'}`;

    const cached = this.opts.cache.findByKey(key);
    if (cached !== null) {
      this.opts.cache.touch(cached.id);
      return { status: 200, body: this.envelopeFor(cached.id) };
    }

    const existingId = this.byKey.get(key);
    const existing = existingId === undefined ? undefined : this.jobs.get(existingId);
    if (existing?.result.state === 'pending') {
      return {
        status: 202,
        body: { status: 'pending', jobId: existing.id, retryAfterMs: this.retryAfterMs },
      };
    }

    const job = this.createJob(key, { url: verdict.url.toString(), maxHeight, prefer, audio });
    return {
      status: 202,
      body: { status: 'pending', jobId: job.id, retryAfterMs: this.retryAfterMs },
    };
  }

  /** `GET /job/<id>` — the same envelope shape as `/resolve`. */
  job(id: string): HttpAnswer {
    this.sweep();
    const job = this.jobs.get(id);
    if (job === undefined) return err(404, 'not-found', 'No such job.');
    if (job.result.state === 'pending') {
      return {
        status: 202,
        body: { status: 'pending', jobId: id, retryAfterMs: this.retryAfterMs },
      };
    }
    if (job.result.state === 'error') {
      return { status: job.result.status, body: job.result.envelope };
    }
    return { status: 200, body: job.result.envelope };
  }

  /** The `ok` envelope for a cached id, rebuilt from the cache record. */
  envelopeFor(id: string): ResolverEnvelope {
    const entry = this.opts.cache.get(id);
    if (entry === null) {
      return { status: 'error', code: 'not-found', message: 'That clip has expired.' };
    }
    const base = this.opts.publicBase();
    const q = this.opts.token === '' ? '' : `?token=${encodeURIComponent(this.opts.token)}`;
    const out: ResolverOk = {
      status: 'ok',
      kind: entry.kind,
      streamUrl: `${base}/stream/${entry.id}.mp4${q}`,
      mime: entry.mime,
      expiresAt: entry.expiresAt,
    };
    if (entry.width !== undefined) out.width = entry.width;
    if (entry.height !== undefined) out.height = entry.height;
    if (entry.fps !== undefined) out.fps = entry.fps;
    if (entry.durationSec !== undefined) out.durationSec = entry.durationSec;
    if (entry.title !== undefined) out.title = entry.title;
    if (entry.thumbFile !== undefined) out.thumbUrl = `${base}/thumb/${entry.id}.jpg${q}`;
    return out;
  }

  /** Pending job count, for `/health` capabilities and for tests. */
  get pending(): number {
    let n = 0;
    for (const job of this.jobs.values()) if (job.result.state === 'pending') n += 1;
    return n;
  }

  get inFlight(): number {
    return this.running;
  }

  private createJob(
    key: string,
    work: { url: string; maxHeight: number; prefer: 'progressive' | 'any'; audio: boolean },
  ): Job {
    // The job id is minted the same way a stream id is — it is handed to a page
    // and must not be guessable by another one.
    const id = this.opts.cache.mintId();
    const job: Job = {
      id,
      key,
      createdAt: this.now(),
      result: { state: 'pending' },
      run: async () => {
        const streamId = this.opts.cache.mintId();
        const destFile = this.opts.cache.pathFor(streamId);
        try {
          const fetched = await this.opts.downloader.fetch({
            url: work.url,
            maxHeight: work.maxHeight,
            audio: work.audio,
            prefer: work.prefer,
            destFile,
          });
          await this.opts.cache.add({
            id: streamId,
            key,
            file: fetched.file,
            mime: fetched.mime,
            bytes: fetched.bytes,
            createdAt: this.now(),
            atime: this.now(),
            expiresAt: this.opts.cache.expiryFromNow(),
            kind: fetched.kind === 'file' ? 'file' : 'progressive',
            ...(fetched.title === undefined ? {} : { title: fetched.title }),
            ...(fetched.width === undefined ? {} : { width: fetched.width }),
            ...(fetched.height === undefined ? {} : { height: fetched.height }),
            ...(fetched.fps === undefined ? {} : { fps: fetched.fps }),
            ...(fetched.durationSec === undefined ? {} : { durationSec: fetched.durationSec }),
          });
          const envelope = this.envelopeFor(streamId);
          job.result =
            envelope.status === 'ok'
              ? { state: 'done', envelope }
              : {
                  state: 'error',
                  status: 500,
                  envelope: { status: 'error', code: 'internal', message: 'The clip vanished.' },
                };
        } catch (cause) {
          const code: ResolverErrorCode =
            cause instanceof MediaError ? cause.code : 'upstream-failed';
          const message =
            cause instanceof Error ? cause.message : 'The extractor failed for an unknown reason.';
          this.log.warn(`resolve failed (${code}):`, message);
          job.result = {
            state: 'error',
            status: code === 'internal' ? 500 : 502,
            envelope: { status: 'error', code, message },
          };
        }
      },
    };

    this.jobs.set(id, job);
    this.byKey.set(key, id);
    this.queue.push(job);
    this.pump();
    return job;
  }

  /** At most `concurrency` extractor processes, ever (§5). */
  private pump(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      if (job === undefined) return;
      this.running += 1;
      void job.run().finally(() => {
        this.running -= 1;
        this.pump();
      });
    }
  }

  private sweep(): void {
    const t = this.now();
    for (const job of [...this.jobs.values()]) {
      if (job.result.state !== 'pending' && t - job.createdAt > JOB_RETENTION_MS) {
        this.jobs.delete(job.id);
        if (this.byKey.get(job.key) === job.id) this.byKey.delete(job.key);
      }
    }
  }
}
