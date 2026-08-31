import { expect, test } from '@playwright/test';

/**
 * Invariant I1: the Kraken Browser never follows a top-level navigation, and
 * CAM's hidden browser would not come back if we tried. This test watches for
 * any navigation at all over a few seconds of normal running.
 */
test('the display page never navigates', async ({ page }) => {
  let navigations = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations += 1;
  });

  await page.goto('/?kraken=1&sim=elite');
  await expect(page.locator('.kh-stage')).toBeVisible();

  const before = new URL(page.url());
  const navigationsAfterLoad = navigations;

  // The point of the test is that nothing happens for three seconds.
  // eslint-disable-next-line playwright/no-wait-for-timeout
  await page.waitForTimeout(3000);

  const after = new URL(page.url());
  expect(navigations).toBe(navigationsAfterLoad);
  expect(after.pathname).toBe(before.pathname);
  expect(after.search).toBe(before.search);
  expect(after.hash).toBe('');

  // And nothing in the display tree offers an outbound link to click.
  await expect(page.locator('.kh-stage a')).toHaveCount(0);
});
