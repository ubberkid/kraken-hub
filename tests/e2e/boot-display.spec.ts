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
    // The ceiling is the attached panel's, and it is in the copy (F12-3).
    await expect(page.locator('.kh-lowfps')).toContainText('40 FPS on this panel');
  });

  /*
   * Round 13, F1 — and the reason it shipped at all.
   *
   * Every display spec before this one ran at the config's default 640x640
   * viewport and asserted on TEXT, so an advisory card 405 px tall inside a
   * 398 px safe box read as passing: the words were all there, they were simply
   * partly off the disc. On a 240 Kraken the same card was 233 px in 202 px of
   * room — 12 px past the glass, footer sheared off — while §6.3 promised the
   * card is "laid out entirely inside safeInsetPx".
   *
   * So the assertion is geometric and the viewport is set per panel: the card's
   * box must fit the safe box, and its bottom edge must stay on the panel.
   */
  for (const panel of [
    { name: 'a 240 Kraken (square)', sim: 'kraken2023', size: 240 },
    { name: 'a 640 Elite (round)', sim: 'elite', size: 640 },
  ]) {
    test(`keeps the low-FPS card inside the safe inset on ${panel.name}`, async ({ page }) => {
      await page.setViewportSize({ width: panel.size, height: panel.size });
      await page.goto(`/?kraken=1&sim=${panel.sim}&fps=1&module=clock`);

      const card = page.locator('.kh-overlay.kh-lowfps .kh-card');
      await expect(card).toBeVisible();

      const m = await page.evaluate(() => {
        const stage = document.querySelector('.kh-stage');
        const el = document.querySelector('.kh-overlay.kh-lowfps .kh-card');
        if (stage === null || el === null) throw new Error('no advisory card');
        const s = stage.getBoundingClientRect();
        const c = el.getBoundingClientRect();
        const safe = Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--kh-safe'),
        );
        return {
          panelH: s.height,
          panelBottom: s.bottom,
          safe,
          cardH: c.height,
          cardW: c.width,
          cardBottom: c.bottom,
          cardTop: c.top,
        };
      });

      expect(m.safe).toBeGreaterThan(0);
      // Inside the safe box in both axes...
      expect(m.cardH).toBeLessThanOrEqual(m.panelH - 2 * m.safe);
      expect(m.cardW).toBeLessThanOrEqual(m.panelH - 2 * m.safe);
      // ...and therefore on the glass, top and bottom.
      expect(m.cardBottom).toBeLessThanOrEqual(m.panelBottom);
      expect(m.cardTop).toBeGreaterThanOrEqual(0);
    });
  }

  /*
   * F12-1: a Kraken Z's slider TOPS OUT at 1 FPS. The advisory there was a
   * permanent instruction to drag a slider that is already at maximum to
   * maximum, followed by a permanent badge. A panel at its ceiling gets nothing.
   */
  test('says nothing on a Kraken Z, whose 1 FPS is its maximum', async ({ page }) => {
    await page.goto('/?kraken=1&sim=z&module=clock');
    await expect(page.locator('.kh-stage')).toHaveAttribute('data-target-fps', '1');
    await expect(page.locator('.kh-lowfps')).toHaveCount(0);
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
