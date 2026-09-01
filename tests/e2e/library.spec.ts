import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import { NOTHING_KEPT } from '../../src/config/vocabulary';

/**
 * The Library page, after it stopped being four pages stacked on top of each
 * other.
 *
 * The report this suite comes from: *"the library page is pretty dumb. It
 * doesn't have a back button. The clips and downloading sections are separate
 * for some reason — it should just show the progress on the actual clip like
 * most people do. The separate section for video link and manual is dumb — just
 * a + button in top right; the library page should show your actual library
 * only and have buttons for adding."*
 *
 * So the assertions are, in order: every sub-page can get you home; the grid is
 * the whole page; a download in flight is a tile in that grid and settles into
 * an ordinary tile without moving; and there is exactly one way to add,
 * whichever kind of thing you are adding.
 */

const FIXTURE_URL = 'http://127.0.0.1:4173/demo/demo.mp4';
const FIXTURE_PATH = fileURLToPath(new URL('../../public/demo/demo.mp4', import.meta.url));

/**
 * A window with a mouse.
 *
 * The remote is a phone surface that a desktop can open, and its sub-header is
 * desktop-only for that reason — on a phone there is no "back", the page IS the
 * app. The suite's default viewport is the 640 px LCD, which reads as a phone.
 */
const DESKTOP = { width: 1024, height: 768 };

function tiles(page: Page) {
  return page.locator('[data-testid="library-tile"]');
}

async function openAddPanel(page: Page): Promise<void> {
  await page.getByTestId('library-add').click();
  await expect(page.getByTestId('library-add-panel')).toBeVisible();
}

test.describe('sub-page navigation', () => {
  /**
   * CAM's Configuration Browser has no browser chrome at all — no back button,
   * no address bar, no shortcut. A screen with no way home is a dead end there,
   * and every one of these four was one.
   */
  for (const [hash, title] of [
    ['#/library', 'Library'],
    // About and Diagnostics are ONE page now (design audit, F7): `#/diag`
    // rewrites to `#/about` and therefore carries the same name.
    ['#/diag', 'About'],
    ['#/about', 'About'],
    ['#/remote', 'Remote'],
  ] as const) {
    test(`${hash} has a back link home, and it routes without navigating`, async ({ page }) => {
      await page.setViewportSize(DESKTOP);
      // A hash change fires no `load`; a navigation or a reload does. One load
      // for `goto`, and no second one, is half the assertion (invariant I1/I2).
      let loads = 0;
      page.on('load', () => {
        loads += 1;
      });

      await page.goto(`/${hash}`);
      const back = page.getByTestId('nav-back');
      await expect(back).toBeVisible();
      await expect(back).toHaveAttribute('href', '#/');
      await expect(back).toContainText('Your Kraken');
      // The page says which one it is, next to the way out.
      await expect(page.locator('.kh-subhead__title')).toHaveText(title);

      await back.click();
      await expect(page.getByTestId('mirror')).toBeVisible();
      expect(new URL(page.url()).hash).toBe('#/');
      expect(loads).toBe(1);
    });
  }

  test('the back link is reachable and operable from the keyboard', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/#/library');
    const back = page.getByTestId('nav-back');
    await back.focus();
    await expect(back).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('mirror')).toBeVisible();
  });

  test('the wordmark is still a way home too', async ({ page }) => {
    await page.goto('/#/library');
    await expect(page.getByTestId('wordmark')).toHaveAttribute('href', '#/');
  });
});

