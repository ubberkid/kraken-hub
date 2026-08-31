import { expect, test, type Page } from '@playwright/test';

/**
 * LIVE — real YouTube, real network. Excluded from CI by living outside
 * `tests/e2e/`; run with `npm run test:e2e:live`.
 *
 * This file exists to check the two claims the stubbed suite structurally
 * cannot: that YouTube permits its embed on this origin at all, and that the
 * oversized element actually raises the served resolution — the entire premise
 * of the geometry engine. Everything else about the engine is asserted
 * hermetically in `tests/e2e/youtube.spec.ts`.
 *
 * A failure here is information about YouTube (a player rollout, a rate limit,
 * an embedding restriction on the fixture video), not necessarily a regression.
 * Read it that way before changing code.
 */

const STATE_KEY = 'kraken-hub:v1:state';
/**
 * Blender Foundation's "Big Buck Bunny" — Creative Commons, embeddable,
 * available in 1080p, and stable for over a decade. If it ever goes away,
 * replace it with another CC-licensed, embeddable 1080p upload.
 */
const LIVE_URL = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';

const LIVE = process.env['KRAKEN_HUB_LIVE'] === '1';

/* This file talks to the real YouTube, so it is opt-in and never runs in CI. */
// eslint-disable-next-line playwright/no-skipped-test
test.skip(!LIVE, 'set KRAKEN_HUB_LIVE=1 to run the live YouTube suite');

async function seed(page: Page): Promise<void> {
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
        writerId: 'e2e-live',
        writerRole: 'config',
        activeModuleId: 'video',
        modules: { video: { v: 1, cfg: { url: LIVE_URL, perf: 'quality' } } },
      }),
    ] as const,
  );
}

test('a real embed loads, plays, and the mask comes down', async ({ page }) => {
  await seed(page);
  await page.goto('/?kraken=1&sim=elite');

  const iframe = page.locator('.kh-video__stage iframe.kh-video__yt');
  await expect(iframe).toBeAttached({ timeout: 30_000 });
  await expect(iframe).toHaveAttribute('width', '1920');

  // The mask coming down is proof the IFrame API handshake completed AND that
  // muted autoplay was allowed — two separate things that both have to work.
  await expect
    .poll(
      () =>
        page.evaluate(
          () => document.querySelector<HTMLElement>('.kh-video__mask')?.style.opacity ?? '',
        ),
      { timeout: 45_000 },
    )
    .toBe('0');
});

test('a 1920-wide element elicits at least 720p — the premise of the whole engine', async ({
  page,
}) => {
  await seed(page);
  await page.goto('/?kraken=1&sim=elite');
  await expect(page.locator('.kh-video__stage iframe.kh-video__yt')).toBeAttached({
    timeout: 30_000,
  });

  // The module publishes every quality report to its telemetry ring buffer,
  // which is also exactly how a user would read this off a real LCD.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const raw = localStorage.getItem('kraken-hub:v1:video:log');
          if (raw === null) return 0;
          const events = JSON.parse(raw) as { code: string; message?: string }[];
          const heights = events
            .filter((e) => e.code === 'quality')
            .map((e) => Number(e.message ?? '0'));
          return heights.length === 0 ? 0 : Math.max(...heights);
        }),
      { timeout: 60_000 },
    )
    .toBeGreaterThanOrEqual(720);
});
