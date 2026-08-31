import { expect, test, type Page } from '@playwright/test';

/**
 * §7.3's fallback chain and §7.4's error card, on a link that genuinely cannot
 * be played.
 *
 * The interesting assertion is not "an error appeared" — it is *which* error,
 * and what the card says. The display is non-interactive, so the card is the
 * entire user interface for a failure: it has to name the category, show the
 * offending link middle-ellipsized, and point at CAM, because that is the only
 * place the user can actually do something.
 */

const STATE_KEY = 'kraken-hub:v1:state';

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

test.describe('unknown-URL fallback chain', () => {
  test('a dead extensionless link walks the chain, then renders the error card', async ({
    page,
  }) => {
    // No extension, so `detect()` can only guess — this is precisely the input
    // §7.3 exists for. The path 404s, so every step of the chain fails.
    await seed(page, {
      url: 'http://127.0.0.1:4173/definitely-not-a-video',
      downloadMode: 'stream-only',
    });
    await page.goto('/?kraken=1&sim=elite');

    const card = page.locator('.kh-video__card');
    // 6 s `<video>` probe + a range probe, inside §7.3's 25 s cap.
    await expect(card).toBeVisible({ timeout: 30_000 });
    // §7.4 — the fixed footer, because the fix is never on the LCD.
    await expect(card).toContainText('Fix in CAM → Kraken → Configure');
    await expect(card).toContainText('diagnostics log');

    // Every step's reason landed in the zero-network diagnostic path (§7.5), so
    // the config page can explain what was tried without any transport.
    const log = await page.evaluate(() => {
      const raw = localStorage.getItem('kraken-hub:v1:video:log') ?? '[]';
      return JSON.parse(raw) as { code: string; message?: string }[];
    });
    const chain = log.find((e) => e.code === 'source-unplayable');
    expect(chain, `no source-unplayable in ${JSON.stringify(log)}`).toBeDefined();
    expect(chain?.message).toContain('direct:video=');
    expect(chain?.message).toContain('direct:range=');
    // The proxy ships empty, so the chain must say so rather than silently
    // routing the user's URLs through a third party.
    expect(chain?.message).toContain('proxy=no proxy configured');

    // And the single-object last-error key, which is what the config UI reads.
    const last = await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('kraken-hub:v1:video:lastError') ?? 'null') as {
          code: string;
        } | null,
    );
    expect(last?.code).toBe('source-unplayable');
  });

  test('a hard reject is refused up front, with the exact §7.1 message and no retry', async ({
    page,
  }) => {
    await seed(page, { url: 'http://127.0.0.1:4173/demo/clip.mkv', downloadMode: 'stream-only' });
    await page.goto('/?kraken=1&sim=elite');

    const card = page.locator('.kh-video__card');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText('Matroska');
    await expect(card).toContainText('ffmpeg -i in.mkv -c copy out.mp4');
    // Deterministic class: no retry counter, ever. Retrying a .mkv forever is
    // how an LCD ends up in a permanent spinner.
    await expect(page.locator('.kh-video__card-retry')).toHaveCount(0);
  });

  test('the low-FPS advisory appears at 1 FPS and names the CAM slider', async ({ page }) => {
    await seed(page, { url: '', downloadMode: 'stream-only' });
    await page.goto('/?kraken=1&sim=elite&fps=1');
    const advisory = page.locator('[data-advisory]');
    await expect(advisory).toBeVisible({ timeout: 15_000 });
    await expect(advisory).toContainText('Frame Rate');
  });
});
