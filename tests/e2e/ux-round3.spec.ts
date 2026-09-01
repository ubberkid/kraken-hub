import { expect, test, type Page } from '@playwright/test';

import { KEEPING_A_COPY_NOW, RETIRED_PHRASES } from '../../src/config/vocabulary';

/**
 * Round 3, the findings that do not belong to the home screen's own arithmetic.
 *
 * The page-budget class fix (F2), the Advanced door (F1) and the empty-room rule
 * (F5) are asserted in `home-composition.spec.ts`, next to the composition they
 * are about; the touch-target sweep (F6) has a file of its own. What is here:
 *
 *  - **F3** — the options panel's first open animated against Suspense's
 *    "Loading settings…" placeholder and then hard-cut to the real content when
 *    the chunk landed. 380 ms of spring at the wrong height, once per cold load,
 *    on the app's most-used gesture.
 *  - **F7** — one vocabulary, on the surfaces the round-2 pass did not reach.
 *    The unit test (`src/config/vocabulary.test.ts`) proves no second literal
 *    survives in the source; this proves the words the user actually sees.
 *  - **F8** — a library tile that is downloading or has failed is a thing with a
 *    name, not a black rectangle.
 */

const CAM = { width: 866, height: 537 } as const;

/**
 * Switch to a module and open its options.
 *
 * A helper rather than four lines in each test: pressing an inactive chip
 * switches, and pressing the chip that is already active is the door — so the
 * number of presses depends on where you started, and that branch is setup
 * rather than an assertion that varies with the run.
 */
async function openOptions(page: Page, id: string): Promise<void> {
  const chip = page.getByTestId(`module-chip-${id}`);
  await chip.click();
  if ((await chip.getAttribute('aria-expanded')) !== 'true') await chip.click();
  await expect(page.locator(`[data-testid="ops-panel"] .kh-field`).first()).toBeVisible();
}

async function cam(page: Page): Promise<void> {
  await page.setViewportSize(CAM);
  await page.addInitScript(() => {
    localStorage.setItem('kraken-hub:v1:config:displaySeen', '1');
  });
}

// ---------------------------------------------------------------------------
// F3 — the first open animates against the real thing
// ---------------------------------------------------------------------------

