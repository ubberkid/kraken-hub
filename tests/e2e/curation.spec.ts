import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

/**
 * Curating the one library from a window that cannot reach the bytes — wave 3.
 *
 * Wave 1 deliberately left pin, rename and delete off the remote: *"a button
 * that silently writes to the wrong database is worse than no button."* That was
 * right about the button and wrong about the fix. The remote does not write to a
 * database at all now — it ASKS the window that owns one, over the `cmd`
 * channel, and the display applies the change and re-announces the shelf.
 *
 * Four claims, and each is a different way this could be quietly broken:
 *
 *  1. a pin sent from the phone lands on the row CAM can see;
 *  2. so does a rename, which is the one thing on a tile a person chose;
 *  3. **three tiles deleted together arrive as ONE command** — `sendCmd`
 *     throttles per-op at 200 ms and DROPS the rest of a loop, so a per-tile
 *     loop would delete one thing and leave two tiles to come back;
 *  4. a change the Kraken never made is ROLLED BACK, with a sentence, instead of
 *     staying optimistically applied forever.
 *
 * Everything runs against the in-repo broker simulator (`?transport=fake`), so a
 * PR never goes red because a public broker is having a bad day.
 */

const FIXTURE_PATH = fileURLToPath(new URL('../../public/demo/demo.mp4', import.meta.url));

function camUrl(room: string, hash = '#/library'): string {
  return `/?cam=1&transport=fake&room=${room}${hash}`;
}

function phoneUrl(room: string, hash = '#/remote'): string {
  return `/?transport=fake&room=${room}${hash}`;
}

function displayUrl(room: string): string {
  return `/?kraken=1&sim=elite&transport=fake&room=${room}`;
}

function tiles(page: Page) {
  return page.locator('[data-testid="library-tile"]');
}

/** The display's machine-readable mirror of what it has actually applied. */
async function readout(display: Page): Promise<Record<string, unknown>> {
  const raw = await display.locator('html').getAttribute('data-kh-sync');
  return raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
}

/**
 * `n` real clips in CAM's library.
 *
 * Added one at a time through the same **+** panel a person would use, because
 * that is the only honest way to produce the IndexedDB rows the display then
 * announces. The same file three times is three rows: the id is a UUID, never
 * the filename.
 */
async function seedClips(cam: Page, room: string, n: number): Promise<void> {
  await cam.goto(camUrl(room));
  for (let i = 0; i < n; i += 1) {
    // The panel closes itself on a successful add, so it is reopened per file.
    await cam.getByTestId('library-add').click();
    await expect(cam.getByTestId('library-add-panel')).toBeVisible();
    await cam.locator('[data-testid="clip-file-input"]').setInputFiles(FIXTURE_PATH);
    await expect(tiles(cam)).toHaveCount(i + 1, { timeout: 20_000 });
  }
}

/** A display that is up, connected, and has announced its shelf to the phone. */
async function openDisplay(page: Page, room: string): Promise<void> {
  await page.goto(displayUrl(room));
  await expect(page.locator('.kh-stage')).toBeVisible();
  await expect.poll(async () => (await readout(page))['net'], { timeout: 20_000 }).toBe('online');
}

