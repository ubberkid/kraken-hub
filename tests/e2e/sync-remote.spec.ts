import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * The M2 acceptance tests, run against the in-repo broker simulator
 * (`?transport=fake`, `src/sync/transports/FakeTransport.ts`).
 *
 * No public broker is contacted here, on purpose: a PR must never go red
 * because emqx.io or ntfy.sh is having a bad day. The live smoke test that DOES
 * touch a real broker is opt-in (`npm run test:live`).
 *
 * The fake transport is backed by `localStorage`, which is shared between pages
 * in one browser context — so a remote page really does drive a display page
 * through a retained-message channel with its own namespace
 * (`kraken-hub:v1:fake:…`), completely separate from the canonical state key.
 */

const STATE_KEY = 'kraken-hub:v1:state';
const ROOM = 'ABCD1234';
/** SHA-256("ABCD1234")[0..10] in Crockford base32 — pinned in crypto.test.ts. */
const TOPIC = '2RTWGMJTZEQ5HGVV';
const RETAINED_KEY = `kraken-hub:v1:fake:primary:${TOPIC}:state`;

function remoteUrl(room = ROOM): string {
  return `/?room=${room}&transport=fake#/remote`;
}

function displayUrl(room = ROOM): string {
  return `/?kraken=1&sim=elite&room=${room}&transport=fake`;
}

async function readSync(page: Page): Promise<Record<string, unknown>> {
  const raw = await page.locator('html').getAttribute('data-kh-sync');
  return raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
}

test('a cold display restores from the retained snapshot ALONE', async ({ context }) => {
  // 1. A remote pairs into the room and changes the active module.
  const remote = await context.newPage();
  await remote.goto(remoteUrl());
  await expect(remote.getByText('Current room')).toBeVisible();

  // The retained slot already holds the snapshot published on connect, so the
  // test waits for it to CHANGE rather than merely to exist.
  const before = await remote.evaluate((key) => localStorage.getItem(key), RETAINED_KEY);
  await remote.locator('#remote-module').selectOption('clock');
  await expect
    .poll(async () => remote.evaluate((key) => localStorage.getItem(key), RETAINED_KEY))
    .not.toBe(before);

  // 2. The remote goes away entirely, so nothing can re-publish behind us.
  await remote.close();

  // 3. Destroy the ONLY other source of truth: the persisted state document.
  //    From here the retained snapshot is the sole record that the module was
  //    ever changed. This is the assertion the whole milestone rests on.
  const scratch = await context.newPage();
  await scratch.goto('/');
  await scratch.evaluate((key) => {
    localStorage.removeItem(key);
  }, STATE_KEY);
  await expect
    .poll(async () => scratch.evaluate((key) => localStorage.getItem(key), STATE_KEY))
    .toBeNull();

  const retained = await scratch.evaluate((key) => localStorage.getItem(key), RETAINED_KEY);
  expect(retained).not.toBeNull();
  // Wire payloads are ciphertext: the module id is nowhere in the frame.
  expect(retained).not.toContain('clock');
  await scratch.close();

  // 4. A cold display, with no persisted state, boots and must end up on
  //    clock — which it can only learn from the retained message.
  const display = await context.newPage();
  await display.goto(displayUrl());
  await expect(display.locator('.kh-stage')).toBeVisible();
  await expect(display.locator('[data-module="clock"]')).toBeVisible({ timeout: 10_000 });

  const readout = await readSync(display);
  expect(readout['module']).toBe('clock');
  expect(readout['retained']).toBe(true);
});

test('a loop-slider change reaches the display in under a second', async ({ context }) => {
  const display = await context.newPage();
  await display.goto(displayUrl('BCDE2345'));
  await expect(display.locator('.kh-stage')).toBeVisible();

  const remote = await context.newPage();
  await remote.goto(remoteUrl('BCDE2345'));
  await expect(remote.getByText('Current room')).toBeVisible();

  // Wait until the display has applied at least one snapshot, so the timing
  // below measures the update rather than the initial handshake.
  await expect.poll(async () => Object.keys(await readSync(display)).length).toBeGreaterThan(0);

  const startedAt = Date.now();
  await remote.locator('#remote-loop-a').fill('30');

  await expect
    .poll(async () => {
      const loop = (await readSync(display))['loop'] as { start?: number } | null | undefined;
      return loop?.start ?? null;
    })
    .toBe(30);

  expect(Date.now() - startedAt).toBeLessThan(1000);
});

