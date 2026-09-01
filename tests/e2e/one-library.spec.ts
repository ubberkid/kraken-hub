import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import { NOTHING_KEPT } from '../../src/config/vocabulary';

/**
 * One Kraken, many windows.
 *
 * The report behind this wave: *"the library is different on my phone and the
 * files are separate."* It was not a perception problem. `#/library` was routed
 * with no surface gating, so a phone reached a second, real, EMPTY library
 * backed by the phone's own IndexedDB — with a working `Browse…` that ingested
 * into a store the Kraken can never open. Meanwhile the display had been
 * publishing its actual shelf on the `tele` channel for two milestones and the
 * remote latched the packet, built a name lookup out of it, and threw the rest
 * away.
 *
 * So there are four claims here, and each one is a different kind of failure:
 *
 *  1. the phone sees **THE** library, with tiles matching the display's;
 *  2. it can PLAY one, through the ordinary state commit;
 *  3. no window that cannot hold bytes renders a control that pretends it can;
 *  4. a cold phone PULLS rather than waiting out a five-minute keepalive.
 *
 * Everything runs against the in-repo broker simulator (`?transport=fake`), so
 * a PR never goes red because a public broker is having a bad day.
 */

const FIXTURE_PATH = fileURLToPath(new URL('../../public/demo/demo.mp4', import.meta.url));

/** The CAM Configuration Browser — the one window that owns the bytes. */
function camUrl(room: string, hash = '#/library'): string {
  return `/?cam=1&transport=fake&room=${room}${hash}`;
}

/** A phone. No `cam` flag, so `ownsBytes()` is false, which is the whole point. */
function phoneUrl(room: string, hash = '#/remote'): string {
  return `/?transport=fake&room=${room}${hash}`;
}

function displayUrl(room: string): string {
  return `/?kraken=1&sim=elite&transport=fake&room=${room}`;
}

function tiles(page: Page) {
  return page.locator('[data-testid="library-tile"]');
}

/**
 * Put one real clip in CAM's library, and leave a display running to publish it.
 *
 * The file goes in through the same `+` panel a user would use, which is the
 * only honest way to produce the IndexedDB row the display then announces.
 */
async function seedOneClip(page: Page, room: string): Promise<void> {
  await page.goto(camUrl(room));
  await page.getByTestId('library-add').click();
  await expect(page.getByTestId('library-add-panel')).toBeVisible();
  await page.locator('[data-testid="clip-file-input"]').setInputFiles(FIXTURE_PATH);
  await expect(tiles(page)).toHaveCount(1, { timeout: 15_000 });
}

