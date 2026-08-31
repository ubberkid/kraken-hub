import { expect, test } from '@playwright/test';

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
