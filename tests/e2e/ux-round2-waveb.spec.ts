import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Round 2, wave B — the four surfaces the ruler had not been on yet.
 *
 * Wave A measured the home screen. This file measures what the round-2 audit
 * captured next, and every test in it is a number rather than an opinion:
 *
 *  - **R3** — the About page was **2,225 px, 498 words and 14 controls**: four
 *    screens of CAM's window, headed by internal hardware-checklist ids, to
 *    answer "what is this and how do I report a problem".
 *  - **R4** — the unpaired remote mounted the whole instrument, including a
 *    scrubber reading `0:00 / 60:00` for a duration nobody had ever reported.
 *  - **R8** — a native `<select>` was still shipping on the remote and in the
 *    Connection section, after wave A had removed every one from home.
 *  - **R10** — at 390 px the segments were 27 px tall and the navigation row
 *    was 17. Both vendors' guidance is 44.
 *
 * The unpaired-remote census lives in `sync-remote.spec.ts` next to the rest of
 * the pairing story; everything else is here.
 */

/** The CAM Configuration Browser, measured. */
const CAM = { width: 866, height: 537 } as const;
/** A small modern phone — the narrowest surface the remote is designed for. */
const PHONE = { width: 390, height: 844 } as const;
/** Both vendors publish the same floor for a touch target. */
const TAP_PX = 44;

/** The steady state: a Kraken has connected, so the install band is gone. */
async function seenDisplay(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('kraken-hub:v1:config:displaySeen', '1');
  });
}

/**
 * What `<main>` actually paints — closed drawers and screen-reader-only text
 * excluded.
 *
 * `toContainText` and `innerText` both read through a collapsed `<details>` in
 * Chromium, which would make every "it moved behind a door" assertion in this
 * file pass or fail for the wrong reason.
 */
async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const main = document.querySelector('main');
    if (main === null) return '';
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    const out: string[] = [];
    let node = walker.nextNode();
    while (node !== null) {
      const el = node.parentElement;
      const hidden =
        el?.closest('details:not([open])') != null || el?.closest('.kh-sr') != null || el === null;
      if (!hidden) out.push(node.textContent ?? '');
      node = walker.nextNode();
    }
    return out.join(' ');
  });
}

/** A bounding box that is a box — an absent one is a failure, not a skip. */
async function boxOf(locator: Locator): Promise<{ width: number; height: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('element has no bounding box — is it rendered?');
  return box;
}

// ---------------------------------------------------------------------------
// R3 — About is two calm sections, not a wall
// ---------------------------------------------------------------------------

test.describe('R3 — the About page', () => {
  /**
   * The measurement the finding is named after.
   *
   * Two screens of CAM's window is the ceiling, and the words are counted the
   * way a reader meets them: what is actually painted, with the contents of
   * closed disclosures excluded — a drawer nobody has opened is not something
   * anybody has read. The technical detail is still all there, one press away,
   * and this test opens it below to prove it.
   */
  test('fits about two CAM windows and stays under 200 visible words', async ({ page }) => {
    await page.setViewportSize(CAM);
    await seenDisplay(page);
    await page.goto('/#/about');
    // The page is named ONCE, by the thing whose job is naming pages. Round 3
    // caught the panel below printing "About" a second time, 30 px under the
    // breadcrumb that had just said it.
    await expect(page.locator('.kh-subhead__title')).toHaveText('About');
    await expect(
      page.getByRole('main').getByRole('heading', { name: 'About', exact: true }),
    ).toHaveCount(0);

    const height = await page.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      return el.scrollHeight;
    });
    expect(height, 'the About page runs past two CAM windows').toBeLessThanOrEqual(CAM.height * 2);

    const words = (await visibleText(page)).trim().split(/\s+/).filter(Boolean).length;
    expect(words, 'the About page is wordier than the budget').toBeLessThanOrEqual(200);
  });

  /**
   * The engineering is not deleted — it moved behind one door, and the door has
   * to open onto all of it.
   */
  test('every probe is behind one disclosure, and it opens', async ({ page }) => {
    await page.setViewportSize(CAM);
    await seenDisplay(page);
    await page.goto('/#/about');

    /*
     * Nothing technical on the page ITSELF.
     *
     * Read as painted text rather than with `toContainText`, which walks
     * `textContent` and therefore reads straight through a closed `<details>`.
     * The distinction is the whole finding: `SHA-256(code)` is a true and
     * useful sentence, and it belongs inside the privacy drawer rather than in
     * front of somebody who clicked a version string.
     */
    const main = page.locator('main');
    const painted = await visibleText(page);
    for (const leak of ['?kraken=1', 'SHA-256', 'H19', 'H20', 'devicePixelRatio', 'rAF']) {
      expect(painted, `"${leak}" is still on the About page`).not.toContain(leak);
    }
    // The address appears exactly once, in the card that uses it. (Block code
    // only: the inline `SHA-256(code)` snippet lives inside the privacy drawer,
    // which the loop above has just proved is not on screen.)
    await expect(page.locator('main .kh-code:not(.kh-code--inline)')).toHaveCount(1);

    const drawer = page.getByTestId('tech-detail');
    await expect(drawer).toHaveCount(1);
    await drawer.locator('summary').click();
    await expect(page.getByRole('heading', { name: 'This browser' })).toBeVisible();
    await expect(page.getByTestId('diag-display-chip')).toBeVisible({ timeout: 15_000 });
    await expect(main).toContainText('devicePixelRatio', { timeout: 15_000 });
  });

  /** One primary on the page, and it is the one the section is named for. */
  test('the Report section has one primary action', async ({ page }) => {
    await page.setViewportSize(CAM);
    await seenDisplay(page);
    await page.goto('/#/about');

    await expect(page.getByTestId('copy-report')).toBeVisible();
    const primaries = await page.evaluate(
      () => document.querySelectorAll('main .kh-btn--primary').length,
    );
    // "Copy report" and "Open in CAM" — the two sections' own single actions.
    expect(primaries).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// R8 — no native pickers anywhere in the configuration UI
// ---------------------------------------------------------------------------

/**
 * Wave A asserted this for the home screen. Round 2's R8 found the rule was
 * true exactly where it had been tested and false everywhere else — the remote
 * still had three `<select>`s and the Connection section had one plus three
 * browser checkboxes. So the assertion is app-wide now, and it walks every
 * route with every drawer opened.
 */
test('no native checkbox, radio or select survives anywhere in the config UI', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await seenDisplay(page);

  for (const hash of ['#/', '#/library', '#/about', '#/remote'] as const) {
    await page.goto(`/?transport=fake&room=ABCD1234${hash}`);
    await expect(page.locator('main')).toBeVisible();

    // Open every drawer on the page, so nothing hides behind one.
    const summaries = page.locator('main details > summary');
    for (let i = 0; i < (await summaries.count()); i++) {
      await summaries.nth(i).click();
    }

    const natives = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          'main select, main input[type="checkbox"], main input[type="radio"]',
        ),
      ].map((el) => el.id || el.className),
    );
    expect(natives, `${hash} still has a native picker`).toEqual([]);
  }
});

