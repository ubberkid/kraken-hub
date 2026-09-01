import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

/**
 * The shelf is LIVE in every window, and CAM's Add takes what CAM's grid draws.
 *
 * Two defects that only appear once you stop seeding the library before the
 * windows exist — which is what every other spec in this suite does, and the
 * reason the suite structurally could not see either of them.
 *
 * ## 1. A change made in CAM reaches an already-open remote
 *
 * The display re-announced its shelf on four triggers: boot, a five-minute
 * keepalive, its own downloader, and a command from a remote. A file added,
 * renamed or deleted in CAM's configuration window — the window that owns the
 * bytes, and the one a person is most likely to be sitting at — was none of
 * them. So a phone that was already open kept showing the shelf as it stood up
 * to five minutes ago: missing what had just been added, and still offering a
 * tile for a row that no longer existed, which plays nothing when pressed.
 * Reloading the phone fixed it instantly, which is the shape of the bug — the
 * cold path (`requestLibrary` on connect) was right and the live path did not
 * exist.
 *
 * The ordering below is the whole test. Display up, phone open and settled on an
 * EMPTY shelf, and only then does CAM appear and add something.
 *
 * ## 2. CAM's own Add takes a picture
 *
 * `accept="video/mp4,video/webm,video/quicktime"`, on the one surface that owns
 * the bytes, on a page whose grid renders pictures — while the phone's Add, on a
 * surface that owns nothing, accepted `video/*,image/*`. The only routes to a
 * picture in CAM were a URL or a transfer from a phone in the same room.
 *
 * Everything runs against the in-repo broker simulator (`?transport=fake`).
 */

const FIXTURE_PATH = fileURLToPath(new URL('../../public/demo/demo.mp4', import.meta.url));

/** An 8×8 PNG, small enough to inline and real enough for `<img>` to decode. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4YWODFTEMLQkAZZlQAVIPr1MAAAAASUVORK5CYII=';

/**
 * Comfortably inside `LIBRARY_REPUBLISH_MS` (300 s), and comfortably outside
 * anything an ingest can take. The verifier's own run watched the phone stay
 * wrong at 3 s, 10 s, 20 s and 40 s, so a bound here is a real bound: nothing
 * short of the keepalive could ever have satisfied it.
 */
const LIVE_MS = 25_000;

function camUrl(room: string): string {
  return `/?cam=1&transport=fake&room=${room}#/library`;
}

function phoneUrl(room: string): string {
  return `/?transport=fake&room=${room}#/remote`;
}

function displayUrl(room: string): string {
  return `/?kraken=1&sim=elite&transport=fake&room=${room}`;
}

function tiles(page: Page) {
  return page.locator('[data-testid="library-tile"]');
}

/** A display that is up and connected. */
async function openDisplay(page: Page, room: string): Promise<void> {
  await page.goto(displayUrl(room));
  await expect(page.locator('.kh-stage')).toBeVisible();
  await expect
    .poll(
      async () => {
        const raw = await page.locator('html').getAttribute('data-kh-sync');
        return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>)['net'];
      },
      { timeout: 20_000 },
    )
    .toBe('online');
}

/** One clip, added through the same **+** panel a person would use. */
async function addClip(cam: Page): Promise<void> {
  await cam.getByTestId('library-add').click();
  await expect(cam.getByTestId('library-add-panel')).toBeVisible();
  await cam.locator('[data-testid="clip-file-input"]').setInputFiles(FIXTURE_PATH);
}

test.describe('a change made in CAM reaches a phone that is already looking', () => {
  test('a clip added after both windows are live turns up on the phone', async ({ context }) => {
    test.slow();
    const room = 'LVKM2345';

    const display = await context.newPage();
    await openDisplay(display, room);

    const phone = await context.newPage();
    await phone.goto(phoneUrl(room));
    // Settled, not merely open: the empty shelf means a library packet has
    // already been received and rendered, so anything that arrives after this
    // is genuinely a second announcement rather than the first one being slow.
    await expect(phone.getByTestId('remote-library-empty')).toBeVisible({ timeout: 30_000 });

    // …and only now does the window that owns the bytes appear.
    const cam = await context.newPage();
    await cam.goto(camUrl(room));
    await expect(cam.getByTestId('library')).toBeVisible();
    await addClip(cam);
    await expect(tiles(cam)).toHaveCount(1, { timeout: 20_000 });

    // The claim. Nothing was pressed on the phone and nothing was reloaded.
    await expect(tiles(phone)).toHaveCount(1, { timeout: LIVE_MS });
    await expect(tiles(phone).first()).toContainText('demo.mp4');

    /*
     * The other direction, which is the worse half.
     *
     * A missing tile is a shelf that looks short; a STALE tile is a shelf that
     * offers a row the Kraken no longer has, and pressing it plays nothing.
     */
    await tiles(cam).first().getByTestId('tile-delete').click();
    // Both shelves ask before a destructive act (round 6, CAM parity).
    await cam.getByTestId('library-confirm-delete-yes').click();
    await expect(tiles(cam)).toHaveCount(0, { timeout: 20_000 });
    await expect(tiles(phone)).toHaveCount(0, { timeout: LIVE_MS });
    await expect(phone.getByTestId('remote-library-empty')).toBeVisible();
  });
});

test.describe('CAM adds a picture through its own + panel', () => {
  test('a picture becomes an ordinary tile, and the image module shows it', async ({ context }) => {
    const cam = await context.newPage();
    await cam.goto('/?cam=1#/library');
    await expect(cam.getByTestId('library')).toBeVisible();

    await cam.getByTestId('library-add').click();
    await expect(cam.getByTestId('library-add-panel')).toBeVisible();
    // The picker takes it: before this it accepted three video containers, and
    // the file went to the video ingest, which rejected it.
    await cam.locator('[data-testid="clip-file-input"]').setInputFiles({
      name: 'holiday.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_BASE64, 'base64'),
    });

    const tile = tiles(cam).first();
    await expect(tile).toBeVisible({ timeout: 20_000 });
    await expect(tile).toContainText('holiday.png');
    // Kind is a property of the row, and the row it produced is a picture — it
    // went through `ingestImageBlob`, not through the video path with a
    // hopeful mime default.
    await expect(tile).toHaveAttribute('data-tile-kind', 'image');
    // …and it is addressable as one, which is what the show commit needs.
    await expect(tile).toHaveAttribute('data-image-id', /.+/);

    await tile.getByTestId('tile-show').click();
    await expect(tile.getByTestId('tile-active')).toBeVisible({ timeout: 15_000 });

    const display = await context.newPage();
    await display.setViewportSize({ width: 640, height: 640 }); // device-size-ok: the Elite preset this spec drives
    await display.goto('/?kraken=1&sim=elite');
    const img = display.locator('.kh-image__img');
    await expect(img).toBeVisible({ timeout: 20_000 });
    // A `blob:` source is the assertion: the module resolved the id the grid
    // committed against the ONE library and painted the stored bytes.
    await expect(img).toHaveAttribute('src', /^blob:/);
    await expect(display.locator('.kh-image__message')).toBeHidden();
  });
});
