import { expect, test, type Page } from '@playwright/test';

import {
  LINK_RECEIPT_UNSEEN,
  LOOP_UNLOCKS_ON_LENGTH,
  NOTHING_KEPT,
  OFFLINE_PROMISE,
} from '../../src/config/vocabulary';

/**
 * Round 7 — the round that turns a claim into a type.
 *
 * Round 6 built two spines and round 7's audit measured what each one bought.
 * The **paste** spine held, because `pasteLink.ts` owns a door: there is no way
 * to submit a link except `pasteAction`, so a field that bypasses the mapping is
 * a compile error. The **presence** spine leaked, because it was a two-phrase
 * grep satisfied per file by an import — `HomeView.tsx` names `panelPresence`
 * once, so all 1,382 of its lines passed, including two unconditional
 * present-tense claims about a panel it may never have heard from.
 *
 * `panelClaims.ts` is the door this time: a claim is a three-tense object, the
 * only ways to render one require a `PanelPresence`, and
 * `src/config/vocabulary.test.ts` proves no raw literal in the panel-verb family
 * survives anywhere on a config surface. That enumeration stops the class coming
 * back; what is HERE is the behaviour it produces, on the screens the audit
 * photographed.
 */

const STATE_KEY = 'kraken-hub:v1:state';
const TELE_KEY = 'kraken-hub:v1:video:tele';
const DOWNLOADS_KEY = 'kraken-hub:v1:video:downloads';
const SEEN_KEY = 'kraken-hub:v1:config:displaySeen';

/** CAM's own window: `camDetected`, and therefore the window that owns the bytes. */
function camUrl(hash = '#/'): string {
  return `/?cam=1${hash}`;
}

/** CAM's real Configuration Browser geometry — the one the composition is fitted to. */
const CAM = { width: 866, height: 537 };

const MP4 = 'https://example.test/clips/dunes.mp4';
const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

/**
 * Drag across the scrubber's track, the way a thumb does.
 *
 * A disabled handle takes no pointer events at all, so the gesture is dispatched
 * at the rail itself — which is what a real thumb hits, and the only way to ask
 * "would this have written anything?" of a control that has withdrawn.
 */
async function dragAcrossTrack(page: Page): Promise<void> {
  const track = await page.locator('.kh-scrub__track').boundingBox();
  if (track === null) throw new Error('the scrubber has no track — is it rendered?');
  await page.mouse.move(track.x + track.width * 0.7, track.y + track.height / 2);
  await page.mouse.down();
  await page.mouse.move(track.x + track.width * 0.9, track.y + track.height / 2, { steps: 5 });
  await page.mouse.up();
}

/**
 * The height of an element that must be on the page.
 *
 * A `boundingBox()` of `null` means "not rendered", which is a different failure
 * from "rendered small" — and folding the two together with `?? 0` is how a
 * missing halo passes as a collapsed one.
 */
async function heightOf(page: Page, testId: string): Promise<number> {
  const box = await page.getByTestId(testId).boundingBox();
  if (box === null) throw new Error(`${testId} is not on the page`);
  return box.height;
}

// ---------------------------------------------------------------------------
// CORE — a claim about the panel is a PanelClaim, in every tense
// ---------------------------------------------------------------------------

