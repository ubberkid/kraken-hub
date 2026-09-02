import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import { KEPT_SAFELY } from '../../src/config/vocabulary';

/**
 * Round 9 — four parked product decisions, made.
 *
 * Every one of them had been deferred for the same reason: the code already
 * supported both answers and nobody had chosen. Deferring a choice is not
 * neutral — it ships one of the answers anyway, silently, with no control and no
 * words. These four are the choices, and this file is what makes them facts.
 *
 *  1. **The YouTube player shape is the user's.** The engine has always had
 *     `square` and `tight`; the round-1 census killed the control, so the field
 *     existed with exactly one reachable value. It is a segment in Advanced now,
 *     and both ends of it reach the compositor.
 *  2. **Storage persistence is a state, not a warning.** CAM's webview GRANTS
 *     `persist()`; the shelf warned about eviction anyway, in orange, forever.
 *     One line, two truthful states, and the warning tone belongs to only one.
 *  3. **One install button.** Two equally-weighted CAM install buttons is a
 *     question with an obvious answer, asked of somebody in their first minute.
 *  4. **A phone is a remote.** Every configuration screen is advice about a PC.
 */

const CAM = { width: 866, height: 537 } as const;
const PHONE = { width: 390, height: 844 } as const;
const STATE_KEY = 'kraken-hub:v1:state';
const FIXTURE_PATH = fileURLToPath(new URL('../../public/demo/demo.mp4', import.meta.url));

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

/** The stored `youtube.mode`, read out of the one state document. */
async function storedYtMode(page: Page): Promise<string | undefined> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (raw === null) return undefined;
    const doc = JSON.parse(raw) as {
      modules?: Record<string, { cfg?: { youtube?: { mode?: string } } }>;
    };
    return doc.modules?.['video']?.cfg?.youtube?.mode;
  }, STATE_KEY);
}

// ---------------------------------------------------------------------------
// 1 — the YouTube player shape
// ---------------------------------------------------------------------------

test.describe('the YouTube player shape is a choice again', () => {
  /**
   * The control writes the field, and the field is the one the engine reads.
   *
   * Not a screenshot assertion: what matters is that the segment lands in
   * `modules.video.cfg.youtube.mode`, because that string is what
   * `youtubeEmbed.adapter` hands `computeGeometry` — and the geometry engine's
   * own two worked examples (`youtube.spec.ts`, §2.3 square and §2.3 tight) are
   * what prove the two shapes are genuinely different pixels.
   */
  test('lives in Advanced, defaults to Square, and both ends persist', async ({ page }) => {
    await cam(page);
    await page.goto('/');
    await openOptions(page, 'video');

    // Advanced, never the primary surface: it is a real trade with a safe
    // default, which is exactly what the one door is for. (A closed `<details>`
    // keeps its children in the DOM, so the assertion is about visibility.)
    await expect(page.getByTestId('video-yt-mode-square')).toBeHidden();
    await page.getByTestId('video-advanced').locator('summary').click();

    const square = page.getByTestId('video-yt-mode-square');
    const tight = page.getByTestId('video-yt-mode-tight');
    await expect(square).toBeVisible();
    await expect(tight).toBeVisible();
    // Square is the default and the safe one: the frame is tall enough that
    // YouTube's own chrome never reaches the crop.
    await expect(square).toHaveAttribute('aria-checked', 'true');

    await tight.click();
    await expect(tight).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => storedYtMode(page)).toBe('tight');

    await square.click();
    await expect.poll(async () => storedYtMode(page)).toBe('square');
  });

  /**
   * …and the choice survives to the panel, which is the only claim worth making.
   *
   * The display page reads the same state document out of the shared origin, so
   * a value written by the segment above is the value the adapter composites
   * with. `tight` drops the element from 1920×1920 to 1920×1440 for a 16:9
   * source — the §2.3 worked example, arrived at through the UI rather than
   * through a seeded document.
   */
  test('a shape chosen in Advanced is the shape the display composites', async ({ context }) => {
    const config = await context.newPage();
    await cam(config);
    await config.goto('/');
    await openOptions(config, 'video');
    await config.getByTestId('video-advanced').locator('summary').click();
    await config.getByTestId('video-yt-mode-tight').click();
    await expect.poll(async () => storedYtMode(config)).toBe('tight');

    // A YouTube link, committed the way the paste row commits one.
    await config.getByTestId('ops-close').click();
    await config.getByTestId('paste-input').fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await config.getByTestId('paste-submit').click();
    await expect.poll(async () => storedYtMode(config)).toBe('tight');

    const display = await context.newPage();
    await display.setViewportSize({ width: 640, height: 640 });
    await display.goto('/?kraken=1&sim=elite');
    const iframe = display.locator('.kh-video__stage iframe.kh-video__yt');
    await expect(iframe).toBeAttached({ timeout: 20_000 });
    await expect(iframe).toHaveAttribute('width', '1920');
    // Tight: the video plus its bar-safe padding, not a square.
    await expect(iframe).toHaveAttribute('height', '1440');
  });
});