test('killing the transport shows the failover in the remote UI', async ({ context }) => {
  const remote = await context.newPage();
  await remote.goto(remoteUrl('CDEF3456'));
  await expect(remote.getByText('Current room')).toBeVisible();
  await expect(remote.getByText(/fake — online/)).toBeVisible({ timeout: 10_000 });

  // Take the primary simulated broker down. The transport's own poll notices,
  // reports `offline`, and SyncService re-runs the ladder onto the fallback.
  const startedAt = Date.now();
  await remote.evaluate(() => {
    localStorage.setItem('kraken-hub:v1:fake:down:primary', '1');
  });

  await expect(remote.getByText('fallback transport — higher latency')).toBeVisible({
    timeout: 15_000,
  });

  // The acceptance criterion is a NUMBER, not "eventually": a phone that takes
  // ten seconds to notice its broker died is indistinguishable from a broken
  // remote. The generous `toBeVisible` timeout above only exists so a failure
  // reports the elapsed time rather than a bare locator timeout.
  expect(Date.now() - startedAt).toBeLessThan(5000);
});

// ---------------------------------------------------------------------------
// Position sync — the half that used to be format-only
// ---------------------------------------------------------------------------

/**
 * `AppState.playback` travelled in the envelope from the start, but nothing
 * ever wrote it, so `anchorPosition()` was dead code at runtime: the remote
 * scrubber froze between telemetry packets and a cold display always resumed at
 * zero. These three tests are the ones that would have caught that.
 *
 * The fixture is the bundled 6-second demo clip, served by the preview server,
 * in stream-only mode — no IndexedDB, no companion, no blob, so a failure here
 * is about position and nothing else.
 */

const FIXTURE_URL = 'http://127.0.0.1:4173/demo/demo.mp4';
const CHECKPOINT_KEY = 'kraken-hub:v1:video:positionCheckpoint';
const MEDIA = '.kh-video__stage video';

/** Seeds every page in the context with the video module on the demo clip. */
async function seedVideo(context: BrowserContext): Promise<void> {
  await context.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key, value);
    },
    [
      STATE_KEY,
      JSON.stringify({
        schema: 2,
        rev: 1,
        updatedAt: 1,
        writerId: 'e2e-config',
        writerRole: 'config',
        activeModuleId: 'video',
        modules: { video: { v: 1, cfg: { url: FIXTURE_URL, downloadMode: 'stream-only' } } },
      }),
    ] as const,
  );
}

/**
 * Records the largest FORWARD jump in `currentTime`, sampled in-page.
 *
 * Magnitude alone cannot prove a seek on a 6-second clip: ordinary playback
 * reaches any position eventually, so "currentTime > 4" passes for the wrong
 * reason if you wait long enough. A discontinuity cannot happen by playing —
 * the loop's wrap is backwards — so a forward jump is the seek and nothing else.
 */
async function watchJumps(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __khJump: number };
    w.__khJump = 0;
    let previous = -1;
    setInterval(() => {
      const el = document.querySelector<HTMLVideoElement>('.kh-video__stage video');
      if (el === null) return;
      const t = el.currentTime;
      if (previous >= 0 && t - previous > w.__khJump) w.__khJump = t - previous;
      previous = t;
    }, 50);
  });
}

async function maxJump(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __khJump?: number }).__khJump ?? 0);
}

async function currentTime(page: Page): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector<HTMLVideoElement>(sel);
    return el === null ? -1 : el.currentTime;
  }, MEDIA);
}

async function seekValue(page: Page): Promise<number> {
  return Number(await page.locator('#remote-seek').inputValue());
}

test('the remote scrubber interpolates between telemetry packets', async ({ context }) => {
  await seedVideo(context);

  const display = await context.newPage();
  await display.goto(displayUrl('DEFG4567'));
  await expect(display.locator(MEDIA)).toBeAttached({ timeout: 15_000 });
  await expect.poll(async () => currentTime(display), { timeout: 15_000 }).toBeGreaterThan(0);

  const remote = await context.newPage();
  await remote.goto(remoteUrl('DEFG4567'));
  await expect(remote.getByText('Current room')).toBeVisible();

  /*
   * Telemetry is 0.5 Hz, so ONE packet arrives per two seconds. Sample the bar
   * ten times across 1.2 s and count the distinct values: a scrubber that
   * rendered `stats.currentTime` raw can change at most once in that window
   * (and usually not at all), while one re-anchored on the 250 ms clock changes
   * four or five times. Three distinct values cannot be produced by packets.
   */
  await expect.poll(async () => seekValue(remote), { timeout: 20_000 }).toBeGreaterThan(0);
  await expect
    .poll(
      async () => {
        const seen = new Set<number>();
        for (let i = 0; i < 10; i += 1) {
          seen.add(await seekValue(remote));
          await remote.waitForTimeout(120);
        }
        return seen.size;
      },
      { timeout: 25_000 },
    )
    .toBeGreaterThanOrEqual(3);
});