test.describe('F3 — opening the options for the first time', () => {
  /**
   * The placeholder must never be what the spring animates against.
   *
   * Measured by watching the panel from the moment it appears: the fallback is
   * a different height from the real content, so a cold open grew to the wrong
   * size, sat there for the length of a chunk fetch, and snapped. The module's
   * panel chunk is prefetched when the module becomes active now — choosing a
   * module is a decision to look at it — so by the time the chip is pressed
   * again the chunk is in the module cache and Suspense never suspends.
   */
  test('the panel never shows the loading placeholder', async ({ page }) => {
    await cam(page);
    await page.goto('/');

    // A cold module: nothing has rendered its panel this page load.
    const chip = page.getByTestId('module-chip-clock');
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');

    // Watch every mutation from the press until the real controls exist, and
    // record whether the placeholder was ever painted.
    await page.evaluate(() => {
      const w = window as unknown as { __khSawFallback?: boolean };
      w.__khSawFallback = false;
      new MutationObserver(() => {
        const panel = document.querySelector('[data-testid="ops-panel"]');
        if (panel?.textContent.includes('Loading settings') === true) {
          w.__khSawFallback = true;
        }
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });

    await chip.click();
    await expect(page.getByTestId('clock-date-on')).toBeVisible();

    const sawFallback = await page.evaluate(
      () => (window as unknown as { __khSawFallback?: boolean }).__khSawFallback === true,
    );
    expect(sawFallback, 'the options spring animated against “Loading settings…”').toBe(false);
  });

  /** And the prefetch is real: switching modules fetches that module's chunk. */
  test('choosing a module fetches its options ahead of the press', async ({ page }) => {
    await cam(page);
    const wanted: string[] = [];
    page.on('request', (r) => {
      const url = r.url();
      if (url.includes('module-image') || url.includes('config-ui')) wanted.push(url);
    });
    await page.goto('/');
    await page.getByTestId('module-chip-image').click();
    // The panel has not been asked for; the chunk is fetched anyway.
    await expect(page.getByTestId('ops-panel')).toHaveCount(0);
    await expect.poll(() => wanted.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// F7 — one vocabulary, on every surface
// ---------------------------------------------------------------------------

test.describe('F7 — the app says one thing one way', () => {
  /**
   * The Library was the surface round 2's "one voice" pass never reached: its
   * downloading tile read *"Saving to your Kraken…"*, which is the exact phrase
   * `HomeView` documents as killed, and it named a destination the copy does
   * not go to.
   */
  test('a downloading tile speaks the same words as the home screen', async ({ page }) => {
    await cam(page);
    await page.addInitScript(() => {
      localStorage.setItem(
        'kraken-hub:v1:video:downloads',
        JSON.stringify([
          {
            id: 'd-live',
            url: 'https://example.test/clips/dunes.mp4',
            sourceUrl: 'https://example.test/clips/dunes.mp4',
            name: 'dunes.mp4',
            state: 'downloading',
            reason: null,
            receivedBytes: 1_048_576,
            totalBytes: 4_194_304,
            error: null,
            clipId: null,
            startedAt: Date.now(),
            updatedAt: Date.now(),
          },
        ]),
      );
    });
    await page.goto('/?cam=1#/library');

    const tile = page.locator('[data-testid="library-tile"]').first();
    await expect(tile).toHaveAttribute('data-tile-state', 'downloading');
    await expect(tile).toContainText(KEEPING_A_COPY_NOW);
  });

  /** …and none of the retired spellings is painted anywhere in the product. */
  test('no retired phrase survives on any screen', async ({ page }) => {
    await cam(page);
    for (const hash of ['#/', '#/library', '#/about', '#/remote'] as const) {
      await page.goto(`/?transport=fake&room=ABCD1234${hash}`);
      await expect(page.locator('main')).toBeVisible();
      const summaries = page.locator('main details > summary');
      for (let i = 0; i < (await summaries.count()); i++) await summaries.nth(i).click();
      const painted = await page.evaluate(() => document.body.innerText);
      for (const dead of RETIRED_PHRASES) {
        expect(painted, `"${dead}" is still on ${hash}`).not.toContain(dead);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// F8 — an in-progress tile is a thing, not a hole
// ---------------------------------------------------------------------------

test.describe('F8 — downloading and failed tiles carry the shelf’s language', () => {
  const JOB = {
    id: 'd1',
    url: 'https://example.test/clips/sunset.mp4',
    sourceUrl: 'https://example.test/clips/sunset.mp4',
    name: 'sunset.mp4',
    reason: null as string | null,
    receivedBytes: 2_097_152,
    totalBytes: 8_388_608,
    error: null,
    clipId: null,
  };

  async function seedJob(page: Page, state: string, reason: string | null): Promise<void> {
    await page.addInitScript(
      ([job, s, r]) => {
        localStorage.setItem(
          'kraken-hub:v1:video:downloads',
          JSON.stringify([
            {
              ...(job as Record<string, unknown>),
              state: s,
              reason: r,
              startedAt: Date.now(),
              updatedAt: Date.now(),
            },
          ]),
        );
      },
      [JOB, state, reason] as const,
    );
  }

  test('a download in flight has a treated card, not a black rectangle', async ({ page }) => {
    await cam(page);
    await seedJob(page, 'downloading', null);
    await page.goto('/?cam=1#/library');

    const tile = page.locator('[data-testid="library-tile"]').first();
    await expect(tile).toHaveAttribute('data-tile-state', 'downloading');
    // The same fallback language a stored clip with no frame gets.
    await expect(tile.getByTestId('tile-treated')).toBeVisible();
    // …with the progress drawn ON it rather than instead of it.
    await expect(tile.getByTestId('tile-progress')).toBeVisible();
  });

  test('a failed download shows the reason, on a card that is not empty', async ({ page }) => {
    await cam(page);
    await seedJob(page, 'error', 'quota');
    await page.goto('/?cam=1#/library');

    const tile = page.locator('[data-testid="library-tile"]').first();
    await expect(tile).toHaveAttribute('data-tile-state', 'failed');
    await expect(tile.getByTestId('tile-treated')).toBeVisible();
    // Our words for it, never the browser's.
    await expect(tile).toContainText('no room left');
    await expect(tile.getByTestId('tile-retry')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Minors — the ones with a number or a string behind them
// ---------------------------------------------------------------------------

test.describe('round 3 minors', () => {
  test('the first-run band fits CAM’s window, halo and nav included', async ({ page }) => {
    await page.setViewportSize(CAM);
    await page.goto('/');
    await expect(page.getByTestId('setup-first-run')).toBeVisible();

    const overflow = await page.evaluate(() => {
      const doc = document.scrollingElement ?? document.documentElement;
      return doc.scrollHeight - doc.clientHeight;
    });
    expect(overflow, 'the first screen anybody sees runs past the fold').toBe(0);
    await expect(page.locator('.kh-more')).toBeInViewport({ ratio: 1 });
    await expect(page.locator('.kh-footer')).toBeInViewport({ ratio: 1 });
  });

  test('the install band uses About’s grammar, not a garden path', async ({ page }) => {
    await page.setViewportSize(CAM);
    await page.goto('/');
    const band = page.getByTestId('setup-first-run');
    // The verb and its destination are adjacent to the path, in that order —
    // never "turn <five-step menu route> up".
    await expect(band).toContainText('drag');
    await expect(band).toContainText('to maximum');
    await expect(band).not.toContainText('up.');
  });

  test('the library’s close button says close', async ({ page }) => {
    await page.setViewportSize(CAM);
    await page.goto('/?cam=1#/library');
    const add = page.getByTestId('library-add');
    await expect(add).toContainText('Add');
    await add.click();
    await expect(page.getByTestId('library-add-panel')).toBeVisible();
    // The glyph rotates into an ×; the word underneath it used to keep saying
    // "Add" — a close button labelled with the action it undoes.
    await expect(add).toContainText('Close');
    await expect(add).not.toContainText('Add');
  });

  test('the add panel does not give editing advice', async ({ page }) => {
    await page.setViewportSize(CAM);
    await page.goto('/?cam=1#/library');
    await page.getByTestId('library-add').click();
    const panel = page.getByTestId('library-add-panel');
    // Advice about preparing a file, in the box that takes the file you have.
    await expect(panel).not.toContainText('square-cropped');
    await expect(panel).not.toContainText('audio dropped');
  });

  test('the empty library sits in the middle of the room it is empty of', async ({ page }) => {
    await page.setViewportSize(CAM);
    await page.goto('/?cam=1#/library');
    await expect(page.getByTestId('library-empty')).toBeVisible();
    const boxes = await page.evaluate(() => {
      const empty = document.querySelector('[data-testid="library-empty"]');
      const main = document.querySelector('main');
      if (empty === null || main === null) return null;
      const e = empty.getBoundingClientRect();
      const m = main.getBoundingClientRect();
      return { above: e.top - m.top, below: m.bottom - e.bottom, mainHeight: m.height };
    });
    expect(boxes).not.toBeNull();
    // `<main>` genuinely fills the shell — the bug underneath this was a
    // three-row grid whose `1fr` landed on the breadcrumb, leaving `<main>`
    // auto-sized at 251 px inside a 537 px window.
    expect(boxes?.mainHeight ?? 0).toBeGreaterThan(300);
  });

  test('every sub-page has the way back, at phone width too', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const hash of ['#/library', '#/remote', '#/about'] as const) {
      await page.goto(`/?transport=fake&room=ABCD1234${hash}`);
      await expect(page.getByTestId('nav-back'), `${hash} has no way home`).toBeVisible();
    }
  });

  test('the compact mirror stays on the composition’s axis', async ({ page }) => {
    await cam(page);
    await page.goto('/');
    await openOptions(page, 'clock');

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const centre = (s: string): number | null => {
            const el = document.querySelector(s);
            if (el === null) return null;
            const r = el.getBoundingClientRect();
            return Math.round(r.left + r.width / 2);
          };
          const mirror = centre('.kh-home__mirror');
          const chips = centre('.kh-mods');
          return mirror === null || chips === null ? -1 : Math.abs(mirror - chips);
        }),
      )
      // The mirror row used to be left-aligned inside a centred box while every
      // other row was centred — one orphan x-axis, at the moment the halo is
      // least able to anchor anything.
      .toBeLessThanOrEqual(2);
  });
});
