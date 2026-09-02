import { expect, test } from '@playwright/test';

import { KEPT_A_COPY } from '../../src/config/vocabulary';

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

    /*
     * No display surface on this page — asserted where it is still a rule.
     *
     * The mirror's iframe is a separate document, so `.kh-stage` in THIS frame
     * used to mean a config-UI leak. Since the editor shipped it means one more
     * thing, legitimately: at editor widths the halo IS a real `LayerHost`
     * running the real renderers (principle 1, "the canvas is the halo"), and a
     * `.kh-stage` in the frame is that compositor rather than a leak. The
     * project's viewport is `devices['Desktop Chrome']` — 1280 wide — so this
     * page is in the editor by default and the count is 1.
     *
     * Below `PHONE_QUERY`'s 700 px there is no editor and the old rule is
     * exactly as strong as it was, so it is asserted there.
     */
    await page.setViewportSize({ width: 640, height: 640 });
    await expect(page.getByTestId('layer-rail')).toHaveCount(0);
    await expect(page.locator('.kh-stage')).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.getByTestId('disclosure-about').click();
    // The page is named once, by the breadcrumb whose job is naming pages —
    // the panel below used to print "About" again 30 px under it (round 3).
    await expect(page.locator('.kh-subhead__title')).toHaveText('About');
    // The install instructions did not vanish with the Setup home — they moved.
    await expect(page.getByTestId('setup-about')).toBeVisible();
    expect(new URL(page.url()).hash).toBe('#/about');

    await page.goto('/#/diag');
    // The probes live behind "Show the technical detail" since round 2's R3;
    // what is on the page itself is the section they belong to.
    await expect(page.getByRole('heading', { name: 'Report', exact: true })).toBeVisible();

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
    /*
     * One primary action on the band; the address behind a reveal.
     *
     * The card used to put four buttons on the first screen a user ever sees
     * (design audit, F7). "Open in CAM" is the one that does the job, so it is
     * the only one on the band — and the address, which the user needs only when
     * that button cannot reach CAM, is one press away and still copyable.
     */
    await expect(page.getByTestId('setup-open-cam')).toBeVisible();
    await expect(page.getByTestId('setup-copy-url')).toHaveCount(0);
    await page.getByTestId('setup-reveal-address').click();
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

    await page.goto('/?cam=1#/sources');
    // "Library", not "Your library": the shelf answered to six names and now
    // answers to one (wave 1, A5), and the name it answers to is the sub-page
    // header's — the page's own duplicate `<h2>` two rows below it is gone.
    await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
    await expect.poll(() => new URL(page.url()).hash).toBe('#/library');
    expect(loads).toBe(1);

    // And the home screen's quiet row points at the new name.
    await page.goto('/');
    await expect(page.getByTestId('disclosure-library')).toHaveAttribute('href', '#/library');
  });

  /**
   * About and Diagnostics were the same errand behind two doors in two type
   * styles (design audit, F7/F8): `Remote · Library · Diagnostics` in the home
   * screen's quiet row, and `About` alone in the footer. They are one page now,
   * behind the footer's version line, and `#/diag` still resolves to it — in
   * page, without a navigation (invariant I1/I2).
   */
  test('#/diag resolves to the merged About page without navigating', async ({ page }) => {
    let loads = 0;
    page.on('load', () => {
      loads += 1;
    });

    await page.goto('/#/diag');

    // Both halves are on the one page — three calm sections since R3.
    const main = page.getByRole('main');
    await expect(page.locator('.kh-subhead__title')).toHaveText('About');
    await expect(main.getByRole('heading', { name: 'Connection', exact: true })).toBeVisible();
    await expect(main.getByRole('heading', { name: 'Report', exact: true })).toBeVisible();

    await expect.poll(() => new URL(page.url()).hash).toBe('#/about');
    expect(loads).toBe(1);

    // The home screen's quiet row is exactly two destinations, and the footer's
    // version line is the way to this page.
    await page.goto('/');
    await expect(page.getByTestId('disclosure-remote')).toBeVisible();
    await expect(page.getByTestId('disclosure-library')).toBeVisible();
    await expect(page.getByTestId('disclosure-diag')).toHaveCount(0);
    await expect(page.getByTestId('disclosure-about')).toHaveAttribute('href', '#/about');
    await expect(page.getByTestId('disclosure-about')).toContainText('kraken-hub v');
  });

  /**
   * Type: `--kh-mono` is for literal machine strings, and nothing else.
   *
   * It used to set the app's entire navigation row and its footer — "the single
   * loudest way a product says 'engineered' when it meant to say 'considered'"
   * (design audit, F8). A spot check on one of each, because the rule is only
   * worth having if a regression fails a build rather than a review.
   */
  test('only machine strings are set in the code face', async ({ page }) => {
    await page.goto('/#/about');

    const face = async (selector: string): Promise<string> =>
      page
        .locator(selector)
        .first()
        .evaluate((el) => getComputedStyle(el).fontFamily);

    // The install URL is a literal machine string: mono, and staying mono.
    expect(await face('.kh-code')).toContain('monospace');

    // Navigation and chrome are not.
    for (const selector of ['.kh-footer', '.kh-footer a', '.kh-subhead__title']) {
      expect(await face(selector)).not.toContain('monospace');
    }

    await page.goto('/');
    for (const selector of ['.kh-more', '.kh-more a']) {
      expect(await face(selector)).not.toContain('monospace');
    }
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
    /*
     * Narrow, because the IFRAME mirror is the narrow composition's halo.
     *
     * At editor widths the halo is not an iframe at all — it is the editor's own
     * `LayerHost`, and the mirror says so (`data-mirror-mode="editor"`, asserted
     * below). The iframe path this test is about is what a window under
     * `PHONE_QUERY`'s 700 px still gets, and it is the path with the property
     * worth pinning: the mirror is the REAL display page rather than a
     * lookalike React tree.
     */
    await page.setViewportSize({ width: 640, height: 640 });
    // `?cam=1` — the live mirror is an iframe of the real display page, and
    // that is only true on the window that shares CAM's storage partition
    // (wave 1, A1). Any other browser would boot a SECOND display.
    await page.goto('/?cam=1');
    await expect(page.getByTestId('mirror')).toHaveAttribute('data-mirror-mode', 'surface');
    await expect(page.locator('.kh-halo__frame')).toHaveCount(0);

    await page.getByTestId('module-chip-clock').click();
    await expect(page.getByTestId('mirror')).toHaveAttribute('data-mirror-mode', 'live');

    const frame = page.frameLocator('.kh-halo__frame');
    await expect(frame.locator('.kh-stage')).toBeVisible();
    await expect(frame.locator('.kh-clock')).toBeVisible();

    // …and the editor's halo is the third mode, named rather than inferred: no
    // iframe, no surface card, a compositor in this document.
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(page.getByTestId('mirror')).toHaveAttribute('data-mirror-mode', 'editor');
    await expect(page.locator('.kh-halo__frame')).toHaveCount(0);
    await expect(page.locator('.kh-stage')).toHaveCount(1);
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
      // The story belongs to the source configured RIGHT NOW: the entry seeded
      // below is this window's business only because it is a download of the
      // link on the screen. (For a while the flow showed the first entry of a
      // mirror nobody prunes, whatever was playing — see `paste-flow.spec.ts`.)
      // The entry itself is deliberately written in the OLD shape, with no
      // `sourceUrl` and no `reason`, because that is what an upgrade finds.
      localStorage.setItem(
        'kraken-hub:v1:state',
        JSON.stringify({
          schema: 2,
          rev: 1,
          updatedAt: Date.now(),
          writerId: 'e2e-config',
          writerRole: 'config',
          activeModuleId: 'video',
          modules: { video: { v: 1, cfg: { url: 'https://youtu.be/jfKfPfyJRdk' } } },
        }),
      );
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
    // One vocabulary: the ladder, the status line and the (now deleted) strip
    // badge all used to say a different word for this (round 2, R5).
    await expect(flow).toContainText('Keeping a copy');
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
    /*
      `128.0`, not `128` — round 5's byte-formatter merge.

      This line used to run the home screen's own copy of the formatter at
      `MB_DECIMALS = 0`, which rendered every download under half a megabyte as
      "0 MB" while the bytes were visibly climbing. There is one formatter now
      (`src/lib/bytes.ts`), it keeps one decimal above a megabyte, and the whole
      product says the size the same way.
    */
    await expect(flow).toContainText(`128.0 MB · ${KEPT_A_COPY}`);
    await expect(flow.locator('li').nth(2)).toHaveClass(/kh-step--on/);
    await expect(flow).toContainText('On screen now');
  });

  /**
   * The ops strip resolves in place.
   *
   * It used to be three lines of text that LOOKED like toggles and all opened
   * the same 1,600 px settings wall, scroll-jumping 1,363 px into it (design
   * audit, F2). Pressing one now changes the setting where it stands, opens
   * nothing, and moves nobody.
   */
  test('an inline op changes the setting where it stands, and opens nothing', async ({ page }) => {
    // The steady state, in the window CAM actually opens: the whole
    // composition is on screen at once, so any scroll below would be the app's
    // doing rather than the click's scroll-into-view.
    await page.setViewportSize({ width: 866, height: 537 });
    await page.addInitScript(() => {
      localStorage.setItem('kraken-hub:v1:config:displaySeen', '1');
    });
    await page.goto('/');
    await page.getByTestId('module-chip-clock').click();
    await expect(page.getByTestId('ops-panel')).toHaveCount(0);

    /*
     * `ed-base-format-12`, not `home-clock-hour-format-12`.
     *
     * The strip is declared by the module and rendered generically now
     * (`SelectionStrip`), so a control's id is `ed-<layer>-<control>` and a
     * Segmented option's is that plus its value. The ids moved with the
     * mechanism; the property this test is about — the press resolves in place,
     * opens nothing and scrolls nobody — did not.
     */
    await page.getByTestId('ed-base-format-12').click();
    await expect(page.getByTestId('ed-base-format-12')).toHaveAttribute('aria-checked', 'true');
    // The whole point: no panel, no scroll, no page.
    await expect(page.getByTestId('ops-panel')).toHaveCount(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    await page.getByTestId('ed-base-seconds-off').click();
    await expect(page.getByTestId('ed-base-seconds-off')).toHaveAttribute('aria-checked', 'true');
    // And it is the real setting, not a local widget state.
    const stored = await page.evaluate(() => localStorage.getItem('kraken-hub:v1:state') ?? '');
    expect(stored).toContain('"hourFormat":"12"');
    expect(stored).toContain('"showSeconds":false');
  });

  /**
   * Options are contextual: the chip that is already active IS the door.
   *
   * Before this there was no button anywhere in the product called Settings,
   * Options or Edit, and `#/module/<id>` had zero inbound links (audit F1).
   */
  test('tapping the active chip reveals that module’s options, and hides them again', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByTestId('module-chip-clock').click();
    const chip = page.getByTestId('module-chip-clock');
    await expect(chip).toHaveAttribute('aria-expanded', 'false');

    await chip.click();
    await expect(page.getByTestId('ops-panel')).toBeVisible();
    await expect(chip).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('heading', { name: 'Clock', exact: true })).toBeVisible();
    // The halo never leaves: the panel appears UNDER the composition, it does
    // not replace it and it does not teleport the scroll position.
    await expect(page.getByTestId('mirror')).toBeInViewport();

    await page.getByTestId('ops-close').click();
    await expect(page.getByTestId('ops-panel')).toHaveCount(0);
  });

  /**
   * The number the whole redesign is answerable to.
   *
   * Clicking `Loop Off` on the shipped build grew the home page to **2,121 px**
   * — four screens — and jumped `window.scrollY` to 1,363, leaving the halo,
   * the paste row and the chips off screen entirely (design audit, F2, with the
   * measurement in `tasks.mjs`). The video panel is the biggest one there is, so
   * it is the one the ceiling is measured on.
   */
  test('opening the video options keeps the halo on screen and the page under two screens', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 866, height: 537 });
    await page.addInitScript(() => {
      localStorage.setItem('kraken-hub:v1:config:displaySeen', '1');
    });
    await page.goto('/');

    const before = await page.evaluate(
      () => (document.scrollingElement ?? document.documentElement).scrollHeight,
    );
    await page.getByTestId('module-chip-video').click();
    await expect(page.getByTestId('ops-panel')).toBeVisible();
    // Wait for the panel's lazy chunk to have actually rendered its controls.
    // Not `video-fit-*` any more: Fit is on the ops strip, in view, and asking
    // for it a second time inside the panel was the duplication round 2 removed.
    await expect(page.getByTestId('video-downloadmode-auto')).toBeVisible();

    // No teleport. The halo is still the thing you are looking at — as a live
    // corner thumb, because the options took its place.
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expect(page.getByTestId('mirror')).toBeInViewport();

    // The halo takes 450 ms to hand the floor over; a measurement before that is
    // a measurement of the transition (round 3 read 638 px for a 537 px page).
    await page.evaluate(async () => {
      const running = document.getAnimations().filter((a) => a.playState === 'running');
      await Promise.race([
        Promise.all(running.map(async (a) => a.finished.catch(() => undefined))),
        new Promise((resolve) => {
          setTimeout(resolve, 1500);
        }),
      ]);
    });
    const after = await page.evaluate(
      () => (document.scrollingElement ?? document.documentElement).scrollHeight,
    );
    /*
     * Round 3 moved this ceiling to the floor.
     *
     * "Under two screens" was the round-1 target, and the round-2 composition
     * hit it by opening the panel in the halo's place — so the page grew a
     * little rather than a lot, and this test asserted the growth. Round 3's F2
     * measured what "a little" was costing: 77 px, which is the nav row. The
     * page does not grow AT ALL now, and `home-composition.spec.ts` asserts
     * that for every module. Nothing below is a relaxation of the old bound.
     */
    expect(after).toBeLessThanOrEqual(before);
    expect(after).toBeLessThan(1100);
  });

  /**
   * Loop is a scrubber with two handles, on the home screen, under the halo.
   *
   * It was two number fields **in seconds**, five clicks and a 1,363 px scroll
   * away — the worst task in the app by the audit's own task-speed test, and the
   * one control the prototype had explicitly drawn as a scrubber all along.
   */
  test('the Loop op opens the A/B scrubber in place, and a handle sets the loop', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 866, height: 537 });
    await page.addInitScript(() => {
      localStorage.setItem('kraken-hub:v1:config:displaySeen', '1');
      /*
        A REPORTED duration — round 7's F1.

        The scrubber's handles write loop points, and a loop point is a position
        on a timeline. Without a length somebody measured there is no timeline,
        only `LOOP_MAX_SEC` drawing a rail, so the handles are disabled and
        nothing is persisted from the invented scale (see `loopPoints.ts` and
        the narrowing test below). This test is about the op OPENING and a
        handle SETTING a loop, so it seeds the one fact that makes a loop point
        mean something — through the real telemetry mirror the display writes.
      */
      localStorage.setItem(
        'kraken-hub:v1:video:tele',
        JSON.stringify({
          ch: 'tele',
          kind: 'videoStats',
          ts: Date.now(),
          provider: 'direct-file',
          display: { w: 640, h: 640, shape: 'circle', targetFps: 40 },
          stats: {
            currentTime: 12,
            durationSec: 182,
            bufferedEnd: 182,
            held: false,
            loopCrossings: 0,
            maskVisiblePct: 0,
          },
        }),
      );
    });
    await page.goto('/');

    await expect(page.getByTestId('ops-loop-panel')).toHaveCount(0);
    await page.getByTestId('ops-loop-button').click();
    await expect(page.getByTestId('scrubber')).toBeVisible();
    await expect(page.getByTestId('scrubber')).toHaveAttribute('data-scale', 'known');
    // The halo stays put — that is the entire difference from the old path.
    await expect(page.getByTestId('mirror')).toBeInViewport();

    // A handle is a real slider: keyboard-operable, and moving it turns the
    // loop on rather than leaving it correct-but-inert behind a separate toggle.
    await page.getByTestId('loop-handle-a').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('loop-toggle')).toHaveAttribute('aria-pressed', 'true');
    const stored = await page.evaluate(() => localStorage.getItem('kraken-hub:v1:state') ?? '');
    expect(stored).toContain('"enabled":true');

    // And the numeric second-fields are gone from every surface.
    await expect(page.locator('#video-loop-start')).toHaveCount(0);
    await expect(page.locator('#video-loop-end')).toHaveCount(0);

    await page.getByTestId('ops-loop-button').click();
    await expect(page.getByTestId('ops-loop-panel')).toHaveCount(0);
  });

  /**
   * The status line, in the present tense (design audit, F4).
   *
   * Two bugs in one line: `sourceName` took the last path segment, so every
   * YouTube watch link in the world produced "Ready to play **watch**"; and the
   * verb never left the pre-flight rung even with a full telemetry packet on
   * the shared origin, because in the configuration browser liveness was
   * unreachable. Both are asserted here on seeded telemetry.
   */
  test('the status line names the source and says what is happening now', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('kraken-hub:v1:config:displaySeen', '1');
      localStorage.setItem(
        'kraken-hub:v1:state',
        JSON.stringify({
          schema: 2,
          rev: 1,
          updatedAt: Date.now(),
          writerId: 'e2e-config',
          writerRole: 'config',
          activeModuleId: 'video',
          modules: { video: { v: 1, cfg: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } } },
        }),
      );
    });
    await page.goto('/');

    const line = page.getByTestId('status-line');
    // Never the word "watch", which is what every YouTube URL's path ends in.
    await expect(line).toContainText('a YouTube video');
    await expect(line).not.toContainText('watch');

    await page.evaluate(() => {
      localStorage.setItem(
        'kraken-hub:v1:video:tele',
        JSON.stringify({
          ch: 'tele',
          kind: 'videoStats',
          ts: Date.now(),
          provider: 'youtube-embed',
          display: { w: 640, h: 640, shape: 'circle', targetFps: 40 },
          title: 'lofi hip hop radio',
          stats: {
            currentTime: 84,
            durationSec: 182,
            bufferedEnd: 182,
            held: false,
            loopCrossings: 0,
            maskVisiblePct: 0,
          },
        }),
      );
    });

    // Present tense, the display's own clock, and the real title.
    await expect(line).toContainText('Playing');
    await expect(line).toContainText('lofi hip hop radio');
    await expect(line).toContainText('1:24 / 3:02');
    await expect(page.locator('.kh-status__live')).toBeVisible();

    /*
     * And the halo is no longer a frozen gradient: telemetry draws the arc
     * (round 3's F3), over the source's own poster.
     *
     * `VideoHalo` is the NARROW composition's halo — at editor widths the same
     * region is the editor's compositor, and progress is drawn on the canvas
     * rather than by this component. So the assertion is made where the
     * component renders, which is also where the finding was made.
     */
    await page.setViewportSize({ width: 640, height: 640 });
    await expect(page.getByTestId('halo-arc')).toBeAttached();
    await expect(page.getByTestId('halo-poster')).toBeAttached();
  });

  /**
   * The same gesture gets the same response (design audit, F4).
   *
   * Pasting a YouTube link produced three step-cards; pasting an `.mp4`
   * produced nothing at all — the primary action, answered with silence.
   */
  test('pasting an MP4 is acknowledged the same way a YouTube link is', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('kraken-hub:v1:config:displaySeen', '1');
    });
    await page.goto('/');

    await page.getByTestId('paste-input').fill('https://example.test/clips/dunes.mp4');
    await page.getByTestId('paste-submit').click();

    const flow = page.getByTestId('paste-flow');
    await expect(flow).toBeVisible();
    await expect(flow).toHaveAttribute('data-flow-stage', 'accepted');
    await expect(flow).toContainText('Video link detected');
    await expect(flow).toContainText('dunes.mp4');
    await expect(flow).toContainText('On screen now');
    // The acknowledgement is not a sales pitch.
    await expect(flow).not.toContainText('Get the downloader');
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

  /**
   * `#/module/<id>` survives as a redirect, not as a page.
   *
   * It was a settings screen with no inbound links and no way back. Bookmarks,
   * doc links and forks still resolve — to home, with that module active and its
   * options already open, which is where the content actually lives now.
   */
  test('the module settings route redirects home with that module’s options open', async ({
    page,
  }) => {
    await page.goto('/#/module/clock');
    await expect(page.getByTestId('home')).toBeVisible();
    await expect(page.getByTestId('module-chip-clock')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('ops-panel')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Clock', exact: true })).toBeVisible();
    // The hash is rewritten in page — never a navigation (invariants I1/I2).
    await expect.poll(async () => page.evaluate(() => window.location.hash)).toBe('#/');
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

    await expect(page.getByRole('heading', { name: 'Report' })).toBeVisible();

    /*
     * The page is short enough not to need scrolling now (round 2's R3 got it
     * from 2,225 px to under two of these windows, and the budget test below
     * pins that) — so the claim this test makes has to be the one that was
     * actually broken: content BELOW the fold is reachable. Opening the
     * technical drawer puts a page's worth of tables there on demand.
     */
    const drawer = page.getByTestId('tech-detail').locator('summary');
    await drawer.scrollIntoViewIfNeeded();
    await drawer.click();

    const belowFold = page.getByRole('link', { name: 'Open display diagnostics' });
    await belowFold.scrollIntoViewIfNeeded();
    await expect(belowFold).toBeInViewport();
    // Actionability without navigating away: a trial click fails if anything
    // covers, clips or detaches the target.
    await belowFold.click({ trial: true });

    const metrics = await scrollMetrics(page);
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

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
    const wayDown = page.getByTestId('disclosure-library');
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expect(wayDown).toBeInViewport();
    await wayDown.click({ trial: true });

    /*
      …and the footer with it.

      The contract in `ui.css`'s short-viewport block promised the whole
      composition fitted 866x537. It did not: the block's selectors were each
      re-declared further down the file at the same specificity, so the later
      declaration won and the compressed rhythm never applied — 572 px of page in
      a 537 px window, with the version line (which is now the way in to About and
      Diagnostics) below the fold. Round 2's R11 asked where the missing 35 px
      were, and this is the assertion that keeps them found.
    */
    const metrics = await scrollMetrics(page);
    expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight);
    await expect(page.locator('.kh-footer')).toBeInViewport();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
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
    // Paired: round 2's R4 gates the instrument on a live room, and what this
    // test is about is the page that HAS one.
    await page.goto('/?transport=fake&room=ABCD1234#/remote');

    await expect(page.getByRole('heading', { name: 'kraken-hub', level: 1 })).toBeVisible();

    // Nothing is clipped horizontally at 390: a phone must never side-scroll.
    const widths = await page.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    });
    expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);

    // The transport is reachable without scrolling — it is what the page is for.
    await expect(page.getByTestId('transport-hold')).toBeInViewport();

    // Any disclosure will do; what is being proved is that opening one produces
    // a page that scrolls all the way to the footer. "More controls" used to be
    // the one here, and it is gone (design audit, F6).
    await page.getByTestId('pairing-options').locator('summary').first().click();
    const metrics = await scrollMetrics(page);
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

    await page.locator('.kh-footer').scrollIntoViewIfNeeded();
    await expect(page.locator('.kh-footer')).toBeInViewport();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  });

  /**
   * First run must not cost you the product.
   *
   * The audit's F7 measured the old first-run card filling the entire 866x537
   * CAM window: the halo, the paste field and the chips were all below the fold,
   * behind a page of prose. The band replaces it, and the ONE thing that has to
   * be true of it is that the object is still the first thing you see.
   */
  test('the first-run band never displaces the halo in a CAM-sized window', async ({ page }) => {
    await page.setViewportSize({ width: 866, height: 537 });
    // No `displaySeen` seeded: this is genuinely the first run.
    await page.goto('/');

    await expect(page.getByTestId('setup-first-run')).toBeVisible();
    const halo = page.getByTestId('mirror');
    await expect(halo).toBeInViewport();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    // Halo FIRST: the band sits under it, not on top of it.
    const haloBox = await halo.boundingBox();
    const bandBox = await page.getByTestId('setup-first-run').boundingBox();
    expect(haloBox).not.toBeNull();
    expect(bandBox).not.toBeNull();
    expect(haloBox?.y ?? 0).toBeLessThan(bandBox?.y ?? 0);
    // The primary action is on screen with it.
    await expect(page.getByTestId('setup-open-cam')).toBeInViewport();

    /*
     * …and FIRST is not the whole of it — biggest is the other half.
     *
     * The starter-Look cards arrived under the setup card and took 121 px of
     * the one grid row that grows, which put the halo at 199 px: first on the
     * page and a thumbnail on it. The cards live in the canvas column's left
     * gutter now (`ui.css`), which is width the halo does not use, so this
     * number is the halo with no band at all.
     */
    expect(
      haloBox?.width ?? 0,
      'the halo is first on the page but no longer the biggest thing on it',
    ).toBeGreaterThanOrEqual(300);
  });

  /**
   * …and nothing paints over it — round 11's F-1.
   *
   * `CamSetupCard`'s two variants have two class names, and only the About
   * one (`.kh-setup`) was named in the editor grid's area assignments. So on a
   * cold profile the first-run band was AUTO-PLACED, and the cell it landed in
   * was the `strip` row — whose one child is the floating selection strip,
   * absolutely positioned against its grid area with `bottom: 0`. A row holding
   * an 85 px band is an 85 px containing block, so the strip stopped floating
   * over the canvas and painted over the band's last line and the top half of
   * both its controls: measured 544 x 40 of overlap at 866x537 and again at
   * 1280x800, with the word "Frame" cut in half.
   *
   * Two windows, because the bug reproduced at both and a grid bug that only
   * one window shows is a grid bug that has been moved rather than fixed.
   */
  for (const size of [
    { width: 866, height: 537 },
    { width: 1280, height: 800 },
  ]) {
    test(`the first-run band and the selection strip never overlap at ${String(size.width)}x${String(size.height)}`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      // No `displaySeen` seeded: this is genuinely the first run.
      await page.goto('/');
      await expect(page.getByTestId('setup-first-run')).toBeVisible();
      await expect(page.getByTestId('ops-strip')).toBeVisible();

      const overlap = await page.evaluate(() => {
        const band = document.querySelector('[data-testid="setup-first-run"]');
        const strip = document.querySelector('[data-testid="ops-strip"]');
        if (band === null || strip === null) return null;
        const a = band.getBoundingClientRect();
        const b = strip.getBoundingClientRect();
        const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
        const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        return Math.round(w * h);
      });
      expect(overlap, 'the strip is painting over the first-run band').toBe(0);

      /*
       * …and the starter-Look cards overlap nothing either, at both windows.
       *
       * They are out of flow in the canvas column's gutter, which is the same
       * shape of placement F-1 was about — an item positioned against a grid
       * area rather than laid out in one. So it gets the same three-way box
       * test, and the halo is in it: the gutter is the width the halo does not
       * use, and "does not use" is a measurement, not a promise.
       */
      await expect(page.getByTestId('first-run-templates')).toBeVisible();
      const starters = await page.evaluate(() => {
        const rect = (id: string) =>
          document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect() ?? null;
        const looks = rect('first-run-templates');
        if (looks === null) return null;
        const over = (b: DOMRect | null): number => {
          if (b === null) return -1;
          const w = Math.max(0, Math.min(looks.right, b.right) - Math.max(looks.left, b.left));
          const h = Math.max(0, Math.min(looks.bottom, b.bottom) - Math.max(looks.top, b.top));
          return Math.round(w * h);
        };
        return {
          onHalo: over(rect('mirror')),
          onStrip: over(rect('ops-strip')),
          onSetup: over(rect('setup-first-run')),
        };
      });
      expect(starters?.onHalo, 'the starter cards are painting over the halo').toBe(0);
      expect(starters?.onStrip, 'the starter cards are painting over the strip').toBe(0);
      expect(starters?.onSetup, 'the starter cards are painting over the install band').toBe(0);

      /*
       * …and both of the band's controls are whole. Overlap 0 is a box test;
       * this is the reader's test, and it is the one the finding was written
       * from — `elementFromPoint` at each corner and the centre says whether
       * anything at all is on top of the control, whatever its box says.
       */
      const covered = await page.evaluate(() =>
        ['setup-open-cam', 'setup-reveal-address'].map((id) => {
          const el = document.querySelector(`[data-testid="${id}"]`);
          if (el === null) return { id, hits: -1 };
          const b = el.getBoundingClientRect();
          const points: [number, number][] = [
            [b.left + 3, b.top + 3],
            [b.right - 3, b.top + 3],
            [b.left + 3, b.bottom - 3],
            [b.right - 3, b.bottom - 3],
            [b.left + b.width / 2, b.top + b.height / 2],
          ];
          const hits = points.filter(([x, y]) => {
            const over = document.elementFromPoint(x, y);
            return !(over === el || el.contains(over) || (over?.contains(el) ?? false));
          }).length;
          return { id, hits };
        }),
      );
      for (const control of covered) {
        expect(control.hits, `${control.id} is painted over`).toBe(0);
      }

      // And the whole composition still fits CAM's window.
      expect(
        await page.evaluate(() => {
          const d = document.scrollingElement ?? document.documentElement;
          return Math.max(0, d.scrollHeight - d.clientHeight);
        }),
      ).toBe(0);
    });
  }

  /**
   * Three Looks to press, on the screen with nothing on it — §4, and round
   * 11's M-h.
   *
   * A cold profile showed the Add-to-CAM band and nothing else: an empty stage,
   * a rail with one row in it, and a first screen whose only offer was a
   * five-minute installation errand. §4 asks for template cards on first run,
   * and they had never been built — measured on a cold profile at 866x537, no
   * template card was in the DOM at all.
   *
   * ## …and then they cost the halo 121 px
   *
   * Built as a row under the setup card, they were 121 px of the one grid row
   * that grows, and the halo went from 320 px to 199 — first on the page and a
   * thumbnail on it. They stand in the canvas column's LEFT GUTTER now: the
   * halo is square and its column is not, so at 866x537 there is 112 px of
   * unused column on each side of it, for the whole height of the row. Out of
   * flow, so the row it used to occupy collapses and the halo is the size it is
   * with no band at all.
   *
   * That is what this measures: the cards are there, they are pressable, they
   * are wholly on screen, and the halo did not pay for them.
   */
  test('first run offers Looks to start from, beside the halo', async ({ page }) => {
    await page.setViewportSize({ width: 866, height: 537 });
    await page.goto('/');

    const band = page.getByTestId('first-run-templates');
    await expect(band).toBeVisible();
    const cards = page.locator('[data-testid^="first-run-look-"]');
    await expect(cards).toHaveCount(3);

    /*
     * Every box in ONE evaluate: the template chunk lands after the first
     * paint, so two sequential `boundingBox()` calls can straddle a reflow and
     * compare one box's position before the change with another's after it.
     */
    const geometry = async () =>
      page.evaluate(() => {
        const rect = (id: string) =>
          document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect() ?? null;
        const halo = rect('mirror');
        const looks = rect('first-run-templates');
        if (halo === null || looks === null) return null;
        const over = (b: DOMRect | null): number => {
          if (b === null) return -1;
          const w = Math.max(0, Math.min(looks.right, b.right) - Math.max(looks.left, b.left));
          const h = Math.max(0, Math.min(looks.bottom, b.bottom) - Math.max(looks.top, b.top));
          return Math.round(w * h);
        };
        const d = document.scrollingElement ?? document.documentElement;
        return {
          halo: Math.round(halo.width),
          // Beside it, clear of the bezel — never over it, and never a
          // hair's breadth from it either.
          bezelGap: Math.round(halo.left - looks.right),
          onHalo: over(halo),
          onStrip: over(rect('ops-strip')),
          onSetup: over(rect('setup-first-run')),
          overflow: Math.max(0, d.scrollHeight - d.clientHeight),
          // A thing you press is at least 44 px in both axes, and all of it is
          // on the screen.
          cards: [...document.querySelectorAll('[data-testid^="first-run-look-"]')].map((el) => {
            const b = el.getBoundingClientRect();
            return {
              w: Math.round(b.width),
              h: Math.round(b.height),
              whole:
                b.top >= 0 &&
                b.left >= 0 &&
                b.bottom <= window.innerHeight &&
                b.right <= window.innerWidth,
            };
          }),
        };
      });

    // Polled: the screen is still arriving — `main` carries the enter animation
    // and the cards' own chunk lands after the first paint, so a single sample
    // can straddle a reflow.
    await expect
      .poll(async () => (await geometry())?.halo ?? 0, { timeout: 5000 })
      .toBeGreaterThanOrEqual(300);

    const m = await geometry();
    expect(m).not.toBeNull();
    expect(m?.bezelGap ?? 0, 'the cards are crowding the halo’s bezel').toBeGreaterThanOrEqual(12);
    expect(m?.onHalo, 'the cards are painting over the halo').toBe(0);
    expect(m?.onStrip, 'the cards are painting over the selection strip').toBe(0);
    expect(m?.onSetup, 'the cards are painting over the install band').toBe(0);
    expect(m?.overflow, 'the cards pushed the composition past CAM’s window').toBe(0);
    expect(m?.cards).toHaveLength(3);
    for (const card of m?.cards ?? []) {
      expect(card.w, 'a starter card is too narrow to press').toBeGreaterThanOrEqual(44);
      expect(card.h, 'a starter card is too short to press').toBeGreaterThanOrEqual(44);
      expect(card.whole, 'a starter card runs off the screen').toBe(true);
    }

    // …and pressing one changes the Look, which is the entire point of them.
    const before = await page.evaluate(() => localStorage.getItem('kraken-hub:v1:state') ?? '');
    await cards.nth(1).click();
    await expect
      .poll(async () => page.evaluate(() => localStorage.getItem('kraken-hub:v1:state') ?? ''))
      .not.toBe(before);
  });

  /**
   * …and where there is no gutter, the row comes back.
   *
   * The gutter is `(column - halo) / 2`, and it closes from both ends: a
   * narrower window shrinks the column, a taller one grows the halo. Below
   * 762 px of editor grid — a ~760 px window — three cards beside the halo
   * would be three cards ON it, so `ui.css` puts them back under the setup
   * card as a single 82 px row of thumb-and-name.
   *
   * This is the branch that has to be measured rather than assumed, because a
   * fallback nobody looks at is a fallback that is broken.
   */
  test('the starter Looks fall back to a compact row where the gutter closes', async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 537 });
    await page.goto('/');

    await expect(page.getByTestId('first-run-templates')).toBeVisible();
    await expect(page.locator('[data-testid^="first-run-look-"]')).toHaveCount(3);

    const geometry = async () =>
      page.evaluate(() => {
        const rect = (id: string) =>
          document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect() ?? null;
        const halo = rect('mirror');
        const looks = rect('first-run-templates');
        const setup = rect('setup-first-run');
        const d = document.scrollingElement ?? document.documentElement;
        return {
          halo: Math.round(halo?.width ?? 0),
          band: Math.round(looks?.height ?? 0),
          // The row is UNDER the setup card here, which is the placement the
          // gutter branch replaces rather than the one it breaks.
          under: Math.round((looks?.top ?? 0) - (setup?.bottom ?? 0)),
          overflow: Math.max(0, d.scrollHeight - d.clientHeight),
          cards: [...document.querySelectorAll('[data-testid^="first-run-look-"]')].map((el) => {
            const b = el.getBoundingClientRect();
            return { w: Math.round(b.width), h: Math.round(b.height) };
          }),
        };
      });

    /*
     * Polled, like every other measurement of this screen in this file: `main`
     * carries an enter animation and the cards' chunk lands after the first
     * paint, so a single sample can be taken of a page that is still arriving.
     */
    await expect
      .poll(async () => (await geometry()).under, { timeout: 5000 })
      .toBeGreaterThanOrEqual(0);

    const m = await geometry();
    expect(m.under, 'the fallback row is not under the setup card').toBeGreaterThanOrEqual(0);
    expect(m.band, 'the fallback row is not a compact row any more').toBeLessThanOrEqual(88);
    expect(m.overflow, 'the fallback row pushed the composition past the window').toBe(0);
    /*
     * The halo is smaller here than in the gutter branch and that is the whole
     * point of the branch — 760x537 is a window where the setup card alone
     * wraps to 122 px, so the canvas row's ceiling is 283 px before any band
     * exists. What this holds is that the row stays a row: 88 px of it, not the
     * 121 px band the gutter placement was written to undo.
     */
    expect(m.halo, 'the fallback row is eating the canvas').toBeGreaterThanOrEqual(190);
    for (const card of m.cards) {
      expect(card.w, 'a fallback starter card is too narrow to press').toBeGreaterThanOrEqual(44);
      expect(card.h, 'a fallback starter card is too short to press').toBeGreaterThanOrEqual(44);
    }
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
