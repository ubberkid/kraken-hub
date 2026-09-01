import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import { KEPT_A_COPY } from '../../src/config/vocabulary';

import type { AddressInfo } from 'node:net';

/**
 * M2.5 acceptance — the **real** companion process, end to end.
 *
 * `resolver.spec.ts` proves the client against a hand-written reference server
 * in the same file. This one proves the shipped program: it builds
 * `companion/resolver`, spawns `dist/cli.js` as its own OS process on a port the
 * kernel picked, points the app's resolver settings at it, and then does the
 * three things the plan says must be true:
 *
 *  1. paste a YouTube URL → resolves through the companion → downloads into the
 *     IndexedDB clip library with progress → plays → **kill the companion** →
 *     reload → still plays, from the local clip, forever;
 *  2. kill the companion *while it is downloading* → the display degrades to the
 *     geometry engine in silence, with no error card;
 *  3. install it AFTER pasting — the order every real user takes — and the
 *     guided panel connects on its own and the pending link downloads with no
 *     further click.
 *
 * The URL is typed into the home screen's paste box rather than seeded into
 * localStorage, on purpose: seeding it is how this suite stayed green through a
 * regression that made every paste look like an error (`paste-flow.spec.ts`).
 *
 * yt-dlp is never involved: `KRAKEN_HUB_RESOLVER_STUB` makes the companion serve
 * a fixture. Everything else — HTTP, CORS, Range, the job queue, the LRU cache,
 * the URL policy — is the production code path.
 */

const STATE_KEY = 'kraken-hub:v1:state';
const DOWNLOADS_KEY = 'kraken-hub:v1:video:downloads';
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = join(REPO_ROOT, 'companion/resolver/dist/cli.js');
const FIXTURE = join(REPO_ROOT, 'public/demo/demo.mp4');
const YT_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

interface Companion {
  port: number;
  base: string;
  /** Everything the process has said, for waiting on a specific log line. */
  log: string;
  waitForLog(needle: string, timeoutMs?: number): Promise<void>;
  kill(): Promise<void>;
  dead: boolean;
}

/**
 * A port nothing is listening on — for the one test that must configure the app
 * BEFORE the companion exists, and therefore cannot let the kernel pick.
 */
function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