test.describe('the phone curates the one library', () => {
  test('a pin sent from the phone lands on the row CAM can see', async ({ context }) => {
    const room = 'PNKM2345';
    const cam = await context.newPage();
    await seedClips(cam, room, 1);

    const display = await context.newPage();
    await openDisplay(display, room);

    const phone = await context.newPage();
    await phone.goto(phoneUrl(room));
    await expect(tiles(phone)).toHaveCount(1, { timeout: 30_000 });

    const tile = tiles(phone).first();
    const id = await tile.getAttribute('data-clip-id');
    expect(id).not.toBeNull();

    await tile.getByTestId('tile-pin').click();
    // Optimistic: the tile says so before any packet has come back.
    await expect(tile).toContainText('pinned');

    // …and the window that holds the bytes agrees, which is the whole claim.
    const camTile = cam.locator(`[data-clip-id="${id ?? ''}"]`);
    await expect(camTile).toContainText('pinned', { timeout: 20_000 });

    // Absolute, never a toggle: pressing Unpin sets false rather than flipping
    // whatever the display happens to hold.
    await tile.getByTestId('tile-pin').click();
    await expect(camTile).not.toContainText('pinned', { timeout: 20_000 });
  });

  test('a rename sent from the phone reaches the row', async ({ context }) => {
    const room = 'RNKM3456';
    const cam = await context.newPage();
    await seedClips(cam, room, 1);

    const display = await context.newPage();
    await openDisplay(display, room);

    const phone = await context.newPage();
    await phone.goto(phoneUrl(room));
    await expect(tiles(phone)).toHaveCount(1, { timeout: 30_000 });

    const tile = tiles(phone).first();
    const id = await tile.getAttribute('data-clip-id');

    await tile.getByTestId('tile-rename').click();
    await tile.getByTestId('tile-rename-input').fill('Sunset over the pier');
    await tile.getByTestId('tile-rename-save').click();

    await expect(tile).toContainText('Sunset over the pier');
    await expect(cam.locator(`[data-clip-id="${id ?? ''}"]`)).toContainText(
      'Sunset over the pier',
      { timeout: 20_000 },
    );
  });

  /**
   * The batching claim, asserted where it can actually be seen.
   *
   * `SyncService.sendCmd` throttles PER OP at 200 ms and **drops** what lands
   * inside the window — it does not queue it — so three `deleteMedia` commands
   * fired in a loop are one command and two silently discarded. The display
   * counts every curation command it applies onto its readout, so "three tiles,
   * one command" is a number rather than a hope.
   */
  test('three tiles deleted together arrive as ONE command', async ({ context }) => {
    const room = 'BTKM4567';
    const cam = await context.newPage();
    await seedClips(cam, room, 3);

    const display = await context.newPage();
    await openDisplay(display, room);
    expect((await readout(display))['cur']).toBeUndefined();

    const phone = await context.newPage();
    await phone.goto(phoneUrl(room));
    await expect(tiles(phone)).toHaveCount(3, { timeout: 30_000 });

    await phone.getByTestId('remote-select').click();
    for (let i = 0; i < 3; i += 1) {
      await tiles(phone).nth(i).getByTestId('tile-select').click();
    }
    await expect(phone.getByTestId('remote-bulk')).toContainText('3 chosen');

    // Destructive, from a room away, over a link with no acknowledgement: this
    // is the one action that asks twice.
    await phone.getByTestId('remote-bulk-delete').click();
    await expect(phone.getByTestId('remote-confirm-delete')).toBeVisible();
    await phone.getByTestId('remote-confirm-delete-yes').click();

    // Optimistic, immediately — no packet has come back yet.
    await expect(tiles(phone)).toHaveCount(0);
    // The bytes are gone from the window that held them…
    await expect(tiles(cam)).toHaveCount(0, { timeout: 20_000 });
    // …and it took exactly one command to do it.
    await expect.poll(async () => (await readout(display))['cur'], { timeout: 20_000 }).toBe(1);
  });

  test('the confirm can be declined, and then nothing happened', async ({ context }) => {
    const room = 'CFKM5678';
    const cam = await context.newPage();
    await seedClips(cam, room, 1);

    const display = await context.newPage();
    await openDisplay(display, room);

    const phone = await context.newPage();
    await phone.goto(phoneUrl(room));
    await expect(tiles(phone)).toHaveCount(1, { timeout: 30_000 });

    await tiles(phone).first().getByTestId('tile-delete').click();
    await expect(phone.getByTestId('remote-confirm-delete')).toBeVisible();
    await phone.getByTestId('remote-confirm-delete-no').click();

    await expect(phone.getByTestId('remote-confirm-delete')).toHaveCount(0);
    await expect(tiles(phone)).toHaveCount(1);
    await expect(tiles(cam)).toHaveCount(1);
    expect((await readout(display))['cur']).toBeUndefined();
  });

  /**
   * The rollback — the half of "optimistic" that is usually left out.
   *
   * Removing the tile on the press is easy. The hard part is what happens when
   * the command never lands: there is no acknowledgement on this channel and
   * there is not going to be one, so a tile that vanished on a phone and is
   * still in the library would stay vanished until something else happened to
   * republish the shelf — up to five minutes, and longer if nobody looks.
   *
   * So: a phone with a shelf, a Kraken that goes away, a delete into the void,
   * and then the Kraken comes back and says what it actually has. The tile
   * returns, and the phone says so in one sentence.
   */
  test('a delete the Kraken never made is rolled back, with a sentence', async ({ context }) => {
    const room = 'RBKM6789';
    const cam = await context.newPage();
    await seedClips(cam, room, 1);

    const display = await context.newPage();
    await openDisplay(display, room);

    const phone = await context.newPage();
    await phone.goto(phoneUrl(room));
    await expect(tiles(phone)).toHaveCount(1, { timeout: 30_000 });

    // The Kraken goes away. The phone still has the shelf it was given.
    await display.close();

    await tiles(phone).first().getByTestId('tile-delete').click();
    await phone.getByTestId('remote-confirm-delete-yes').click();
    // Optimistic: gone from the shelf the moment it was confirmed.
    await expect(tiles(phone)).toHaveCount(0);

    // Comfortably past the reconciliation grace window, so the next packet is
    // one that genuinely could have known about the command.
    await phone.waitForTimeout(4000);

    const revived = await context.newPage();
    await openDisplay(revived, room);

    // The row is still there, so the shelf takes it back and says why.
    await expect(tiles(phone)).toHaveCount(1, { timeout: 30_000 });
    await expect(phone.getByTestId('remote-library')).toContainText('did not change', {
      timeout: 10_000,
    });
    await expect(tiles(cam)).toHaveCount(1);
  });
});

