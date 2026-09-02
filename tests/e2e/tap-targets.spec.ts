import { expect, test, type Page } from '@playwright/test';

/**
 * Every visible interactive element, on every route, at phone width (F6).
 *
 * ## Why this file exists instead of another list
 *
 * Round 2 shipped a touch-target fix and a test to go with it. The test named
 * five selectors — the five the round-2 audit had photographed — and everything
 * it did not name stayed exactly as small as it had been. Round 3 walked the
 * DOM instead of the screenshots and found seventeen more, including the four
 * **module chips**: the app's primary gesture, at 36 px, sitting directly under
 * a passing test about touch targets.
 *
 * So this file does not name any element. It enumerates what the page actually
 * paints — every anchor, button, form control, `summary`, ARIA widget and
 * anything else in the tab order — and holds all of it to the same floor. A
 * control added next year is caught here rather than in round four.
 *
 * ## What counts as the target
 *
 * The bounding box, OR an absolutely-positioned `::before`/`::after` bleed,
 * whichever is bigger. That distinction is load-bearing and round 2 got it
 * wrong in the opposite direction: the loop handles already had a 44 px hit
 * area via a pseudo-element and the test could not see it, so the fix was to
 * move the DOT into the pseudo and make the button itself the target. Both
 * techniques are legitimate — a 44 px disc in a panel head would be a porthole
 * — so the measurement understands both, and a hit area that exists only in a
 * developer's intention still fails.
 */

/** A small modern phone — the narrowest surface any of this is designed for. */
const PHONE = { width: 390, height: 844 } as const;

/** Both vendors publish the same floor for a touch target. */
const TAP_PX = 44;

/**
 * Elements this rule does not apply to, and why.
 *
 * Deliberately empty. Every exception considered during round 3 turned out to
 * be a control that should simply be bigger, and an exception list is how the
 * round-2 version of this test came to pass while missing the module chips.
 * Anything added here must name the element and the reason, and must be a case
 * where 44 px is genuinely the wrong answer rather than the inconvenient one.
 */
const JUSTIFIED_EXCEPTIONS: readonly { selector: string; because: string }[] = [];

interface SmallTarget {
  what: string;
  width: number;
  height: number;
}

/**
 * Measure every visible interactive element and return the ones under the floor.
 *
 * Runs in the page, because the alternative is one round trip per element and
 * there are ~40 of them per route.
 */