test('a seek on the remote moves the display', async ({ context }) => {
  await seedVideo(context);

  const display = await context.newPage();
  await display.goto(displayUrl('EFGH5678'));
  await expect(display.locator(MEDIA)).toBeAttached({ timeout: 15_000 });
  await expect.poll(async () => currentTime(display), { timeout: 15_000 }).toBeGreaterThan(0);

  const remote = await context.newPage();
  await remote.goto(remoteUrl('EFGH5678'));
  await expect(remote.getByText('Current room')).toBeVisible();
  await expect.poll(async () => seekValue(remote), { timeout: 20_000 }).toBeGreaterThan(0);

  // Hold first, so the assertion below cannot pass because the clip simply
  // played on: while held, the ONLY thing that can move `currentTime` is a seek.
  await remote.getByRole('button', { name: 'Hold' }).click();
  await expect
    .poll(
      async () => {
        const before = await currentTime(display);
        await display.waitForTimeout(500);
        return (await currentTime(display)) === before;
      },
      { timeout: 15_000 },
    )
    .toBe(true);

  // Two seeks, so the second one is measured from a KNOWN starting point rather
  // than from wherever playback happened to stop: rewind to the top, then jump
  // most of the way through a six-second clip.
  // 0.5, not 0.2: the slider's step is 0.5 and an off-grid value is refused.
  await remote.locator('#remote-seek').fill('0.5');
  await expect.poll(async () => currentTime(display), { timeout: 10_000 }).toBeLessThan(1);

  await remote.locator('#remote-seek').fill('4.5');
  await expect
    .poll(async () => Math.abs((await currentTime(display)) - 4.5), { timeout: 10_000 })
    .toBeLessThan(0.4);
});

test('a cold display resumes from the position in the retained snapshot', async ({ context }) => {
  await seedVideo(context);

  const display = await context.newPage();
  await display.goto(displayUrl('FGHI6789'));
  await expect(display.locator(MEDIA)).toBeAttached({ timeout: 15_000 });
  await expect.poll(async () => currentTime(display), { timeout: 15_000 }).toBeGreaterThan(0);

  const remote = await context.newPage();
  await remote.goto(remoteUrl('FGHI6789'));
  await expect(remote.getByText('Current room')).toBeVisible();
  await expect.poll(async () => seekValue(remote), { timeout: 20_000 }).toBeGreaterThan(0);

  // Hold, and wait until the HELD flag has reached the remote through telemetry:
  // the scrubber standing still is exactly that signal, and it is what makes the
  // published sample `paused`, so no extrapolation is applied downstream.
  await remote.getByRole('button', { name: 'Hold' }).click();
  await expect
    .poll(
      async () => {
        const before = await seekValue(remote);
        await remote.waitForTimeout(800);
        return (await seekValue(remote)) === before;
      },
      { timeout: 20_000 },
    )
    .toBe(true);

  await remote.locator('#remote-seek').fill('4.5');

  // The live display applies it once, and says so in its readout.
  await expect.poll(async () => (await readSync(display))['pos'], { timeout: 10_000 }).toBe(4.5);

  // Everything that could remember the position locally now goes away: both
  // pages close, and the display's own 10 s checkpoint is deleted. The retained
  // frame is the only record left.
  await remote.close();
  await display.close();

  const scratch = await context.newPage();
  await scratch.goto('/');
  await scratch.evaluate((key) => {
    localStorage.removeItem(key);
  }, CHECKPOINT_KEY);
  await expect
    .poll(async () => scratch.evaluate((key) => localStorage.getItem(key), CHECKPOINT_KEY))
    .toBeNull();
  await scratch.close();

  const cold = await context.newPage();
  await watchJumps(cold);
  await cold.goto(displayUrl('FGHI6789'));
  await expect(cold.locator(MEDIA)).toBeAttached({ timeout: 15_000 });

  await expect.poll(async () => (await readSync(cold))['pos'], { timeout: 15_000 }).toBe(4.5);
  // …and it reached the media element, not just the readout.
  await expect.poll(async () => maxJump(cold), { timeout: 15_000 }).toBeGreaterThan(2);
});
