import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import { installFakeYouTube } from '../support/fakeYouTube';

import type { AddressInfo } from 'node:net';

/**
 * The paste flow, end to end, for the three answers a link can give.
 *
 * This suite exists because of a bug report: *"Any youtube or direct link I put
 * in there just gives me an error saying it can't do it. Saying it can't do a
 * cross origin read."* Every one of those videos was **playing**. What had
 * broken was the story the configuration page told about them — the home
 * screen showed the first entry of an unpruned download mirror forever, with
 * the browser's own `TypeError` as its copy, so one CORS-less MP4 made every
 * later paste look like a failure.
 *
 * The three cases below are therefore all *successes*, and each asserts the
 * same three things:
 *
 *   1. the DISPLAY reaches playback (a `<video>` with a moving clock, or the
 *      geometry engine's iframe);
 *   2. **no error card**, anywhere, ever;
 *   3. the step-cards say something honest and specific about the local copy.
 *
 * The two MP4 cases are served by real Node servers on real ports rather than
 * by `page.route`, because CORS is the entire subject: the only faithful way to
 * test "this server sends no `Access-Control-Allow-Origin`" is a server that
 * sends no `Access-Control-Allow-Origin`.
 */

const FIXTURE = readFileSync(fileURLToPath(new URL('../../public/demo/demo.mp4', import.meta.url)));
const YT_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

interface MediaServer {
  url: string;
  close: () => Promise<void>;
}

/**
 * A one-file video server. `cors: false` is not laziness — it is what most of
 * the web does, and the case the app must degrade through in silence.
 */
