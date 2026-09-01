import { expect, test, type Page } from '@playwright/test';

import { LINK_RECEIPT } from '../../src/config/vocabulary';
import { ROOM_CODE_HINT } from '../../src/sync/roomCode';

/**
 * Round 5, and its one theme: **the app saying something it does not know to be
 * true.**
 *
 * Every finding this round is the same shape — a surface asserting a fact it had
 * not checked, could not check, or had stopped checking:
 *
 *  - **S1** the phone's link field committed `modules.video.cfg.url` whatever
 *    was on the panel, then printed the receipt. With Image active a pasted
 *    `.jpg` went nowhere the picture module could see it, and the screen said it
 *    had been sent.
 *  - **S3** `Meter` rendered an unknown percentage as a full bar, under a
 *    docstring promising indeterminate. Asserted here on the DOM, and as a unit
 *    invariant in `src/ui/Meter.test.tsx`.
 *  - **S4** a receipt never expired and was never invalidated, so *"Added
 *    “x”."* stood over an empty shelf after the file was deleted.
 *  - **S5** an invalid room code was refused in total silence.
 *  - **S6** the About page's Route control forced sideways scroll below 390 px.
 *
 * Everything runs on the in-repo broker simulator (`?transport=fake`), so a PR
 * never goes red because a public broker is having a bad day.
 */

const STATE_KEY = 'kraken-hub:v1:state';
const DOWNLOADS_KEY = 'kraken-hub:v1:video:downloads';

/** An 8×8 PNG, for the seeded row that never leaves this browser. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4YWODFTEMLQkAZZlQAVIPr1MAAAAASUVORK5CYII=';

/**
 * An 8×8 JPEG, served cross-origin so the download-first path is genuinely
 * exercised.
 *
 * A JPEG rather than a PNG because `.png` is in `ANIMATED_EXT_RE` — APNG is a
 * real thing — so a pasted `.png` earns the frame-rate advisory, and a warning
 * on the row is not what these tests are measuring.
 */
const JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDmqKKK6TnP/9k=';
const PICTURE_URL = 'https://pictures.example.test/wallpaper.jpg';

function phoneUrl(room: string, hash = '#/remote'): string {
  return `/?transport=fake&room=${room}${hash}`;
}

function camUrl(room: string, hash = '#/'): string {
  return `/?cam=1&transport=fake&room=${room}${hash}`;
}

async function servePicture(page: Page): Promise<void> {
  await page.route(PICTURE_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/jpeg',
      headers: { 'access-control-allow-origin': '*' },
      body: Buffer.from(JPEG_BASE64, 'base64'),
    }),
  );
}

/**
 * One picture on the shelf, written straight into the store the page reads.
 *
 * The same seed `one-media-library.spec.ts` uses, and for the same reason: the
 * legacy `images` store is read through the merged-library fallback, so a row
 * put here is on the shelf without a network fetch, a decode or a probe. This
 * test is about a receipt, not about ingest.
 */
async function seedPicture(page: Page, id: string, name: string): Promise<void> {
  await page.evaluate(
    async ([base64, rowId, rowName]) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('kraken-hub.v1');
        req.onupgradeneeded = () => {
          const fresh = req.result;
          if (!fresh.objectStoreNames.contains('images')) {
            fresh.createObjectStore('images', { keyPath: 'id' });
          }
          if (!fresh.objectStoreNames.contains('imageBlobs')) {
            fresh.createObjectStore('imageBlobs', { keyPath: 'id' });
          }
        };
        req.onsuccess = () => {
          resolve(req.result);
        };
        req.onerror = () => {
          reject(req.error ?? new Error('indexedDB.open failed'));
        };
      });
      const tx = db.transaction(['images', 'imageBlobs'], 'readwrite');
      tx.objectStore('imageBlobs').put({
        id: rowId,
        blob: new Blob([bytes], { type: 'image/png' }),
      });
      tx.objectStore('images').put({
        id: rowId,
        name: rowName,
        mime: 'image/png',
        size: bytes.byteLength,
        width: 8,
        height: 8,
        animated: false,
        createdAt: Date.now(),
        lastUsedAt: 0,
        sourceUrl: null,
        pinned: false,
      });
      await new Promise<void>((resolve) => {
        tx.oncomplete = () => {
          resolve();
        };
      });
      db.close();
    },
    [PNG_BASE64, id, name] as const,
  );
}

/** The committed state document, as the app itself wrote it. */
async function readState(page: Page): Promise<Record<string, unknown>> {
  const raw = await page.evaluate((key) => localStorage.getItem(key), STATE_KEY);
  return raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
}

function moduleUrl(state: Record<string, unknown>, id: string): string {
  const modules = state['modules'] as Record<string, { cfg?: { url?: string } }> | undefined;
  return modules?.[id]?.cfg?.url ?? '';
}