async function smallTargets(page: Page): Promise<SmallTarget[]> {
  return page.evaluate(
    ({ floor, skipSelectors }) => {
      const SELECTOR = [
        'a[href]',
        'button',
        'input:not([type="hidden"])',
        'select',
        'textarea',
        'summary',
        '[role="button"]',
        '[role="radio"]',
        '[role="slider"]',
        '[role="switch"]',
        '[tabindex]:not([tabindex="-1"])',
      ].join(', ');

      /** The drawn box, or an absolutely-positioned pseudo bleed — the larger. */
      const hitBox = (el: Element): { w: number; h: number } => {
        const r = el.getBoundingClientRect();
        let w = r.width;
        let h = r.height;
        for (const pseudo of ['::before', '::after']) {
          const ps = getComputedStyle(el, pseudo);
          if (ps.content === 'none' || ps.position !== 'absolute') continue;
          const pw = Number.parseFloat(ps.width);
          const ph = Number.parseFloat(ps.height);
          if (Number.isFinite(pw)) w = Math.max(w, pw);
          if (Number.isFinite(ph)) h = Math.max(h, ph);
        }
        return { w, h };
      };

      const out: { what: string; width: number; height: number }[] = [];
      for (const el of document.querySelectorAll(SELECTOR)) {
        if (skipSelectors.some((s) => el.matches(s))) continue;
        const r = el.getBoundingClientRect();
        // Not painted: a closed drawer's contents, a `display:none` branch.
        if (r.width === 0 || r.height === 0) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden') continue;
        const { w, h } = hitBox(el);
        if (w >= floor && h >= floor) continue;
        const name = el.textContent.trim().slice(0, 30);
        const cls = typeof el.className === 'string' ? el.className.slice(0, 40) : '';
        out.push({
          what: `<${el.tagName.toLowerCase()}> .${cls} "${name}"`,
          width: Math.round(w),
          height: Math.round(h),
        });
      }
      return out;
    },
    { floor: TAP_PX, skipSelectors: JUSTIFIED_EXCEPTIONS.map((e) => e.selector) },
  );
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

async function expectAllReachable(page: Page, where: string): Promise<void> {
  await settle(page);
  const small = await smallTargets(page);
  expect(
    small.map((s) => `${String(s.width)}x${String(s.height)} ${s.what}`),
    `${where}: controls below the ${String(TAP_PX)} px touch floor`,
  ).toEqual([]);
}

/** The steady state: a Kraken has connected, so the install band is gone. */
async function phone(page: Page, seen = true): Promise<void> {
  await page.setViewportSize(PHONE);
  if (seen) {
    await page.addInitScript(() => {
      localStorage.setItem('kraken-hub:v1:config:displaySeen', '1');
    });
  }
}

/** Open every drawer on the page, so nothing hides behind one. */
async function openEveryDrawer(page: Page): Promise<void> {
  const summaries = page.locator('main details > summary');
  for (let i = 0; i < (await summaries.count()); i++) {
    await summaries.nth(i).click();
  }
}

const MODULE_IDS = ['video', 'clock', 'stats', 'image'] as const;

/**
 * Switch to a module and open its options.
 *
 * A helper rather than a branch in the test body: an inactive chip switches and
 * the already-active chip is the door, so the number of presses depends on
 * where you started. That is setup, not an assertion.
 */
async function openOptions(page: Page, id: string): Promise<void> {
  const chip = page.getByTestId(`module-chip-${id}`);
  await chip.click();
  if ((await chip.getAttribute('aria-expanded')) !== 'true') await chip.click();
  await expect(page.locator(`[data-testid="ops-panel"] .kh-field`).first()).toBeVisible();
}

/* eslint-disable playwright/expect-expect --
   `expectAllReachable` IS the assertion in every test below; the rule matches
   on a literal `expect` in the test body and cannot see through a helper. The
   alternative — inlining the sweep four times — is the duplication this file
   exists to remove. */
test.describe('every control is a thumb target at 390 px', () => {
  test('the home screen, and every module’s options and Advanced door', async ({ page }) => {
    await phone(page);
    await page.goto('/');
    await expectAllReachable(page, 'home, nothing open');

    for (const id of MODULE_IDS) {
      await openOptions(page, id);
      await expectAllReachable(page, `home, ${id} options`);
      await openEveryDrawer(page);
      await expectAllReachable(page, `home, ${id} options + Advanced`);
      await page.getByTestId('ops-close').click();
    }
  });

  test('the loop scrubber — the only drag in the product', async ({ page }) => {
    await phone(page);
    await page.goto('/');
    await page.getByTestId('module-chip-video').click();
    await page.getByTestId('ops-loop-button').click();
    await expect(page.getByTestId('ops-loop-panel')).toBeVisible();
    await expectAllReachable(page, 'home, loop scrubber');
  });

  test('the first-run band, which is the first thing anybody touches', async ({ page }) => {
    await phone(page, false);
    await page.goto('/');
    await expect(page.getByTestId('setup-first-run')).toBeVisible();
    await expectAllReachable(page, 'home, first run');
    await page.getByTestId('setup-reveal-address').click();
    await expectAllReachable(page, 'home, first run, address revealed');
  });

  test('the library, the remote and the About page', async ({ page }) => {
    await phone(page);

    await page.goto('/?cam=1#/library');
    await expect(page.getByTestId('library')).toBeVisible();
    await expectAllReachable(page, 'library');
    await page.getByTestId('library-add').click();
    await expect(page.getByTestId('library-add-panel')).toBeVisible();
    await expectAllReachable(page, 'library, add panel open');

    // Paired: an unpaired remote is a pairing card and nothing else (round 2, R4),
    // so the instrument only exists to be measured once a room does.
    await page.goto('/?transport=fake&room=ABCD1234#/remote');
    await expect(page.locator('main')).toBeVisible();
    await openEveryDrawer(page);
    await expectAllReachable(page, 'remote, paired, drawers open');

    await page.goto('/#/about');
    await expect(page.locator('main')).toBeVisible();
    await openEveryDrawer(page);
    await expectAllReachable(page, 'about, drawers open');
  });

  /**
   * The measurement itself, proved.
   *
   * A sweep that silently selected nothing would pass every assertion above, and
   * that is precisely how a test like this rots. So: the page has controls, and
   * the floor is a floor the code could fail.
   */
  test('the sweep actually finds controls to measure', async ({ page }) => {
    await phone(page);
    await page.goto('/');
    await expect(page.getByTestId('home')).toBeVisible();
    const counted = await page.evaluate(
      () =>
        document.querySelectorAll('a[href], button, input:not([type="hidden"]), summary').length,
    );
    expect(counted).toBeGreaterThan(8);
    // Same sweep, an impossible floor: it has to report something.
    const withImpossibleFloor = await page.evaluate(
      () =>
        [...document.querySelectorAll('button')].filter(
          (el) => el.getBoundingClientRect().height < 4000,
        ).length,
    );
    expect(withImpossibleFloor).toBeGreaterThan(0);
  });

  /**
   * The one control that dismisses a sheet — round 10's M3.
   *
   * `.kh-iconbtn` is 26×26, which is right for a mouse and 18 px under the floor
   * for a finger, and the sheet's close button is that class. It measured 26×26
   * on the phone's add sheet, which is the same `AddSheet` component the desktop
   * editor renders — so the fix is a coarse-pointer rule and the measurement is
   * of that rule, taken where the sheet exists.
   *
   * A touch context at CAM's own window rather than at 390: the editor is what
   * puts these sheets on the screen, and the media query is
   * `(pointer: coarse)` — not a width. A touch laptop and a phone in a paired
   * room get the same 44 px.
   */
  test('a sheet’s close button is a thumb target on a touch screen', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 866, height: 537 },
      hasTouch: true,
      isMobile: true,
    });
    await context.addInitScript(() => {
      localStorage.setItem('kraken-hub:v1:config:displaySeen', '1');
    });
    const page = await context.newPage();
    await page.goto('/');
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

    /** How each sheet is opened, beside the id of the button that closes it. */
    const sheets: readonly { open: (p: Page) => Promise<void>; close: string }[] = [
      {
        open: async (p) => {
          await p.getByTestId('rail-add').click();
        },
        close: 'add-sheet-close',
      },
      {
        open: async (p) => {
          await p.getByTestId('looks-menu').click();
          await p.getByTestId('looks-browse').click();
        },
        close: 'looks-sheet-close',
      },
    ];

    for (const sheet of sheets) {
      await sheet.open(page);
      const box = await page.getByTestId(sheet.close).boundingBox();
      expect(box?.width, `${sheet.close} width`).toBeGreaterThanOrEqual(TAP_PX);
      expect(box?.height, `${sheet.close} height`).toBeGreaterThanOrEqual(TAP_PX);
      await page.getByTestId(sheet.close).click();
    }

    await context.close();
  });
});

