import { expect, test, type Page } from '@playwright/test';

/**
 * Round 8 — the closing audit's three user-visible claims, and the two
 * mechanisms that let them through.
 *
 * Every one of the three is the SAME failure round 6 named and round 7 typed —
 * a present-tense claim about the LCD panel made without asking whether a panel
 * has ever been heard from — wearing a shape neither round's rule was looking
 * at. A dot rather than a sentence. A card headline rather than a paragraph. An
 * instruction rather than a claim.
 *
 *  - **A** `HomeView.describeStatus` returned `live: true` as a literal for
 *    clock, stats and image: the presence went into the verb and was discarded
 *    for the dot. `panelClaims.panelVerb` documents the collapse of the
 *    `showing` tense onto exactly that pixel — the word may stay in the
 *    participle BECAUSE the dot asserts "this second" — so a hardcoded dot was
 *    not one bug beside the claim, it was the claim.
 *  - **B** the remote's card read **Paired with your PC** on `paired &&
 *    roomCode !== null`, which is two facts the phone produces on its own:
 *    pressing **Create a code** mints a room and joins it in one commit, so a
 *    phone announced a pairing with a machine that had never been asked.
 *  - **C** …and the card's unpaired half told that phone to *"scan it from the
 *    CAM window on your PC — nothing to type"*. There is no decoder anywhere in
 *    `src`, CAM has no camera, the phone draws no square of its own below
 *    700 px, and typing is the only way a code minted on a phone reaches CAM.
 *
 * The mechanisms are in `vocabulary.test.ts` (the literal scan is parse-based
 * now, so a claim Prettier wrapped is still read, over a widened verb family)
 * and `panelClaims.test.ts` (the honesty property runs over a registry every
 * claim joins at construction, not over the exports). What is HERE is the
 * behaviour on the screens the audit photographed.
 */

const STATE_KEY = 'kraken-hub:v1:state';
const TELE_KEY = 'kraken-hub:v1:video:tele';
const SEEN_KEY = 'kraken-hub:v1:config:displaySeen';

/** CAM's own window — the surface the home screen is fitted to. */
function camUrl(hash = '#/'): string {
  return `/?cam=1${hash}`;
}

const CAM = { width: 866, height: 537 };

/** Older than `PRESENCE_FRESH_MS` by a wide margin: seen, and not talking. */
const STALE_MS = 60_000;

type Presence = 'never-seen' | 'quiet' | 'live';

/**
 * A home screen in one of the three presence states, on one module.
 *
 * The three states are seeded from the two facts `panelPresence` actually
 * derives from and nothing else: the latch (`displaySeen`) and the age of the
 * telemetry mirror. `never-seen` seeds no telemetry at all, because the mirror
 * IS evidence — `hasDisplayBeenSeen()` latches on it — so a stale packet is a
 * quiet Kraken rather than an unknown one.
 */
async function seedHome(
  page: Page,
  moduleId: string,
  presence: Presence,
  targetFps = 40,
): Promise<void> {
  await page.addInitScript(
    ([stateKey, teleKey, seenKey, id, state, fps, staleMs]) => {
      localStorage.setItem(
        stateKey,
        JSON.stringify({
          schema: 2,
          rev: 1,
          updatedAt: Date.now(),
          writerId: 'e2e-round8',
          writerRole: 'config',
          activeModuleId: id,
          modules: {},
        }),
      );
      if (state === 'never-seen') return;
      localStorage.setItem(seenKey, '1');
      localStorage.setItem(
        teleKey,
        JSON.stringify({
          ch: 'tele',
          kind: 'videoStats',
          ts: state === 'live' ? Date.now() : Date.now() - Number(staleMs),
          provider: 'local-file',
          display: { w: 640, h: 640, shape: 'circle', targetFps: Number(fps) },
          stats: {
            currentTime: 4,
            durationSec: 182,
            bufferedEnd: 182,
            held: false,
            loopCrossings: 0,
            maskVisiblePct: 0,
          },
        }),
      );
    },
    [
      STATE_KEY,
      TELE_KEY,
      SEEN_KEY,
      moduleId,
      presence,
      String(targetFps),
      String(STALE_MS),
    ] as const,
  );
}

// ---------------------------------------------------------------------------
// A — the live dot is evidence, on every module
// ---------------------------------------------------------------------------