test.describe('the phone sees THE library', () => {
  test('the shelf arrives over the wire with tiles matching the display’s', async ({ context }) => {
    const room = 'HJKM2345';
    const cam = await context.newPage();
    await seedOneClip(cam, room);

    // The display is what publishes the library — it is the window whose
    // storage the LCD reads, and the packet is a fact about that machine.
    const display = await context.newPage();
    await display.goto(displayUrl(room));
    await expect(display.locator('.kh-stage')).toBeVisible();

    const phone = await context.newPage();
    await phone.goto(phoneUrl(room));
    await expect(phone.getByTestId('paired-summary')).toBeVisible();

    // The Library is a PEER of the transport, in the page's flow — not a modal,
    // not a drawer, and not the "picker" that read as a duplicate app.
    const shelf = phone.getByTestId('remote-library');
    await expect(shelf).toBeVisible({ timeout: 30_000 });
    await expect(tiles(phone)).toHaveCount(1, { timeout: 30_000 });

    const tile = tiles(phone).first();
    await expect(tile).toContainText('demo.mp4');
    await expect(tile).toHaveAttribute('data-tile-kind', 'clip');
    await expect(tile).toHaveAttribute('data-tile-state', 'ready');
    // The id is the SAME id CAM's tile carries: one library, one row, two
    // windows onto it.
    const camId = await tiles(cam).first().getAttribute('data-clip-id');
    expect(camId).not.toBeNull();
    await expect(tile).toHaveAttribute('data-clip-id', camId ?? '');

    /*
     * The art matches too, and for free.
     *
     * `TreatedArt` is a deterministic pure function of the name, so the initial
     * and the hue rotation the phone computes are the ones CAM computes. No
     * thumbnail was pushed over the radio for this — that is A4's whole claim.
     */
    const phoneHue = await tile
      .getByTestId('tile-treated')
      .evaluate((el) => el.getAttribute('style'));
    // The hue is a pure function of the name, so it is asserted against the
    // value that function produces rather than against CAM's DOM — CAM draws a
    // generated frame over its card once the decoder has one, and the point is
    // that the CARD is identical, not that the frame is missing.
    expect(phoneHue).toContain('--kh-tile-hue');
  });

  test('playing from the phone puts it on the Kraken, as a state commit', async ({ context }) => {
    const room = 'NPQR3456';
    const cam = await context.newPage();
    await seedOneClip(cam, room);

    const display = await context.newPage();
    await display.goto(displayUrl(room));
    await expect(display.locator('.kh-stage')).toBeVisible();

    const phone = await context.newPage();
    await phone.goto(phoneUrl(room));
    await expect(tiles(phone)).toHaveCount(1, { timeout: 30_000 });

    await tiles(phone).first().getByTestId('tile-show').click();

    // No new command op was invented: this is the ordinary retained state
    // snapshot, which is why the display simply ends up on the clip.
    await expect
      .poll(
        async () => {
          const raw = await display.locator('html').getAttribute('data-kh-sync');
          const readout = raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
          return readout['module'];
        },
        { timeout: 20_000 },
      )
      .toBe('video');
    // …and the phone's own tile says what is on screen.
    await expect(tiles(phone).first().getByTestId('tile-active')).toBeVisible({ timeout: 15_000 });
  });

  /**
   * The cold pull (B3).
   *
   * `tele` publishes UNRETAINED and the display re-announces its library every
   * five minutes, so a phone that opened one second after a republish used to
   * wait most of five minutes in front of an empty shelf. This test opens the
   * phone LAST, long after the display's boot-time publish has come and gone
   * with nobody listening — the only thing that can fill the shelf is the
   * phone's own `requestLibrary`.
   */
  test('a cold phone pulls the shelf instead of waiting for a republish', async ({ context }) => {
    const room = 'STVW4567';
    const cam = await context.newPage();
    await seedOneClip(cam, room);
    await cam.close();

    const display = await context.newPage();
    await display.goto(displayUrl(room));
    await expect(display.locator('.kh-stage')).toBeVisible();
    await expect
      .poll(async () => {
        const raw = await display.locator('html').getAttribute('data-kh-sync');
        return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>)['net'];
      })
      .toBe('online');

    // Well past any boot-time publish, and nowhere near the five-minute
    // keepalive: whatever arrives from here was asked for.
    await display.waitForTimeout(2000);

    const phone = await context.newPage();
    await phone.goto(phoneUrl(room));
    await expect(tiles(phone)).toHaveCount(1, { timeout: 30_000 });
    await expect(tiles(phone).first()).toContainText('demo.mp4');
  });
});

