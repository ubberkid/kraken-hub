import { expect, test, type Page } from '@playwright/test';

import { LINK_RECEIPT_UNSEEN } from '../../src/config/vocabulary';

/**
 * Round 6 — the round that builds spines instead of fixing instances.
 *
 * Every finding this round orbits one of two absences, and both are now a file:
 *
 *  - **`app/config/pasteLink.ts`** — one paste mechanism. Enumerated in
 *    `paste-spine.spec.ts`, which walks the app looking for a link field that
 *    bypassed it, and enforced by the compiler: the two module-blind submitters
 *    are module-private, so `pasteAction` is the only door.
 *  - **`app/config/panelPresence.ts`** — one presence truth. Enumerated in
 *    `src/config/vocabulary.test.ts`, which reads the tree for claims about the
 *    panel and requires the file making one to consume the derivation.
 *
 * What is here is the BEHAVIOUR the two spines produce, on the screens the
 * audit photographed: C2, C3, C4 and C5 as things you can see happen. The
 * enumerations stop the class coming back; these prove the class was actually
 * fixed.
 */

const STATE_KEY = 'kraken-hub:v1:state';

function camUrl(hash = '#/'): string {
  return `/?cam=1${hash}`;
}

function phoneUrl(room: string, hash = '#/remote'): string {
  return `/?transport=fake&room=${room}${hash}`;
}

/** A first run: no `displaySeen` latch, so nothing has ever been heard from. */
async function firstRun(page: Page, url: string): Promise<void> {
  await page.addInitScript(
    ([key]) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          schema: 2,
          rev: 1,
          updatedAt: Date.now(),
          writerId: 'e2e-round6',
          writerRole: 'config',
          activeModuleId: 'video',
          modules: {},
        }),
      );
    },
    [STATE_KEY] as const,
  );
  await page.goto(url);
}

// ---------------------------------------------------------------------------
// C2 — the receipt does not put a video on a screen it has never heard from
// ---------------------------------------------------------------------------

test.describe('C2 — a settled story claims a screen only if one has been seen', () => {
  /**
   * The reproduction, as a passing test.
   *
   * On a genuinely first-run window the download ladder settled on **On screen
   * now — Playing on your Kraken**, at the same moment, on the same screen, as
   * the first-run band explaining how to install CAM. The page told the user
   * their video was playing and that their Kraken was not connected yet.
   */
  test('a first-run window says what it saved, not what is on screen', async ({ page }) => {
    await firstRun(page, camUrl());
    // The band is the proof that this really is the never-seen state, rather
    // than a display having quietly published something mid-test.
    await expect(page.getByTestId('home')).toHaveAttribute('data-firstrun', 'true');

    await page.getByTestId('paste-input').fill('https://example.test/clips/dunes.mp4');
    await page.getByTestId('paste-submit').click();

    const flow = page.getByTestId('paste-flow');
    await expect(flow).toBeVisible();
    await expect(flow).toContainText('Saved');
    await expect(flow).toContainText('Plays when your Kraken connects');
    // The two claims it cannot support.
    await expect(flow).not.toContainText('On screen now');
    await expect(flow).not.toContainText('Playing on your Kraken');
  });

  /**
   * …and the other direction, so the fix is a question rather than a deletion.
   *
   * With the latch present the ladder says exactly what it always said. A rule
   * that only ever removes a sentence is indistinguishable from having deleted
   * the feature.
   */
  test('a window that has seen a Kraken still says On screen now', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('kraken-hub:v1:config:displaySeen', '1');
    });
    await page.goto(camUrl());

    await page.getByTestId('paste-input').fill('https://example.test/clips/dunes.mp4');
    await page.getByTestId('paste-submit').click();

    const flow = page.getByTestId('paste-flow');
    await expect(flow).toContainText('On screen now');
    await expect(flow).toContainText('Playing on your Kraken');
  });
});

// ---------------------------------------------------------------------------
// C3 — the video instrument belongs to the video module
// ---------------------------------------------------------------------------

test.describe('C3 — the remote drives the module that is actually on the panel', () => {
  /**
   * The reproduction: a phone paired to a Kraken showing a clock was handed a
   * scrubber, A-B loop handles, ±10 seconds and a quality picker — every one of
   * them a control for a module that was not on screen — under a heading naming
   * whatever `.mp4` the video config happened to hold.
   */
  test('a clock on the panel gets no scrubber, no transport and no quality', async ({ page }) => {
    await page.goto(phoneUrl('CDFG2345'));
    await expect(page.getByTestId('paired-summary')).toBeVisible();
    await page.locator('#remote-module').getByRole('radio', { name: 'Clock' }).click();

    for (const id of [
      'scrubber',
      'transport-hold',
      'transport-back',
      'transport-forward',
    ] as const) {
      await expect(page.getByTestId(id), `${id} is a video control`).toHaveCount(0);
    }
    await expect(page.locator('#remote-quality')).toHaveCount(0);
    await expect(page.getByTestId('remote-quality-readout')).toHaveCount(0);

    // …and the heading names the module rather than a video nobody is showing.
    await expect(page.getByTestId('remote-title')).toHaveText('Clock');

    // The shelf, the Showing row and Fit are not video's, so they stay.
    await expect(page.locator('#remote-module')).toBeVisible();
    await expect(page.locator('#remote-fit')).toBeVisible();
    await expect(page.getByTestId('remote-library')).toBeVisible();
  });

  test('switching back to video brings the instrument back', async ({ page }) => {
    await page.goto(phoneUrl('DFGH3456'));
    await expect(page.getByTestId('paired-summary')).toBeVisible();
    const modules = page.locator('#remote-module');

    await modules.getByRole('radio', { name: 'Clock' }).click();
    await expect(page.getByTestId('transport-hold')).toHaveCount(0);
    await modules.getByRole('radio', { name: 'Video' }).click();
    await expect(page.getByTestId('transport-hold')).toBeVisible();
  });

  /**
   * The presence half of the same rule.
   *
   * "Playing on your Kraken · 1080p" was printed off a `displayOnline` check
   * that the sub-line did not share with anything else on the page. It is
   * `panelPresence.playingLine` now, which returns nothing at all unless
   * telemetry is fresh — so with no display in the room the line is absent
   * rather than greyed out or hopeful.
   */
  test('nothing claims playback into a room with no display in it', async ({ page }) => {
    await page.goto(phoneUrl('FGHJ4567'));
    await expect(page.getByTestId('paired-summary')).toBeVisible();
    await expect(page.getByTestId('remote-sub')).toHaveCount(0);
    await expect(page.getByTestId('remote')).not.toContainText('Playing on your Kraken');
  });
});

// ---------------------------------------------------------------------------
// C5 — a receipt promises only what the room can deliver
// ---------------------------------------------------------------------------

test('C5 — the phone’s Add panel says what is true of an empty room', async ({ page }) => {
  await page.goto(phoneUrl('GHJK5678'));
  await expect(page.getByTestId('paired-summary')).toBeVisible();
  await page.getByTestId('remote-add').click();
  await page.getByTestId('remote-add-link').fill('https://example.test/clips/dunes.mp4');
  await page.getByTestId('remote-add-link-submit').click();

  const note = page.locator('.kh-notice');
  await expect(note).toContainText(LINK_RECEIPT_UNSEEN);
  // The promise it cannot keep: nothing is fetching, so no tile is coming.
  await expect(note).not.toContainText('a tile appears here shortly');
});
