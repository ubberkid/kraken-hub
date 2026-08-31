import { expect, test } from '@playwright/test';

import type { Page } from '@playwright/test';

test.describe('config boot', () => {
  test('renders the configuration UI and routes by hash', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1, name: 'kraken-hub' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Step 1 — raise the frame rate' }),
    ).toBeVisible();
    // The version footer proves the build-time defines reached the bundle.
    await expect(page.locator('.kh-footer')).toContainText('kraken-hub v');

    // No display surface on this page.
    await expect(page.locator('.kh-stage')).toHaveCount(0);

    await page.getByRole('link', { name: 'About' }).click();
    await expect(page.getByRole('heading', { name: 'kraken-hub', level: 2 })).toBeVisible();
    expect(new URL(page.url()).hash).toBe('#/about');

    await page.getByRole('link', { name: 'Diagnostics' }).click();
    await expect(page.getByRole('heading', { name: 'This browser' })).toBeVisible();

    await page.getByRole('link', { name: 'Preview' }).click();
    await expect(page.locator('.kh-bezel iframe')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('the module settings route renders the module panel', async ({ page }) => {
    await page.goto('/#/module/clock');
    await expect(page.getByRole('heading', { name: 'Clock', exact: true })).toBeVisible();
    await expect(page.getByLabel('Hour format')).toBeVisible();
  });
});

/**
 * The scroll lock, and the two pages that must disagree about it.
 *
 * `index.html`'s inline critical CSS pins html/body/#root to the viewport so the
 * LCD can never scroll — there is no scrollbar and no input device on a 640x640
 * panel, so a stray scroll there is permanent and invisible. That lock leaked
 * into the configuration page, where it is fatal: CAM's Configuration Browser is
 * a ~866x537 Electron window and everything below the fold was unreachable.
 * Every desktop viewport in this suite happened to fit the content, which is why
 * no existing test caught it — hence the explicit small viewports below.
 */
test.describe('scrolling', () => {
  /** What the browser will actually scroll, as the page sees it. */
  async function scrollMetrics(page: Page) {
    return page.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    });
  }

  test('the config page scrolls in a CAM-sized window and reaches below the fold', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 866, height: 537 });
    await page.goto('/#/diag');

    await expect(page.getByRole('heading', { name: 'This browser' })).toBeVisible();

    const metrics = await scrollMetrics(page);
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

    // The display-report panel and its controls live below the fold at this
    // size. Reaching them by scrolling is the whole bug.
    const belowFold = page.getByRole('link', { name: 'Open display diagnostics' });
    await belowFold.scrollIntoViewIfNeeded();
    await expect(belowFold).toBeInViewport();
    // Actionability without navigating away: a trial click fails if anything
    // covers, clips or detaches the target.
    await belowFold.click({ trial: true });

    await page.locator('.kh-footer').scrollIntoViewIfNeeded();
    await expect(page.locator('.kh-footer')).toBeInViewport();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  });

  test('the remote page scrolls on a phone-sized viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/remote');

    await expect(page.getByRole('heading', { name: 'kraken-hub', level: 1 })).toBeVisible();

    const metrics = await scrollMetrics(page);
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

    await page.locator('.kh-footer').scrollIntoViewIfNeeded();
    await expect(page.locator('.kh-footer')).toBeInViewport();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  });

  test('the display page stays locked to the viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 400 });
    await page.goto('/?kraken=1&sim=elite');
    await expect(page.locator('.kh-stage')).toBeVisible();

    const metrics = await scrollMetrics(page);
    expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight);

    // The config page's marker class must never be applied here — it is added
    // by the config mount, which the display never loads.
    await expect(page.locator('html')).not.toHaveClass(/kh-config-mode/);

    await page.evaluate(() => {
      window.scrollTo(0, 5000);
    });
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });
});