test.describe('no window offers what it cannot do', () => {
  /**
   * The enumerated gate (A1).
   *
   * Each of these is a control whose bytes would land somewhere the Kraken can
   * never read, or a claim about a disk the library does not live on. They are
   * not disabled — they are not mounted, because a disabled control is still a
   * control that says the feature belongs here.
   */
  const INGEST = [
    'library-add', // the + that opens the add panel
    'library-add-panel',
    'library-browse', // "Browse…" — a file picker into the wrong database
    'clip-file-input',
    'library-quota', // a meter for THIS browser's disk
  ] as const;

  test('a paired phone’s Library has no ingest, no quota and no persistence chip', async ({
    context,
  }) => {
    const room = 'XYZ23456';
    const phone = await context.newPage();
    await phone.goto(phoneUrl(room, '#/library'));
    await expect(phone.getByTestId('library')).toBeVisible();
    await expect(phone.getByTestId('library')).toHaveAttribute('data-owns', 'false');

    for (const id of INGEST) {
      await expect(
        phone.getByTestId(id),
        `${id} must not exist off the owning surface`,
      ).toHaveCount(0);
    }
    // The persistence chip is part of the quota block, and the block is gone.
    await expect(phone.getByText('Kept for good')).toHaveCount(0);
    await expect(phone.getByText('May be cleared if the disk fills up')).toHaveCount(0);

    /*
     * The asymmetry the old copy stated as a fact is GONE (wave 3).
     *
     * "Files are added at your PC." was true for exactly as long as a phone had
     * no way to hand the Kraken a file. It has one now — over the LAN, into the
     * same ingest pipeline CAM's own drop target uses — so the sentence is
     * retired and the control that makes it untrue stands in its place. What is
     * still gated is the LOCAL file picker, which would write to the wrong
     * database; that is the enumerated list above.
     */
    await expect(phone.getByTestId('remote-add')).toBeVisible();
    const body = await phone.locator('main').innerText();
    expect(body).not.toContain('Files are added at your PC');
    // …and no machine-centric location copy, because nothing here is about a PC.
    expect(body).not.toContain('inside CAM’s own browser storage');
  });

  test('the CAM window keeps every one of them', async ({ page }) => {
    // The other half of the assertion: the gate removed the controls from the
    // wrong surface, not from the product.
    await page.goto('/?cam=1#/library');
    await expect(page.getByTestId('library')).toHaveAttribute('data-owns', 'true');
    await page.getByTestId('library-add').click();
    await expect(page.getByTestId('library-add-panel')).toBeVisible();
    await expect(page.getByTestId('library-browse')).toBeVisible();

    /*
      The meter needs something to measure (round 6's minors).

      Round 2's rule — a quota claim is only actionable once something is
      actually stored — was wired to the persistence chip alone, so the bar and
      its label stood over an empty shelf reading "13 kB of 4.0 GB used"
      directly under **Nothing kept here**. It gates the block now, so this
      half of the surface assertion puts a row on the shelf first. The claim is
      unchanged: the gate removed these controls from the wrong surface, not
      from the product.
    */
    await page.locator('[data-testid="clip-file-input"]').setInputFiles(FIXTURE_PATH);
    await expect(tiles(page)).toHaveCount(1, { timeout: 20_000 });
    await expect(page.getByTestId('library-quota')).toBeVisible();
  });

  /**
   * The home screen's live mirror is an iframe of the REAL display page. On any
   * other browser that is a second decoder and a second download, on a battery,
   * reading a database with nothing in it — and drawing a confident picture of a
   * Kraken it has never seen.
   */
  test('a remote surface never mounts the display iframe', async ({ page }) => {
    await page.goto('/#/');
    await page.getByTestId('module-chip-clock').click();
    await expect(page.getByTestId('mirror')).toBeVisible();
    await expect(page.getByTestId('mirror')).toHaveAttribute('data-mirror-mode', 'surface');
    await expect(page.locator('.kh-halo__frame')).toHaveCount(0);
  });

  /**
   * A6 — an unpaired remote has no Library, because there is nothing on the
   * other side of that door. An empty grid calling itself your library is the
   * false second library all over again.
   */
  test('an unpaired remote’s Library route lands on pairing instead', async ({ page }) => {
    let loads = 0;
    page.on('load', () => {
      loads += 1;
    });
    await page.goto('/#/library');
    await expect(page.getByTestId('pairing-card')).toBeVisible();
    await expect.poll(() => new URL(page.url()).hash).toBe('#/remote');
    // A hash rewrite, never a navigation (invariant I1/I2).
    expect(loads).toBe(1);

    // The DOOR stays on every surface — the Library is a property of the
    // Kraken, not of the window, and hiding it would be the app telling a phone
    // it has no library. What is gated is what lies behind it.
    await page.goto('/#/');
    await expect(page.getByTestId('disclosure-library')).toBeVisible();
  });
});

test.describe('the remote says what it does', () => {
  test('an empty shelf on a paired phone says so in the app’s own words', async ({ context }) => {
    const phone = await context.newPage();
    await phone.goto(phoneUrl('BCDF5678'));
    await expect(phone.getByTestId('paired-summary')).toBeVisible();
    const empty = phone.getByTestId('remote-library-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText(NOTHING_KEPT);
    // And the way to stop it being empty, on the phone itself (wave 3): the
    // shelf no longer says files are added somewhere else, because they are not.
    await expect(phone.getByTestId('remote-add')).toBeVisible();
  });

  /**
   * A5 — adding from the phone has always worked, and nothing said so. The link
   * field committed the source and the display fetched it, while the button
   * said "Play" and the surface that needed the explanation least carried the
   * full receipt.
   */
  test('the remote’s link field gives the same receipt CAM’s does', async ({ context }) => {
    const phone = await context.newPage();
    await phone.goto(phoneUrl('GHJK6789'));
    await expect(phone.getByTestId('paired-summary')).toBeVisible();

    await phone.locator('#remote-src').fill('https://example.com/clip.mp4');
    await phone.getByTestId('remote-play').click();
    await expect(phone.getByTestId('remote-receipt')).toBeVisible();
    // The retired implementation copy does not come back with it.
    await expect(phone.getByTestId('remote-receipt')).not.toContainText('CAM picks it up');
  });
});