function runNpm(args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm ${args.join(' ')} exited ${String(code)}`));
    });
  });
}

/**
 * Spawns the compiled CLI on an ephemeral port and waits until `/health`
 * answers. `--port 0` lets the kernel choose, so two workers never collide.
 */
async function startCompanion(opts: { delayMs?: number; port?: number } = {}): Promise<Companion> {
  const cacheDir = mkdtempSync(join(tmpdir(), 'kh-e2e-resolver-'));
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [CLI, '--port', String(opts.port ?? 0), '--cache-dir', cacheDir, '--log-level', 'debug'],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        KRAKEN_HUB_RESOLVER_STUB: FIXTURE,
        KRAKEN_HUB_RESOLVER_STUB_DELAY_MS: String(opts.delayMs ?? 0),
      },
    },
  );

  const state = { log: '', dead: false };
  const watchers: (() => void)[] = [];
  const absorb = (chunk: Buffer): void => {
    state.log += chunk.toString('utf8');
    for (const notify of watchers) notify();
  };
  child.stdout.on('data', absorb);
  child.stderr.on('data', absorb);
  child.on('close', () => {
    state.dead = true;
  });

  const waitForLog = (needle: string, timeoutMs = 20_000): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const check = (): void => {
        if (state.log.includes(needle)) {
          clearTimeout(timer);
          const i = watchers.indexOf(check);
          if (i >= 0) watchers.splice(i, 1);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        reject(new Error(`companion never logged ${needle}. Got:\n${state.log}`));
      }, timeoutMs);
      watchers.push(check);
      check();
    });

  await waitForLog('listening on http://127.0.0.1:');
  const port = Number(/listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(state.log)?.[1]);
  expect(Number.isInteger(port), 'the companion printed its port').toBe(true);
  const base = `http://127.0.0.1:${String(port)}`;

  // It is genuinely up before any test touches it.
  const health = await fetch(`${base}/health`);
  expect(health.status).toBe(200);
  expect(health.headers.get('access-control-allow-origin')).toBe('*');
  expect(((await health.json()) as { api: number }).api).toBe(1);

  return {
    port,
    base,
    get log() {
      return state.log;
    },
    get dead() {
      return state.dead;
    },
    waitForLog,
    kill: () =>
      new Promise<void>((resolve) => {
        if (state.dead) {
          rmSync(cacheDir, { recursive: true, force: true });
          resolve();
          return;
        }
        child.once('close', () => {
          rmSync(cacheDir, { recursive: true, force: true });
          resolve();
        });
        // SIGKILL, not SIGTERM: "the user closed the laptop lid", not "the
        // user asked it politely to stop".
        child.kill('SIGKILL');
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
        writerId: 'e2e-companion',
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

function clipCount(page: Page): Promise<number> {
  return page.evaluate(
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
}

test.describe('the shipped resolver companion', () => {
  // Serial: both tests compile the same `dist/`, and two `tsc` runs writing the
  // same files from different workers is a race with no upside.
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    // The e2e suite tests the compiled program, so it compiles it.
    await runNpm(['run', 'build', '--workspace', 'kraken-hub-resolver']);
  });

  test('a YouTube URL is downloaded by the companion into the clip library, and outlives it', async ({
    context,
    page,
  }) => {
    // A delay long enough that `/resolve` MUST answer 202 and the client MUST
    // poll `/job` — the flow a real yt-dlp download takes.
    const companion = await startCompanion({ delayMs: 400 });
    try {
      // The URL arrives the way a user's URL actually arrives: typed into the
      // home screen's paste box, not written into localStorage by the test.
      // Seeding it directly would have let the paste flow break — and it did,
      // see `paste-flow.spec.ts` — with this suite still green.
      // Seeded on the CONFIG page only. Both pages share the origin, so an init
      // script on the display would rewrite the state the paste just committed
      // and the display would boot on the demo clip.
      const config = await context.newPage();
      await seed(config, {
        url: '',
        downloadMode: 'auto',
        resolver: { policy: 'youtube-only', port: companion.port, token: '' },
      });
      await config.goto('/');
      await config.fill('[data-testid="paste-input"]', YT_URL);
      await config.click('[data-testid="paste-submit"]');

      await page.goto('/?kraken=1&sim=elite');

      // A YouTube link became a LOCAL blob. No iframe, no error card.
      await expect(media(page)).toBeAttached({ timeout: 30_000 });
      await expect.poll(() => mediaSrc(page), { timeout: 30_000 }).toMatch(/^blob:/);
      await expect(page.locator('.kh-video__yt')).toHaveCount(0);
      await expect(page.locator('.kh-video__card')).toHaveCount(0);

      // The 202 → /job flow really happened, in the shipped server's own log:
      // `/resolve` answered 202 and the client polled `/job` until it settled.
      expect(companion.log).toContain('resolve 202');

      // …and the download was a tracked, progress-reporting job, not a silent
      // blob assignment: the mirror carries the byte counts the LCD card reads.
      const downloads = await page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) ?? '[]') as Record<string, unknown>[],
        DOWNLOADS_KEY,
      );
      expect(downloads.length).toBeGreaterThan(0);
      const done = downloads.find((d) => d['state'] === 'done');
      expect(done, 'a completed download entry').toBeDefined();
      expect(Number(done?.['receivedBytes'])).toBeGreaterThan(0);
      expect(done?.['clipId']).toBeTruthy();
      // The job is filed under the URL the USER pasted, not the loopback stream
      // it was fetched from — which is what lets the home screen tell this
      // link's story rather than some earlier link's.
      expect(done?.['sourceUrl']).toBe(YT_URL);

      // And the paste flow on the config page says so, in its terminal state.
      const flow = config.locator('[data-testid="paste-flow"]');
      await expect(flow).toHaveAttribute('data-flow-stage', 'stored', { timeout: 20_000 });
      await expect(flow).toContainText(KEPT_A_COPY);
      // The success path never carries an install pitch at all any more
      // (design audit F10) — with or without a companion running.
      await expect(config.locator('[data-testid="resolver-get"]')).toHaveCount(0);

      expect(await clipCount(page)).toBe(1);
    } finally {
      await companion.kill();
    }

    // The companion is not merely idle — its process is gone, and nothing is
    // listening on the port any more.
    expect(companion.dead).toBe(true);
    const stillThere = await fetch(`${companion.base}/health`).then(
      () => true,
      () => false,
    );
    expect(stillThere, 'nothing answers on the companion port').toBe(false);

    // The clip is not. This is the whole download-first product decision in one
    // assertion: the bytes live in IndexedDB, so the companion is never needed
    // for this clip again.
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
    await expect(page.locator('.kh-video__card')).toHaveCount(0);
  });

  test('killing the companion mid-download degrades to the geometry engine in silence', async ({
    page,
  }) => {
    // Long enough that the job is still running when we pull the plug.
    const companion = await startCompanion({ delayMs: 30_000 });

    // Hermetic: the geometry engine's iframe never has to reach YouTube.
    await page.route(/^https:\/\/(www\.youtube|www\.youtube-nocookie|i\.ytimg)\./, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html>' }),
    );

    await seed(page, {
      url: YT_URL,
      downloadMode: 'auto',
      resolver: { policy: 'youtube-only', port: companion.port, token: '' },
    });
    await page.goto('/?kraken=1&sim=elite');

    // Wait until the companion has actually accepted the job and is "downloading".
    await companion.waitForLog('resolve 202');
    // The resolver path is genuinely in control at this instant — the job will
    // not settle for another 30 s, so nothing has fallen back yet. Without this
    // the next assertion could pass for the wrong reason.
    await expect(page.locator('.kh-video__yt')).toHaveCount(0);

    await companion.kill();
    expect(companion.dead).toBe(true);

    // The geometry engine takes over. Not an error card, not a black panel.
    await expect(page.locator('.kh-video__yt')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator('.kh-video__card')).toHaveCount(0);

    // Nothing was stored: a page URL is not a clip, and the app knows it.
    expect(await clipCount(page)).toBe(0);

    // The downgrade is recorded where the config UI can show it — as a warning
    // in telemetry, which is the only place a resolver miss is ever allowed to
    // appear (§6.4).
    const codes = await page.evaluate(() => {
      const raw = localStorage.getItem('kraken-hub:v1:video:log') ?? '[]';
      return (JSON.parse(raw) as { code: string; severity: string }[]).map((e) => e.code);
    });
    expect(codes).toContain('resolver-fallback');
    expect(codes).not.toContain('provider-unavailable');
  });

  /**
   * The guided install, in the order a real person does it: paste first,
   * install second.
   *
   * Everything that makes this hard is a consequence of CAM running two
   * browsers: the panel that notices the companion is in the CONFIGURATION
   * window, and the video it has to rescue is in the DISPLAY window, which
   * resolved this source before the companion existed and memoized "no
   * companion" for 60 s. The user has to press nothing.
   */
  test('installing the downloader while the panel waits connects it and downloads the pending link', async ({
    context,
  }) => {
    const port = await freePort();
    const config = await context.newPage();
    const display = await context.newPage();

    // Hermetic: the geometry engine's iframe never has to reach YouTube.
    await display.route(/^https:\/\/(www\.youtube|www\.youtube-nocookie|i\.ytimg)\./, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html>' }),
    );

    // Seeded on the CONFIG page only — see the note in the test above.
    await seed(config, {
      url: '',
      downloadMode: 'auto',
      resolver: { policy: 'youtube-only', port, token: '' },
    });

    await config.goto('/');
    await config.fill('[data-testid="paste-input"]', YT_URL);
    await config.click('[data-testid="paste-submit"]');
    await display.goto('/?kraken=1&sim=elite');

    // Nothing is installed, so the embed is playing and the home screen offers
    // the downloader instead of complaining about it.
    await expect(display.locator('.kh-video__yt')).toHaveCount(1, { timeout: 30_000 });
    await expect(display.locator('.kh-video__card')).toHaveCount(0);
    await expect(config.locator('[data-testid="paste-flow"]')).toHaveAttribute(
      'data-flow-stage',
      'youtube-embed',
      { timeout: 20_000 },
    );
    // The downloader lives behind the module's one Advanced door now, not next
    // to a working video (design audit F10).
    await config.click('[data-testid="module-chip-video"]');
    await config.click('[data-testid="video-advanced"] summary');
    await config.click('[data-testid="resolver-get"]');
    await expect(config.locator('[data-testid="resolver-connect"]')).toBeVisible();

    // The user goes and runs the program. The panel is polling; nothing else
    // happens on this page.
    const companion = await startCompanion({ port });
    try {
      await expect(config.locator('[data-testid="resolver-connected"]')).toBeVisible({
        timeout: 30_000,
      });

      // …and with zero further clicks the display re-resolves the link it has
      // been playing all along, through the companion, into the clip library.
      await expect.poll(() => mediaSrc(display), { timeout: 60_000 }).toMatch(/^blob:/);
      await expect(display.locator('.kh-video__card')).toHaveCount(0);
      expect(await clipCount(display)).toBe(1);
      await expect(config.locator('[data-testid="paste-flow"]')).toHaveAttribute(
        'data-flow-stage',
        'stored',
        { timeout: 20_000 },
      );
    } finally {
      await companion.kill();
    }
  });
});
