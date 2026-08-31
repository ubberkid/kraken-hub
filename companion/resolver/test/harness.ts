import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ClipCache } from '../src/cache.js';
import { createResolverServer, type ResolverServer } from '../src/server.js';
import { createStubDownloader, type MediaDownloader } from '../src/ytdlp.js';

/**
 * The real server, on an ephemeral port, with the extractor injected.
 *
 * The fixture is the app's own `public/demo/demo.mp4` — the same 32 KB clip the
 * web app ships — so "what yt-dlp downloaded" is a real mp4 with a real length,
 * and Range assertions are assertions about bytes rather than about a mock.
 */
export const FIXTURE = fileURLToPath(new URL('../../../public/demo/demo.mp4', import.meta.url));

export const SAMPLE_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

export interface Harness {
  app: ResolverServer;
  cache: ClipCache;
  base: string;
  dir: string;
  stop(): Promise<void>;
}

export interface HarnessOptions {
  token?: string;
  downloader?: MediaDownloader;
  delayMs?: number;
  maxBytes?: number;
  ttlMs?: number;
  rateLimit?: { max: number; windowMs: number };
  retryAfterMs?: number;
  concurrency?: number;
  now?: () => number;
}

export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'kh-resolver-test-'));
  const cache = new ClipCache({
    dir,
    maxBytes: opts.maxBytes ?? 64 * 1024 * 1024,
    ttlMs: opts.ttlMs ?? 60_000,
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
  await cache.init();

  const app = createResolverServer({
    cache,
    downloader:
      opts.downloader ??
      createStubDownloader(FIXTURE, opts.delayMs === undefined ? {} : { delayMs: opts.delayMs }),
    version: '1.0.0-test',
    ...(opts.token === undefined ? {} : { token: opts.token }),
    ...(opts.rateLimit === undefined ? {} : { rateLimit: opts.rateLimit }),
    ...(opts.retryAfterMs === undefined ? {} : { retryAfterMs: opts.retryAfterMs }),
    ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
  await app.listen(0);

  return {
    app,
    cache,
    dir,
    base: app.base,
    async stop() {
      await app.close();
      await cache.flush();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Polls `/resolve` → `/job` the way the browser client does, and returns the settled envelope. */
export async function settle(
  base: string,
  query: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  // The token, if the caller put one in the query, has to travel on the /job
  // polls too — exactly as the browser client does it.
  const token = new URLSearchParams(query).get('token');
  const suffix = token === null ? '' : `?token=${encodeURIComponent(token)}`;

  let res = await fetch(`${base}/resolve?${query}`, init);
  let body = (await res.json()) as Record<string, unknown>;
  const deadline = Date.now() + 15_000;

  while (body['status'] === 'pending' && Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 25));
    res = await fetch(`${base}/job/${String(body['jobId'])}${suffix}`, init);
    body = (await res.json()) as Record<string, unknown>;
  }
  return { status: res.status, body };
}
