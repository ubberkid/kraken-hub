import { expect, test, type Page } from '@playwright/test';

/**
 * Round 4 — the finishing round, and its one theme.
 *
 * Every previous round fixed a class and then applied it to the states somebody
 * had photographed. The receipt was never in the page-fit matrix (F1, asserted
 * in `home-composition.spec.ts`, next to the composition it is about). This file
 * carries the other three:
 *
 *  - **F2** — a control's DEPTH is a property of the control. Stats' Colour used
 *    to hop between the top level and Advanced depending on the Layout segment,
 *    because the empty-room rule relocated controls instead of opening a door.
 *  - **F3** — there was no reachable exit. With Advanced open the page is
 *    1,343 px in a 537 px window and the panel's × sat 557 px above the fold,
 *    inside a browser with no chrome of its own.
 *  - **F5** — identity and status may not share a colour channel. The unit test
 *    (`libraryItems.test.ts`) proves the hue band; this proves the other half,
 *    that a failed tile is marked as failed rather than merely unlucky.
 */

const CAM = { width: 866, height: 537 } as const;

async function cam(page: Page): Promise<void> {
  await page.setViewportSize(CAM);
  await page.addInitScript(() => {
    localStorage.setItem('kraken-hub:v1:config:displaySeen', '1');
  });
}

/** Switch to a module and open its options, whichever chip we started on. */
async function openOptions(page: Page, id: string): Promise<void> {
  const chip = page.getByTestId(`module-chip-${id}`);
  await chip.click();
  if ((await chip.getAttribute('aria-expanded')) !== 'true') await chip.click();
  await expect(page.getByTestId('ops-panel')).toBeVisible();
}

// ---------------------------------------------------------------------------
// F2 — depth is a property of the control
// ---------------------------------------------------------------------------

