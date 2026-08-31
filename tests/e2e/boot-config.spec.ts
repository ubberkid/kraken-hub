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
    // Home is "Your Kraken": the halo, the one primary action, the module chips.
    await expect(page.getByTestId('mirror')).toBeVisible();
    await expect(page.getByTestId('paste-input')).toBeVisible();
    await expect(page.getByTestId('module-chip-video')).toHaveAttribute('aria-pressed', 'true');
    // Six tabs → zero: the header is a wordmark, and nothing else.
    await expect(page.getByRole('navigation', { name: 'Sections' })).toHaveCount(0);
    // The version footer proves the build-time defines reached the bundle.
    await expect(page.locator('.kh-footer')).toContainText('kraken-hub v');

    // No display surface on this page. (The mirror's iframe is a separate
    // document, so `.kh-stage` in THIS frame would still be a config-UI leak.)
    await expect(page.locator('.kh-stage')).toHaveCount(0);

    await page.getByTestId('disclosure-about').click();
    await expect(
      page.getByRole('heading', { name: 'kraken-hub', level: 2, exact: true }),
    ).toBeVisible();
    // The install instructions did not vanish with the Setup home — they moved.
    await expect(page.getByTestId('setup-about')).toBeVisible();
    expect(new URL(page.url()).hash).toBe('#/about');

    await page.goto('/#/diag');
    await expect(page.getByRole('heading', { name: 'This browser' })).toBeVisible();

    expect(errors).toEqual([]);
  });

  /**
   * First run, done the Apple way.
   *
   * The install card is the most important thing on the page until a Kraken has
   * ever connected, and then it must get out of the way for good. The trigger is
   * evidence rather than a dismiss button — `displaySeen.ts` latches on anything
   * the DISPLAY published to this origin — because nobody dismisses the one card
   * that would have fixed their black screen, and nobody with a working cooler
   * should be shown step one again.
   */
  test('the CAM install card appears on the home screen until a display connects', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('setup-first-run')).toBeVisible();
    await expect(page.getByTestId('setup-copy-url')).toBeVisible();

    // Evidence: exactly what the display module publishes during ordinary use.
    await page.evaluate(() => {
      localStorage.setItem(
        'kraken-hub:v1:video:tele',
        JSON.stringify({
          ch: 'tele',
          kind: 'videoStats',
          ts: Date.now(),
          display: { w: 640, h: 640, shape: 'circle', targetFps: 40 },
        }),
      );
    });
    await page.reload();
    await expect(page.getByTestId('setup-first-run')).toHaveCount(0);

    // …and it stays gone once the evidence itself expires.
    await page.evaluate(() => {
      localStorage.removeItem('kraken-hub:v1:video:tele');
    });
    await page.reload();
    await expect(page.getByTestId('setup-first-run')).toHaveCount(0);

    // It is still reachable, quietly, where somebody setting up a second
    // machine would look for it.
    await page.goto('/#/about');
    await expect(page.getByTestId('setup-about')).toBeVisible();
  });

  /**
   * `#/sources` became `#/library`. Old links must still land — in page, without
   * a navigation (invariant I1/I2), exactly like `#/preview` before it.
   */
  test('#/sources resolves to the library without navigating', async ({ page }) => {
    let loads = 0;
    page.on('load', () => {
      loads += 1;
    });

    await page.goto('/#/sources');
    await expect(page.getByRole('heading', { name: 'Add a video' })).toBeVisible();
    await expect.poll(() => new URL(page.url()).hash).toBe('#/library');
    expect(loads).toBe(1);

    // And the home screen's quiet row points at the new name.
    await page.goto('/');
    await expect(page.getByTestId('disclosure-library')).toHaveAttribute('href', '#/library');
  });

  /**
   * The Preview tab is gone: the home screen carries a live mirror of the LCD,
   * so the route it used to own now folds into the mirror. Old links must still
   * land somewhere — in page, without a navigation (invariant I1).
   */
  test('#/preview folds into the mirror without navigating', async ({ page }) => {
    // A hash rewrite fires no `load`; a navigation or a reload does. One load
    // for `goto`, and no second one, is the whole assertion.
    let loads = 0;
    page.on('load', () => {
      loads += 1;
    });

    await page.goto('/#/preview');
    await expect(page.getByTestId('mirror')).toBeVisible();
    await expect.poll(() => new URL(page.url()).hash).toBe('#/');
    expect(new URL(page.url()).pathname).toBe('/');
    expect(loads).toBe(1);
  });

  /**
   * The mirror is the REAL display page, booted the way CAM boots it and
   * sharing this window's localStorage — not a lookalike React tree. Video is
   * the one exception: a second player would mean a second decoder, a second
   * download and, on an embed, a second set of ads.
   */
  test('the mirror runs the real display for every module but video', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('mirror')).toHaveAttribute('data-mirror-mode', 'surface');
    await expect(page.locator('.kh-halo__frame')).toHaveCount(0);

    await page.getByTestId('module-chip-clock').click();
    await expect(page.getByTestId('mirror')).toHaveAttribute('data-mirror-mode', 'live');

    const frame = page.frameLocator('.kh-halo__frame');
    await expect(frame.locator('.kh-stage')).toBeVisible();
    await expect(frame.locator('.kh-clock')).toBeVisible();
  });

  /**
   * One primary action. The paste row routes through the SAME validation the
   * module panel uses, so a link that cannot play says so before it is stored.
   */
  test('the paste row validates, then commits the source', async ({ page }) => {
    await page.goto('/');

    await page.getByTestId('paste-input').fill('https://example.test/clip.mkv');
    await page.getByTestId('paste-submit').click();
    await expect(page.locator('.kh-notice--error')).toContainText('.mkv');

    await page.getByTestId('paste-input').fill('https://example.test/clips/dunes.mp4');
    await page.getByTestId('paste-submit').click();
    await expect(page.locator('.kh-notice--error')).toHaveCount(0);
    await expect(page.getByTestId('status-line')).toContainText('dunes.mp4');

    const stored = await page.evaluate(() => {
      const raw = localStorage.getItem('kraken-hub:v1:state');
      const state = raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
      const modules = (state['modules'] ?? {}) as Record<string, { cfg?: { url?: string } }>;
      return { active: state['activeModuleId'], url: modules['video']?.cfg?.url };
    });
    expect(stored).toEqual({ active: 'video', url: 'https://example.test/clips/dunes.mp4' });
  });

  /**
   * The download story, told in plain words (prototype screen 2).
   *
   * Keeping a local copy is the app's biggest differentiator and it used to
   * happen silently; the three step cards are the whole point of the redesign's
   * second screen, so the words on them are behaviour, not decoration. The
   * mirror this reads is the one the DISPLAY writes while it fetches — seeded
   * here directly, because the point under test is the config window's reading
   * of it, not the fetch (`video.spec.ts` covers the download itself).
   */
  test('the download story names the provider and reports progress in words', async ({ page }) => {
    const seed = (state: string, received: number): string =>
      JSON.stringify([
        {
          id: 'd1',
          url: 'https://youtu.be/jfKfPfyJRdk',
          name: 'lofi hip hop radio',
          state,
          receivedBytes: received,
          totalBytes: 134_217_728,
          attempt: 1,
          error: null,
          clipId: state === 'done' ? 'c1' : null,
          startedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]);

    await page.addInitScript(() => {
      localStorage.setItem('kraken-hub:v1:config:displaySeen', '1');
    });
    await page.goto('/');
    await page.evaluate(
      (v) => {
        localStorage.setItem('kraken-hub:v1:video:downloads', v);
      },
      seed('downloading', 53_687_091),
    );

    const flow = page.getByTestId('paste-flow');
    await expect(flow).toBeVisible();
    // Detection is legible: the app agrees, by name, with the link you pasted.
    await expect(flow).toContainText('YouTube video detected');
    await expect(flow).toContainText('lofi hip hop radio');
    await expect(flow).toContainText('Saving to your Kraken');
    // The number lives in the sentence, as the prototype writes it — not as a
    // second label echoing the bar it sits beside.
    await expect(flow).toContainText('Downloading locally — 40%');
    await expect(flow.locator('.kh-meter__label')).toHaveCount(0);
    // Step three is dimmed until it is actually true.
    await expect(flow.locator('li').nth(2)).not.toHaveClass(/kh-step--on/);

    await page.evaluate(
      (v) => {
        localStorage.setItem('kraken-hub:v1:video:downloads', v);
      },
      seed('done', 134_217_728),
    );
    await expect(flow).toContainText('128 MB · kept in your library');
    await expect(flow.locator('li').nth(2)).toHaveClass(/kh-step--on/);
    await expect(flow).toContainText('On screen now');
  });

  /**
   * Contextual options, in place: the inline ops line opens the module's own
   * settings panel under the halo rather than sending anyone to a settings page
   * — and lands on the CONTROL IT NAMES, not merely somewhere in the panel. A
   * line that says "Format · 24 h" and then dumps you at the top of a settings
   * card has made you do the finding twice.
   */
  test('an inline op opens the module panel and focuses the control it names', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('module-chip-clock').click();

    await expect(page.getByTestId('ops-panel')).toHaveCount(0);
    await page.getByTestId('ops-format').click();
    await expect(page.getByTestId('ops-panel')).toBeVisible();
    await expect(page.getByLabel('Hour format')).toBeVisible();
    await expect(page.locator('#clock-hour-format')).toBeFocused();

    // A second op moves the focus to ITS control, in the same open panel.
    await page.getByTestId('ops-seconds').click();
    await expect(page.locator('#clock-seconds')).toBeFocused();
  });

  /**
   * The advisory is the one piece of copy that must never fire on a guess: this
   * window's own geometry fallback is 640/30 in any ordinary browser, and a
   * warning about a slider the user already raised is how a correct app earns a
   * reputation for crying wolf. It fires only on a number the DISPLAY published.
   */
  test('the low-frame-rate advisory follows the display, not this window', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('fps-banner')).toHaveCount(0);

    await page.evaluate(() => {
      localStorage.setItem(
        'kraken-hub:v1:video:tele',
        JSON.stringify({
          ch: 'tele',
          kind: 'videoStats',
          ts: Date.now(),
          display: { w: 640, h: 640, shape: 'circle', targetFps: 1 },
        }),
      );
    });
    await expect(page.getByTestId('fps-banner')).toContainText('Frame Rate');

    await page.evaluate(() => {
      localStorage.setItem(
        'kraken-hub:v1:video:tele',
        JSON.stringify({
          ch: 'tele',
          kind: 'videoStats',
          ts: Date.now(),
          display: { w: 640, h: 640, shape: 'circle', targetFps: 40 },
        }),
      );
    });
    await expect(page.getByTestId('fps-banner')).toHaveCount(0);
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

  /**
   * The home screen is the one every user sees, so it has to be usable at CAM's
   * real window size: the halo scales down rather than being clipped, and the
   * WHOLE composition — halo, status, the one action, the chips, the ops line
   * and the quiet way down — is visible at once, the way the prototype draws it.
   *
   * That last part is the assertion that matters. This app has no tabs: the
   * `Remote · Library · Diagnostics` row IS its navigation, and a build where it
   * loads below the fold in the only window CAM ever opens is a build where the
   * navigation is invisible on arrival. It was, before the short-viewport rhythm
   * in `ui.css`, by about a hundred pixels.
   */
  test('the home screen is usable and complete in a CAM-sized window', async ({ page }) => {
    await page.setViewportSize({ width: 866, height: 537 });
    // The steady state, not first run: once a Kraken has connected the install
    // card is gone and the halo is the first thing on the page. First run is
    // covered by its own test above.
    await page.addInitScript(() => {
      localStorage.setItem('kraken-hub:v1:config:displaySeen', '1');
    });
    await page.goto('/');

    const halo = page.getByTestId('mirror');
    await expect(halo).toBeInViewport();
    const box = await halo.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.width).toBeLessThanOrEqual(866);
    // Scaled down, not shrunk to nothing.
    expect(box?.width).toBeGreaterThan(150);
    // Round: the bezel is what makes it read as the object.
    expect(box?.width).toBeCloseTo(box?.height ?? 0, 0);

    await page.getByTestId('paste-input').click({ trial: true });

    // Everything the prototype puts on screen 1, on screen, without scrolling.
    for (const id of ['status-line', 'module-chip-video', 'ops-fill'] as const) {
      await expect(page.getByTestId(id)).toBeInViewport();
    }
    const wayDown = page.getByTestId('disclosure-diag');
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expect(wayDown).toBeInViewport();
    await wayDown.click({ trial: true });

    // The page still scrolls — the footer is below the fold and has to be
    // reachable, which is the scroll-lock regression this suite exists for.
    const metrics = await scrollMetrics(page);
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

    await page.locator('.kh-footer').scrollIntoViewIfNeeded();
    await expect(page.locator('.kh-footer')).toBeInViewport();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  });

  /**
   * The remote at a real phone size.
   *
   * The Halo remote is short by design — halo, scrubber, transport, one pairing
   * card — so it can now FIT on a phone with nothing below the fold, which is
   * the point. What must still hold is that anything a user opens is reachable:
   * expanding a disclosure has to produce a page that scrolls all the way to the
   * footer, which is the bug the scroll lock caused in the first place.
   */
  test('the remote is usable on a phone and scrolls once a disclosure is open', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/remote');

    await expect(page.getByRole('heading', { name: 'kraken-hub', level: 1 })).toBeVisible();

    // Nothing is clipped horizontally at 390: a phone must never side-scroll.
    const widths = await page.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    });
    expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);

    // The transport is reachable without scrolling — it is what the page is for.
    await expect(page.getByTestId('transport-hold')).toBeInViewport();

    await page.getByTestId('more-controls').locator('summary').first().click();
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
