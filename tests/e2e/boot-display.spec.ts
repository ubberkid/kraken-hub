import { expect, test } from '@playwright/test';

test.describe('display boot', () => {
  test('renders the stage and the requested module under the simulator', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(err.message));

    // `video` is the default module now, so `clock` is asked for by name.
    await page.goto('/?kraken=1&sim=elite&module=clock');

    const stage = page.locator('.kh-stage');
    await expect(stage).toBeVisible();
    await expect(stage).toHaveAttribute('data-shape', 'circle');
    await expect(stage).toHaveAttribute('data-target-fps', '40');

    await expect(page.locator('[data-module="clock"]')).toBeAttached();
    await expect(page.locator('.kh-clock__time')).toHaveText(/^\d{2}:\d{2}:\d{2}$/);

    // Geometry reached the DOM as custom properties (invariant I3 consumers).
    const vars = await page.evaluate(() => {
      const s = getComputedStyle(document.documentElement);
      return {
        w: s.getPropertyValue('--kh-w').trim(),
        safe: s.getPropertyValue('--kh-safe').trim(),
        shape: document.documentElement.dataset['shape'],
      };
    });
    expect(vars.w).toBe('640px');
    expect(vars.safe).toBe('121px');
    expect(vars.shape).toBe('circle');

    // No configuration UI on the LCD path.
    await expect(page.locator('.kh-app')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('boots into the video module by default', async ({ page }) => {
    await page.goto('/?kraken=1&sim=elite');
    await expect(page.locator('[data-module="video"]')).toBeAttached();
  });

  test('shows the low-FPS advisory when CAM reports 1 FPS', async ({ page }) => {
    await page.goto('/?kraken=1&sim=elite&fps=1&module=clock');
    await expect(page.locator('.kh-lowfps .kh-card__title')).toHaveText('1 FPS');
    await expect(page.locator('.kh-lowfps')).toContainText('Frame Rate');
  });

  test('survives late CAM injection', async ({ page }) => {
    await page.goto('/?kraken=1&sim=z&inject=late&module=clock');
    // Before injection the fallback geometry applies...
    await expect(page.locator('.kh-stage')).toBeVisible();
    // ...and once the mock lands, the real panel size takes over.
    await expect
      .poll(
        async () =>
          page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue('--kh-w').trim(),
          ),
        { timeout: 10_000 },
      )
      .toBe('320px');
  });
});
