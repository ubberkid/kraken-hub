import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * The two user-facing features that span both pages: the quality control and
 * the remote's live ring.
 *
 * Everything here runs against the in-repo broker simulator (`?transport=fake`,
 * `src/sync/transports/FakeTransport.ts`) for the same reason as
 * `sync-remote.spec.ts`: a PR must never go red because a public broker is
 * having a bad day.
 *
 * The HLS fixture is a two-variant MASTER playlist served by `page.route`, and
 * it is served only far enough to make `MANIFEST_PARSED` fire. That is exactly
 * the moment the level ladder becomes knowable, and the level ladder is what
 * the whole quality picker is built on — playing an actual segment would test
 * hls.js, which is not our code.
 */

const STATE_KEY = 'kraken-hub:v1:state';
const LOG_KEY = 'kraken-hub:v1:video:log';
const ROOM = 'QRST5678';

const HLS_URL = 'http://127.0.0.1:4173/fixture/master.m3u8';
const DEMO_URL = 'http://127.0.0.1:4173/demo/demo.mp4';

const MASTER_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
  'v360.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720',
  'v720.m3u8',
  '',
].join('\n');

function remoteUrl(room = ROOM): string {
  return `/?room=${room}&transport=fake#/remote`;
}

function displayUrl(room = ROOM): string {
  return `/?kraken=1&sim=elite&room=${room}&transport=fake`;
}

/** Seeds every page in the context with one module and one config. */
async function seed(context: BrowserContext, moduleId: string, cfg: unknown): Promise<void> {
  await context.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key, value);
    },
    [
      STATE_KEY,
      JSON.stringify({
        schema: 5,
        rev: 1,
        updatedAt: Date.now(),
        writerId: 'e2e',
        writerRole: 'config',
        activeModuleId: moduleId,
        modules: { [moduleId]: { v: 2, cfg } },
        sync: { enabled: true, roomCode: ROOM, transport: 'fake', publishTelemetry: true },
      }),
    ] as const,
  );
}

/** Serves the master playlist, and 404s the media playlists it points at. */
async function serveHls(page: Page): Promise<void> {
  await page.route('**/fixture/master.m3u8', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      headers: { 'access-control-allow-origin': '*' },
      body: MASTER_PLAYLIST,
    }),
  );
  await page.route('**/fixture/v*.m3u8', (route) =>
    route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' }),
  );
}

async function telemetryCodes(page: Page): Promise<string[]> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (raw === null) return [];
    try {
      const parsed = JSON.parse(raw) as { code?: string; message?: string }[];
      return parsed.map((e) => `${e.code ?? ''}:${e.message ?? ''}`);
    } catch {
      return [];
    }
  }, LOG_KEY);
}

async function storedQuality(page: Page): Promise<unknown> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const doc = JSON.parse(raw) as {
      modules?: Record<string, { cfg?: { quality?: unknown } }>;
    };
    return doc.modules?.['video']?.cfg?.quality ?? null;
  }, STATE_KEY);
}

// ---------------------------------------------------------------------------
// Feature 1 — quality
// ---------------------------------------------------------------------------

