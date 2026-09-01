import { expect, test, type Page } from '@playwright/test';

/**
 * The home screen, measured — design audit, round 2, waveA.
 *
 * Round 1 asked for options that resolve in place, and got them: the active chip
 * became the door and the 1,600 px settings wall went away. Round 2 then put a
 * ruler on the result and found the door opened onto something still off the
 * bottom of the screen — the options panel overflowed CAM's real 866x537 window
 * by **426 to 888 px, on every module**, because it opened *underneath* a
 * full-height composition rather than in place of one.
 *
 * So this file is arithmetic, not opinion. Every test here is a number the
 * screen has to hit in the only window CAM ever opens:
 *
 *  - each module's options fully visible, with `scrollY` still 0;
 *  - the halo cross-fading down to a live corner thumb to make the room, and
 *    coming back when the panel closes;
 *  - the one primary action taking the active module's noun;
 *  - one voice in the status line;
 *  - and the receipt getting out of the way once it is a receipt.
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
async function openOptions(page: Page, id: string): Promise<void> {
  const chip = page.getByTestId(`module-chip-${id}`);
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  if ((await chip.getAttribute('aria-expanded')) !== 'true') await chip.click();
  await expect(page.getByTestId('ops-panel')).toBeVisible();
  // The panel is a lazy chunk: wait for the module's real controls, not the
  // frame that will hold them.
  await expect(page.locator('[data-testid="ops-panel"] .kh-panel')).toBeVisible();
}

interface PanelMetrics {
  /** Distance from the panel's last pixel to the bottom of the window. */
  slack: number;
  /** Non-zero means the panel is scrolling its own content — i.e. clipped. */
  clipped: number;
  scrollY: number;
}

async function panelMetrics(page: Page): Promise<PanelMetrics> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="ops-panel"]');
    if (el === null) return { slack: -9999, clipped: 9999, scrollY: window.scrollY };
    return {
      slack: Math.round(window.innerHeight - el.getBoundingClientRect().bottom),
      clipped: el.scrollHeight - el.clientHeight,
      scrollY: window.scrollY,
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

test.describe('a module’s options open inside the window', () => {
  for (const id of MODULE_IDS) {
    test(`${id}: fully visible at 866×537, with no scroll`, async ({ page }) => {
      await cam(page);
      await page.goto('/');
      await openOptions(page, id);

      // Polled, because the halo takes 450 ms to hand over the floor and a
      // measurement mid-spring is a measurement of the animation.
      await expect.poll(async () => (await panelMetrics(page)).slack).toBeGreaterThanOrEqual(0);

      const m = await panelMetrics(page);
      // The number round 2 measured as 426–888 px of overflow, for every module.
      expect(m.slack, `${id}: options run past the bottom of CAM's window`).toBeGreaterThanOrEqual(
        0,
      );
      // "Fully visible" means fully visible: the panel is not quietly scrolling
      // its own content to fit inside the promise either.
      expect(m.clipped, `${id}: options are clipped inside their own box`).toBe(0);
      // And the app did not teleport the page to make it true.
      expect(m.scrollY).toBe(0);
    });
  }

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
      // Advanced is part of the panel, so it is part of the rule.
      await page.locator('[data-testid="ops-panel"] .kh-details__summary').first().click();
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
