/**
 * The one test that runs the REAL extractor against the REAL internet.
 *
 * Everything in `test/` injects `createStubDownloader`, which is the right call
 * for a suite every pull request has to pass: it makes the contract assertions
 * deterministic and keeps CI off the network. But it also means the program
 * that ships — `createYtDlpDownloader` — is only ever exercised at the level of
 * its argv construction. Three things can therefore rot without any test
 * noticing, and all three are things the browser depends on:
 *
 *  1. **yt-dlp's own interface.** `-J`, `--merge-output-format`, the format
 *     selector syntax, the shape of the JSON `-J` prints. Upstream moves.
 *  2. **The mime the companion promises.** `createYtDlpDownloader` hard-codes
 *     `mime: 'video/mp4'` for every fetch. If the selector or the remux path
 *     ever leaves a WebM in the cache, the companion is lying to a `<video>`
 *     element about what it is being handed — which fails on the panel, at
 *     playback time, with no diagnostic. So the assertion here is on the
 *     container's MAGIC BYTES, not on the header the server echoed back.
 *  3. **`/resolve` → `202` → `/job` → `/stream`.** The stub settles in
 *     milliseconds; a real extraction takes tens of seconds, which is the only
 *     way to exercise the pending-job path at its real timescale.
 *
 *     npm run test:live
 *
 * It is opt-in twice over: this file is not in `vitest.config.ts`'s `include`,
 * so an ordinary `npm test` never loads it, AND every case is gated on
 * `KRAKEN_HUB_LIVE=1`.
 *
 * ## It never installs anything
 *
 * `allowAutoDownload` is `false` and the binary is located on PATH. If yt-dlp
 * (or ffmpeg, which the mp4 remux needs) is missing, the test SKIPS with a
 * message saying so. A test that silently downloads a 30 MB binary from GitHub
 * to make itself pass is not a test.
 *
 * ## The fixture
 *
 * A 12-second CC-BY-SA clip on Wikimedia Commons — small, stable, properly
 * licensed, and served by an organisation that does not mind being fetched.
 * Override it with `KRAKEN_HUB_LIVE_URL` if it ever goes away.
 */

import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ClipCache, OPAQUE_ID_RE } from '../src/cache.js';
import { RESOLVER_ERROR_CODES } from '../src/contract.js';
import { createResolverServer, type ResolverServer } from '../src/server.js';
import { createYtDlpDownloader } from '../src/ytdlp.js';

const LIVE = process.env['KRAKEN_HUB_LIVE'] === '1';

/** 12 s, CC BY-SA 3.0, ~13 MB at source; the 480p rendition is ~1 MB. */
const DEFAULT_URL = 'https://commons.wikimedia.org/wiki/File:Schlossbergbahn.webm';
const TARGET_URL = process.env['KRAKEN_HUB_LIVE_URL'] ?? DEFAULT_URL;
const MAX_HEIGHT = 480;

/** Locate a tool on PATH without ever installing one. */
function onPath(name: string): string | null {
  const env = process.env['KRAKEN_HUB_YTDLP'];
  if (name === 'yt-dlp' && env !== undefined && env !== '') return env;
  const which = process.platform === 'win32' ? 'where' : 'which';
  const found = spawnSync(which, [name], { encoding: 'utf8', shell: false });
  const first = found.stdout.split('\n')[0]?.trim();
  return found.status === 0 && first !== undefined && first !== '' ? first : null;
}

const YTDLP = LIVE ? onPath('yt-dlp') : null;
const FFMPEG = LIVE ? onPath('ffmpeg') : null;

const MISSING = [YTDLP === null ? 'yt-dlp' : null, FFMPEG === null ? 'ffmpeg' : null]
  .filter((n) => n !== null)
  .join(' and ');

const SKIP_NOTE =
  `${MISSING} is not installed. This test deliberately does NOT download one — ` +
  'install it (brew install yt-dlp ffmpeg) or point KRAKEN_HUB_YTDLP at a binary, then re-run.';