// ---------------------------------------------------------------------------
// R10 — thumbs, at phone width
// ---------------------------------------------------------------------------

test.describe('R10 — touch targets', () => {
  /**
   * The loop handles are the ones that matter most: they are the only DRAG in
   * the product, and a drag that starts on an 18 px dot on a phone is a drag
   * that misses. The hit area was already 44 px wide via a `::after` bleed —
   * which is invisible to every measurement, including this one, which is
   * exactly why the dot moved into a `::before` and the button became the
   * target.
   *
   * This pair is all that is left here. Round 3's F6 found that the rest of
   * this block — a list of five selectors — had been passing while the four
   * MODULE CHIPS, the app's primary gesture, sat at 36 px underneath it. The
   * general sweep lives in `tap-targets.spec.ts` and enumerates every visible
   * interactive element on every route rather than the ones round 2 happened
   * to photograph. These two stay because the drag deserves its own name.
   */
  test('the loop handles are 44 px drag targets on a phone', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await seenDisplay(page);
    await page.goto('/');

    await page.getByTestId('module-chip-video').click();
    await page.getByTestId('ops-loop-button').click();
    await expect(page.getByTestId('ops-loop-panel')).toBeVisible();

    for (const id of ['loop-handle-a', 'loop-handle-b'] as const) {
      const box = await boxOf(page.getByTestId(id));
      expect(box.width, `${id} is too narrow to grab`).toBeGreaterThanOrEqual(TAP_PX);
      expect(box.height, `${id} is too short to grab`).toBeGreaterThanOrEqual(TAP_PX);
    }
  });
});

// ---------------------------------------------------------------------------
// R7 — the library's tiles carry information
// ---------------------------------------------------------------------------

test.describe('R7 — library tiles', () => {
  const FIXTURE = new URL('../../public/demo/demo.mp4', import.meta.url);

  test('a tile is a picture, a name, a duration and a size — and nothing else', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto('/?cam=1#/library');

    // The + is a labelled button now, which is what let the empty card stop
    // explaining where its own button was.
    const add = page.getByTestId('library-add');
    await expect(add).toContainText('Add');
    await expect(page.getByTestId('library-empty')).not.toContainText('button in the corner');
    // …and the shelf's promise is made once, not in the header AND the card.
    const promise = 'plays with the network unplugged';
    expect(
      await page
        .locator('main')
        .evaluate((root, needle) => root.textContent.split(needle).length - 1, promise),
    ).toBeLessThanOrEqual(1);

    await add.click();
    await page.locator('[data-testid="clip-file-input"]').setInputFiles(FIXTURE.pathname);
    const tile = page.locator('[data-testid="library-tile"]').first();
    await expect(tile).toHaveAttribute('data-tile-state', 'ready', { timeout: 15_000 });

    // No CLIP badge over the one part of the tile that is informative.
    await expect(tile.locator('.kh-tile__badge')).toHaveCount(0);
    await expect(tile).not.toContainText('CLIP');
    // …and no pixel dimensions on the detail line.
    await expect(tile).not.toContainText('640×640');
    // Something to recognise it by: either the real frame or the treated card.
    await expect(tile.locator('.kh-tile__thumb')).toBeVisible();
  });
});