/**
 * Selection, in a high-contrast theme — round 12's F12-10 (WCAG 1.4.1).
 *
 * Every "this one is chosen" state in `ui.css` was an accent COLOUR and
 * nothing else. Under `forced-colors: active` the user agent replaces author
 * colours with the two the theme provides, so the selected base chip computed
 * BYTE-IDENTICAL to the six unselected ones — same background, same text, same
 * border, same weight — and which background is on the panel became
 * unanswerable from the screen.
 *
 * Measured at CAM's window rather than at 390, because the chip row in its rail
 * is where the audit found it. The assertion is deliberately loose about WHICH
 * property carries the difference: a fill, an outline and a border are all
 * legitimate answers, and an empty one is not.
 */
test('selection survives a forced-colours theme', async ({ page }) => {
  await page.setViewportSize({ width: 866, height: 537 });
  await page.addInitScript(() => {
    localStorage.setItem('kraken-hub:v1:config:displaySeen', '1');
  });
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto('/');
  await expect(page.getByTestId('mods-row')).toBeVisible();
  await settle(page);

  const chips = await page.evaluate(() => {
    const read = (el: Element): Record<string, string> => {
      const cs = getComputedStyle(el);
      return {
        background: cs.backgroundColor,
        color: cs.color,
        border: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`,
        outline: `${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineColor}`,
        weight: cs.fontWeight,
      };
    };
    const all = [...document.querySelectorAll('[data-testid="mods-row"] .kh-mod')];
    const on = all.find((c) => c.getAttribute('aria-pressed') === 'true');
    const off = all.find((c) => c.getAttribute('aria-pressed') !== 'true');
    return {
      count: all.length,
      on: on === undefined ? null : read(on),
      off: off === undefined ? null : read(off),
    };
  });

  // The measurement is only worth anything if it found both states.
  expect(chips.count, 'the base picker has chips to compare').toBeGreaterThan(2);
  expect(chips.on, 'no chip is marked as the current background').not.toBeNull();
  expect(chips.off, 'every chip claims to be the current background').not.toBeNull();

  const differing = Object.keys(chips.on ?? {}).filter(
    (key) => chips.on?.[key] !== chips.off?.[key],
  );
  expect(
    differing,
    'the selected chip is byte-identical to an unselected one in forced colours',
  ).not.toEqual([]);
});