/**
 * The dot is the app's smallest present-tense claim and its loudest one.
 *
 * `describeVideoStatus` has derived it since round 6, and for four rounds the
 * other three modules got `live: true` typed in — so the first screen a user
 * ever sees, with the CAM install band still on it, burned a live dot beside
 * "Showing Clock". All four modules, all three states, because the finding is
 * that one path was checked and three were not.
 */
test.describe('A — the live dot is drawn from evidence, on all four modules', () => {
  const MODULES = ['clock', 'stats', 'image', 'video'] as const;

  for (const moduleId of MODULES) {
    test(`${moduleId}: no dot on a window that has never heard from a Kraken`, async ({ page }) => {
      await page.setViewportSize(CAM);
      await seedHome(page, moduleId, 'never-seen');
      await page.goto(camUrl());

      // The band is the proof this really is the never-seen state.
      await expect(page.getByTestId('home')).toHaveAttribute('data-firstrun', 'true');
      const line = page.getByTestId('status-line');
      await expect(line).toBeVisible();
      await expect(line.locator('.kh-status__live')).toHaveCount(0);
    });

    test(`${moduleId}: no dot on a Kraken that has gone quiet`, async ({ page }) => {
      await page.setViewportSize(CAM);
      await seedHome(page, moduleId, 'quiet');
      await page.goto(camUrl());

      // Seen, so the band is gone — and still not talking, so still no dot.
      await expect(page.getByTestId('home')).toHaveAttribute('data-firstrun', 'false');
      await expect(page.getByTestId('status-line').locator('.kh-status__live')).toHaveCount(0);
    });

    test(`${moduleId}: the dot comes back on fresh telemetry`, async ({ page }) => {
      await page.setViewportSize(CAM);
      await seedHome(page, moduleId, 'live');
      await page.goto(camUrl());

      await expect(page.getByTestId('status-line').locator('.kh-status__live')).toHaveCount(1);
    });
  }

  /**
   * …and the composition the claims module argues for still reads correctly.
   *
   * "Showing Clock" survives first run because it names the configured module
   * rather than a frame that arrived; that is only allowed while the dot beside
   * it is the thing making the present-tense claim. The two halves are asserted
   * together, in all three states, because separating them is how the
   * arrangement came apart in the first place.
   */
  test('the verb keeps naming the module while the dot carries the tense', async ({ page }) => {
    await page.setViewportSize(CAM);
    for (const presence of ['never-seen', 'quiet', 'live'] as const) {
      const fresh = await page.context().newPage();
      await seedHome(fresh, 'clock', presence);
      await fresh.goto(camUrl());

      const line = fresh.getByTestId('status-line');
      await expect(line).toContainText('Showing');
      await expect(line).toContainText('Clock');
      await expect(line.locator('.kh-status__live')).toHaveCount(presence === 'live' ? 1 : 0);
      await fresh.close();
    }
  });
});

// ---------------------------------------------------------------------------
// D — the persisted frame rate, tensed
// ---------------------------------------------------------------------------

/**
 * The claim the upgraded scan caught: it was multi-line JSX prose, so the
 * line-anchored extractor read past it for as long as it had existed.
 *
 * `readDisplayFacts()` reads `localStorage`, so the reading outlives the
 * session that observed it — a window opened a week later asserted a frame rate
 * the panel was achieving *right now*, from a record.
 */
test.describe('D — the low-frame-rate banner reports a reading, not a live panel', () => {
  test('a quiet Kraken is described in the habitual present', async ({ page }) => {
    await page.setViewportSize(CAM);
    await seedHome(page, 'clock', 'quiet', 1);
    await page.goto(camUrl());

    const banner = page.getByTestId('fps-banner');
    await expect(banner).toContainText('Your Kraken runs at');
    await expect(banner).not.toContainText('is running at');
    // The reading and its consequence are facts in every tense, so they stay.
    await expect(banner).toContainText('1 FPS');
    await expect(banner).toContainText('slideshow');
  });

  test('…and the present progressive is earned by fresh telemetry', async ({ page }) => {
    await page.setViewportSize(CAM);
    await seedHome(page, 'clock', 'live', 1);
    await page.goto(camUrl());

    await expect(page.getByTestId('fps-banner')).toContainText('Your Kraken is running at');
  });
});

// ---------------------------------------------------------------------------
// B and C — the pairing card
// ---------------------------------------------------------------------------