test.describe('the two claims round 6’s grep could not see', () => {
  /**
   * F2, half one: `<b>Playing through YouTube</b>`.
   *
   * Flat, in the present progressive, on every window — and the card directly
   * beneath it was at that same moment correctly refusing to claim a screen,
   * because THAT one went through the spine. One ladder, two answers about one
   * panel, eighteen pixels apart.
   */
  test('a first-run window does not say a YouTube video is playing on it', async ({ page }) => {
    await page.addInitScript(
      ([key]) => {
        localStorage.setItem(
          key,
          JSON.stringify({
            schema: 2,
            rev: 1,
            updatedAt: Date.now(),
            writerId: 'e2e-round7',
            writerRole: 'config',
            activeModuleId: 'video',
            modules: {},
          }),
        );
      },
      [STATE_KEY] as const,
    );
    await page.goto(camUrl());
    // The band is the proof this really is the never-seen state.
    await expect(page.getByTestId('home')).toHaveAttribute('data-firstrun', 'true');

    await page.getByTestId('paste-input').fill(YT);
    await page.getByTestId('paste-submit').click();

    const flow = page.getByTestId('paste-flow');
    await expect(flow).toHaveAttribute('data-flow-stage', 'youtube-embed');
    // The future tense, naming the condition — not a deletion.
    await expect(flow).toContainText('Plays through YouTube when your Kraken connects');
    await expect(flow).not.toContainText('Playing through YouTube');
    // …and the whole ladder agrees with itself now.
    await expect(flow).not.toContainText('On screen now');
  });

  /** …and the same card in the present tense, once a Kraken is talking. */
  test('a live window says it is playing through YouTube', async ({ page }) => {
    await page.addInitScript(
      ([seen, tele, state, url]) => {
        localStorage.setItem(seen, '1');
        localStorage.setItem(state, JSON.stringify({ schema: 2, rev: 1, modules: {} }));
        localStorage.setItem(
          tele,
          JSON.stringify({
            ch: 'tele',
            kind: 'videoStats',
            ts: Date.now(),
            provider: 'youtube-embed',
            display: { w: 640, h: 640, shape: 'circle', targetFps: 40 },
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
        void url;
      },
      [SEEN_KEY, TELE_KEY, STATE_KEY, YT] as const,
    );
    await page.goto(camUrl());
    await page.getByTestId('paste-input').fill(YT);
    await page.getByTestId('paste-submit').click();

    const flow = page.getByTestId('paste-flow');
    await expect(flow).toContainText('Playing through YouTube');
    await expect(flow).toContainText('On screen now');
  });

  /**
   * F2, half two: the CORS sub-line.
   *
   * "This server does not allow saving a copy, so your Kraken **is playing** it
   * straight from the web." The server's refusal is permanent and is stated in
   * every tense; the playback is not.
   */
  test('the streaming sub-line keeps the server fact and drops the panel claim', async ({
    page,
  }) => {
    await page.addInitScript(
      ([state, downloads, url]) => {
        localStorage.setItem(
          state,
          JSON.stringify({
            schema: 2,
            rev: 1,
            updatedAt: Date.now(),
            writerId: 'e2e-round7',
            writerRole: 'config',
            activeModuleId: 'video',
            modules: { video: { v: 1, cfg: { url } } },
          }),
        );
        localStorage.setItem(
          downloads,
          JSON.stringify([
            {
              id: 'd-cors',
              url,
              sourceUrl: url,
              name: 'dunes.mp4',
              state: 'error',
              reason: 'cors',
              receivedBytes: 0,
              totalBytes: null,
              attempt: 1,
              error: null,
              clipId: null,
              startedAt: Date.now(),
              updatedAt: Date.now(),
            },
          ]),
        );
      },
      [STATE_KEY, DOWNLOADS_KEY, MP4] as const,
    );
    await page.goto(camUrl());

    const flow = page.getByTestId('paste-flow');
    await expect(flow).toHaveAttribute('data-flow-stage', 'streaming');
    await expect(flow).toContainText('does not allow saving a copy');
    await expect(flow).not.toContainText('is playing it straight from the web');
  });
});

// ---------------------------------------------------------------------------
// F1 — no invented durations
// ---------------------------------------------------------------------------

test.describe('F1 — the scrubber withdraws rather than inventing a scale', () => {
  /**
   * The hazard round 2's own comment names at `LoopScrubber.tsx:57` and then
   * fixed for exactly one of three consumers: `LOOP_MAX_SEC` is a rail length,
   * and it was still feeding the seek input's `max` and the handles' range.
   */
  test('with no reported length there is no seek input and no writable handle', async ({
    page,
  }) => {
    await page.setViewportSize(CAM);
    await page.addInitScript(
      ([seen]) => {
        localStorage.setItem(seen, '1');
      },
      [SEEN_KEY] as const,
    );
    await page.goto(camUrl());
    await page.getByTestId('ops-loop-button').click();

    const scrubber = page.getByTestId('scrubber');
    await expect(scrubber).toHaveAttribute('data-scale', 'unknown');
    // No range input at all: a `max` of one fabricated hour is the whole bug.
    await expect(page.locator('#home-seek')).toHaveCount(0);
    // The band and the fill are positions on that same absent scale.
    await expect(page.getByTestId('scrub-loop')).toHaveCount(0);
    // The handles are inert, and they say what unlocks them.
    await expect(page.getByTestId('loop-handle-a')).toBeDisabled();
    await expect(page.getByTestId('loop-handle-b')).toBeDisabled();
    await expect(page.getByTestId('scrub-locked')).toHaveText(LOOP_UNLOCKS_ON_LENGTH);

    /*
      And nothing is persisted from the rail. `loopPoints.test.ts` pins the guard
      itself, for every write path at once; this pins that the control really is
      inert on the surface.
    */
    await dragAcrossTrack(page);
    const stored = await page.evaluate((key) => localStorage.getItem(key) ?? '', STATE_KEY);
    expect(stored).not.toContain('"enabled":true');
    expect(stored).not.toMatch(/"end":\s*\d/);
  });

  /** …and the same panel with a reported length is the instrument it always was. */
  test('a reported length brings the whole control back', async ({ page }) => {
    await page.setViewportSize(CAM);
    await page.addInitScript(
      ([seen, tele]) => {
        localStorage.setItem(seen, '1');
        localStorage.setItem(
          tele,
          JSON.stringify({
            ch: 'tele',
            kind: 'videoStats',
            ts: Date.now(),
            provider: 'direct-file',
            display: { w: 640, h: 640, shape: 'circle', targetFps: 40 },
            stats: {
              currentTime: 10,
              durationSec: 120,
              bufferedEnd: 120,
              held: false,
              loopCrossings: 0,
              maskVisiblePct: 0,
            },
          }),
        );
      },
      [SEEN_KEY, TELE_KEY] as const,
    );
    await page.goto(camUrl());
    await page.getByTestId('ops-loop-button').click();

    await expect(page.getByTestId('scrubber')).toHaveAttribute('data-scale', 'known');
    await expect(page.getByTestId('scrub-locked')).toHaveCount(0);
    await expect(page.getByTestId('loop-handle-a')).toHaveAttribute('role', 'slider');
    await expect(page.getByTestId('scrub-duration')).toHaveText('2:00');
  });
});

// ---------------------------------------------------------------------------
// F3 — one group, one answer
// ---------------------------------------------------------------------------

/**
 * The rail greyed out with the buttons beside it.
 *
 * The three transport buttons gated on `displayOnline`; the seek input did not.
 * A tap on a dead link moved the thumb, sent a `seekTo` into a room with nobody
 * in it, and left the bar showing a position no display had ever reported.
 */
test('F3 — the seek gates with the transport it sits above', async ({ page }) => {
  await page.addInitScript(
    ([key]) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          schema: 2,
          rev: 1,
          updatedAt: Date.now(),
          writerId: 'e2e-round7',
          writerRole: 'config',
          activeModuleId: 'video',
          playback: {
            ownerModuleId: 'video',
            paused: false,
            posSec: 0,
            posAtTs: Date.now(),
            durationSec: 300,
            rate: 1,
            muted: true,
            volume: 1,
            loop: { enabled: false, startSec: 0, endSec: null },
          },
        }),
      );
    },
    [STATE_KEY] as const,
  );
  // A room with nothing listening in it: paired, and no display anywhere.
  await page.goto('/?transport=fake&room=QRST5678#/remote');
  await expect(page.getByTestId('paired-summary')).toBeVisible();

  await expect(page.getByTestId('scrubber')).toHaveAttribute('data-scale', 'known');
  await expect(page.getByTestId('transport-hold')).toBeDisabled();
  await expect(page.locator('#remote-seek')).toBeDisabled();
});