test.describe('the owning window keeps its own directness', () => {
  /**
   * CAM asks, and then does it ITSELF.
   *
   * This test used to assert that CAM had no confirm at all: the two-tap answer
   * existed because a phone deletes something on a screen in another room, over
   * an eventually-consistent link, and in CAM the row, the finger and the shelf
   * are in one place. Round 6 found the flaw in that: the thing the two surfaces
   * genuinely share is that there is NO UNDO, and CAM's Delete was the last
   * unconfirmed destructive act in the product. Both shelves mount
   * `views/ConfirmSheet` now.
   *
   * What is still CAM's own directness, and is what this test is actually for,
   * is everything after the confirm: the delete happens against a database this
   * window can read, so there is no optimistic removal, no command with no
   * acknowledgement and no reconciliation — the remote's confirm sheet is not
   * even mounted here.
   */
  test('CAM confirms, then deletes against its own database, and renames in place', async ({
    page,
  }) => {
    await page.goto('/?cam=1#/library');
    await page.getByTestId('library-add').click();
    await page.locator('[data-testid="clip-file-input"]').setInputFiles(FIXTURE_PATH);
    await expect(tiles(page)).toHaveCount(1, { timeout: 20_000 });

    const tile = tiles(page).first();
    await tile.getByTestId('tile-rename').click();
    await tile.getByTestId('tile-rename-input').fill('A better name');
    await tile.getByTestId('tile-rename-save').click();
    await expect(tile).toContainText('A better name', { timeout: 10_000 });

    /*
      CAM asks too, now — round 6's CAM parity.

      This assertion used to be that CAM deleted on the press and mounted no
      confirm at all, on the argument that here the row and the finger are in
      the same room. Round 6 retired the argument: there is no undo anywhere in
      the product and the bytes go from the one database the LCD can read, so
      the last unconfirmed destructive act in the app got the sheet the phone's
      batch delete has had since wave 3. What is still true — and is what this
      test was really about — is that the delete then happens HERE, against a
      database this window can read, rather than as a command with no
      acknowledgement: no optimistic tile, no reconciliation, gone.
    */
    await tile.getByTestId('tile-delete').click();
    await expect(page.getByTestId('remote-confirm-delete')).toHaveCount(0);
    await expect(page.getByTestId('library-confirm-delete')).toBeVisible();
    await page.getByTestId('library-confirm-delete-yes').click();
    await expect(tiles(page)).toHaveCount(0, { timeout: 10_000 });
  });
});