// ---------------------------------------------------------------------------
// S1 — the phone's link field is the field for whatever is on the panel
// ---------------------------------------------------------------------------

test.describe('S1 — the remote asks for what the panel can use', () => {
  /**
   * The reproduction, as a passing test.
   *
   * Before the fix this wrote `modules.video.cfg.url`, left `modules.image`
   * undefined, and showed the receipt anyway. The two assertions that matter
   * are therefore a pair: the picture landed where the picture module reads,
   * and the video source was **not** touched.
   */
  test('a picture link pasted with Image active lands in the image module', async ({ page }) => {
    await page.goto(phoneUrl('HJKM2345'));
    await expect(page.getByTestId('paired-summary')).toBeVisible();

    await page.locator('#remote-module').getByRole('radio', { name: 'Image' }).click();

    await page.locator('#remote-src').fill(PICTURE_URL);
    await page.getByTestId('remote-play').click();

    // First, because the receipt is a receipt now: it lingers and goes (S4).
    await expect(page.getByTestId('remote-receipt')).toContainText(LINK_RECEIPT);

    await expect.poll(async () => moduleUrl(await readState(page), 'image')).toBe(PICTURE_URL);
    expect(moduleUrl(await readState(page), 'video')).toBe('');
    expect((await readState(page))['activeModuleId']).toBe('image');
  });

  /**
   * The per-module wording, on the phone — the same mapping CAM's home row has
   * read since round 2's R9, from `pasteLink.pasteAction`.
   */
  test('the row takes each module’s own noun, and steps aside for the two that have none', async ({
    page,
  }) => {
    await page.goto(phoneUrl('BCDF5678'));
    await expect(page.getByTestId('paired-summary')).toBeVisible();

    const field = page.locator('#remote-src');
    const submit = page.getByTestId('remote-play');
    const modules = page.locator('#remote-module');

    // Video is the resting module.
    await expect(field).toHaveAttribute('placeholder', /video link/);
    await expect(submit).toHaveText('Play');

    await modules.getByRole('radio', { name: 'Image' }).click();
    await expect(field).toHaveAttribute('placeholder', /picture link/);
    await expect(submit).toHaveText('Show');

    // Clock and Stats have nothing to be handed, so the loudest control on the
    // page changes the subject instead of asking for a video link.
    for (const name of ['Clock', 'Stats']) {
      await modules.getByRole('radio', { name }).click();
      await expect(page.locator('#remote-src')).toHaveCount(0);
      await expect(page.getByTestId('remote-paste-switch')).toHaveText('Play something');
    }

    // And the switch does what it says: video, with the caret in the field.
    await page.getByTestId('remote-paste-switch').click();
    await expect(page.locator('#remote-src')).toBeFocused();
  });

  /**
   * The field belongs to the module it is the field FOR.
   *
   * Leaving Image must not carry a picture URL into the video row — the same
   * `draftOwner` rule the home screen has.
   */
  test('switching modules does not carry a draft into the other module’s field', async ({
    page,
  }) => {
    await page.goto(phoneUrl('GHJK6789'));
    await expect(page.getByTestId('paired-summary')).toBeVisible();

    const modules = page.locator('#remote-module');
    await modules.getByRole('radio', { name: 'Image' }).click();
    await page.locator('#remote-src').fill('https://pictures.example.test/not-submitted.png');

    await modules.getByRole('radio', { name: 'Video' }).click();
    await expect(page.locator('#remote-src')).toHaveValue('');
  });
});

/**
 * The whole way through: phone → wire → display → library.
 *
 * Kept separate from the state assertions above because it needs three windows
 * and a real fetch. What it proves is the half a state assertion cannot: the
 * link the phone committed becomes an `image` row on the shelf, which is the
 * "panel shows it" the reproduction never reached.
 */
test('a picture pasted from the phone becomes an image tile in the real library', async ({
  context,
}) => {
  const room = 'MNPQ2345';

  const display = await context.newPage();
  await servePicture(display);
  await display.goto(`/?kraken=1&sim=elite&transport=fake&room=${room}`);
  await expect(display.locator('.kh-stage')).toBeVisible();

  const phone = await context.newPage();
  await phone.goto(phoneUrl(room));
  await expect(phone.getByTestId('paired-summary')).toBeVisible();

  await phone.locator('#remote-module').getByRole('radio', { name: 'Image' }).click();
  await phone.locator('#remote-src').fill(PICTURE_URL);
  await phone.getByTestId('remote-play').click();

  // The display is the window that owns the bytes, so it is the one that
  // fetches and stores — exactly as it does for a link pasted in CAM.
  const cam = await context.newPage();
  await cam.goto(camUrl(room, '#/library'));
  const tile = cam.locator('[data-testid="library-tile"][data-tile-kind="image"]');
  await expect(tile).toHaveCount(1, { timeout: 30_000 });
});