// ---------------------------------------------------------------------------
// F4 — the receipt does not name a shelf the shelf then denies
// ---------------------------------------------------------------------------

test('F4 — "Saved" over an empty shelf, not "Saved to the library"', async ({ page }) => {
  await page.goto('/?transport=fake&room=VWXY6789#/remote');
  await expect(page.getByTestId('paired-summary')).toBeVisible();

  await page.getByTestId('remote-add').click();
  await page.getByTestId('remote-add-link').fill(MP4);
  await page.getByTestId('remote-add-link-submit').click();

  const receipt = page.getByTestId('remote-add-block');
  await expect(receipt).toContainText(LINK_RECEIPT_UNSEEN);
  // The two objects that used to contradict each other in one frame.
  await expect(receipt).not.toContainText('library');
  await expect(page.getByTestId('remote-library-empty')).toContainText(NOTHING_KEPT);
});

// ---------------------------------------------------------------------------
// F5 — CAM's #/remote is the pairing surface
// ---------------------------------------------------------------------------

test.describe('F5 — a window is not a remote control for the machine it runs on', () => {
  /**
   * The audit's screenshots: a replica ring above CAM's own live mirror, a
   * scrubber for a panel whose real transport is one click away on the home
   * screen, a Library that IS this window's database, and a card announcing
   * **Paired with your PC** — to the PC.
   */
  test('CAM gets pairing, with the square it exists to show', async ({ page }) => {
    await page.setViewportSize(CAM);
    await page.goto('/?cam=1&transport=fake&room=WXYZ7890#/remote');

    const remote = page.getByTestId('remote');
    await expect(remote).toHaveAttribute('data-surface', 'pairing');

    // The gesture, named — and the QR up front rather than behind a disclosure.
    await expect(page.getByTestId('pairing-title')).toHaveText('Scan with your phone');
    await expect(page.getByTestId('pair-qr')).toBeVisible();
    await expect(page.getByTestId('pair-rotate')).toBeVisible();
    await expect(remote).toContainText('WXYZ 7890');

    // No self-pairing, and no instrument for the panel this window mirrors.
    await expect(remote).not.toContainText('Paired with your PC');
    await expect(page.getByTestId('remote-mirror')).toHaveCount(0);
    await expect(page.getByTestId('scrubber')).toHaveCount(0);
    await expect(page.getByTestId('transport-hold')).toHaveCount(0);
    await expect(page.getByTestId('remote-library')).toHaveCount(0);
  });

  /** Unpaired, CAM asks the reader to do something the reader can actually do. */
  test('CAM’s unpaired card does not send you to the window you are in', async ({ page }) => {
    await page.setViewportSize(CAM);
    await page.goto('/?cam=1#/remote');
    await expect(page.getByTestId('remote')).toHaveAttribute('data-surface', 'pairing');
    await expect(page.getByTestId('pairing-title')).toHaveText('Pair your phone');
    await expect(page.getByTestId('pairing-card')).toContainText('scan it with your phone');
    // The reader is standing in the CAM window, so it is not sent to one. Round
    // 8's C rewrote the phone's half of this sentence; CAM's half is unchanged,
    // and what it must never do is address the wrong machine.
    await expect(page.getByTestId('pairing-card')).not.toContainText('scan it from the CAM window');
  });

  /** …and every window that really is remote keeps the instrument. */
  test('a phone keeps the remote it came for', async ({ page }) => {
    await page.goto('/?transport=fake&room=ABCD1234#/remote');
    await expect(page.getByTestId('remote')).toHaveAttribute('data-surface', 'instrument');
    await expect(page.getByTestId('remote-mirror')).toBeVisible();
    // The pairing card is still the collapsed credential at the bottom of an
    // instrument — with the headline round 8's B made conditional, because this
    // room has no display in it and never has had.
    await expect(page.getByTestId('pairing-card')).toHaveAttribute('data-paired', 'true');
    await expect(page.getByTestId('paired-title')).toHaveText('Your pairing code');
  });
});

