import { expect, test, type Page } from '@playwright/test';

/**
 * The home screen, measured — design audit, rounds 2 and 3.
 *
 * Round 1 asked for options that resolve in place, and got them: the active chip
 * became the door and the 1,600 px settings wall went away. Round 2 then put a
 * ruler on the result and found the door opened onto something still off the
 * bottom of the screen — the options panel overflowed CAM's real 866x537 window
 * by **426 to 888 px, on every module**, because it opened *underneath* a
 * full-height composition rather than in place of one.
 *
 * ## Round 3: the component is never the unit of measurement again
 *
 * Round 2 fixed that, and this file measured the fix — the PANEL's last pixel
 * against the bottom of the window, with a `slack >= 0` per module. Every one of
 * those assertions passed at eab18f0. And the page still overflowed by 14 to
 * 77 px with the options open, because the panel ending above the fold says
 * nothing about the **nav row and the footer underneath it** — and `.kh-more`
 * is this app's entire navigation. A test that measures a component and calls it
 * a composition is a test that will keep passing while the screen gets worse.
 *
 * So the budget below is `document.scrollHeight <= clientHeight`: the PAGE, in
 * CAM's window, for every module in every panel state. Nothing is exempt because
 * it happens to be below the element somebody was looking at.
 *
 * The one state that is allowed to scroll is the one where scrolling is the
 * point. Round 3's F1: the panel used to carry `max-height: calc(100dvh - 268px)`
 * with `overflow-y: auto`, which at 866x537 silently swallowed **929 px** —
 * pressing Advanced rotated a chevron and changed nothing else on the screen.
 * The cap is gone; Advanced now promotes the page to an honest full-height flow,
 * which the suite asserts is honest rather than pretending it does not happen.
 *
 * Everything else here is unchanged from round 2: the halo cross-fading down to
 * a live corner thumb to make the room, the primary action taking the active
 * module's noun, one voice in the status line, and the receipt getting out of
 * the way once it is a receipt.
 */

/** The CAM Configuration Browser, measured. Every assertion here is about it. */
const CAM = { width: 866, height: 537 } as const;

const MODULE_IDS = ['video', 'clock', 'stats', 'image'] as const;

/** The steady state: a Kraken has connected, so the install band is gone. */
async function cam(page: Page): Promise<void> {
  await page.setViewportSize({ width: CAM.width, height: CAM.height });
  await page.addInitScript(() => {
    localStorage.setItem('kraken-hub:v1:config:displaySeen', '1');
  });
}

/**
 * Switch to a module and open its options.
 *
 * Two presses for an inactive chip, one for the active one — which is the whole
 * gesture: a chip switches, and the chip that is already active is the door.
 */
/** Open the panel's Advanced door, where the module has one (F5). */
async function openEveryDoor(page: Page): Promise<void> {
  const doors = page.locator('[data-testid="ops-panel"] .kh-details__summary');
  for (let i = 0; i < (await doors.count()); i++) await doors.nth(i).click();
}

/** Make a module active, with its options CLOSED — the base composition. */
async function selectModule(page: Page, id: string): Promise<void> {
  const chip = page.getByTestId(`module-chip-${id}`);
  if ((await chip.getAttribute('aria-pressed')) !== 'true') await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  // Pressing the chip that is already active is the door, so the first press
  // may have opened it. This helper is about the closed state.
  if ((await chip.getAttribute('aria-expanded')) === 'true') await chip.click();
  await expect(page.getByTestId('ops-panel')).toHaveCount(0);
}

async function openOptions(page: Page, id: string): Promise<void> {
  const chip = page.getByTestId(`module-chip-${id}`);
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  if ((await chip.getAttribute('aria-expanded')) !== 'true') await chip.click();
  await expect(page.getByTestId('ops-panel')).toBeVisible();
  // The module's real controls, not a frame that might hold them. Round 3 made
  // `.kh-panel` an unreliable signal here: Suspense's placeholder used to be one
  // too, so a wait on it could satisfy itself with the very jank F3 is about.
  await expect(page.locator('[data-testid="ops-panel"] .kh-field').first()).toBeVisible();
}

/**
 * What the PAGE is doing — not what one box inside it is doing.
 *
 * `overflow` is the number round 2's per-panel assertion could not see: the
 * document's own scrollable surplus, which is where the nav row and the footer
 * went. `clipped` is the second half of the same honesty — a composition that
 * fits only because something inside it is quietly scrolling its own content
 * has not fitted, it has hidden.
 */