test.describe('the library shows your library, and nothing else', () => {
  test('an empty library is a friendly card that stays true when the add panel opens', async ({
    page,
  }) => {
    await page.goto('/#/library');
    await expect(page.getByTestId('library')).toBeVisible();
    // One verb for what a shelf does, from `config/vocabulary.ts` (round 4, F4):
    // the header said "Kept", this card said "saved" and the meter said
    // "stored", about one act, on one screen.
    await expect(page.getByTestId('library-empty')).toContainText(NOTHING_KEPT);
    await expect(page.getByTestId('library-add')).toBeVisible();

    /*
     * It must not point at a "+" that is not there.
     *
     * The card used to read "Press + up there…" — and pressing + turns that
     * button into an ×, so with the add panel open the instruction named a
     * control that was no longer on screen (design audit, F5.2).
     */
    await expect(page.getByTestId('library-empty')).not.toContainText('Press +');
    await openAddPanel(page);
    await expect(page.getByTestId('library-empty')).not.toContainText('Press +');
    await page.getByTestId('library-add').click();
    await expect(page.getByTestId('library-add-panel')).toHaveCount(0);

    // The sections that were not the library are gone: no paste panel, no
    // separate "add a file by hand" block, no "Downloading now" list.
    await expect(page.getByRole('heading', { name: 'Add a video' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Add a file by hand' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Downloading now' })).toHaveCount(0);
    // …and the add surface only exists once you ask for it.
    await expect(page.getByTestId('library-add-panel')).toHaveCount(0);
  });

  /**
   * The manual-upload fallback, which used to be its own section at the bottom
   * of the page. Same guarantee as before: the duration and the dimensions come
   * from the metadata probe, not from the filename.
   */
  test('the + panel adds a file from this PC, and the tile carries the real metadata', async ({
    page,
  }) => {
    await page.goto('/#/library');
    await openAddPanel(page);
    await page.locator('[data-testid="clip-file-input"]').setInputFiles(FIXTURE_PATH);

    const tile = tiles(page).first();
    await expect(tiles(page)).toHaveCount(1, { timeout: 15_000 });
    await expect(tile).toHaveAttribute('data-clip-id', /.+/);
    await expect(tile).toContainText('demo.mp4');
    // The duration and the size, and NOT the pixel dimensions: `640×640` was on
    // every tile in the shelf and changed nothing a person could do from it
    // (round 2, R7). The probe still measures them — the report carries them.
    await expect(tile).not.toContainText('640×640');
    await expect(tile).toHaveAttribute('data-tile-kind', 'clip');
    await expect(tile).toHaveAttribute('data-tile-state', 'ready');

    // Pin and delete still work, from the tile itself rather than a row of
    // buttons in a list.
    await tile.getByTestId('tile-pin').click();
    await expect(tile).toContainText('pinned');
    await tile.getByTestId('tile-pin').click();
    await expect(tile).not.toContainText('pinned');

    // Showing it puts it on the display, and the tile says so.
    await tile.getByTestId('tile-show').click();
    await expect(tile.getByTestId('tile-active')).toBeVisible();

    await tile.getByTestId('tile-delete').click();
    await expect(tiles(page)).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByTestId('library-empty')).toBeVisible();
  });

  /**
   * The headline change: a download is not a separate section, it is the tile.
   *
   * The link is added through the same **+** panel and travels the same route a
   * link pasted on the home screen does — validated, committed as the source,
   * fetched by the DISPLAY (CAM's two browsers share a storage partition; this
   * is the only context whose IndexedDB the LCD can read back). The response is
   * held for three seconds so the in-flight tile is genuinely observable rather
   * than a race against a 32 kB file.
   */
  test('a link added from the + panel is a downloading tile that completes in place', async ({
    context,
  }) => {
    const config = await context.newPage();
    const display = await context.newPage();
    await display.setViewportSize({ width: 640, height: 640 }); // device-size-ok: the Elite preset this spec drives

    const HOLD_MS = 3000;
    await display.route(FIXTURE_URL, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
      await route.continue();
    });

    await config.goto('/#/library');
    await openAddPanel(config);
    await config.fill('[data-testid="library-add-input"]', FIXTURE_URL);
    await config.click('[data-testid="library-add-submit"]');
    // One add surface, and it closes behind itself.
    await expect(config.getByTestId('library-add-panel')).toHaveCount(0);

    await display.goto('/?kraken=1&sim=elite');

    // In flight: a tile in the grid, with progress ON it and a way to stop.
    const running = tiles(config).filter({ hasText: 'demo.mp4' }).first();
    await expect(running).toHaveAttribute('data-tile-state', 'downloading', { timeout: 20_000 });
    await expect(running.getByTestId('tile-progress')).toBeVisible();
    await expect(running.getByTestId('tile-cancel')).toBeVisible();

    // Finished: the same one tile, now an ordinary clip. Never two, and never a
    // second section for it to move to.
    await expect(running).toHaveAttribute('data-tile-state', 'ready', { timeout: 30_000 });
    await expect(tiles(config)).toHaveCount(1);
    await expect(running).toHaveAttribute('data-clip-id', /.+/);
    await expect(running).not.toContainText('640×640');
  });
});