test.describe('F2 — a control does not change depth under the user', () => {
  /**
   * The exact gesture that moved it.
   *
   * Layout lives on the ops strip and is about how many dials are drawn. Stats'
   * one primary control — Reading — only means anything on the single-dial
   * layout, so on Two and All the panel had no primary set, and round 3's rule
   * answered that by promoting the Advanced controls into the panel itself.
   * Pressing a segment about dials therefore restructured the options
   * underneath it: Colour at the top level on Two, behind a door on One.
   */
  test('Stats’ Colour stays behind Advanced whatever the Layout segment says', async ({ page }) => {
    await cam(page);
    await page.goto('/');
    await openOptions(page, 'stats');

    for (const layout of ['single', 'dual', 'grid', 'single'] as const) {
      await page.getByTestId(`home-stats-layout-${layout}`).click();
      // The control exists, in every layout…
      const colour = page.locator('#stats-theme');
      await expect(colour).toHaveCount(1);
      // …and it is inside the one Advanced door, in every layout.
      const depth = await page.evaluate(() => {
        const el = document.querySelector('#stats-theme');
        if (el === null) return null;
        const details = el.closest('details');
        const panel = el.closest('[data-testid="ops-panel"]');
        return {
          behindADoor: details !== null,
          summary: details?.querySelector('summary')?.textContent ?? null,
          insidePanel: panel !== null,
        };
      });
      expect(depth?.insidePanel, `${layout}: Colour left the options panel`).toBe(true);
      expect(depth?.behindADoor, `${layout}: Colour hopped out of Advanced`).toBe(true);
      expect(depth?.summary).toBe('Advanced');
    }
  });

  /**
   * …and the same rule read from the other side: the door is where the panel's
   * only content lives, so it is OPEN on arrival rather than absent.
   *
   * That is the half of round 3's F5 this preserves — one tap still lands on a
   * control, never on a signpost sentence and a closed disclosure.
   */
  test('a panel with nothing above the door opens with the door open', async ({ page }) => {
    await cam(page);
    await page.goto('/');
    // Two dials is the default layout, so Stats has no primary control here.
    await openOptions(page, 'stats');

    const advanced = page.getByTestId('stats-advanced');
    await expect(advanced).toBeVisible();
    expect(await advanced.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);
    await expect(page.locator('#stats-theme')).toBeVisible();
    // The page says which promise it is making, and the promise matches: an
    // open door means the taller, scrolling composition.
    await expect(page.locator('.kh-home')).toHaveAttribute('data-advanced', 'true');
  });

  /** Clock's Colour is advanced too, and Clock always has a primary control. */
  test('Clock’s Colour is behind the same door, at the same depth', async ({ page }) => {
    await cam(page);
    await page.goto('/');
    await openOptions(page, 'clock');
    await expect(page.getByTestId('clock-date-on')).toBeVisible();
    const behind = await page.evaluate(
      () => document.querySelector('#clock-theme')?.closest('details') !== null,
    );
    expect(behind).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F3 — there is always a way out
// ---------------------------------------------------------------------------

test.describe('F3 — the exit is reachable', () => {
  test('Escape closes the options panel', async ({ page }) => {
    await cam(page);
    await page.goto('/');
    await openOptions(page, 'clock');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('ops-panel')).toHaveCount(0);
    await expect(page.getByTestId('module-chip-clock')).toHaveAttribute('aria-expanded', 'false');
  });

  test('Escape closes the loop scrubber', async ({ page }) => {
    await cam(page);
    await page.goto('/');
    await page.getByTestId('ops-loop-button').click();
    await expect(page.getByTestId('ops-loop-panel')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('ops-loop-panel')).toHaveCount(0);
  });

  /** …and it works from the bottom of a page taller than the window. */
  test('Escape closes an Advanced panel from the bottom of the scroll', async ({ page }) => {
    await cam(page);
    await page.goto('/');
    await openOptions(page, 'video');
    await page.getByTestId('video-advanced').locator('summary').click();
    await expect(page.locator('.kh-home')).toHaveAttribute('data-advanced', 'true');

    await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('ops-panel')).toHaveCount(0);
  });

  /**
   * The pointer's version of the same promise.
   *
   * CAM's Configuration Browser has no back button, no address bar and no tab
   * strip: if the app's own × is off the screen there is nothing else. At the
   * bottom of the Advanced flow it was 557 px above the fold, so the head is
   * sticky while `data-advanced` is true.
   */
  test('the × is on the screen at every scroll position while Advanced is open', async ({
    page,
  }) => {
    await cam(page);
    await page.goto('/');
    await openOptions(page, 'video');
    await page.getByTestId('video-advanced').locator('summary').click();
    await expect(page.locator('.kh-home')).toHaveAttribute('data-advanced', 'true');

    // The state this is about: the page really is taller than the window.
    const scrollable = await page.evaluate(() => {
      const doc = document.scrollingElement ?? document.documentElement;
      return doc.scrollHeight - doc.clientHeight;
    });
    expect(scrollable, 'Advanced did not produce the scrolling composition').toBeGreaterThan(0);

    await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
    await expect(page.getByTestId('ops-close')).toBeInViewport({ ratio: 1 });
    // And it still closes the panel from down there.
    await page.getByTestId('ops-close').click();
    await expect(page.getByTestId('ops-panel')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// F5 — warm means one thing
// ---------------------------------------------------------------------------

test.describe('F5 — a failed tile is marked failed, not merely unlucky', () => {
  const JOB = {
    id: 'd1',
    url: 'https://example.test/clips/sunset.mp4',
    sourceUrl: 'https://example.test/clips/sunset.mp4',
    name: 'sunset.mp4',
    receivedBytes: 2_097_152,
    totalBytes: 8_388_608,
    error: null,
    clipId: null,
  };

  async function seed(page: Page, state: string, reason: string | null): Promise<void> {
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

  /**
   * The identity hue is a hash of the name and used to span the whole wheel, so
   * six of twenty sample filenames landed in red or amber — the colours this
   * product uses for one thing. The band is clamped to blue → teal → violet in
   * `libraryItems.tileHue`, and the warm treatment is applied from
   * `data-tile-state` instead, which is a fact about the download.
   */
  test('the failure colour comes from the state, and only from the state', async ({ page }) => {
    await cam(page);
    await seed(page, 'error', 'quota');
    await page.goto('/?cam=1#/library');

    const tile = page.locator('[data-testid="library-tile"]').first();
    await expect(tile).toHaveAttribute('data-tile-state', 'failed');
    const failed = await tile
      .getByTestId('tile-treated')
      .evaluate((el) => getComputedStyle(el).filter);

    // A tile with the SAME name, downloading rather than failed: identical hash,
    // different treatment. That is the whole point — the colour is the state.
    const other = await page.context().newPage();
    await other.setViewportSize(CAM);
    await seed(other, 'downloading', null);
    await other.goto('/?cam=1#/library');
    const running = other.locator('[data-testid="library-tile"]').first();
    await expect(running).toHaveAttribute('data-tile-state', 'downloading');
    const ok = await running
      .getByTestId('tile-treated')
      .evaluate((el) => getComputedStyle(el).filter);

    expect(failed).not.toBe(ok);
    expect(failed).toContain('hue-rotate');
    await other.close();
  });
});

// ---------------------------------------------------------------------------
// Minors with a string or a number behind them
// ---------------------------------------------------------------------------

test.describe('round 4 minors', () => {
  /** A link label names the page it opens. There is no Diagnostics page. */
  test('the remote’s one link says where it goes', async ({ page }) => {
    await page.setViewportSize(CAM);
    await page.goto('/?transport=fake&room=ABCD1234#/remote');
    const link = page.getByTestId('remote-connection-link');
    await expect(link).toHaveText('About');
    await expect(link).toHaveAttribute('href', '#/about');
  });

  /** The build id is on this page once — in the footer, which is how you got here. */
  test('About prints the version exactly once', async ({ page }) => {
    await page.setViewportSize(CAM);
    await page.goto('/#/about');
    await expect(page.getByTestId('about-build')).toBeVisible();
    const times = await page.evaluate(() => {
      const text = document.body.innerText;
      // Whatever this build calls itself — read it off the footer rather than
      // hard-coding a number that moves every release.
      const version = /v(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null;
      if (version === null) return -1;
      return text.split(version).length - 1;
    });
    expect(times, 'the build id is printed more than once on the About page').toBe(1);
  });

  /** The receipt's second line is dropped when it only restates the headline. */
  test('the YouTube receipt does not say the same thing twice', async ({ page }) => {
    await cam(page);
    await page.goto('/');
    await page.getByTestId('paste-input').fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await page.getByTestId('paste-submit').click();

    const flow = page.getByTestId('paste-flow');
    await expect(flow).toHaveAttribute('data-flow-stage', 'youtube-embed');
    await expect(flow).toContainText('YouTube video detected');
    await expect(flow).not.toContainText('a YouTube video');
  });

  /** The quality reading is a resting state, not an apology for one. */
  test('an unreported quality reads as Auto and nothing else', async ({ page }) => {
    await cam(page);
    await page.goto('/');
    await openOptions(page, 'video');
    const panel = page.getByTestId('ops-panel');
    await expect(panel).not.toContainText('not reported yet');
  });
});