test.describe('quality', () => {
  /**
   * The end-to-end claim: the picker on the phone offers the renditions the
   * DISPLAY reported, and choosing one reaches the display and is handed to the
   * adapter.
   *
   * The last step is asserted through `quality-requested` in the display's
   * telemetry ring buffer rather than through a test-only global. That entry is
   * not scaffolding — it is written on every quality change precisely so "I
   * asked for 1080 and the provider said no" is distinguishable from "nothing
   * happened" on a screen nobody can click.
   */
  test('the remote picker reaches the display, which asks its adapter', async ({ context }) => {
    await seed(context, 'video', { url: HLS_URL, downloadMode: 'stream-only' });

    const display = await context.newPage();
    await serveHls(display);
    await display.goto(displayUrl());

    const remote = await context.newPage();
    await remote.goto(remoteUrl());
    await expect(remote.getByTestId('link-status')).toHaveAttribute('data-network', 'online', {
      timeout: 10_000,
    });

    // No "More controls" door any more (design audit, F6): the quality picker
    // is one of the four compact essentials, on the page — and since round 2's
    // R8 it is a segmented row rather than a `<select>`, like every other short
    // exclusive choice in the product.
    await expect(remote.getByTestId('more-controls')).toHaveCount(0);
    const picker = remote.locator('#remote-quality');
    await expect(picker).toBeVisible({ timeout: 10_000 });

    // The ladder came off the wire, not out of a guess: 720p is in this
    // fixture's master playlist and nowhere else.
    const rung = remote.getByTestId('remote-quality-720');
    await expect(rung).toBeVisible({ timeout: 15_000 });

    await rung.click();

    // 1. The choice reached the display's own state document.
    await expect
      .poll(async () => storedQuality(display), { timeout: 10_000 })
      .toEqual({ mode: 'fixed', height: 720 });

    // 2. …and the display handed it to the adapter.
    await expect
      .poll(async () => telemetryCodes(display), { timeout: 10_000 })
      .toContain('quality-requested:720');
  });

  /**
   * "Offer control only where it's real." A stored file or a direct `.mp4` has
   * exactly one resolution, so the remote shows a reading and no picker at all.
   */
  test('a direct file gets a read-only reading, not a picker', async ({ context }) => {
    await seed(context, 'video', { url: DEMO_URL, downloadMode: 'stream-only' });

    const remote = await context.newPage();
    await remote.goto(remoteUrl());

    await expect(remote.getByTestId('remote-quality-readout')).toContainText('nothing to choose');
    await expect(remote.locator('#remote-quality')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Feature 2 — the live ring
// ---------------------------------------------------------------------------

test.describe('the remote ring', () => {
  /**
   * The clock ring is the REAL clock renderer. Its time is correct by
   * definition — the phone has its own clock — so what this proves is that the
   * display module's chunk really is mounted and really is ticking, which is
   * the whole "state replica, not a stylized surface" claim.
   */
  test('renders the real clock module, ticking', async ({ context }) => {
    await seed(context, 'clock', { face: 'digital', showSeconds: true });

    /*
      A display first — round 6's C4.

      A replica needs the panel's REPORTED geometry, because every module scales
      its type and its dials off `geometry()` rather than off its container.
      Until the first monitor packet arrives there is no geometry, and the ring
      used to mount the renderer anyway at `RING_PX` and `scale(1)`: a 640 px
      module cropped to the top-left corner of a 132 px circle, drawn
      confidently, on the one surface whose promise is that it shows what the
      panel shows. So the walk starts a display, exactly as the stats test
      below does, and the no-geometry case is asserted in its own test.
    */
    const display = await context.newPage();
    await display.goto(displayUrl());

    const remote = await context.newPage();
    await remote.goto(remoteUrl());

    const ring = remote.getByTestId('remote-mirror');
    await expect(ring).toHaveAttribute('data-mode', 'replica', { timeout: 20_000 });
    await expect(ring).toHaveAttribute('data-module', 'clock');

    const time = remote.locator('[data-testid="ring-replica"] .kh-clock__time');
    await expect(time).toBeVisible({ timeout: 10_000 });
    const first = await time.textContent();
    expect(first).toMatch(/\d/);

    // It ticks. The replica runs at 1 Hz, so two seconds is two chances.
    await expect.poll(async () => time.textContent(), { timeout: 10_000 }).not.toBe(first);
  });

  /**
   * The stats ring is the REAL stats renderer, fed the compact monitoring
   * snapshot off the telemetry channel.
   *
   * It used to assert that before any packet arrived the ring showed the
   * module's own "waiting" card rather than a wall of zeroes. Round 6's C4
   * moved that boundary: a replica is not mounted at all until the panel's
   * geometry has been REPORTED, because a module laid out against a guessed
   * panel is a confident picture of something nobody has described — the same
   * class of lie, one level up from a wall of zeroes. The no-feed state gets
   * the treated placeholder card instead, asserted in the test below; what
   * remains here is the claim that made the ring worth building.
   */
  test('renders the real stats module once the panel has been described', async ({ context }) => {
    await seed(context, 'stats', { layout: 'dual', primary: 'cpuTemp' });

    const remote = await context.newPage();
    await remote.goto(remoteUrl());

    // Bring a display up: `?sim=elite` runs the monitoring generator, so real
    // packets — geometry included — start flowing over the fake transport.
    const display = await context.newPage();
    await display.goto(displayUrl());

    const ring = remote.locator('[data-testid="ring-replica"]');
    await expect(ring).toBeVisible({ timeout: 20_000 });
    const value = ring.locator('.kh-stats__value').first();
    await expect(value).toBeVisible({ timeout: 20_000 });
    // A real reading, not the `--` placeholder the module shows for an absent
    // sensor. This is the injected snapshot, decoded and rendered.
    await expect.poll(async () => value.textContent(), { timeout: 20_000 }).toMatch(/\d/);
  });

  /**
   * C4 — the ring never draws a module at a panel size nobody reported.
   *
   * The reproduction, as a passing test: a remote opened into a room with no
   * display in it, on a module that CAN be replicated. `RemoteRing` fell back
   * to `RING_PX` for both dimensions and `scale(1)` while `replica.ts` fell
   * back to `0 × 0` for the geometry, so the ring mounted a real renderer at
   * 1:1 inside a 132 px box. The honest answer is the treated card the picture
   * modules already use — the same fallback language the home screen's halo
   * speaks — which says "nothing has been reported" instead of showing the
   * corner of something.
   */
  test('shows the placeholder card rather than a module at a guessed size', async ({ context }) => {
    await seed(context, 'stats', { layout: 'dual', primary: 'cpuTemp' });

    const remote = await context.newPage();
    await remote.goto(remoteUrl());
    await expect(remote.getByTestId('remote-mirror')).toBeVisible();

    // No display anywhere in this test, so no monitor packet and no geometry.
    await expect(remote.getByTestId('ring-empty')).toBeVisible({ timeout: 10_000 });
    await expect(remote.getByTestId('ring-replica')).toHaveCount(0);
    // …and it names the module, so the card is an answer rather than a hole.
    await expect(remote.getByTestId('ring-empty')).toContainText('Stats');
  });

  /**
   * The video ring cannot be a replica — pixels are the one thing this design
   * refuses to stream — so it is a still plus a position arc. The arc is what
   * makes it live: it is re-anchored on the phone between telemetry packets, so
   * it advances continuously rather than stepping twice a second.
   */
  test('the video ring’s position arc advances between telemetry packets', async ({ context }) => {
    await seed(context, 'video', { url: DEMO_URL, downloadMode: 'stream-only' });

    const display = await context.newPage();
    await display.goto(displayUrl());

    const remote = await context.newPage();
    await remote.goto(remoteUrl());
    await expect(remote.getByTestId('remote-mirror')).toHaveAttribute('data-mode', 'still');

    const arc = remote.getByTestId('ring-arc');
    await expect(arc).toBeAttached({ timeout: 20_000 });

    const readProgress = async (): Promise<number> =>
      Number((await arc.getAttribute('data-progress')) ?? '0');

    const first = await readProgress();
    await expect.poll(readProgress, { timeout: 15_000 }).toBeGreaterThan(first);
  });
});