/** Polls `/resolve` → `/job` exactly as `resolverClient.ts` does in the browser. */
async function settle(base: string, url: string): Promise<Record<string, unknown>> {
  const query = `url=${encodeURIComponent(url)}&maxHeight=${String(MAX_HEIGHT)}&prefer=any&audio=1`;
  let res = await fetch(`${base}/resolve?${query}`);
  let body = (await res.json()) as Record<string, unknown>;

  // The whole point of the pending path: a real extraction does not fit in one
  // request, so the first answer must be a 202 with a job id.
  expect(res.status).toBe(202);
  expect(body['status']).toBe('pending');
  expect(typeof body['jobId']).toBe('string');

  const deadline = Date.now() + 240_000;
  while (body['status'] === 'pending' && Date.now() < deadline) {
    const wait = typeof body['retryAfterMs'] === 'number' ? body['retryAfterMs'] : 1500;
    await new Promise<void>((r) => setTimeout(r, wait));
    res = await fetch(`${base}/job/${String(body['jobId'])}`);
    body = (await res.json()) as Record<string, unknown>;
  }
  return body;
}

describe.skipIf(!LIVE)('yt-dlp, for real', () => {
  let dir = '';
  let cache: ClipCache;
  let app: ResolverServer | null = null;

  beforeAll(async () => {
    if (YTDLP === null || FFMPEG === null) return;
    dir = await mkdtemp(join(tmpdir(), 'kh-resolver-live-'));
    cache = new ClipCache({ dir, maxBytes: 256 * 1024 * 1024, ttlMs: 600_000 });
    await cache.init();
    app = createResolverServer({
      cache,
      downloader: createYtDlpDownloader({
        cacheDir: dir,
        binaryPath: YTDLP,
        ffmpegPath: FFMPEG,
        // The line that keeps this test honest: it uses the tool you already
        // have, or it skips. It never installs one.
        allowAutoDownload: false,
      }),
      version: '1.0.0-live',
    });
    await app.listen(0);
  });

  afterAll(async () => {
    await app?.close();
    if (dir !== '') await rm(dir, { recursive: true, force: true });
  });

  it('resolves a real URL through 202 → /job and lands a playable mp4 in the cache', async (ctx) => {
    if (YTDLP === null || FFMPEG === null || app === null) {
      ctx.skip(SKIP_NOTE);
      return;
    }
    const base = app.base;

    const body = await settle(base, TARGET_URL);

    expect(body['status'], `resolver said: ${JSON.stringify(body)}`).toBe('ok');
    expect(body['kind']).toBe('progressive');
    expect(body['mime']).toBe('video/mp4');
    // The id is opaque and minted from random bytes — never derived from the
    // URL, which would leak it to anyone who can see the stream path.
    const streamUrl = String(body['streamUrl']);
    expect(streamUrl.startsWith(`${base}/stream/`)).toBe(true);
    expect(OPAQUE_ID_RE.test(streamUrl.slice(streamUrl.lastIndexOf('/') + 1))).toBe(true);

    // ── The cache entry, and what is actually in it ────────────────────────
    const entries = cache.list();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.bytes).toBeGreaterThan(1024);

    const head = await readFile(entry.file);
    expect(head.length).toBe(entry.bytes);
    // ISO base media file format: `....ftyp` at offset 4. The companion tells
    // every browser `video/mp4`, so anything else here is a lie that only shows
    // up as a black panel.
    expect(head.subarray(4, 8).toString('ascii')).toBe('ftyp');

    // ── And it is genuinely servable, ranges and all ───────────────────────
    const whole = await fetch(streamUrl);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(Number(whole.headers.get('content-length'))).toBe(entry.bytes);
    expect(whole.headers.get('content-type')).toBe('video/mp4');
    await whole.arrayBuffer();

    const ranged = await fetch(streamUrl, { headers: { Range: 'bytes=0-99' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe(`bytes 0-99/${String(entry.bytes)}`);
    const first100 = Buffer.from(await ranged.arrayBuffer());
    expect(first100.length).toBe(100);
    // The bytes the browser would seek to are the bytes on disk, not a re-read
    // of the upstream URL.
    expect(first100.equals(head.subarray(0, 100))).toBe(true);
  });

  it('reports a closed-enum error for an unresolvable URL rather than crashing', async (ctx) => {
    if (YTDLP === null || FFMPEG === null || app === null) {
      ctx.skip(SKIP_NOTE);
      return;
    }
    // A real yt-dlp failure, classified by the real `classifyStderr`.
    const body = await settle(
      app.base,
      'https://commons.wikimedia.org/wiki/File:Does_Not_Exist_kraken_hub.webm',
    );
    expect(body['status']).toBe('error');
    expect(typeof body['code']).toBe('string');
    expect(RESOLVER_ERROR_CODES as readonly string[]).toContain(body['code']);
  });
});