// ---------------------------------------------------------------------------
// S3 — a bar that does not know how far along it is says so
// ---------------------------------------------------------------------------

test.describe('S3 — an unknown percentage is never drawn as a finished bar', () => {
  /** A download with no `Content-Length`: `totalBytes` is 0 and stays 0. */
  const chunked = (received: number): string =>
    JSON.stringify([
      {
        id: 'd1',
        url: 'https://example.test/clips/stream.mp4',
        sourceUrl: 'https://example.test/clips/stream.mp4',
        name: 'stream.mp4',
        state: 'downloading',
        receivedBytes: received,
        totalBytes: 0,
        attempt: 1,
        error: null,
        clipId: null,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);

  test('a chunked download shows no fill at all while the bytes climb', async ({ page }) => {
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
          modules: { video: { v: 1, cfg: { url: 'https://example.test/clips/stream.mp4' } } },
        }),
      );
    });
    await page.goto('/');
    await page.evaluate(
      ([key, value]) => {
        localStorage.setItem(key, value);
      },
      [DOWNLOADS_KEY, chunked(1_048_576)] as const,
    );

    const flow = page.getByTestId('paste-flow');
    await expect(flow).toBeVisible();
    const meter = flow.locator('.kh-meter');
    await expect(meter).toHaveAttribute('data-known', 'false');

    // The claim, stated on the DOM rather than on a computed width: there is no
    // fill element, so there is no width for anything to get wrong.
    await expect(flow.locator('.kh-meter__fill')).toHaveCount(0);
    await expect(flow.locator('[data-testid="meter-indeterminate"]')).toHaveCount(1);

    // …and it stays that way while the bytes climb. This is the exact frame
    // that used to read as a completed download, over and over.
    for (const bytes of [4_194_304, 16_777_216, 67_108_864]) {
      await page.evaluate(
        ([key, value]) => {
          localStorage.setItem(key, value);
        },
        [DOWNLOADS_KEY, chunked(bytes)] as const,
      );
      await expect(flow.locator('.kh-meter__fill')).toHaveCount(0);
    }

    // The sentence beside it says what IS known — how much has landed — rather
    // than a percentage nobody has.
    await expect(flow).not.toContainText('100%');
    await expect(flow).toContainText('so far');
  });

  /**
   * The other `null` caller, on the surface the audit photographed: an
   * unmeasured quota, next to the words "space in use — unknown".
   */
  test('the library quota meter draws no fill when the quota is unknown', async ({ page }) => {
    await page.addInitScript(() => {
      // No quota estimate at all — which is what a browser that refuses
      // `navigator.storage.estimate()` gives you.
      Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: { estimate: () => Promise.resolve({}) },
      });
    });
    await page.goto('/?cam=1#/library');
    const quota = page.getByTestId('library-quota');
    await expect(quota).toBeVisible();
    await expect(quota.locator('.kh-meter')).toHaveAttribute('data-known', 'false');
    await expect(quota.locator('.kh-meter__fill')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// S4 — a receipt stops being shown when it stops being true
// ---------------------------------------------------------------------------

test.describe('S4 — receipts expire, and they invalidate', () => {
  /**
   * The invalidation, not the timer.
   *
   * The whole sequence below runs in well under the four-second linger, so the
   * only thing that can clear the line is the claim being reconciled against
   * the shelf. Before the fix, *"“wallpaper.png” is on your Kraken."* stood
   * directly above **Nothing kept here**.
   */
  test('deleting the thing a receipt is about clears the receipt', async ({ page }) => {
    await page.goto('/?cam=1#/library');
    await expect(page.getByTestId('library')).toBeVisible();

    await seedPicture(page, 'seed-pic', 'wallpaper.png');
    await page.reload();
    const tile = page.locator('[data-testid="library-tile"]');
    await expect(tile).toHaveCount(1, { timeout: 20_000 });

    await page.getByTestId('tile-show').first().click();
    const notice = page.locator('.kh-notice');
    await expect(notice).toContainText('wallpaper.png');

    await page.getByTestId('tile-delete').first().click();
    await expect(tile).toHaveCount(0);
    // Gone with the thing it was about, not four seconds later.
    await expect(notice).toHaveCount(0, { timeout: 2000 });
    await expect(page.getByTestId('library-empty')).toBeVisible();
  });

  /** The other half of the rule, on the other surface: it lingers, then goes. */
  test('the remote’s link receipt says its piece and gets out of the way', async ({ page }) => {
    await page.goto(phoneUrl('PQRS2345'));
    await expect(page.getByTestId('paired-summary')).toBeVisible();

    await page.locator('#remote-src').fill('https://example.test/clips/dunes.mp4');
    await page.getByTestId('remote-play').click();
    await expect(page.getByTestId('remote-receipt')).toBeVisible();

    // Four seconds is `RECEIPT_LINGER_MS`; nothing else on the page is touched.
    await expect(page.getByTestId('remote-receipt')).toHaveCount(0, { timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// S5 — a control that refuses says why
// ---------------------------------------------------------------------------

test.describe('S5 — a bad room code is answered, not swallowed', () => {
  async function openCodeField(page: Page): Promise<void> {
    await page.goto('/?transport=fake#/remote');
    await expect(page.getByTestId('pairing-card')).toHaveAttribute('data-paired', 'false');
    await page.getByTestId('pair-by-hand').locator('summary').click();
    await expect(page.locator('#remote-room')).toBeVisible();
  }

  for (const [shape, typed] of [
    ['too short', 'ABCD'],
    // Every character excluded from the alphabet, so the filter leaves an
    // empty box behind and **Join** has nothing at all to work with.
    ['made entirely of characters the alphabet excludes', 'UUUU-UUUU'],
  ] as const) {
    test(`a code that is ${shape} gets aria-invalid and the rule, in words`, async ({ page }) => {
      await openCodeField(page);
      const field = page.locator('#remote-room');
      await field.fill(typed);
      await page.getByTestId('pair-join').click();

      await expect(field).toHaveAttribute('aria-invalid', 'true');
      const error = page.getByTestId('pair-code-error');
      await expect(error).toBeVisible();
      await expect(error).toContainText(ROOM_CODE_HINT);
      // The field names its own error, so a screen reader reaches it.
      await expect(field).toHaveAttribute('aria-describedby', 'remote-room-bad');
      // And nothing was joined on the strength of a code that is not one.
      await expect(page.getByTestId('pairing-card')).toHaveAttribute('data-paired', 'false');
    });
  }

  test('the field filters to the code alphabet as you type', async ({ page }) => {
    await openCodeField(page);
    const field = page.locator('#remote-room');

    // The lookalikes fold exactly as `normalizeRoomCode` folds them, and `U` —
    // which Crockford excludes and which has no lookalike to fold into — is
    // simply not stored.
    await field.fill('iolu');
    await expect(field).toHaveValue('101');

    // Lowercase and separators, because a code is read aloud off a monitor.
    await field.fill('ab-cd 2345');
    await expect(field).toHaveValue('ABCD2345');

    // A ninth character can only be a mistake, so it never lands.
    await field.fill('ABCD2345XYZ');
    await expect(field).toHaveValue('ABCD2345');
    await expect(field).not.toHaveAttribute('aria-invalid', 'true');
  });

  test('the valid path is unchanged: eight good characters pair the device', async ({ page }) => {
    await openCodeField(page);
    await page.locator('#remote-room').fill('ABCD2345');
    await page.getByTestId('pair-join').click();

    await expect(page.getByTestId('pairing-card')).toHaveAttribute('data-paired', 'true');
    await expect(page.getByTestId('pair-code-error')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// S6 — nothing scrolls sideways on a phone, on any route
// ---------------------------------------------------------------------------

/**
 * The sweep, rather than the one control.
 *
 * The About page's Route segmented row was 364 px of fixed-width segments in a
 * 320 px viewport, which is a horizontal scrollbar on the page somebody opens
 * when something has already gone wrong. Fixing that row alone would be round 5
 * repeating round 3's mistake, so this asserts the property for every route at
 * every phone width the product claims to support.
 */
test.describe('S6 — no route scrolls sideways at any phone width', () => {
  const WIDTHS = [320, 360, 390] as const;
  const ROUTES = ['#/', '#/library', '#/remote', '#/about'] as const;

  for (const width of WIDTHS) {
    for (const route of ROUTES) {
      test(`${route} fits at ${String(width)} px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(`/?transport=fake&room=ABCD2345${route}`);
        await expect(page.getByRole('heading', { name: 'kraken-hub', level: 1 })).toBeVisible();

        const widths = await page.evaluate(() => {
          const el = document.scrollingElement ?? document.documentElement;
          return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
        });
        expect(
          widths.scrollWidth,
          `${route} at ${String(width)} px scrolls sideways`,
        ).toBeLessThanOrEqual(widths.clientWidth);
      });
    }
  }

  /** The specific row, named, so a regression points at the thing that broke. */
  test('the Route control wraps rather than pushing About sideways', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto('/?transport=fake#/about');
    const seg = page.locator('#room-transport');
    await expect(seg).toBeVisible();

    const fits = await seg.evaluate((el) => el.scrollWidth <= el.clientWidth);
    expect(fits).toBe(true);
    // Wrapped, not scrolled and not truncated: all four options are still there.
    await expect(seg.getByRole('radio')).toHaveCount(4);
  });
});