test.describe('B — a code this device minted is not a pairing with a PC', () => {
  test('the phone that pressed Create a code does not announce a PC', async ({ page }) => {
    await page.goto('/?transport=fake#/remote');
    await expect(page.getByTestId('pairing-card')).toHaveAttribute('data-paired', 'false');

    await page.getByTestId('pair-rotate').click();

    const card = page.getByTestId('pairing-card');
    // The room is real — the device joined one — so the code, Unpair and the
    // pairing options are all where they were. What is withheld is the claim.
    await expect(card).toHaveAttribute('data-paired', 'true');
    await expect(card).toHaveAttribute('data-evidence', 'waiting');
    await expect(page.getByTestId('paired-summary')).toContainText('ROOM');
    await expect(page.getByTestId('pair-forget')).toHaveText('Unpair');
    await expect(page.getByTestId('paired-title')).toHaveText('Your pairing code');
    await expect(card).not.toContainText('Paired with your PC');
  });

  /**
   * …and evidence from the other end is what brings the sentence back.
   *
   * A real display page in the same room over the fake transport, rather than a
   * seeded mirror: the remote reads `sync.lastTele`, which is what a Kraken
   * actually publishes, and seeding this device's own `localStorage` would be
   * the device manufacturing the evidence it is supposed to be waiting for.
   */
  test('a room something has published into may name the PC', async ({ context }) => {
    const display = await context.newPage();
    await display.goto('/?kraken=1&sim=elite&room=BCDF2345&transport=fake');
    await expect(display.locator('.kh-stage')).toBeVisible();

    const remote = await context.newPage();
    await remote.goto('/?transport=fake&room=BCDF2345#/remote');

    await expect(remote.getByTestId('link-status')).toHaveAttribute('data-display', 'online', {
      timeout: 15_000,
    });
    await expect(remote.getByTestId('pairing-card')).toHaveAttribute('data-evidence', 'seen');
    await expect(remote.getByTestId('paired-title')).toHaveText('Paired with your PC');
    await display.close();
  });
});

test.describe('C — the phone is told a route its hardware has', () => {
  /**
   * The audit's third finding, as the property that makes it a bug rather than
   * a wording preference: every control an instruction names must exist.
   *
   * The old sentence named a scan on CAM — a gesture with no decoder behind it
   * on any surface — and then closed the only working door with "nothing to
   * type". This asserts the two controls the new copy names are real, on the
   * surfaces it names them for.
   */
  test('the phone-create instruction names only controls that exist', async ({ page, browser }) => {
    await page.goto('/?transport=fake#/remote');

    // The unpaired lede no longer sends a camera-equipped device to a machine
    // with no camera, and no longer rules out typing.
    const card = page.getByTestId('pairing-card');
    await expect(card).not.toContainText('scan it from the CAM window');
    await expect(card).not.toContainText('nothing to type');
    await expect(card).toContainText('The code comes from CAM');

    await page.getByTestId('pair-rotate').click();
    const instruction = page.getByTestId('pair-waiting');
    await expect(instruction).toBeVisible();

    /*
      The two controls it names, checked on the surface it names them for
      rather than trusted. Both are on CAM: the sub-page the reader is sent to,
      and the disclosure that accepts eight typed characters.
    */
    const named = (await instruction.innerText()).trim();
    expect(named).toContain('Remote');
    expect(named).toContain('Type a code instead');
    // …and it does not send this reader to a scan, which is the finding.
    expect(named.toLowerCase()).not.toContain('scan');

    /*
      A CLEAN context for the PC's half of this.

      The room the phone just minted lives in `localStorage`, which is shared
      across pages of one context — a CAM page opened beside it would read that
      room, land on the paired card, and pass this assertion by being the very
      device the instruction is trying to reach.
    */
    const camContext = await browser.newContext({ viewport: CAM });
    const cam = await camContext.newPage();
    await cam.goto(camUrl());
    await expect(cam.getByTestId('disclosure-remote')).toHaveText('Remote');

    await cam.goto(camUrl('#/remote'));
    await expect(cam.getByTestId('remote')).toHaveAttribute('data-surface', 'pairing');
    await expect(cam.getByTestId('pair-by-hand')).toContainText('Type a code instead');
    // The field really is behind it, so the instruction ends somewhere real.
    await cam.getByTestId('pair-by-hand').locator('summary').click();
    await expect(cam.locator('#remote-room')).toBeVisible();
    await expect(cam.getByTestId('pair-join')).toBeVisible();
    await camContext.close();
  });
});
