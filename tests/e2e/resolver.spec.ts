import { readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

/**
 * The resolver companion, end to end, against a **real HTTP server** speaking
 * the frozen v1 contract on `127.0.0.1:8976`.
 *
 * This is the acceptance test for the whole download-first product decision, and
 * the last assertion is the one that matters: after the companion is killed and
 * the page reloaded, the video still plays — because by then the bytes live in
 * IndexedDB and the companion is not needed for that clip ever again.
 *
 * The server implements `/health`, `/resolve` (with the 202 + `/job` flow, so the
 * client's polling path is genuinely exercised rather than mocked) and `/stream`
 * with CORS and Range, exactly as `docs/resolver-protocol.md` mandates.
 */

const STATE_KEY = 'kraken-hub:v1:state';
const RESOLVER_PORT = 8976;
const FIXTURE = fileURLToPath(new URL('../../public/demo/demo.mp4', import.meta.url));
const YT_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

interface Companion {
  server: Server;
  close(): Promise<void>;
  resolveCalls: number;
  streamCalls: number;
}

function cors(res: ServerResponse): void {
  // §6.2 — mandated on EVERY endpoint, `/stream` included: `<video src>` would
  // not need it, but `fetch`-into-IndexedDB absolutely does.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, X-Krakenhub-Token');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  res.setHeader('Accept-Ranges', 'bytes');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** A companion that answers 202 once, then ok — so `/job` polling is exercised. */
async function startCompanion(): Promise<Companion> {
  const bytes = readFileSync(FIXTURE);
  const size = statSync(FIXTURE).size;
  const state = { resolveCalls: 0, streamCalls: 0 };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${String(RESOLVER_PORT)}`);

    if (req.method === 'OPTIONS') {
      cors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === '/health') {
      json(res, 200, {
        ok: true,
        name: 'kraken-hub-resolver',
        version: '1.0.0-e2e',
        api: 1,
        capabilities: ['resolve', 'stream', 'probe'],
        maxHeight: 2160,
      });
      return;
    }

    if (url.pathname === '/resolve') {
      state.resolveCalls += 1;
      // The first call reports a job in progress, exactly as a real companion
      // does while yt-dlp is still downloading.
      json(res, 202, { status: 'pending', jobId: 'job-1', retryAfterMs: 250 });
      return;
    }

    if (url.pathname === '/job/job-1') {
      json(res, 200, {
        status: 'ok',
        kind: 'progressive',
        streamUrl: `http://127.0.0.1:${String(RESOLVER_PORT)}/stream/job-1.mp4`,
        mime: 'video/mp4',
        width: 640,
        height: 640,
        durationSec: 4,
        title: 'resolved-demo.mp4',
      });
      return;
    }

    if (url.pathname === '/stream/job-1.mp4') {
      state.streamCalls += 1;
      cors(res);
      const range = req.headers.range;
      if (typeof range === 'string') {
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        const start = Number(m?.[1] ?? 0);
        const end = m?.[2] !== undefined && m[2] !== '' ? Number(m[2]) : size - 1;
        res.writeHead(206, {
          'Content-Type': 'video/mp4',
          'Content-Range': `bytes ${String(start)}-${String(end)}/${String(size)}`,
          'Content-Length': String(end - start + 1),
        });
        res.end(bytes.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(size) });
      res.end(bytes);
      return;
    }

    json(res, 404, { status: 'error', code: 'not-found', message: 'no such path' });
  });

  await new Promise<void>((resolve) => {
    // Loopback only — the contract's own security posture (§6.3).
    server.listen(RESOLVER_PORT, '127.0.0.1', resolve);
  });

  return {
    server,
    get resolveCalls() {
      return state.resolveCalls;
    },
    get streamCalls() {
      return state.streamCalls;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

async function seed(page: Page, cfg: Record<string, unknown>): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key, value);
    },
    [
      STATE_KEY,
      JSON.stringify({
        schema: 2,
        rev: 1,
        updatedAt: Date.now(),
        writerId: 'e2e-config',
        writerRole: 'config',
        activeModuleId: 'video',
        modules: { video: { v: 1, cfg } },
      }),
    ] as const,
  );
}

function media(page: Page) {
  return page.locator('.kh-video__stage video');
}

function mediaSrc(page: Page): Promise<string> {
  return page.evaluate(
    () => document.querySelector<HTMLVideoElement>('.kh-video__stage video')?.src ?? '',
  );
}

test.describe('resolver companion', () => {
  test('a YouTube URL routes through the companion, imports to the clip library, and survives the companion being killed', async ({
    page,
  }) => {
    const companion = await startCompanion();
    try {
      await seed(page, {
        url: YT_URL,
        downloadMode: 'auto',
        resolver: { policy: 'youtube-only', port: RESOLVER_PORT, token: '' },
      });
      await page.goto('/?kraken=1&sim=elite');

      // The whole point: a YouTube link ends up as a LOCAL blob, not an iframe.
      await expect(media(page)).toBeAttached({ timeout: 30_000 });
      await expect.poll(() => mediaSrc(page), { timeout: 30_000 }).toMatch(/^blob:/);
      // No geometry engine anywhere near this — the resolver path has no iframe.
      await expect(page.locator('.kh-video__yt')).toHaveCount(0);

      // The 202 → /job flow was genuinely exercised.
      expect(companion.resolveCalls).toBeGreaterThan(0);
      expect(companion.streamCalls).toBeGreaterThan(0);

      const clips = await page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            const req = indexedDB.open('kraken-hub.v1');
            req.onsuccess = () => {
              const tx = req.result.transaction('clips', 'readonly');
              const count = tx.objectStore('clips').count();
              count.onsuccess = () => {
                resolve(count.result);
              };
            };
            req.onerror = () => {
              resolve(-1);
            };
          }),
      );
      expect(clips).toBe(1);
    } finally {
      await companion.close();
    }

    // The companion is gone. The clip is not.
    await page.reload();
    await expect(media(page)).toBeAttached({ timeout: 30_000 });
    await expect.poll(() => mediaSrc(page), { timeout: 30_000 }).toMatch(/^blob:/);
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              document.querySelector<HTMLVideoElement>('.kh-video__stage video')?.currentTime ?? -1,
          ),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
  });

  test('with no companion running, a YouTube URL falls back to the geometry engine silently', async ({
    page,
  }) => {
    await seed(page, {
      url: YT_URL,
      downloadMode: 'auto',
      // A port nothing is listening on — the ordinary case for most users.
      resolver: { policy: 'youtube-only', port: 8977, token: '' },
    });
    // Keep the test hermetic: the YouTube iframe itself never has to load.
    await page.route(/^https:\/\/(www\.youtube|www\.youtube-nocookie|i\.ytimg)\./, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html>' }),
    );
    await page.goto('/?kraken=1&sim=elite');

    // The geometry engine's iframe, not an error card.
    await expect(page.locator('.kh-video__yt')).toHaveCount(1, { timeout: 20_000 });
    await expect(page.locator('.kh-video__card')).toHaveCount(0);

    // And the fallback is recorded where the config UI can read it, for free.
    const codes = await page.evaluate(() => {
      const raw = localStorage.getItem('kraken-hub:v1:video:log') ?? '[]';
      return (JSON.parse(raw) as { code: string }[]).map((e) => e.code);
    });
    expect(codes).not.toContain('provider-unavailable');
  });
});