// ---------------------------------------------------------------------------
// F6 — receipts are keyed to story time
// ---------------------------------------------------------------------------

/**
 * Reopening CAM on a day-old state replayed the whole ladder.
 *
 * The retirement timer started on MOUNT, so "four seconds old" meant four
 * seconds since React rendered. A finished story from yesterday was narrated as
 * news, and it took the floor while it did it — the halo yields to the receipt,
 * so the first thing a returning user saw was a 64 px thumbnail under a stale
 * narration.
 */
test('F6 — a day-old story is not replayed, and the halo is never held down by one', async ({
  page,
}) => {
  const DAY_MS = 86_400_000;
  await page.setViewportSize(CAM);
  await page.addInitScript(
    ([seen, state, downloads, url, dayMs]) => {
      const old = Date.now() - dayMs;
      localStorage.setItem(seen, '1');
      localStorage.setItem(
        state,
        JSON.stringify({
          schema: 2,
          rev: 1,
          updatedAt: old,
          writerId: 'e2e-round7',
          writerRole: 'config',
          activeModuleId: 'video',
          modules: { video: { v: 1, cfg: { url } } },
        }),
      );
      localStorage.setItem(
        downloads,
        JSON.stringify([
          {
            id: 'd-old',
            url,
            sourceUrl: url,
            name: 'dunes.mp4',
            state: 'done',
            reason: null,
            receivedBytes: 2_097_152,
            totalBytes: 2_097_152,
            attempt: 1,
            error: null,
            clipId: 'abcd1234',
            startedAt: old,
            updatedAt: old,
          },
        ]),
      );
    },
    [SEEN_KEY, STATE_KEY, DOWNLOADS_KEY, MP4, DAY_MS] as const,
  );
  await page.goto(camUrl());

  // The stage is still readable — the story happened — but it is not narrated.
  const flow = page.getByTestId('paste-flow');
  await expect(flow).toHaveAttribute('data-flow-stage', 'stored');
  await expect(flow).toHaveAttribute('data-collapsed', 'true');

  // …and the halo never gives up the floor to it, not even for a frame.
  await expect(page.getByTestId('home')).toHaveAttribute('data-compact', 'false');
  expect(await heightOf(page, 'mirror')).toBeGreaterThan(120);

  /*
    …and it stays free across the screen's own 1 Hz clock.

    The receipt is decided from `now`, which ticks once a second, so a single
    assertion at mount could only prove the first frame. Two ticks is the
    smallest window that shows the ladder is not merely late.
  */
  // eslint-disable-next-line playwright/no-wait-for-timeout -- two ticks of the page's own 1 Hz clock; there is no event to await
  await page.waitForTimeout(2200);
  await expect(page.getByTestId('home')).toHaveAttribute('data-compact', 'false');
  await expect(flow).toHaveAttribute('data-collapsed', 'true');
});