async function startMedia(cors: boolean): Promise<MediaServer> {
  const server: Server = createServer((req, res) => {
    const headers: Record<string, string> = {
      'content-type': 'video/mp4',
      'content-length': String(FIXTURE.length),
      'accept-ranges': 'bytes',
    };
    if (cors) headers['access-control-allow-origin'] = '*';
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : FIXTURE);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/demo.mp4`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * Points the app's resolver settings at a port nothing is listening on.
 *
 * Not paranoia: `resolver.spec.ts` runs a reference companion on the DEFAULT
 * port, and the suite is `fullyParallel` on one host — so a YouTube test that
 * leaves the port at its default is asserting "no companion is installed" while
 * another worker has one listening. Pinning a dead port makes the no-companion
 * case actually be the no-companion case.
 */
async function seedNoCompanion(config: Page): Promise<void> {
  const port = await freePort();
  await config.addInitScript(
    (value) => {
      localStorage.setItem('kraken-hub:v1:state', value);
    },
    JSON.stringify({
      schema: 2,
      rev: 1,
      updatedAt: Date.now(),
      writerId: 'e2e-paste',
      writerRole: 'config',
      activeModuleId: 'video',
      modules: {
        video: {
          v: 1,
          cfg: {
            url: '',
            downloadMode: 'auto',
            resolver: { policy: 'youtube-only', port, token: '' },
          },
        },
      },
    }),
  );
}

/** A port nothing is listening on, chosen by the kernel and immediately freed. */
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

/** Pastes a link the way a user does: into the home screen's one box. */
async function pasteOnHome(config: Page, url: string): Promise<void> {
  await config.goto('/');
  await config.waitForSelector('[data-testid="paste-input"]');
  await config.fill('[data-testid="paste-input"]', url);
  await config.click('[data-testid="paste-submit"]');
}

function flow(config: Page) {
  return config.locator('[data-testid="paste-flow"]');
}

function errorCard(display: Page) {
  return display.locator('.kh-video__card');
}

function videoSrc(display: Page): Promise<string> {
  return display.evaluate(
    () => document.querySelector<HTMLVideoElement>('.kh-video__stage video')?.src ?? '',
  );
}

function currentTime(display: Page): Promise<number> {
  return display.evaluate(
    () => document.querySelector<HTMLVideoElement>('.kh-video__stage video')?.currentTime ?? -1,
  );
}

test.describe('pasting a link never produces an error for a video that plays', () => {
  test('a YouTube link with no companion plays through the embed and OFFERS the downloader', async ({
    context,
  }) => {
    const config = await context.newPage();
    const display = await context.newPage();
    await display.setViewportSize({ width: 640, height: 640 }); // device-size-ok: the Elite preset this spec drives
    await installFakeYouTube(display);
    await seedNoCompanion(config);

    await pasteOnHome(config, YT_URL);
    await display.goto('/?kraken=1&sim=elite');

    // 1. The geometry engine is playing it. No companion is running, and §6.4
    //    says that is a silent downgrade, not a failure.
    await expect(display.locator('.kh-video__yt')).toHaveCount(1, { timeout: 30_000 });
    // 2. No error card, then or later.
    await expect(errorCard(display)).toHaveCount(0);

    // 3. The step-cards say what is true: it is playing, and a local copy is
    //    one program away. An invitation, never a diagnosis.
    await expect(flow(config)).toHaveAttribute('data-flow-stage', 'youtube-embed', {
      timeout: 15_000,
    });
    await expect(flow(config)).toContainText('Playing through YouTube');
    await expect(flow(config)).toContainText('On screen now');
    await expect(config.locator('[data-testid="resolver-get"]')).toBeVisible();

    // The CTA opens the guided install, with the one button a CAM user can use.
    await config.click('[data-testid="resolver-get"]');
    const panel = config.locator('[data-testid="resolver-connect"]');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('SmartScreen');
    // The developer fallback is a command that actually exists. The companion is
    // not on npm, so an `npx` line would be a 404 dressed as help.
    await expect(panel).toContainText('npm run build:companion');
    await expect(panel).not.toContainText('npx kraken-hub-resolver');
    await expect(config.locator('[data-testid="resolver-download-win"]')).toHaveAttribute(
      'href',
      /\/releases\/latest\/download\/kraken-hub-resolver-win-x64\.exe$/,
    );

    await expect(errorCard(display)).toHaveCount(0);
  });

  test('a direct MP4 whose server refuses a cross-origin read streams, silently', async ({
    context,
  }) => {
    const media = await startMedia(false);
    try {
      const config = await context.newPage();
      const display = await context.newPage();
      await display.setViewportSize({ width: 640, height: 640 }); // device-size-ok: the Elite preset this spec drives

      await pasteOnHome(config, media.url);
      await display.goto('/?kraken=1&sim=elite');

      // 1. Playing — from the remote URL, because a plain `<video src>` needs no
      //    CORS at all. Only KEEPING the bytes does.
      await expect(display.locator('.kh-video__stage video')).toBeAttached({ timeout: 30_000 });
      await expect.poll(() => videoSrc(display), { timeout: 30_000 }).toBe(media.url);
      await expect.poll(() => currentTime(display), { timeout: 20_000 }).toBeGreaterThan(0);
      // 2.
      await expect(errorCard(display)).toHaveCount(0);

      // 3. The download's failure is reported as what it is — an absent copy —
      //    in our words. `Failed to fetch` is Chrome talking to a programmer.
      await expect(flow(config)).toHaveAttribute('data-flow-stage', 'streaming', {
        timeout: 20_000,
      });
      await expect(flow(config)).toContainText('Streaming from the link');
      await expect(flow(config)).toContainText('does not allow saving a copy');
      await expect(flow(config)).not.toContainText('Failed to fetch');
      await expect(flow(config)).not.toContainText('cross-origin read');
      // The last step is reached: the video IS on screen.
      await expect(flow(config)).toContainText('On screen now');

      // And it is a warning in the diagnostics, at warn severity — the one place
      // a CORS refusal is allowed to appear.
      const log = await display.evaluate(
        () =>
          JSON.parse(localStorage.getItem('kraken-hub:v1:video:log') ?? '[]') as {
            code: string;
            severity: string;
          }[],
      );
      const blocked = log.find((e) => e.code === 'download-cors-blocked');
      expect(blocked, `no download-cors-blocked in ${JSON.stringify(log)}`).toBeDefined();
      expect(blocked?.severity).toBe('warn');
    } finally {
      await media.close();
    }
  });

  test('a CORS-clean MP4 is downloaded, kept, and played from the local copy', async ({
    context,
  }) => {
    const media = await startMedia(true);
    try {
      const config = await context.newPage();
      const display = await context.newPage();
      await display.setViewportSize({ width: 640, height: 640 }); // device-size-ok: the Elite preset this spec drives

      await pasteOnHome(config, media.url);
      await display.goto('/?kraken=1&sim=elite');

      // 1. A blob URL: the bytes are in IndexedDB and the panel is playing THEM.
      await expect(display.locator('.kh-video__stage video')).toBeAttached({ timeout: 30_000 });
      await expect.poll(() => videoSrc(display), { timeout: 30_000 }).toMatch(/^blob:/);
      // 2.
      await expect(errorCard(display)).toHaveCount(0);
      // 3.
      await expect(flow(config)).toHaveAttribute('data-flow-stage', 'stored', { timeout: 20_000 });
      await expect(flow(config)).toContainText('kept in your library');
    } finally {
      await media.close();
    }
  });

  test('a failure from an earlier link never becomes the story of the next one', async ({
    context,
  }) => {
    // The reported bug, reproduced as a sequence: the CORS-less link first, then
    // a YouTube link. Before the fix the second paste inherited the first one's
    // `Failed to fetch` — as did every paste after it, forever.
    const media = await startMedia(false);
    try {
      const config = await context.newPage();
      const display = await context.newPage();
      await display.setViewportSize({ width: 640, height: 640 }); // device-size-ok: the Elite preset this spec drives
      await installFakeYouTube(display);
      await seedNoCompanion(config);

      await pasteOnHome(config, media.url);
      await display.goto('/?kraken=1&sim=elite');
      await expect(flow(config)).toHaveAttribute('data-flow-stage', 'streaming', {
        timeout: 20_000,
      });

      await config.fill('[data-testid="paste-input"]', YT_URL);
      await config.click('[data-testid="paste-submit"]');

      await expect(flow(config)).toHaveAttribute('data-flow-stage', 'youtube-embed', {
        timeout: 20_000,
      });
      await expect(flow(config)).not.toContainText('Failed to fetch');
      await expect(display.locator('.kh-video__yt')).toHaveCount(1, { timeout: 30_000 });
      await expect(errorCard(display)).toHaveCount(0);
    } finally {
      await media.close();
    }
  });
});
