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
 *  2. **The mime the companion promises.** `createYtDlpDownloader` reads it off
 *     the file's own first bytes. If the selector or the remux path ever leaves
 *     a WebM in the cache, the companion must say so rather than tell a
 *     `<video>` element it is being handed an mp4 — a lie that fails on the
 *     panel, at playback time, with no diagnostic. So the assertions here are on
 *     the container's MAGIC BYTES, not on the header the server echoed back.
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
 * `allowAutoDownload` is `false` and the binary is located on PATH. If yt-dlp is
 * missing, the test SKIPS with a message saying so. A test that silently
 * downloads a 30 MB binary from GitHub to make itself pass is not a test.
 *
 * **ffmpeg is no longer required to run this.** It used to be, because the
 * companion needed it to produce anything at all above 360p. That was the bug:
 * a user without ffmpeg got `Requested format is not available` rather than a
 * lower-quality file. The ladder now has a no-ffmpeg branch, so this suite runs
 * either way — and when ffmpeg *is* absent, it is asserting exactly the path the
 * bug report came from.
 *
 * ## The fixtures
 *
 * A 12-second CC-BY-SA clip on Wikimedia Commons — small, stable, properly
 * licensed, and served by an organisation that does not mind being fetched.
 * Override it with `KRAKEN_HUB_LIVE_URL` if it ever goes away.
 *
 * And, for the ladder itself, a YouTube URL — because Wikimedia serves a single
 * muxed file and therefore cannot reproduce the failure at all. YouTube's
 * adaptive-only format list is the whole reason this ladder exists, so the one
 * assertion that would have caught the shipped bug has to be made against
 * YouTube. That case only ever runs `--simulate`: it resolves formats, it does
 * not download.
 */

import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ClipCache, OPAQUE_ID_RE } from '../src/cache.js';
import { RESOLVER_ERROR_CODES } from '../src/contract.js';
import { run } from '../src/exec.js';
import { createResolverServer, type ResolverServer } from '../src/server.js';
import { createYtDlpDownloader, formatSelector, sniffContainerMime } from '../src/ytdlp.js';

const LIVE = process.env['KRAKEN_HUB_LIVE'] === '1';

/** 12 s, CC BY-SA 3.0, ~13 MB at source; the 480p rendition is ~1 MB. */
const DEFAULT_URL = 'https://commons.wikimedia.org/wiki/File:Schlossbergbahn.webm';
const TARGET_URL = process.env['KRAKEN_HUB_LIVE_URL'] ?? DEFAULT_URL;
const MAX_HEIGHT = 480;

/** Caminandes 3: Llamigos — Blender, CC-BY, 1920×1080, 2m30s, and adaptive-only. */
const ADAPTIVE_URL =
  process.env['KRAKEN_HUB_LIVE_ADAPTIVE_URL'] ?? 'https://www.youtube.com/watch?v=SkVqJ1SGeL0';

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