interface PageMetrics {
  /** `scrollHeight - clientHeight`. Zero means the whole page is on the screen. */
  overflow: number;
  /** Pixels any element inside the home screen is hiding inside its own box. */
  clipped: number;
  /** The app did not teleport the page to make any of the above true. */
  scrollY: number;
  /** Is the nav row — this app's entire navigation — whole and on the screen? */
  navFullyVisible: boolean;
  /** Is the footer, which is the way to About and Diagnostics? */
  footerFullyVisible: boolean;
}

/**
 * Wait for the composition to stop moving.
 *
 * Everything on this screen is a transition — the halo takes 450 ms to hand the
 * floor over and the panel springs in on the same curve — so a measurement taken
 * on the frame after a click is a measurement of the animation. Round 3 caught
 * this reading 638 px for a 537 px page and 41 px for a 44 px button (a
 * `scaleY(0.94)` keyframe, mid-flight). Bounded, because an infinite animation
 * would otherwise wait forever.
 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const running = document.getAnimations().filter((a) => a.playState === 'running');
    await Promise.race([
      Promise.all(running.map(async (a) => a.finished.catch(() => undefined))),
      new Promise((resolve) => {
        setTimeout(resolve, 1500);
      }),
    ]);
  });
}

async function pageMetrics(page: Page): Promise<PageMetrics> {
  await settle(page);
  return page.evaluate(() => {
    const doc = document.scrollingElement ?? document.documentElement;
    const whole = (selector: string): boolean => {
      const el = document.querySelector(selector);
      if (el === null) return false;
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight;
    };
    let clipped = 0;
    for (const el of document.querySelectorAll('.kh-home, .kh-home *')) {
      // A shelf that scrolls on purpose is not a composition that failed: the
      // picture list is explicitly a fixed-height shelf (`.kh-list--shelf`).
      if (el.classList.contains('kh-list--shelf')) continue;
      /*
       * Only SCROLL boxes count.
       *
       * `overflow: visible` gives sub-pixel rounding, not swallowed content. A
       * mask — the halo's round bezel window is `overflow: hidden` and clips the
       * mirror by 1–2 px, which is what a bezel is for — hides nothing a user
       * could otherwise have reached. The failure this number exists to catch is
       * specifically the deleted `max-height` + `overflow-y: auto` cap: content
       * that IS there, IS reachable, and is not on the screen, so the page can
       * report a height that is not the height of what it contains.
       */
      const overflow = getComputedStyle(el).overflowY;
      if (overflow !== 'auto' && overflow !== 'scroll') continue;
      clipped = Math.max(clipped, el.scrollHeight - el.clientHeight);
    }
    return {
      overflow: doc.scrollHeight - doc.clientHeight,
      clipped,
      scrollY: window.scrollY,
      navFullyVisible: whole('.kh-more'),
      footerFullyVisible: whole('.kh-footer'),
    };
  });
}

function haloWidth(page: Page): Promise<number> {
  return page.evaluate(
    () => document.querySelector('[data-testid="mirror"]')?.getBoundingClientRect().width ?? 0,
  );
}

// ---------------------------------------------------------------------------
// R1 + R2 — one set of options, and they are IN VIEW
// ---------------------------------------------------------------------------