// ---------------------------------------------------------------------------
// 2 — persistence is a state, not a warning
// ---------------------------------------------------------------------------

/**
 * Stub the browser's own answer, which is the only input the line has.
 *
 * `navigator.storage.persisted()` is what `platform/idb` asks and what
 * `readQuota` reports; overriding it is therefore the honest way to put the page
 * in each of its two states. `persist()` is stubbed alongside it so the request
 * every add now makes agrees with the answer.
 */
async function stubPersistence(page: Page, granted: boolean): Promise<void> {
  await page.addInitScript((value) => {
    const storage = navigator.storage;
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        estimate: () => storage.estimate(),
        persisted: () => Promise.resolve(value),
        persist: () => Promise.resolve(value),
      },
    });
  }, granted);
}

async function seedOneClip(page: Page): Promise<void> {
  await page.getByTestId('library-add').click();
  await expect(page.getByTestId('library-add-panel')).toBeVisible();
  await page.locator('[data-testid="clip-file-input"]').setInputFiles(FIXTURE_PATH);
  await expect(page.locator('[data-testid="library-tile"]')).toHaveCount(1, { timeout: 15_000 });
}

test.describe('the library says ONE true thing about storage', () => {
  test('granted: a quiet line, and no warning anywhere', async ({ page }) => {
    await cam(page);
    await stubPersistence(page, true);
    await page.goto('/?cam=1#/library');
    await seedOneClip(page);

    await expect(page.getByTestId('library-quota')).toBeVisible();
    await expect(page.getByTestId('storage-persisted')).toHaveText(KEPT_SAFELY);
    // The whole point: the warning is not merely re-toned, it is ABSENT.
    await expect(page.getByTestId('storage-evictable')).toHaveCount(0);
    await expect(page.locator('.kh-chip--warn')).toHaveCount(0);
  });

  test('denied: the warning, with its tone and its remedy', async ({ page }) => {
    await cam(page);
    await stubPersistence(page, false);
    await page.goto('/?cam=1#/library');
    await seedOneClip(page);

    await expect(page.getByTestId('storage-persisted')).toHaveCount(0);
    const warn = page.getByTestId('storage-evictable');
    await expect(warn).toBeVisible();
    await expect(warn).toHaveClass(/kh-chip--warn/);
    // The remedy is a control on this page, which is what makes the warning
    // worth its tone: pin is on every tile.
    await expect(warn).toContainText('pin');
    await expect(page.getByTestId('tile-pin').first()).toBeVisible();
  });

  /**
   * Every add asks — the half a stub cannot fake.
   *
   * The old code cached the first grant forever, so a browser that refused once
   * was never asked again. `persist()` is counted here across two adds.
   */
  test('every add re-requests persistence while it is still refused', async ({ page }) => {
    await cam(page);
    await page.addInitScript(() => {
      const storage = navigator.storage;
      const counter = { n: 0 };
      Object.defineProperty(window, '__persistCalls', { value: counter, configurable: true });
      Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: {
          estimate: () => storage.estimate(),
          persisted: () => Promise.resolve(false),
          persist: () => {
            counter.n += 1;
            return Promise.resolve(false);
          },
        },
      });
    });
    await page.goto('/?cam=1#/library');
    await seedOneClip(page);
    await expect
      .poll(async () =>
        page.evaluate(
          () => (window as unknown as { __persistCalls: { n: number } }).__persistCalls.n,
        ),
      )
      .toBeGreaterThanOrEqual(1);

    const first = await page.evaluate(
      () => (window as unknown as { __persistCalls: { n: number } }).__persistCalls.n,
    );
    // The add panel closes itself on a successful add, so a second file goes in
    // through the same door the first one did.
    await page.getByTestId('library-add').click();
    await expect(page.getByTestId('library-add-panel')).toBeVisible();
    await page.locator('[data-testid="clip-file-input"]').setInputFiles(FIXTURE_PATH);
    await expect(page.locator('[data-testid="library-tile"]')).toHaveCount(2, { timeout: 15_000 });
    await expect
      .poll(async () =>
        page.evaluate(
          () => (window as unknown as { __persistCalls: { n: number } }).__persistCalls.n,
        ),
      )
      .toBeGreaterThan(first);
  });
});

// ---------------------------------------------------------------------------
// 3 — one install button
// ---------------------------------------------------------------------------

