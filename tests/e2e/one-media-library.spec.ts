import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

/**
 * ONE media library, all the way down — wave 2, phase C.
 *
 * Wave 1 made the shelf look like one shelf. Underneath it was still two: two
 * object stores, two orderings, two index mirrors, and — in the image module's
 * own settings panel — a second list of pictures sitting beside the unified
 * grid, which is a second place to go looking for something you already found.
 *
 * So the claims here are the three that phase C is:
 *
 *  1. **C1** — a module panel holds settings, not a shelf. There is one grid.
 *  2. **C2** — clips and pictures are one store with `kind` as a property, and
 *     a library written before the merge is still completely visible while (and
 *     after) it is copied across. A delete is idempotent and does not come back
 *     through the fallback read.
 *  3. **C3** — a picture carries a thumbnail made at ingest, like a clip.
 *
 * The migration's transactional half is asserted here rather than in a unit test
 * on purpose: its correctness is a property of a real IndexedDB, and jsdom has
 * none. The arithmetic — idempotence, restartability, the merged read — is
 * pinned in `src/platform/mediaStore.test.ts`.
 */

const FIXTURE_PATH = fileURLToPath(new URL('../../public/demo/demo.mp4', import.meta.url));

/** An 8×8 PNG, small enough to inline and real enough for `<img>` to decode. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4YWODFTEMLQkAZZlQAVIPr1MAAAAASUVORK5CYII=';

function tiles(page: Page) {
  return page.locator('[data-testid="library-tile"]');
}

/**
 * Write a picture into the LEGACY `images`/`imageBlobs` stores — the shape every
 * install on disk today actually has.
 *
 * Nothing here knows about `media`: that is the point. The row goes in the way
 * v3 wrote it, and everything downstream has to cope, first by reading it where
 * it lies and then by copying it across.
 */
async function seedLegacyPicture(page: Page, id: string, name: string): Promise<void> {
  await page.evaluate(
    async ([base64, rowId, rowName]) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      // No version: "whatever version this database is". Naming one would make
      // the seed a race against whichever of the app and the test opens first.
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
        // Newer than the clip below, so the shelf's one order is observable.
        createdAt: Date.now() + 60_000,
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

/** What the merged store holds, read from the page rather than inferred. */
async function mediaIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('kraken-hub.v1');
      req.onsuccess = () => {
        resolve(req.result);
      };
      req.onerror = () => {
        reject(req.error ?? new Error('indexedDB.open failed'));
      };
    });
    if (!db.objectStoreNames.contains('media')) {
      db.close();
      return [];
    }
    const rows = await new Promise<{ id: string }[]>((resolve, reject) => {
      const req = db.transaction('media', 'readonly').objectStore('media').getAll() as IDBRequest<
        { id: string }[]
      >;
      req.onsuccess = () => {
        resolve(req.result);
      };
      req.onerror = () => {
        reject(req.error ?? new Error('getAll failed'));
      };
    });
    db.close();
    return rows.map((row) => row.id).sort();
  });
}

/** A clip, added through the same `+` panel a person would use. */
async function addOneClip(page: Page): Promise<void> {
  await page.getByTestId('library-add').click();
  await expect(page.getByTestId('library-add-panel')).toBeVisible();
  await page.locator('[data-testid="clip-file-input"]').setInputFiles(FIXTURE_PATH);
}

/** The image module's own settings, open on the home screen's ops strip. */
async function openImageOptions(page: Page): Promise<void> {
  const chip = page.getByTestId('module-chip-image');
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  // Selecting a module and expanding its options are two states of one chip.
  if ((await chip.getAttribute('aria-expanded')) !== 'true') await chip.click();
  await expect(page.getByTestId('ops-panel')).toBeVisible();
  await expect(page.locator('[data-testid="ops-panel"] .kh-field').first()).toBeVisible();
}