// ---------------------------------------------------------------------------
// The minors
// ---------------------------------------------------------------------------

test.describe('the minors', () => {
  /** One field per screen, and the phone's own placeholder in the phone's panel. */
  test('the Add panel is the only link field while it is open', async ({ page }) => {
    // A phone, explicitly: the project's `Desktop Chrome` device overrides the
    // config's 640 px default, and the placeholder this asserts is a width
    // question (`PHONE_QUERY`).
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/?transport=fake&room=EFGH2345#/remote');
    await expect(page.getByTestId('paired-summary')).toBeVisible();

    const sourceRow = page.locator('#remote-src');
    await expect(sourceRow).toBeVisible();

    await page.getByTestId('remote-add').click();
    const field = page.getByTestId('remote-add-link');
    // The phone's placeholder, not the desk's — the one `pasteAction` call site
    // in the product that never passed the width.
    await expect(field).toHaveAttribute('placeholder', 'Paste a video link');
    // …and the duplicate row is gone while this one is up.
    await expect(sourceRow).toHaveCount(0);

    await page.getByTestId('remote-add').click();
    await expect(page.locator('#remote-src')).toBeVisible();
  });

  /** One library, one empty state — the phone's was a caption, CAM's was a card. */
  test('the phone’s empty shelf is the framed card CAM draws', async ({ page }) => {
    await page.goto('/?transport=fake&room=JKMN3456#/remote');
    const empty = page.getByTestId('remote-library-empty');
    await expect(empty).toHaveClass(/kh-empty/);
    await expect(empty).toContainText(NOTHING_KEPT);
    await expect(empty).toContainText(OFFLINE_PROMISE);
  });

  /** The picker says "Auto"; the line above it says what Auto is choosing. */
  test('the quality row says Auto once', async ({ page }) => {
    await page.setViewportSize(CAM);
    await page.addInitScript(
      ([seen, state, tele, url]) => {
        localStorage.setItem(seen, '1');
        localStorage.setItem(
          state,
          JSON.stringify({
            schema: 2,
            rev: 1,
            updatedAt: Date.now(),
            writerId: 'e2e-round7',
            writerRole: 'config',
            activeModuleId: 'video',
            modules: { video: { v: 1, cfg: { url } } },
          }),
        );
        localStorage.setItem(
          tele,
          JSON.stringify({
            ch: 'tele',
            kind: 'videoStats',
            ts: Date.now(),
            provider: 'youtube-embed',
            display: { w: 640, h: 640, shape: 'circle', targetFps: 40 },
            quality: { height: 720, label: '720p' },
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
      [SEEN_KEY, STATE_KEY, TELE_KEY, YT] as const,
    );
    await page.goto(camUrl());
    await page.getByTestId('module-chip-video').click();

    /*
      Scoped to the quality control itself, not to the panel.

      "Auto" is also the first segment of **Shape of the video**, which is a
      different setting answering a different question; counting the word across
      the whole panel would make this test fail for a correct screen. What was
      doubled is one row: the description said "Auto — 720p right now" directly
      above a segment labelled Auto.
    */
    const row = page
      .locator('#video-quality')
      .locator('xpath=ancestor::*[contains(@class,"kh-field")][1]');
    await expect(row).toBeVisible();
    const autos = await row.evaluate((el) => el.textContent.split('Auto').length - 1);
    expect(autos).toBe(1);
    // …and the half the segment cannot show is still there.
    await expect(row).toContainText('720p right now');
  });

  /** All four legacy routes behave the same way: one hash rewrite, no remount. */
  test('every legacy route rewrites its hash, and none of them remounts', async ({ page }) => {
    await page.setViewportSize(CAM);
    await page.addInitScript(
      ([seen]) => {
        localStorage.setItem(seen, '1');
      },
      [SEEN_KEY] as const,
    );

    for (const [from, to] of [
      ['#/module/video', '#/'],
      ['#/preview', '#/'],
      ['#/sources', '#/library'],
      ['#/diag', '#/about'],
    ] as const) {
      await page.goto(camUrl(from));
      await expect.poll(() => new URL(page.url()).hash, { message: `${from} → ${to}` }).toBe(to);
    }
  });
});

/**
 * The console is clean for the overwhelming majority who never run the
 * companion.
 *
 * `checkHealth` was always careful — timeout, `try/catch`, a `debug` log — and
 * none of it mattered: Chrome logs a failed subresource load from the renderer
 * before the promise ever rejects, so every user without the downloader
 * collected `net::ERR_CONNECTION_REFUSED` for a component behaving exactly as
 * §6.4 specifies. The probe runs in a worker now, whose failures do not reach
 * the page console.
 */
test('a companion-less load logs no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.addInitScript(
    ([state, url]) => {
      localStorage.setItem(
        state,
        JSON.stringify({
          schema: 2,
          rev: 1,
          updatedAt: Date.now(),
          writerId: 'e2e-round7',
          writerRole: 'config',
          activeModuleId: 'video',
          modules: { video: { v: 1, cfg: { url } } },
        }),
      );
    },
    [STATE_KEY, YT] as const,
  );
  // The display, with a YouTube link and no downloader anywhere — the exact
  // load that used to print a red line.
  await page.goto('/?kraken=1&sim=elite');
  // eslint-disable-next-line playwright/no-wait-for-timeout -- waiting for a request that must NOT happen has no event to await
  await page.waitForTimeout(6000);
  /*
    The probe's noise, named rather than counted.

    A sandboxed browser cannot actually play a real YouTube video, so this load
    legitimately reports `source-unplayable` — a genuine event about a genuine
    source, which is exactly the kind of line a console is for. What must not be
    there is a failed loopback request for a program the user never installed.
  */
  expect(
    errors.filter((e) => /ERR_CONNECTION_REFUSED|127\.0\.0\.1/.test(e)),
    'the companion probe must not reach the page console',
  ).toEqual([]);

  // …and the ordinary configuration window, which is what most people open, is
  // clean outright.
  errors.length = 0;
  await page.goto('/?cam=1#/');
  // eslint-disable-next-line playwright/no-wait-for-timeout -- same: the assertion is about an absence
  await page.waitForTimeout(3000);
  expect(errors, 'a companion-less config load prints nothing at all').toEqual([]);
});