test.describe('the page fits CAM’s window — every module, every panel state', () => {
  for (const id of MODULE_IDS) {
    test(`${id}: the whole composition fits at 866×537, closed and with options open`, async ({
      page,
    }) => {
      await cam(page);
      await page.goto('/');

      // 1. Closed. The base composition, which round 2 also measured.
      await selectModule(page, id);
      await expect.poll(async () => (await pageMetrics(page)).overflow).toBe(0);

      // 2. Options open — the state round 2 declared fixed by measuring the
      //    panel, and which was still putting the nav row across the fold.
      await openOptions(page, id);
      // Polled, because the halo takes 450 ms to hand over the floor and a
      // measurement mid-spring is a measurement of the animation.
      await expect.poll(async () => (await pageMetrics(page)).overflow).toBe(0);

      const m = await pageMetrics(page);
      expect(
        m.overflow,
        `${id}: the composition runs past the bottom of CAM's window with the options open`,
      ).toBe(0);
      // "Fits" means fits: nothing is quietly scrolling its own content to make
      // the number true. This is the assertion the deleted `max-height` cap
      // would have failed (F1).
      expect(m.clipped, `${id}: something inside the home screen is clipped`).toBe(0);
      // The two things the overflow was eating.
      expect(m.navFullyVisible, `${id}: the nav row is cut by the fold`).toBe(true);
      expect(m.footerFullyVisible, `${id}: the footer is cut by the fold`).toBe(true);
      // And the app did not teleport the page to make any of it true.
      expect(m.scrollY).toBe(0);
    });

    /**
     * F1 — the Advanced door, which used to do nothing at all.
     *
     * At 866x537 the panel's `max-height` hid 929 px of it: the chevron
     * rotated, a scrollbar appeared inside a box, and the screen did not
     * change. This is the OTHER promise: the page is allowed to scroll here,
     * because the user asked for more than a window's worth — and it has to
     * scroll HONESTLY, with the panel's content in the flow rather than inside
     * a hidden overflow, and the nav and footer below it rather than lost.
     */
    test(`${id}: Advanced opens onto a full-height flow, not a hidden overflow`, async ({
      page,
    }) => {
      await cam(page);
      await page.goto('/');
      await openOptions(page, id);

      const panelHeight = async (): Promise<number> => {
        await settle(page);
        return page.evaluate(
          () => document.querySelector('[data-testid="ops-panel"]')?.scrollHeight ?? 0,
        );
      };
      const before = await panelHeight();
      const summary = page.locator('[data-testid="ops-panel"] .kh-details__summary');
      const doors = await summary.count();
      /* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect --
         Whether a module HAS an Advanced door is a property of the module, and
         "there is no door because there was nothing to put behind one" is the
         other half of the same rule (F5) rather than a case to skip. Both
         branches assert; neither is a silent pass. */
      if (doors === 0) {
        // No door, because there is nothing left to put behind one — the
        // module's options ARE the advanced controls (F5). That is a state
        // this rule is satisfied by, not one it skips: assert it.
        await expect(page.locator('[data-testid="ops-panel"] .kh-panel')).toBeVisible();
        expect(await pageMetrics(page).then((m) => m.overflow)).toBe(0);
        return;
      }
      /* eslint-enable playwright/no-conditional-in-test, playwright/no-conditional-expect */

      await summary.first().click();
      await expect(page.locator('.kh-home')).toHaveAttribute('data-advanced', 'true');

      /*
       * The press changed the screen. That is the whole finding: it did not.
       *
       * Measured on the PANEL rather than the document, because the two are
       * different claims: the panel must always grow (that is what opening a
       * door means), while whether the PAGE then needs to scroll depends on how
       * much was behind it — Clock's Advanced still fits in CAM's window and
       * Video's is 800 px. Asserting the page grew would make the smallest
       * module's success look like a failure.
       */
      await expect.poll(panelHeight).toBeGreaterThan(before);

      const m = await pageMetrics(page);
      // Honest: the content is in the document's flow, not hidden inside the
      // panel's own scroll box.
      expect(m.clipped, `${id}: Advanced is hiding content inside a box again`).toBe(0);
      // …and the way out is still below it, in flow, reachable by scrolling.
      const reachable = await page.evaluate(() => {
        const nav = document.querySelector('.kh-more');
        const foot = document.querySelector('.kh-footer');
        const doc = document.scrollingElement ?? document.documentElement;
        if (nav === null || foot === null) return false;
        return (
          nav.getBoundingClientRect().bottom + window.scrollY <= doc.scrollHeight &&
          foot.getBoundingClientRect().bottom + window.scrollY <= doc.scrollHeight
        );
      });
      expect(reachable, `${id}: the nav and footer are not in the flow below Advanced`).toBe(true);
    });
  }

  /**
   * F5 — a door never opens onto an empty room.
   *
   * Three of the four panels used to open to a signpost sentence ("Face, hours
   * and seconds are on the strip above") and a closed `Advanced` disclosure —
   * a deliberate second gesture answered with a paragraph about somewhere else.
   * The rule now lives in `ui/ModuleOptions`: with no primary controls the
   * advanced ones are promoted to the panel itself.
   */
  test('a module’s options always open onto a control, never onto a signpost', async ({ page }) => {
    await cam(page);
    await page.goto('/');

    for (const id of MODULE_IDS) {
      await openOptions(page, id);
      const panel = page.getByTestId('ops-panel');

      // No prose pointing at the screen the reader is already looking at.
      await expect(panel).not.toContainText('on the strip above');
      await expect(panel).not.toContainText('strip above');

      // At least one control is reachable WITHOUT opening anything: either the
      // panel has primary controls, or the advanced ones were promoted into it.
      const openControls = await page.evaluate(() => {
        const root = document.querySelector('[data-testid="ops-panel"] .kh-panel');
        if (root === null) return 0;
        return [...root.querySelectorAll('button, input, [role="radio"], [role="switch"]')].filter(
          (el) => el.closest('details:not([open])') === null,
        ).length;
      });
      expect(openControls, `${id}: the options panel opens onto no control at all`).toBeGreaterThan(
        0,
      );
    }
  });

  /**
   * R1/R2 — ONE set of options.
   *
   * The strip and the panel each carried Face, Hours and Seconds; Layout,
   * Degrees and Labels; Fit. Two surfaces for one module, on one screen, at the
   * same time, and free to disagree in wording ("24" against "24-hour"). The
   * rows exist once now, and the copy that used to differ cannot.
   */
  test('the strip owns the controls, and the panel does not ask again', async ({ page }) => {
    await cam(page);
    await page.goto('/');

    await openOptions(page, 'clock');
    const panel = page.getByTestId('ops-panel');
    // On the strip…
    await expect(page.getByTestId('ops-face')).toBeVisible();
    await expect(page.getByTestId('ops-format')).toBeVisible();
    await expect(page.getByTestId('ops-seconds')).toBeVisible();
    // …and therefore not in the panel.
    await expect(panel.getByTestId('clock-face-digital')).toHaveCount(0);
    await expect(panel.getByTestId('clock-hour-format-12')).toHaveCount(0);
    await expect(panel.getByTestId('clock-seconds-on')).toHaveCount(0);
    // What is left is what the strip has no room for, plus the one door.
    await expect(panel.getByTestId('clock-date-on')).toBeVisible();
    await expect(panel.getByTestId('clock-advanced')).toBeVisible();

    await openOptions(page, 'video');
    await expect(page.getByTestId('ops-fill')).toBeVisible();
    await expect(panel.getByTestId('video-fit-cover')).toHaveCount(0);
    await expect(panel.getByTestId('video-downloadmode-auto')).toBeVisible();
  });

  /**
   * R2/R8 — one control idiom.
   *
   * A boolean was a house segmented control on the strip and a bare browser
   * checkbox in the panel four inches below it; short exclusive choices were
   * native `<select>`s. There is one shape for a boolean and one for a choice,
   * everywhere on this screen.
   */
  test('no native checkbox or select survives on home or in any module’s options', async ({
    page,
  }) => {
    await cam(page);
    await page.goto('/');

    for (const id of MODULE_IDS) {
      await openOptions(page, id);
      // Advanced is part of the panel, so it is part of the rule — where there
      // still is one. A module whose options ARE its advanced controls has no
      // door to open (F5), and its controls are already in the sweep below.
      await openEveryDoor(page);
      const natives = await page.evaluate(
        () =>
          document.querySelectorAll(
            '.kh-home select, .kh-home input[type="checkbox"], .kh-home input[type="radio"]',
          ).length,
      );
      expect(natives, `${id}: a native picker survives in the options`).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// R1 — the halo yields the floor, and takes it back
// ---------------------------------------------------------------------------

test('the halo becomes a live corner thumb while the options are open, and comes back', async ({
  page,
}) => {
  await cam(page);
  await page.goto('/');
  await page.getByTestId('module-chip-clock').click();
  await expect(page.getByTestId('mirror')).toHaveAttribute('data-mirror-mode', 'live');

  const full = await haloWidth(page);
  expect(full).toBeGreaterThan(150);

  await openOptions(page, 'clock');
  await expect.poll(async () => haloWidth(page)).toBeLessThan(90);
  // Still the object, and still the real display page — a thumb, not a picture
  // of one: the mirror's iframe is the same document it always was.
  await expect(page.getByTestId('mirror')).toBeInViewport();
  await expect(page.locator('.kh-halo__frame')).toHaveCount(1);

  await page.getByTestId('ops-close').click();
  await expect.poll(async () => haloWidth(page)).toBeGreaterThan(150);
  await expect(page.getByTestId('ops-panel')).toHaveCount(0);
});

/**
 * R11 — and the same courtesy for the scrubber.
 *
 * Loop opens under the strip. It used to push its own labels past the fold at
 * this window size, which is the same failure as the options panel, one control
 * smaller.
 */
test('the loop scrubber opens fully visible, labels included', async ({ page }) => {
  await cam(page);
  await page.goto('/');
  await page.getByTestId('ops-loop-button').click();
  await expect(page.getByTestId('scrubber')).toBeVisible();

  await expect(page.getByTestId('ops-loop-panel')).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId('loop-handle-a')).toBeInViewport();
  await expect(page.getByTestId('loop-handle-b')).toBeInViewport();
  await expect(page.locator('.kh-footer')).toBeInViewport();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

// ---------------------------------------------------------------------------
// R9 — the primary action belongs to the module on the panel
// ---------------------------------------------------------------------------

test.describe('the one primary action is contextual', () => {
  test('video asks for a video link; image IS the picture link', async ({ page }) => {
    await cam(page);
    await page.goto('/');

    const input = page.getByTestId('paste-input');
    await expect(input).toHaveAttribute('placeholder', /video link/);
    await expect(page.getByTestId('paste-submit')).toHaveText('Play');

    await page.getByTestId('module-chip-image').click();
    await expect(input).toHaveAttribute('placeholder', /picture link/);
    await expect(page.getByTestId('paste-submit')).toHaveText('Show');

    // The merge: the module panel used to carry a second field holding the same
    // string. Submitting here commits the image module's own url.
    await input.fill('https://images.example.test/wallpaper.png');
    await page.getByTestId('paste-submit').click();

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const raw = localStorage.getItem('kraken-hub:v1:state');
          const state = raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
          const modules = (state['modules'] ?? {}) as Record<string, { cfg?: { url?: string } }>;
          return modules['image']?.cfg?.url ?? '';
        }),
      )
      .toBe('https://images.example.test/wallpaper.png');
    // It is a field, so it keeps showing what it is showing.
    await expect(input).toHaveValue('https://images.example.test/wallpaper.png');
    // And the panel does not hold a second copy of it.
    await openOptions(page, 'image');
    await expect(page.locator('#image-url')).toHaveCount(0);
  });

  test('clock and stats get a quiet way in, not a loud irrelevant field', async ({ page }) => {
    await cam(page);
    await page.goto('/');

    for (const id of ['clock', 'stats'] as const) {
      await page.getByTestId(`module-chip-${id}`).click();
      await expect(page.getByTestId('paste-input')).toHaveCount(0);
      await expect(page.getByTestId('paste-switch')).toHaveText('Play something');
    }

    // It switches context and hands over the caret — that is the whole errand.
    await page.getByTestId('paste-switch').click();
    await expect(page.getByTestId('module-chip-video')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('paste-input')).toBeFocused();
  });
});

// ---------------------------------------------------------------------------
// R5 — one status voice
// ---------------------------------------------------------------------------

test.describe('the screen tells one story about the copy', () => {
  const MP4 = 'https://example.test/clips/clip.mp4';

  test('a kept copy is “Playing”, and the permanent badge is gone', async ({ page }) => {
    await cam(page);
    await page.goto('/');
    await page.getByTestId('paste-input').fill(MP4);
    await page.getByTestId('paste-submit').click();

    const line = page.getByTestId('status-line');
    // The contradiction, in one screenshot: this line read "Streaming clip.mp4"
    // directly under a green chip that read "Keeping a copy".
    await expect(line).toContainText('Playing');
    await expect(line).toContainText('clip.mp4');
    await expect(line).not.toContainText('Streaming');
    // The chip was a stage wearing the clothes of a permanent property.
    await expect(page.getByTestId('ops-saved')).toHaveCount(0);
    await expect(page.getByTestId('ops-strip')).not.toContainText('Keeping a copy');
  });

  test('“Streaming” is claimed only when nothing is being kept', async ({ page }) => {
    await cam(page);
    await page.addInitScript(() => {
      localStorage.setItem(
        'kraken-hub:v1:state',
        JSON.stringify({
          schema: 2,
          rev: 1,
          updatedAt: Date.now(),
          writerId: 'e2e-voice',
          writerRole: 'config',
          activeModuleId: 'video',
          modules: {
            video: {
              v: 1,
              cfg: { url: 'https://example.test/clips/clip.mp4', downloadMode: 'stream-only' },
            },
          },
        }),
      );
    });
    await page.goto('/');
    await expect(page.getByTestId('status-line')).toContainText('Streaming');
  });
});

// ---------------------------------------------------------------------------
// R11 — a receipt is not furniture
// ---------------------------------------------------------------------------

test.describe('the paste receipt', () => {
  test('collapses to the status line once it is plainly a success', async ({ page }) => {
    await cam(page);
    await page.goto('/');
    await page.getByTestId('paste-input').fill('https://example.test/clips/dunes.mp4');
    await page.getByTestId('paste-submit').click();

    const flow = page.getByTestId('paste-flow');
    await expect(flow).toBeVisible();
    await expect(flow).toHaveAttribute('data-flow-stage', 'accepted');

    await expect(flow).toHaveAttribute('data-collapsed', 'true', { timeout: 10_000 });
    await expect(flow).toBeHidden();
    // …into the line that carries the state, which is still saying it.
    await expect(page.getByTestId('status-line')).toContainText('dunes.mp4');
    // And the composition it was sitting on top of is back, whole.
    await expect(page.locator('.kh-footer')).toBeInViewport();
  });

  /**
   * F4 — and the flagship path is not an exception.
   *
   * Round 2 hard-coded the set of stages allowed to retire as `accepted` and
   * `stored`, which excluded the single most common thing anybody does with
   * this app: paste a YouTube link. The receipt stayed for the session, 219 px
   * of it, asserting that a video was playing next to a halo showing it playing
   * and a status line saying it was playing. The rule is a question about the
   * stage now (`homeState.receiptPersists`), not a list.
   */
  test('the YouTube receipt collapses too, and the ads note is not in the ladder', async ({
    page,
  }) => {
    await cam(page);
    await page.goto('/');
    await page.getByTestId('paste-input').fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await page.getByTestId('paste-submit').click();

    const flow = page.getByTestId('paste-flow');
    await expect(flow).toHaveAttribute('data-flow-stage', 'youtube-embed');
    // A source property, not an event: it lives in the module's options, next
    // to the control that answers it.
    await expect(flow).not.toContainText('Ads and all');

    await expect(flow).toHaveAttribute('data-collapsed', 'true', { timeout: 10_000 });
    await expect(flow).toBeHidden();
    // …and the halo's line is still carrying the fact the ladder handed over.
    await expect(page.getByTestId('status-line')).toContainText('YouTube');
    // The composition it was sitting on is whole again.
    expect((await pageMetrics(page)).overflow).toBe(0);

    // The fact itself did not vanish from the product — it moved.
    await openOptions(page, 'video');
    await expect(page.getByTestId('ops-panel')).toContainText('ads');
  });

  test('a failure stays, because a failure is not a receipt', async ({ page }) => {
    const url = 'https://example.test/clips/broken.mp4';
    await cam(page);
    await page.goto('/');
    await page.getByTestId('paste-input').fill(url);
    await page.getByTestId('paste-submit').click();

    await page.evaluate((sourceUrl) => {
      localStorage.setItem(
        'kraken-hub:v1:video:downloads',
        JSON.stringify([
          {
            id: 'd1',
            url: sourceUrl,
            sourceUrl,
            name: 'broken.mp4',
            state: 'error',
            reason: 'network',
            receivedBytes: 0,
            totalBytes: null,
            error: null,
            clipId: null,
            startedAt: Date.now(),
            updatedAt: Date.now(),
          },
        ]),
      );
    }, url);

    const flow = page.getByTestId('paste-flow');
    await expect(flow).toHaveAttribute('data-flow-stage', 'unsaved', { timeout: 10_000 });

    // An absence, so a settle window is the honest instrument: well past the
    // linger a success would have used up.
    // eslint-disable-next-line playwright/no-wait-for-timeout
    await page.waitForTimeout(6000);
    await expect(flow).toHaveAttribute('data-collapsed', 'false');
    await expect(flow).toBeVisible();
    await expect(flow).toContainText('did not finish');
  });
});

// ---------------------------------------------------------------------------
// R11 — one name for one module
// ---------------------------------------------------------------------------

test('the stats module is called Stats everywhere it is named', async ({ page }) => {
  await cam(page);
  await page.goto('/');

  await expect(page.getByTestId('module-chip-stats')).toHaveText('Stats');
  await page.getByTestId('module-chip-stats').click();
  await expect(page.getByTestId('status-line')).toContainText('Stats');
  await openOptions(page, 'stats');
  // The panel's head names what you opened, from the same registry entry.
  await expect(page.getByRole('heading', { name: 'Stats', exact: true })).toBeVisible();
  await expect(page.getByTestId('ops-panel')).not.toContainText('System stats');

  // …including the remote's module picker, which read `name` and therefore said
  // a third thing again (round 2, R11).
  //
  // Paired, because round 2's R4 gates the remote's controls on a live room:
  // an unpaired remote is a pairing card and nothing else.
  await page.goto('/?transport=fake&room=ABCD1234#/remote');
  const picker = page.locator('#remote-module');
  await expect(picker).not.toContainText('System stats');
  await expect(page.getByTestId('remote-module-stats')).toHaveText('Stats');
});