test.describe('one primary way into CAM', () => {
  test('the band offers one button; Beta is a link behind the address', async ({ page }) => {
    await page.setViewportSize(CAM);
    await page.goto('/');
    const band = page.getByTestId('setup-first-run');
    await expect(band).toBeVisible();

    // Exactly one primary action on the surface a first-run user sees.
    await expect(band.locator('.kh-btn--primary')).toHaveCount(1);
    await expect(page.getByTestId('setup-open-cam')).toBeVisible();
    // …and Beta is not on it at all until the address is revealed.
    await expect(page.getByTestId('setup-cam-beta')).toHaveCount(0);

    await page.getByTestId('setup-reveal-address').click();
    const beta = page.getByTestId('setup-cam-beta');
    await expect(beta).toBeVisible();
    await expect(beta).toHaveAttribute('href', /cam-beta-redirect\.nzxt\.com/);
    // Reachable, and not a button: a text link is the honest weight for a
    // channel almost nobody is on.
    await expect(beta).not.toHaveClass(/kh-btn/);
  });

  test('the quiet card under About says the same thing the same way', async ({ page }) => {
    await page.setViewportSize(CAM);
    await page.goto('/#/about');
    const card = page.getByTestId('setup-about');
    await expect(card).toBeVisible();
    await expect(card.locator('.kh-btn--primary')).toHaveCount(1);
    await expect(page.getByTestId('setup-cam-beta')).toHaveCount(0);

    await page.getByTestId('setup-reveal-address').click();
    await expect(page.getByTestId('setup-cam-beta')).not.toHaveClass(/kh-btn/);
  });
});

// ---------------------------------------------------------------------------
// 4 — a phone is a remote, on every route
// ---------------------------------------------------------------------------

test.describe('a phone gets the remote and nothing else', () => {
  for (const hash of ['', '#/library', '#/about', '#/sources', '#/diag', '#/module/video']) {
    test(`"${hash === '' ? '/' : hash}" renders the remote on a phone`, async ({ page }) => {
      await page.setViewportSize(PHONE);
      await page.goto(`/?phone=1${hash}`);

      await expect(page.getByTestId('remote')).toBeVisible();
      // None of the configuration surfaces exist on this device — not hidden,
      // not empty: absent, and therefore not in the accessibility tree either.
      await expect(page.getByTestId('mirror')).toHaveCount(0);
      await expect(page.getByTestId('library')).toHaveCount(0);
      await expect(page.getByTestId('setup-about')).toHaveCount(0);
      await expect(page.getByTestId('setup-first-run')).toHaveCount(0);
      // …and the hash agrees with the screen, in page, without a navigation.
      await expect.poll(() => new URL(page.url()).hash).toBe('#/remote');
    });
  }

  /**
   * The gate is the DEVICE, not the width — the part that had to be got right.
   *
   * `PHONE_QUERY` is true of any narrow window, including CAM's own frame at a
   * high zoom. Gating a whole app on it would mean dragging a window narrower
   * changed which product you were using. A desktop browser at 390 px keeps the
   * configuration surface, and keeps the install card it is the only surface
   * that can act on.
   */
  test('a narrow DESKTOP browser is unchanged — it is a remote at a desk, and can install CAM', async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/');
    await expect(page.getByTestId('mirror')).toBeVisible();
    await expect(page.getByTestId('setup-first-run')).toBeVisible();

    await page.goto('/#/about');
    await expect(page.getByTestId('setup-about')).toBeVisible();
  });

  /** CAM is never gated: it is the window whose storage the LCD reads. */
  test('CAM keeps every screen, at any width and with any pointer', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/?cam=1&phone=1#/library');
    await expect(page.getByTestId('library')).toBeVisible();
    await expect(page.getByTestId('library')).toHaveAttribute('data-owns', 'true');

    await page.goto('/?cam=1&phone=1#/about');
    await expect(page.getByTestId('setup-about')).toBeVisible();
  });

  /**
   * What the phone KEEPS. The shelf is the same wire-fed shelf `#/library`
   * would have drawn, and pairing lives on this screen — so nothing was lost
   * with the routes, only the advice about somebody else's machine.
   */
  test('the remote keeps its Library and its pairing, and drops the dead door', async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/?phone=1&transport=fake&room=PHON2345#/library');

    await expect(page.getByTestId('remote')).toBeVisible();
    await expect(page.getByTestId('remote-library')).toBeVisible();
    await expect(page.getByTestId('pairing-card')).toBeVisible();
    // The About link would resolve straight back to this screen, so it is gone.
    await expect(page.getByTestId('remote-connection-link')).toHaveCount(0);
  });
});