test.describe('one grid, both kinds', () => {
  test('a clip and a picture sit in the same shelf, in one order', async ({ page }) => {
    await page.goto('/?cam=1#/library');
    await expect(page.getByTestId('library')).toBeVisible();

    await seedLegacyPicture(page, 'seed-pic', 'wallpaper.png');
    await addOneClip(page);
    await expect(tiles(page)).toHaveCount(2, { timeout: 20_000 });

    // Newest first, across kinds — one comparator, not one per store.
    const kinds = await tiles(page).evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-tile-kind')),
    );
    expect(kinds).toEqual(['image', 'clip']);
    await expect(tiles(page).nth(0)).toContainText('wallpaper.png');
    await expect(tiles(page).nth(1)).toContainText('demo.mp4');

    // …and there is exactly ONE grid on the page. The picture did not bring a
    // second shelf with it.
    await expect(page.locator('[data-testid="library-grid"]')).toHaveCount(1);
  });

  /**
   * C2, the part that only a real database can show: a library written before
   * the merge is visible immediately, and then genuinely copied across.
   */
  test('a pre-merge picture is on the shelf before it is copied, and is copied', async ({
    page,
  }) => {
    await page.goto('/?cam=1#/');
    await seedLegacyPicture(page, 'legacy-pic', 'old.png');

    // Nothing has copied it yet — it is in `images`, where v3 put it.
    expect(await mediaIds(page)).not.toContain('legacy-pic');

    await page.goto('/?cam=1#/library');
    await expect(tiles(page)).toHaveCount(1, { timeout: 20_000 });
    await expect(tiles(page).first()).toContainText('old.png');

    // Reading the shelf ran the copy, in an ordinary transaction, after the
    // upgrade rather than inside it.
    await expect.poll(async () => mediaIds(page), { timeout: 20_000 }).toContain('legacy-pic');

    // And it is idempotent: a second visit copies nothing and duplicates
    // nothing — the shelf is one row, not two.
    await page.reload();
    await expect(tiles(page)).toHaveCount(1, { timeout: 20_000 });
    expect((await mediaIds(page)).filter((id) => id === 'legacy-pic')).toHaveLength(1);
  });

  /**
   * The one way "copy, don't move" can bite: the fallback read would put a
   * deleted picture straight back on the shelf unless the delete removes the
   * legacy row too.
   */
  test('deleting a copied picture does not resurrect it through the fallback', async ({ page }) => {
    await page.goto('/?cam=1#/');
    await seedLegacyPicture(page, 'doomed-pic', 'doomed.png');
    await page.goto('/?cam=1#/library');
    await expect(tiles(page)).toHaveCount(1, { timeout: 20_000 });

    await tiles(page).first().getByTestId('tile-delete').click();
    // Both shelves ask before a destructive act (round 6, CAM parity).
    await page.getByTestId('library-confirm-delete-yes').click();
    await expect(tiles(page)).toHaveCount(0, { timeout: 20_000 });

    await page.reload();
    await expect(page.getByTestId('library-empty')).toBeVisible({ timeout: 20_000 });
    expect(await mediaIds(page)).not.toContain('doomed-pic');
  });
});

test.describe('the module panel holds settings, not a shelf (C1)', () => {
  test('the image panel has no picture list of its own', async ({ page }) => {
    await page.goto('/?cam=1#/library');
    await seedLegacyPicture(page, 'panel-pic', 'panel.png');
    await page.reload();
    await expect(tiles(page)).toHaveCount(1, { timeout: 20_000 });

    await page.goto('/?cam=1#/');
    await openImageOptions(page);

    const panel = page.getByTestId('ops-panel');
    // The settings are still there…
    await expect(panel.locator('#image-download-mode')).toBeVisible();
    // …and the second shelf is not, under any of the names it used to have.
    await expect(panel.getByRole('list', { name: 'Your pictures' })).toHaveCount(0);
    await expect(panel.getByRole('list', { name: 'Library' })).toHaveCount(0);
    await expect(panel.getByText('panel.png')).toHaveCount(0);
  });
});

test.describe('the image module reads the one library (C3)', () => {
  /**
   * The other half of deleting that list: picking a picture from the ONE grid
   * has to put it on the Kraken, through the same commit a clip's tile makes.
   */
  test('showing a picture from the grid displays it on the panel', async ({ context }) => {
    const config = await context.newPage();
    await config.goto('/?cam=1#/library');
    await seedLegacyPicture(config, 'shown-pic', 'shown.png');
    await config.reload();
    await expect(tiles(config)).toHaveCount(1, { timeout: 20_000 });

    await tiles(config).first().getByTestId('tile-show').click();
    await expect(tiles(config).first().getByTestId('tile-active')).toBeVisible({ timeout: 15_000 });

    const display = await context.newPage();
    await display.setViewportSize({ width: 640, height: 640 }); // device-size-ok: the Elite preset this spec drives
    await display.goto('/?kraken=1&sim=elite');
    const img = display.locator('.kh-image__img');
    await expect(img).toBeVisible({ timeout: 20_000 });
    // A `blob:` source is the whole assertion: the module resolved the id the
    // grid committed against the ONE library and painted the stored bytes,
    // rather than reaching the network or falling back to a message card.
    await expect(img).toHaveAttribute('src', /^blob:/);
    await expect(display.locator('.kh-image__message')).toBeHidden();
  });

  /**
   * C3 — a picture gets a stored 320-edge thumbnail rather than being decoded
   * at full size once per tile, per visit, on a page that also drives the panel.
   * A pre-merge row has none, so the shelf backfills it on first sight and
   * writes it back.
   */
  test('a picture ends up carrying its own stored thumbnail', async ({ page }) => {
    await page.goto('/?cam=1#/library');
    await seedLegacyPicture(page, 'thumb-pic', 'thumb.png');
    await page.reload();
    await expect(tiles(page)).toHaveCount(1, { timeout: 20_000 });

    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
              const req = indexedDB.open('kraken-hub.v1');
              req.onsuccess = () => {
                resolve(req.result);
              };
              req.onerror = () => {
                reject(req.error ?? new Error('indexedDB.open failed'));
              };
            });
            const row = await new Promise<{ thumbBlob?: Blob | null } | undefined>(
              (resolve, reject) => {
                const req = db
                  .transaction('media', 'readonly')
                  .objectStore('media')
                  .get('thumb-pic') as IDBRequest<{ thumbBlob?: Blob | null } | undefined>;
                req.onsuccess = () => {
                  resolve(req.result);
                };
                req.onerror = () => {
                  reject(req.error ?? new Error('get failed'));
                };
              },
            );
            db.close();
            return row?.thumbBlob instanceof Blob;
          }),
        { timeout: 20_000 },
      )
      .toBe(true);
  });
});