const SKIP_NOTE =
  'yt-dlp is not installed. This test deliberately does NOT download one — ' +
  'install it (brew install yt-dlp) or point KRAKEN_HUB_YTDLP at a binary, then re-run.';

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
    if (YTDLP === null) return;
    dir = await mkdtemp(join(tmpdir(), 'kh-resolver-live-'));
    cache = new ClipCache({ dir, maxBytes: 256 * 1024 * 1024, ttlMs: 600_000 });
    await cache.init();
    app = createResolverServer({
      cache,
      downloader: createYtDlpDownloader({
        cacheDir: dir,
        binaryPath: YTDLP,
        // Passed when this machine has one, omitted when it does not — so the
        // suite exercises whichever branch of the ladder the machine can reach.
        ...(FFMPEG === null ? {} : { ffmpegPath: FFMPEG }),
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
    if (YTDLP === null || app === null) {
      ctx.skip(SKIP_NOTE);
      return;
    }
    const base = app.base;

    const body = await settle(base, TARGET_URL);

    expect(body['status'], `resolver said: ${JSON.stringify(body)}`).toBe('ok');
    expect(body['kind']).toBe('progressive');
    // NOT hard-coded to `video/mp4`, and this fixture is why. Wikimedia's only
    // rendition is a WebM, and `--merge-output-format mp4` governs *merges* —
    // a single-format download is written through untouched, so the file behind
    // the `.mp4` name is a Matroska. The companion used to promise `video/mp4`
    // for it anyway. Chromium sniffs and copes; not every decoder does, and a
    // companion that misdescribes its own cache has no way to be debugged.
    expect(['video/mp4', 'video/webm']).toContain(body['mime']);
    // The height the companion reports is now the height it actually got, not
    // the source's — so it has to be there, and it has to be plausible.
    expect(typeof body['height'], `no height in ${JSON.stringify(body)}`).toBe('number');
    expect(Number(body['height'])).toBeGreaterThan(0);
    // The id is opaque and minted from random bytes — never derived from the
    // URL, which would leak it to anyone who can see the stream path.
    const streamUrl = String(body['streamUrl']);
    expect(streamUrl.startsWith(`${base}/stream/`)).toBe(true);
    // `/stream/<id>.mp4` — the extension is there for the browser's benefit and
    // is not part of the id, so it has to come off before the id is checked.
    const streamId = streamUrl.slice(streamUrl.lastIndexOf('/') + 1).replace(/\.[a-z0-9]+$/i, '');
    expect(OPAQUE_ID_RE.test(streamId), `not an opaque id: ${streamId}`).toBe(true);

    // ── The cache entry, and what is actually in it ────────────────────────
    const entries = cache.list();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.bytes).toBeGreaterThan(1024);

    const head = await readFile(entry.file);
    expect(head.length).toBe(entry.bytes);
    // The assertion that matters: whatever the container turned out to be, the
    // mime the companion hands the browser is *derived from these bytes*, so the
    // two cannot disagree. A hard-coded mime is exactly the failure this catches
    // — it shows up only at playback time, on the panel, with no diagnostic.
    const magic = head.subarray(0, 16);
    expect(entry.mime).toBe(sniffContainerMime(magic));
    expect(body['mime']).toBe(entry.mime);
    if (entry.mime === 'video/mp4') {
      expect(magic.subarray(4, 8).toString('ascii')).toBe('ftyp'); // ISO base media
    } else {
      expect([...magic.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]); // EBML
    }

    // ── And it is genuinely servable, ranges and all ───────────────────────
    const whole = await fetch(streamUrl);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(Number(whole.headers.get('content-length'))).toBe(entry.bytes);
    // The same mime all the way down: envelope, cache record, and the header
    // `/stream` actually sets.
    expect(whole.headers.get('content-type')).toBe(entry.mime);
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
    if (YTDLP === null || app === null) {
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

/**
 * The one assertion that would have caught the shipped bug.
 *
 * `--simulate` means yt-dlp resolves the format list and picks a format without
 * downloading a byte, so this is cheap enough to run against every rung of the
 * ladder. It is the only thing here that talks to YouTube, and it is talking to
 * it because YouTube is the source whose format list breaks selectors: no muxed
 * formats at all, not even the 360p `itag 18` everything used to fall back to.
 */
describe.skipIf(!LIVE || YTDLP === null)(
  `the format ladder, against a real adaptive-only source${YTDLP === null ? ` (skipped: ${SKIP_NOTE})` : ''}`,
  () => {
    /** Exit 0 means "yt-dlp found a format for this selector". That is the claim. */
    async function resolves(selector: string): Promise<{ ok: boolean; picked: string }> {
      if (YTDLP === null) return { ok: false, picked: '' };
      const result = await run(
        YTDLP,
        [
          '--no-warnings',
          '--no-playlist',
          '--simulate',
          '--print',
          '%(format_id)s %(height)s',
          '-f',
          selector,
          '--',
          ADAPTIVE_URL,
        ],
        { timeoutMs: 120_000 },
      );
      return { ok: result.code === 0, picked: `${result.stdout.trim()}${result.stderr.trim()}` };
    }

    it.each([
      { audio: true, hasFfmpeg: true },
      { audio: true, hasFfmpeg: false },
      { audio: false, hasFfmpeg: true },
      { audio: false, hasFfmpeg: false },
    ])('finds a format for audio=$audio ffmpeg=$hasFfmpeg', async (c) => {
      const selector = formatSelector({ maxHeight: 1080, prefer: 'any', ...c });
      const { ok, picked } = await resolves(selector);
      // Before the fix, `hasFfmpeg: false` failed here with exactly the message
      // the bug report carried.
      expect(ok, `-f ${selector} did not resolve: ${picked}`).toBe(true);
      expect(picked).not.toMatch(/Requested format is not available/i);
    });

    it('still fails the way the bug reported it, for the selector that shipped', async () => {
      // Verbatim from the released `formatSelector`, no-ffmpeg branch. Kept here
      // so that if YouTube ever starts serving muxed formats again, this test goes
      // red and tells us the regression suite above stopped proving anything.
      const shipped = 'best[height<=?1080][vcodec!=none]/best[height<=?1080]/best';
      const { ok, picked } = await resolves(shipped);
      expect(ok, `the old selector unexpectedly resolved to: ${picked}`).toBe(false);
      expect(picked).toMatch(/Requested format is not available/i);
    });
  },
);
