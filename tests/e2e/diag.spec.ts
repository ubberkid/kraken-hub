import { expect, test } from '@playwright/test';

/**
 * The diagnostics hand-off: an LCD has no clipboard, so the display writes its
 * report to localStorage and the configuration page reads it back.
 */
const DIAG_KEY = 'kraken-hub:v1:diag:display';

test('the display publishes a DiagReport that the config page can read', async ({ context }) => {
  const display = await context.newPage();
  await display.goto('/?kraken=1&sim=elite&diag=1');

  await expect(display.locator('.kh-diag')).toBeVisible();
  await expect(display.locator('.kh-diag')).toContainText('640×640 circle');

  const report = await display.evaluate(async (key) => {
    for (let i = 0; i < 40; i++) {
      const raw = localStorage.getItem(key);
      if (raw !== null) return JSON.parse(raw) as Record<string, unknown>;
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  }, DIAG_KEY);

  expect(report).not.toBeNull();
  expect(report?.['schemaVersion']).toBe(1);
  expect(report?.['mode']).toBe('display');

  const config = await context.newPage();
  await config.goto('/#/diag');
  // The probes and the hand-off live behind "Show the technical detail" since
  // round 2's R3 — the same content, one press down.
  await config.getByTestId('tech-detail').locator('summary').click();
  await expect(config.getByRole('heading', { name: 'Your Kraken' })).toBeVisible();
  // Addressed by test id rather than by `.kh-chip--ok`: `#/diag` is the merged
  // About/Diagnostics page now (design audit, F7), so several other healthy
  // chips share that class on it.
  await expect(config.getByTestId('diag-display-chip')).toHaveClass(/kh-chip--ok/, {
    timeout: 5000,
  });
  await expect(config.getByTestId('diag-display-chip')).toContainText('captured');
  await expect(config.locator('.kh-code').last()).toContainText('"schemaVersion": 1');
});

test('the ring target pattern renders for the visible-radius measurement', async ({ page }) => {
  await page.goto('/?kraken=1&sim=elite&diag=1&pattern=rings');
  const img = page.locator('.kh-diag__rings');
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute('src', './diag/ring-target.svg');
});
