import { fileURLToPath } from 'node:url';

import { devices, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * ONE tap does one thing — the phone bug, held down by a test.
 *
 * The report: *"I had to click things twice in the remote on my phone for it to
 * actually do or change anything — e.g. clicking things from my library I had to
 * click twice for it to show that library item."*
 *
 * Two causes were investigated, and they are not the same kind of thing:
 *
 *  - **Sticky hover.** A touch browser has no pointer, so it decides what a tap
 *    MEANS: iOS Safari delivers the first tap as a hover whenever hovering would
 *    reveal, hide or move something, and withholds the click. The library tile's
 *    action row was `opacity: 0` until `:hover`, which is exactly that shape.
 *    Chromium cannot reproduce it — it has no such heuristic, at any emulation
 *    setting — so it is held by a STYLESHEET rule instead
 *    (`scripts/check-invariants.mjs`, the hover-gated-content check), and the
 *    rules were rewritten hover-first so a touch browser never reads them.
 *  - **No immediate feedback.** Reproducible, and covered here: pressing a tile
 *    is a state commit whose echo can arrive a beat later saying something else,
 *    and a highlight that flickers off reads as "that did nothing".
 *    `RemoteLibrary` now holds its own press for the reconciliation grace.
 *
 * Everything below runs under real touch emulation — `hasTouch`, `isMobile`, a
 * coarse pointer — and uses `tap()` rather than `click()`, because a synthesised
 * mouse click does not exercise the touch path at all.
 */

const FIXTURE_PATH = fileURLToPath(new URL('../../public/demo/demo.mp4', import.meta.url));

/**
 * The phone descriptor, at file scope.
 *
 * `test.use` with a device is a worker-level fixture and Playwright refuses it
 * inside a `describe`. `?phone=1` is belt and braces: the emulation really does
 * report `pointer: coarse`, and the flag keeps the gate under test rather than
 * under the emulator.
 */
test.use({ ...devices['iPhone 14'], defaultBrowserType: 'chromium' });

function camUrl(room: string, hash = '#/library'): string {
  return `/?cam=1&transport=fake&room=${room}${hash}`;
}
function phoneUrl(room: string): string {
  return `/?phone=1&transport=fake&room=${room}#/remote`;
}
function displayUrl(room: string): string {
  return `/?kraken=1&sim=elite&transport=fake&room=${room}`;
}

/**
 * One clip in CAM's library, and a display running to announce it.
 *
 * The phone shares this browser context because the in-repo broker simulator
 * (`?transport=fake`) is a same-origin bus — two contexts cannot see each
 * other's messages, so a "real" storage split would mean no pairing at all.
 */
async function pairedPhoneWithOneClip(context: BrowserContext, room: string): Promise<Page> {
  const cam = await context.newPage();
  await cam.setViewportSize({ width: 900, height: 700 });
  await cam.goto(camUrl(room));
  await cam.getByTestId('library-add').click();
  await cam.locator('[data-testid="clip-file-input"]').setInputFiles(FIXTURE_PATH);
  await expect(cam.locator('[data-testid="library-tile"]')).toHaveCount(1, { timeout: 15_000 });

  const display = await context.newPage();
  await display.setViewportSize({ width: 640, height: 640 });
  await display.goto(displayUrl(room));
  await expect(display.locator('.kh-stage')).toBeVisible();

  const phone = await context.newPage();
  await phone.goto(phoneUrl(room));
  await expect(phone.getByTestId('paired-summary')).toBeVisible();
  await expect(phone.locator('[data-testid="library-tile"]')).toHaveCount(1, { timeout: 20_000 });
  return phone;
}

test.describe('one tap, one effect', () => {
  test('the emulation really is a phone — coarse pointer, no hover', async ({ page }) => {
    await page.goto('/?phone=1');
    // A test that measured a mouse would pass every assertion below for the
    // wrong reason, so the environment is asserted first.
    expect(
      await page.evaluate(() => ({
        coarse: matchMedia('(pointer: coarse)').matches,
        noHover: matchMedia('(hover: none)').matches,
        touch: 'ontouchstart' in window,
      })),
    ).toEqual({ coarse: true, noHover: true, touch: true });
  });

  /**
   * …and it has TWO of them, which is the harness `remote-editor.spec.ts` rests
   * on — round 13, F5.
   *
   * `page.touchscreen` taps with one finger and `page.mouse` has none, so the
   * pinch and two-finger rotate in §8 could not be reached from this suite at
   * all. The only route is the DevTools protocol: `Input.dispatchTouchEvent`
   * takes a LIST of touch points and Chrome expands the list into one
   * `pointerdown` per point, with distinct `pointerId`s.
   *
   * Asserted HERE, on a page with no editor on it, because if this ever stops
   * being true the pinch tests two files over would fail with a story about
   * gestures rather than with the truth: the input harness stopped delivering
   * two fingers. The environment is asserted before the thing that needs it,
   * which is the same reason the test above measures `pointer: coarse`.
   */
  test('two touch points arrive as two independent pointers', async ({ page }) => {
    await page.goto('/?phone=1');
    await page.evaluate(() => {
      (window as unknown as { __ids: number[] }).__ids = [];
      window.addEventListener(
        'pointerdown',
        (e) => {
          (window as unknown as { __ids: number[] }).__ids.push(e.pointerId);
        },
        true,
      );
    });

    const cdp = await page.context().newCDPSession(page);
    const points = [
      { x: 100, y: 400, id: 0, radiusX: 8, radiusY: 8 },
      { x: 200, y: 400, id: 1, radiusX: 8, radiusY: 8 },
    ];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    const ids = await page.evaluate(() => (window as unknown as { __ids: number[] }).__ids);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  /**
   * The tile actions are reachable WITHOUT a hover that could swallow the tap.
   *
   * The old stylesheet hid them at `opacity: 0` and revealed them on `:hover`,
   * with an `@media (hover: none)` block putting them back. Same pixels here,
   * and a different rule on the phone the user is holding — the point is that
   * nothing on a touch device is gated behind a state a touch device cannot
   * enter.
   */
  test('a tile’s actions are visible on a touch device, ungated', async ({ context }) => {
    const phone = await pairedPhoneWithOneClip(context, 'TAPA2345');
    const actions = phone.locator('[data-testid="library-tile"] .kh-tile__actions');
    await expect(actions).toBeVisible();
    await expect(actions).toHaveCSS('opacity', '1');
    await expect(phone.getByTestId('tile-pin')).toBeVisible();
    await expect(phone.getByTestId('tile-delete')).toBeVisible();
  });

  /**
   * The report itself: ONE tap shows the item, and the state agrees.
   *
   * Both halves are asserted, because either one alone is a different bug: the
   * badge without the commit is a lie, and the commit without the badge is what
   * makes somebody tap again.
   */
  test('one tap on a library tile shows it, and commits it', async ({ context }) => {
    const phone = await pairedPhoneWithOneClip(context, 'TAPB2345');

    await expect(phone.getByTestId('tile-active')).toHaveCount(0);
    await phone.getByTestId('tile-show').first().tap();

    await expect(phone.getByTestId('tile-active')).toBeVisible();
    await expect(phone.locator('[data-testid="library-tile"]')).toHaveClass(/kh-tile--active/);
    await expect
      .poll(async () =>
        phone.evaluate(() => {
          const raw = localStorage.getItem('kraken-hub:v1:state');
          if (raw === null) return null;
          const doc = JSON.parse(raw) as {
            activeModuleId?: string;
            modules?: Record<string, { cfg?: { url?: string } }>;
          };
          return `${doc.activeModuleId ?? ''}|${doc.modules?.['video']?.cfg?.url ?? ''}`;
        }),
      )
      .toMatch(/^video\|kraken-hub-clip:/);

    // …and it STAYS shown. The state channel is last-writer-wins, so a frame
    // already in flight can answer with the previous tile; the shelf holds its
    // own press for the reconciliation grace rather than flickering off, which
    // is what a person reads as "that did nothing".
    await expect(phone.getByTestId('tile-active')).toBeVisible({ timeout: 3000 });
  });

  /** A second tap on the tile already showing is the same sentence twice. */
  test('tapping the showing tile again is harmless', async ({ context }) => {
    const phone = await pairedPhoneWithOneClip(context, 'TAPC2345');
    const hit = phone.getByTestId('tile-show').first();

    await hit.tap();
    await expect(phone.getByTestId('tile-active')).toBeVisible();
    await hit.tap();
    // Not a toggle: `showTile` writes an absolute value, so nothing is undone.
    await expect(phone.getByTestId('tile-active')).toBeVisible();
    await expect(phone.locator('[data-testid="library-tile"]')).toHaveClass(/kh-tile--active/);
  });

  /**
   * The other controls on the screen, each with exactly one tap.
   *
   * The report said "things", not "the library", so the sweep is the transport,
   * the segments and the shelf's own select mode — every gesture a thumb makes
   * on this page that has a state to observe.
   */
  test('one tap changes a segment, the transport and select mode', async ({ context }) => {
    const phone = await pairedPhoneWithOneClip(context, 'TAPD2345');

    // A segmented control: `Fit`, which is a pure local state commit.
    const contain = phone.getByTestId('remote-fit-contain');
    await expect(contain).toHaveAttribute('aria-checked', 'false');
    await contain.tap();
    await expect(contain).toHaveAttribute('aria-checked', 'true');

    // The transport's hold button, whose label IS its state.
    const hold = phone.getByTestId('transport-hold');
    const before = await hold.textContent();
    await hold.tap();
    await expect(hold).not.toHaveText(before ?? '');

    // The shelf's own mode switch, and a tile tap inside it.
    await phone.getByTestId('remote-select').tap();
    await expect(phone.getByTestId('tile-select')).toBeVisible();
    await phone.getByTestId('tile-select').tap();
    await expect(phone.getByTestId('tile-selected')).toBeVisible();
    await expect(phone.getByTestId('remote-bulk')).toBeVisible();
  });
});
