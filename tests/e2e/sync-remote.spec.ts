import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';

/**
 * The M2 acceptance tests, run against the in-repo broker simulator
 * (`?transport=fake`, `src/sync/transports/FakeTransport.ts`).
 *
 * No public broker is contacted here, on purpose: a PR must never go red
 * because emqx.io or ntfy.sh is having a bad day. The live smoke test that DOES
 * touch a real broker is opt-in (`npm run test:live`).
 *
 * The fake transport is backed by `localStorage`, which is shared between pages
 * in one browser context — so a remote page really does drive a display page
 * through a retained-message channel with its own namespace
 * (`kraken-hub:v1:fake:…`), completely separate from the canonical state key.
 */

const STATE_KEY = 'kraken-hub:v1:state';
const ROOM = 'ABCD1234';
/** SHA-256("ABCD1234")[0..10] in Crockford base32 — pinned in crypto.test.ts. */
const TOPIC = '2RTWGMJTZEQ5HGVV';
const RETAINED_KEY = `kraken-hub:v1:fake:primary:${TOPIC}:state`;

function remoteUrl(room = ROOM): string {
  return `/?room=${room}&transport=fake#/remote`;
}

function displayUrl(room = ROOM): string {
  return `/?kraken=1&sim=elite&room=${room}&transport=fake`;
}

/** A bounding box that is a box, not `Box | null` — an absent one is a failure. */
async function boxOf(
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('element has no bounding box — is it rendered?');
  return box;
}

async function readSync(page: Page): Promise<Record<string, unknown>> {
  const raw = await page.locator('html').getAttribute('data-kh-sync');
  return raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Zero-tap pairing — the link a phone actually opens
// ---------------------------------------------------------------------------

/** `kraken-hub:v1:remote:room` — this device's pairing, kept apart from state. */
const REMEMBERED_KEY = 'kraken-hub:v1:remote:room';

/**
 * The real shared link: the room code lives in the FRAGMENT.
 *
 * `?transport=fake` stays in the search because it is a test harness flag, not
 * a secret. The room does not, and `src/app/config/qr.test.ts` pins that the
 * link builder puts it in the hash — a fragment never leaves the browser, so
 * the one piece of key material in the sync design cannot land in an access
 * log, a CDN log or a `Referer` header on the way to a static host.
 */
function scannedLink(room = ROOM): string {
  return `/?transport=fake#/remote?room=${room}`;
}

test('a scanned pairing link connects with zero taps', async ({ context }) => {
  const remote = await context.newPage();
  await remote.goto(scannedLink('MNPQ2345'));

  // No Join. No Generate. Nothing pressed at all between `goto` and this.
  await expect(remote.getByTestId('paired-summary')).toBeVisible();
  await expect(remote.getByTestId('paired-summary')).toContainText('MNPQ 2345');
  await expect(remote.getByTestId('link-status')).toHaveAttribute('data-network', 'online', {
    timeout: 10_000,
  });

  // …and the room really did reach the sync layer, not just the card.
  await expect(remote.getByTestId('paired-title')).toHaveText('Paired with your PC');

  // The device wrote the pairing down while doing it.
  await expect
    .poll(async () => remote.evaluate((key) => localStorage.getItem(key), REMEMBERED_KEY))
    .toBe('MNPQ2345');
});

/**
 * The second visit: a home-screen bookmark or a plain reload, with no code in
 * the link at all. This is the case the remembered key exists for.
 */
test('a later visit to plain #/remote reconnects from storage', async ({ context }) => {
  const first = await context.newPage();
  await first.goto(scannedLink('RSTV3456'));
  await expect(first.getByTestId('paired-summary')).toBeVisible();
  await expect
    .poll(async () => first.evaluate((key) => localStorage.getItem(key), REMEMBERED_KEY))
    .toBe('RSTV3456');
  await first.close();

  // Destroy the state document, so the remembered key is the ONLY record that
  // this device was ever paired — which is the whole point of it being separate.
  const scratch = await context.newPage();
  await scratch.goto('/');
  await scratch.evaluate((key) => {
    localStorage.removeItem(key);
  }, STATE_KEY);
  await scratch.close();

  const again = await context.newPage();
  await again.goto('/?transport=fake#/remote');
  await expect(again.getByTestId('paired-summary')).toBeVisible();
  await expect(again.getByTestId('paired-summary')).toContainText('RSTV 3456');
  await expect(again.getByTestId('link-status')).toHaveAttribute('data-network', 'online', {
    timeout: 10_000,
  });
});

/**
 * Unpair has to clear all three places a room hides — the
 * remembered key, the state document and the code still sitting in this page's
 * own address bar from the link that opened it. Missing any one of them shows up
 * as a remote that re-pairs itself on the next render.
 */
test('Unpair clears the pairing and disconnects', async ({ context }) => {
  const remote = await context.newPage();
  await remote.goto(scannedLink('WXYZ4567'));
  await expect(remote.getByTestId('paired-summary')).toBeVisible();
  await expect(remote.getByTestId('link-status')).toHaveAttribute('data-network', 'online', {
    timeout: 10_000,
  });

  await remote.getByTestId('pairing-options').locator('summary').first().click();
  await remote.getByTestId('pair-forget').click();

  await expect(remote.getByTestId('pairing-card')).toHaveAttribute('data-paired', 'false');
  await expect(remote.getByTestId('paired-summary')).toHaveCount(0);
  // The status line goes with the instrument: round 2's R4 gates both on a live
  // room, and a line reading "Not paired yet" above a card that says the same
  // thing was the second of the two duplicate waiting lines.
  await expect(remote.getByTestId('link-status')).toHaveCount(0);

  expect(await remote.evaluate((key) => localStorage.getItem(key), REMEMBERED_KEY)).toBeNull();
  // The room is out of the fragment too, so a reload cannot undo the decision.
  expect(new URL(remote.url()).hash).toBe('#/remote');

  await remote.reload();
  await expect(remote.getByTestId('pairing-card')).toHaveAttribute('data-paired', 'false');
});

/**
 * The remote page is a remote control, and nothing else.
 *
 * The design audit opened `More controls` and found a second complete copy of
 * the app inside it: fourteen controls duplicating the home screen in different
 * words, a nested privacy disclosure, room settings, and a hardware-report
 * puller — on a 390 px screen (F6). The census's verdict was 22 controls down
 * to 8.
 *
 * Two assertions, because "it is gone" and "what is left is small" are different
 * claims. The ceiling is measured on everything EXCEPT the scrubber and the
 * transport, which are not settings: they are the reason the page exists.
 */
test('the paired remote is a remote, not a second copy of the app', async ({ context }) => {
  const remote = await context.newPage();
  await remote.goto(remoteUrl());
  await expect(remote.getByTestId('paired-summary')).toBeVisible();

  // The duplicate app, by name.
  await expect(remote.getByTestId('more-controls')).toHaveCount(0);
  await expect(remote.getByTestId('diag-disclosure')).toHaveCount(0);
  await expect(remote.getByTestId('request-report')).toHaveCount(0);
  await expect(remote.getByTestId('privacy-note')).toHaveCount(0);
  for (const id of [
    'remote-transport',
    'remote-zoom',
    'remote-rotate',
    'remote-clip',
    'remote-endpoints',
    'remote-persist',
    'remote-tele',
    'remote-mqtt',
    'remote-ntfy',
  ]) {
    await expect(remote.locator(`#${id}`)).toHaveCount(0);
  }

  // The four essentials that DID survive the census are on the page, with no
  // door in front of them — as segmented rows, not `<select>`s (round 2, R8).
  await expect(remote.locator('#remote-src')).toBeVisible();
  await expect(remote.locator('#remote-module')).toBeVisible();
  await expect(remote.locator('#remote-fit')).toBeVisible();
  expect(
    await remote.getByTestId('remote').evaluate((root) => root.querySelectorAll('select').length),
  ).toBe(0);

  // Room settings live in exactly one place now, and this is the way there.
  await expect(remote.getByTestId('remote-connection-link')).toHaveAttribute('href', '#/about');

  const controls = await remote.getByTestId('remote').evaluate((root) => {
    const interactive = 'button, a[href], input, select, textarea, summary, [role="radiogroup"]';
    return [...root.querySelectorAll(interactive)].filter((el) => {
      if (el.closest('.kh-scrub') !== null) return false;
      if (el.closest('.kh-transport') !== null) return false;
      // A segmented row is ONE control — the same one control a `<select>` was
      // before round 2's R8 turned it inside out. Counting its segments would
      // score the app as more complicated for having made the choices visible,
      // which is the opposite of what this ceiling is for.
      if (el.closest('[role="radiogroup"]') !== null && el.getAttribute('role') !== 'radiogroup') {
        return false;
      }
      // A collapsed <details> still lays its children out in Chromium, so
      // `offsetParent` alone would count things nobody can see. The summary
      // itself is on screen and does count — it is the door.
      const closed = el.closest('details:not([open])');
      if (closed !== null && el.tagName !== 'SUMMARY') return false;
      return (el as HTMLElement).offsetParent !== null;
    }).length;
  });
  expect(controls).toBeLessThanOrEqual(10);
});

/**
 * Unpaired is ONE state, and it never names something that is not on screen.
 *
 * The old card read "Point a camera at this code" above no code at all, and two
 * paragraphs above an orange "No code yet. Press Generate code." — with three
 * equal-weight controls under it where one was the answer (design audit, F5.4).
 */
test('the unpaired remote is a sentence and one button, then a code', async ({ context }) => {
  const remote = await context.newPage();
  await remote.goto('/?transport=fake#/remote');

  const card = remote.getByTestId('pairing-card');
  await expect(card).toHaveAttribute('data-paired', 'false');
  // No copy about a code that is not there, and no orange warning about it.
  await expect(card).not.toContainText('Point a camera at this code');
  await expect(card).not.toContainText('No code yet');
  await expect(card.locator('.kh-qr')).toHaveCount(0);

  // One primary action.
  const create = remote.getByTestId('pair-rotate');
  await expect(create).toBeVisible();
  await expect(remote.getByTestId('pair-copy')).toHaveCount(0);

  await create.click();

  // …and now there IS a code, so the card may finally talk about one.
  await expect(remote.getByTestId('pairing-card')).toHaveAttribute('data-paired', 'true');
  await expect(remote.getByTestId('paired-summary')).toContainText('ROOM');
  // Unpairing is the card's one visible action, out of the drawer it used to
  // hide in and named after the state it produces (round 2, R4).
  await expect(remote.getByTestId('pair-forget')).toHaveText('Unpair');
});

/**
 * R4 — the remote leads with its job, and its job is pairing until it has a room.
 *
 * What the audit's capture showed at `#/remote` with nothing paired: a scrubber
 * reading `0:00 / 60:00` for a video nobody had chosen, three dead transport
 * buttons, a video field, a module picker, a Fit picker, a quality line, TWO
 * status lines both saying it was waiting, and — somewhere under all of it —
 * the one button that would have made any of it work.
 *
 * The ceiling is what the screen honestly needs: create a code, and the by-hand
 * fallback's summary, field and Join — plus, at a DESKTOP width only, the two
 * controls of the install card (wave 1, A6). Somebody sitting at a desktop
 * browser with nothing paired is very often somebody who has not pointed CAM at
 * this page yet, and until now the only door to that instruction was on a screen
 * they could not reach from here. A phone never sees it: "point CAM at this
 * address" is advice about a PC, and the phone is not the PC.
 */
test('an unpaired remote mounts pairing and nothing else', async ({ context }) => {
  const remote = await context.newPage();
  await remote.goto('/?transport=fake#/remote');
  await expect(remote.getByTestId('pairing-card')).toHaveAttribute('data-paired', 'false');

  // The instrument is not mounted at all — not merely disabled.
  for (const id of [
    'scrubber',
    'transport-hold',
    'transport-back',
    'transport-forward',
    'remote-essentials',
    'link-status',
    'remote-title',
    'remote-sub',
    'remote-connection-link',
  ] as const) {
    await expect(remote.getByTestId(id)).toHaveCount(0);
  }
  // …so there is no invented duration on screen either.
  await expect(remote.getByTestId('remote')).not.toContainText('60:00');

  // The ring stays: it is the object the page is about.
  await expect(remote.getByTestId('remote-mirror')).toBeVisible();

  const controls = await remote.getByTestId('remote').evaluate((root) => {
    const interactive = 'button, a[href], input, select, textarea, summary';
    return [...root.querySelectorAll(interactive)].filter(
      (el) => (el as HTMLElement).offsetParent !== null,
    ).length;
  });
  expect(controls).toBeLessThanOrEqual(6);
  // The instrument is still not mounted — that is what the per-testid
  // assertions above pin, and it is the half of this test that matters.
  await expect(remote.getByTestId('setup-about')).toBeVisible();
});

test('a cold display restores from the retained snapshot ALONE', async ({ context }) => {
  // 1. A remote pairs into the room and changes the active module.
  const remote = await context.newPage();
  await remote.goto(remoteUrl());
  await expect(remote.getByTestId('paired-summary')).toBeVisible();

  // The retained slot already holds the snapshot published on connect, so the
  // test waits for it to CHANGE rather than merely to exist.
  const before = await remote.evaluate((key) => localStorage.getItem(key), RETAINED_KEY);
  // The module picker is one of the remote's four compact essentials — the
  // "More controls" duplicate app it used to hide behind is gone (audit F6) —
  // and it is a segmented row rather than a `<select>` (round 2, R8).
  await remote.getByTestId('remote-module-clock').click();
  await expect
    .poll(async () => remote.evaluate((key) => localStorage.getItem(key), RETAINED_KEY))
    .not.toBe(before);

  // 2. The remote goes away entirely, so nothing can re-publish behind us.
  await remote.close();

  // 3. Destroy the ONLY other source of truth: the persisted state document.
  //    From here the retained snapshot is the sole record that the module was
  //    ever changed. This is the assertion the whole milestone rests on.
  const scratch = await context.newPage();
  await scratch.goto('/');
  await scratch.evaluate((key) => {
    localStorage.removeItem(key);
  }, STATE_KEY);
  await expect
    .poll(async () => scratch.evaluate((key) => localStorage.getItem(key), STATE_KEY))
    .toBeNull();

  const retained = await scratch.evaluate((key) => localStorage.getItem(key), RETAINED_KEY);
  expect(retained).not.toBeNull();
  // Wire payloads are ciphertext: the module id is nowhere in the frame.
  expect(retained).not.toContain('clock');
  await scratch.close();

  // 4. A cold display, with no persisted state, boots and must end up on
  //    clock — which it can only learn from the retained message.
  const display = await context.newPage();
  await display.goto(displayUrl());
  await expect(display.locator('.kh-stage')).toBeVisible();
  await expect(display.locator('[data-module="clock"]')).toBeVisible({ timeout: 10_000 });

  const readout = await readSync(display);
  expect(readout['module']).toBe('clock');
  expect(readout['retained']).toBe(true);
});

/**
 * The A-B loop, dragged rather than typed.
 *
 * The old remote spelled the loop as two number-fed range inputs; the Halo
 * remote makes it two draggable handles on the scrubber, which is what the
 * design calls for and what a thumb can actually operate. The assertion is
 * unchanged in intent: a loop change made on the phone reaches the display in
 * under a second, through the ordinary state channel and its 5 Hz coalescing.
 */
/**
 * A duration the display REPORTED — round 7's F1.
 *
 * The two loop tests below used to lean on the fabricated one-hour rail: their
 * own comment said *"no duration is known here, so the track spans the one-hour
 * ceiling"* and then dragged handle A to "~1800 s" of a video nobody had
 * measured. That number is exactly what F1 removed — without a reported length
 * the handles are disabled and nothing is written — so the tests keep their
 * intent (a drag reaches the display; the handles are keyboard-operable) and
 * get a real timeline to operate on, seeded into the same `playback` the
 * display publishes.
 */
async function seedDuration(page: Page, durationSec: number): Promise<void> {
  await page.addInitScript(
    ([key, sec]) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          schema: 2,
          rev: 1,
          updatedAt: Date.now(),
          writerId: 'e2e-duration',
          writerRole: 'config',
          activeModuleId: 'video',
          playback: {
            ownerModuleId: 'video',
            paused: false,
            posSec: 0,
            posAtTs: Date.now(),
            durationSec: sec,
            rate: 1,
            muted: true,
            volume: 1,
            loop: { enabled: false, startSec: 0, endSec: null },
          },
        }),
      );
    },
    [STATE_KEY, durationSec] as const,
  );
}

test('a dragged loop handle reaches the display in under a second', async ({ context }) => {
  const display = await context.newPage();
  await seedDuration(display, 3600);
  await display.goto(displayUrl('BCDE2345'));
  await expect(display.locator('.kh-stage')).toBeVisible();

  const remote = await context.newPage();
  await seedDuration(remote, 3600);
  await remote.goto(remoteUrl('BCDE2345'));
  await expect(remote.getByTestId('paired-summary')).toBeVisible();

  // Wait until the display has applied at least one snapshot, so the timing
  // below measures the update rather than the initial handshake.
  await expect.poll(async () => Object.keys(await readSync(display)).length).toBeGreaterThan(0);

  // A one-hour timeline, REPORTED rather than invented (F1): dragging handle A
  // to the middle asks for ~1800 s of a length the display actually published.
  await expect(remote.getByTestId('scrubber')).toHaveAttribute('data-scale', 'known');
  const box = await boxOf(remote.locator('.kh-scrub__track'));
  const from = await boxOf(remote.getByTestId('loop-handle-a'));

  const startedAt = Date.now();
  await remote.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await remote.mouse.down();
  await remote.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await remote.mouse.up();

  await expect
    .poll(async () => {
      const loop = (await readSync(display))['loop'] as { start?: number } | null | undefined;
      return loop?.start ?? null;
    })
    .toBeGreaterThan(1500);

  expect(Date.now() - startedAt).toBeLessThan(1000);

  const loop = (await readSync(display))['loop'] as { start?: number };
  expect(loop.start).toBeLessThan(2100);
  // Moving a handle turns the loop on — a drag that changed nothing visible
  // because a separate toggle was off is the failure this prevents.
  await expect(remote.getByTestId('loop-toggle')).toHaveAttribute('aria-pressed', 'true');
});

/**
 * The handles are focusable and keyboard-operable, which is the half of
 * "draggable" that a pointer test can never cover.
 */
test('the loop handles are reachable and adjustable from the keyboard', async ({ context }) => {
  const remote = await context.newPage();
  await seedDuration(remote, 600);
  await remote.goto(remoteUrl('JKLM1234'));
  await expect(remote.getByTestId('paired-summary')).toBeVisible();

  const handle = remote.getByTestId('loop-handle-a');
  await expect(handle).toHaveAttribute('role', 'slider');
  await handle.focus();
  await expect(handle).toBeFocused();

  const before = Number(await handle.getAttribute('aria-valuenow'));
  await remote.keyboard.press('ArrowRight');
  await expect
    .poll(async () => Number(await handle.getAttribute('aria-valuenow')))
    .toBeGreaterThan(before);

  // Page Up moves ten steps, not one.
  const nudged = Number(await handle.getAttribute('aria-valuenow'));
  await remote.keyboard.press('PageUp');
  await expect
    .poll(async () => Number(await handle.getAttribute('aria-valuenow')))
    .toBeGreaterThan(nudged + 1);
});

test('killing the transport shows the failover in the remote UI', async ({ context }) => {
  const remote = await context.newPage();
  await remote.goto(remoteUrl('CDEF3456'));
  await expect(remote.getByTestId('paired-summary')).toBeVisible();
  // The five transport chips became one quiet line; the transport's own name
  // moved into the Diagnostics disclosure, and the line carries the same facts
  // as data attributes so a test never has to match user-facing prose.
  const status = remote.getByTestId('link-status');
  await expect(status).toHaveAttribute('data-transport', 'fake', { timeout: 10_000 });
  await expect(status).toHaveAttribute('data-network', 'online');

  // Take the primary simulated broker down. The transport's own poll notices,
  // reports `offline`, and SyncService re-runs the ladder onto the fallback.
  const startedAt = Date.now();
  await remote.evaluate(() => {
    localStorage.setItem('kraken-hub:v1:fake:down:primary', '1');
  });

  await expect(status).toHaveAttribute('data-failover', 'true', { timeout: 15_000 });

  // The acceptance criterion is a NUMBER, not "eventually": a phone that takes
  // ten seconds to notice its broker died is indistinguishable from a broken
  // remote. The generous `toBeVisible` timeout above only exists so a failure
  // reports the elapsed time rather than a bare locator timeout.
  expect(Date.now() - startedAt).toBeLessThan(5000);
});

/**
 * The remote diagnostics pull — the acceptance test for the whole feature.
 *
 * The load-bearing detail is what `displayUrl()` does NOT contain: `diag=1`.
 * The old hand-off needed somebody to append that parameter to a hidden Kraken
 * Browser window and then read the result out of the SAME machine's
 * localStorage, which is impossible when CAM runs on a PC and you work on a Mac.
 * A display booted perfectly normally has to answer, or the feature has not
 * solved anything.
 */
test('a remote pulls a hardware report from a display never opened with ?diag=1', async ({
  context,
}) => {
  const display = await context.newPage();
  await display.goto(displayUrl('GHJK7890'));
  await expect(display.locator('.kh-stage')).toBeVisible();
  expect(display.url()).not.toContain('diag');
  // The display's sync layer is up: without this the command has no listener
  // and the test would be measuring a race rather than the feature.
  await expect.poll(async () => (await readSync(display))['net']).toBe('online');

  const remote = await context.newPage();
  await remote.goto(remoteUrl('GHJK7890'));
  await expect(remote.getByTestId('paired-summary')).toBeVisible();
  await expect(remote.getByTestId('link-status')).toHaveAttribute('data-network', 'online', {
    timeout: 10_000,
  });

  /*
   * The pull now lives on the merged About/Diagnostics page, reached by the
   * remote's one quiet link (design audit, F6/F7). It is the same feature over
   * the same channel — the room this device joined by scanning the link is
   * still joined — so everything below is unchanged.
   */
  await remote.getByTestId('remote-connection-link').click();
  await expect.poll(() => new URL(remote.url()).hash).toBe('#/about');
  // This page joins the same room, but its transport has to come up before the
  // command has anywhere to go — otherwise this measures a race, not a feature.
  // Both readouts moved one door down in round 2's R3: the transport chips into
  // "Connection detail", the pull into "Show the technical detail". Same
  // feature, same channel — one press each to reach them.
  await remote.getByTestId('connection-detail').locator('summary').click();
  await expect(remote.getByTestId('connection-net')).toContainText('online', {
    timeout: 10_000,
  });
  await remote.getByTestId('tech-detail').locator('summary').click();
  await remote.getByTestId('request-report').click();

  // The display samples frames for three seconds before it answers, and the
  // report may arrive in several chunks, so this is generous on purpose — but
  // it is still well inside the card's own 20 s timeout, which would render
  // "the display did not answer" instead.
  const summary = remote.getByText('Raw JSON');
  await expect(summary).toBeVisible({ timeout: 25_000 });
  await expect(remote.getByText('display did not answer')).toBeHidden();

  // The block is collapsed by design, so it has to be opened before it has any
  // rendered text to read.
  await summary.click();
  const raw = remote.getByTestId('pulled-report').locator('.kh-code');
  await expect(raw).toBeVisible();
  const json = await raw.innerText();
  expect(json).toContain('"schemaVersion"');
  expect(JSON.parse(json)).toMatchObject({ mode: 'display' });

  // The summary the card renders, not just the blob behind it — scoped to the
  // pulled report, because this page runs its own local probes too. R3 cut the
  // summary to the four rows somebody actually reads off a screen; the rest is
  // in the JSON above and on the clipboard.
  await expect(
    remote.getByTestId('pulled-summary').getByRole('row', { name: /Panel/ }),
  ).toBeVisible();
  await expect(remote.getByTestId('copy-report')).toBeVisible();
});

// ---------------------------------------------------------------------------
// Position sync — the half that used to be format-only
// ---------------------------------------------------------------------------

/**
 * `AppState.playback` travelled in the envelope from the start, but nothing
 * ever wrote it, so `anchorPosition()` was dead code at runtime: the remote
 * scrubber froze between telemetry packets and a cold display always resumed at
 * zero. These three tests are the ones that would have caught that.
 *
 * The fixture is the bundled 6-second demo clip, served by the preview server,
 * in stream-only mode — no IndexedDB, no companion, no blob, so a failure here
 * is about position and nothing else.
 */

const FIXTURE_URL = 'http://127.0.0.1:4173/demo/demo.mp4';
const CHECKPOINT_KEY = 'kraken-hub:v1:video:positionCheckpoint';
const MEDIA = '.kh-video__stage video';

/** Seeds every page in the context with the video module on the demo clip. */
async function seedVideo(context: BrowserContext): Promise<void> {
  await context.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key, value);
    },
    [
      STATE_KEY,
      JSON.stringify({
        schema: 2,
        rev: 1,
        updatedAt: 1,
        writerId: 'e2e-config',
        writerRole: 'config',
        activeModuleId: 'video',
        modules: { video: { v: 1, cfg: { url: FIXTURE_URL, downloadMode: 'stream-only' } } },
      }),
    ] as const,
  );
}

/**
 * Records the largest FORWARD jump in `currentTime`, sampled in-page.
 *
 * Magnitude alone cannot prove a seek on a 6-second clip: ordinary playback
 * reaches any position eventually, so "currentTime > 4" passes for the wrong
 * reason if you wait long enough. A discontinuity cannot happen by playing —
 * the loop's wrap is backwards — so a forward jump is the seek and nothing else.
 */
async function watchJumps(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __khJump: number };
    w.__khJump = 0;
    let previous = -1;
    setInterval(() => {
      const el = document.querySelector<HTMLVideoElement>('.kh-video__stage video');
      if (el === null) return;
      const t = el.currentTime;
      if (previous >= 0 && t - previous > w.__khJump) w.__khJump = t - previous;
      previous = t;
    }, 50);
  });
}

async function maxJump(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __khJump?: number }).__khJump ?? 0);
}

async function currentTime(page: Page): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector<HTMLVideoElement>(sel);
    return el === null ? -1 : el.currentTime;
  }, MEDIA);
}

async function seekValue(page: Page): Promise<number> {
  return Number(await page.locator('#remote-seek').inputValue());
}

test('the remote scrubber interpolates between telemetry packets', async ({ context }) => {
  await seedVideo(context);

  const display = await context.newPage();
  await display.goto(displayUrl('DEFG4567'));
  await expect(display.locator(MEDIA)).toBeAttached({ timeout: 15_000 });
  await expect.poll(async () => currentTime(display), { timeout: 15_000 }).toBeGreaterThan(0);

  const remote = await context.newPage();
  await remote.goto(remoteUrl('DEFG4567'));
  await expect(remote.getByTestId('paired-summary')).toBeVisible();

  /*
   * Telemetry is 0.5 Hz, so ONE packet arrives per two seconds. Sample the bar
   * ten times across 1.2 s and count the distinct values: a scrubber that
   * rendered `stats.currentTime` raw can change at most once in that window
   * (and usually not at all), while one re-anchored on the 250 ms clock changes
   * four or five times. Three distinct values cannot be produced by packets.
   */
  await expect.poll(async () => seekValue(remote), { timeout: 20_000 }).toBeGreaterThan(0);
  await expect
    .poll(
      async () => {
        const seen = new Set<number>();
        for (let i = 0; i < 10; i += 1) {
          seen.add(await seekValue(remote));
          await remote.waitForTimeout(120);
        }
        return seen.size;
      },
      { timeout: 25_000 },
    )
    .toBeGreaterThanOrEqual(3);
});

test('a seek on the remote moves the display', async ({ context }) => {
  await seedVideo(context);

  const display = await context.newPage();
  await display.goto(displayUrl('EFGH5678'));
  await expect(display.locator(MEDIA)).toBeAttached({ timeout: 15_000 });
  await expect.poll(async () => currentTime(display), { timeout: 15_000 }).toBeGreaterThan(0);

  const remote = await context.newPage();
  await remote.goto(remoteUrl('EFGH5678'));
  await expect(remote.getByTestId('paired-summary')).toBeVisible();
  await expect.poll(async () => seekValue(remote), { timeout: 20_000 }).toBeGreaterThan(0);

  // Hold first, so the assertion below cannot pass because the clip simply
  // played on: while held, the ONLY thing that can move `currentTime` is a seek.
  await remote.getByRole('button', { name: 'Hold' }).click();
  await expect
    .poll(
      async () => {
        const before = await currentTime(display);
        await display.waitForTimeout(500);
        return (await currentTime(display)) === before;
      },
      { timeout: 15_000 },
    )
    .toBe(true);

  // Two seeks, so the second one is measured from a KNOWN starting point rather
  // than from wherever playback happened to stop: rewind to the top, then jump
  // most of the way through a six-second clip.
  // 0.5, not 0.2: the slider's step is 0.5 and an off-grid value is refused.
  await remote.locator('#remote-seek').fill('0.5');
  await expect.poll(async () => currentTime(display), { timeout: 10_000 }).toBeLessThan(1);

  /*
   * Wait for the BAR, not just the display, before the second gesture.
   *
   * The scrubber is a controlled `<input type="range">` whose value is the
   * re-anchored telemetry position, refreshed on a 250 ms clock. Filling it
   * again while it still reads the pre-seek position races that re-render:
   * React resets the element's value between `fill`'s write and the `change`
   * it dispatches, and the handler then sees the value the bar snapped back to.
   * A real thumb cannot outrun the bar it is dragging; a script can.
   */
  await expect.poll(async () => seekValue(remote), { timeout: 10_000 }).toBeLessThan(1);

  await remote.locator('#remote-seek').fill('4.5');
  await expect
    .poll(async () => Math.abs((await currentTime(display)) - 4.5), { timeout: 10_000 })
    .toBeLessThan(0.4);
});

test('a cold display resumes from the position in the retained snapshot', async ({ context }) => {
  await seedVideo(context);

  const display = await context.newPage();
  await display.goto(displayUrl('FGHI6789'));
  await expect(display.locator(MEDIA)).toBeAttached({ timeout: 15_000 });
  await expect.poll(async () => currentTime(display), { timeout: 15_000 }).toBeGreaterThan(0);

  const remote = await context.newPage();
  await remote.goto(remoteUrl('FGHI6789'));
  await expect(remote.getByTestId('paired-summary')).toBeVisible();
  await expect.poll(async () => seekValue(remote), { timeout: 20_000 }).toBeGreaterThan(0);

  // Hold, and wait until the HELD flag has reached the remote through telemetry:
  // the scrubber standing still is exactly that signal, and it is what makes the
  // published sample `paused`, so no extrapolation is applied downstream.
  await remote.getByRole('button', { name: 'Hold' }).click();
  await expect
    .poll(
      async () => {
        const before = await seekValue(remote);
        await remote.waitForTimeout(800);
        return (await seekValue(remote)) === before;
      },
      { timeout: 20_000 },
    )
    .toBe(true);

  await remote.locator('#remote-seek').fill('4.5');

  // The live display applies it once, and says so in its readout.
  await expect.poll(async () => (await readSync(display))['pos'], { timeout: 10_000 }).toBe(4.5);

  // Everything that could remember the position locally now goes away: both
  // pages close, and the display's own 10 s checkpoint is deleted. The retained
  // frame is the only record left.
  await remote.close();
  await display.close();

  const scratch = await context.newPage();
  await scratch.goto('/');
  await scratch.evaluate((key) => {
    localStorage.removeItem(key);
  }, CHECKPOINT_KEY);
  await expect
    .poll(async () => scratch.evaluate((key) => localStorage.getItem(key), CHECKPOINT_KEY))
    .toBeNull();
  await scratch.close();

  const cold = await context.newPage();
  await watchJumps(cold);
  await cold.goto(displayUrl('FGHI6789'));
  await expect(cold.locator(MEDIA)).toBeAttached({ timeout: 15_000 });

  await expect.poll(async () => (await readSync(cold))['pos'], { timeout: 15_000 }).toBe(4.5);
  // …and it reached the media element, not just the readout.
  await expect.poll(async () => maxJump(cold), { timeout: 15_000 }).toBeGreaterThan(2);
});

// ---------------------------------------------------------------------------
// The QR as a thing a camera has to read
// ---------------------------------------------------------------------------

/**
 * Everything about the pairing QR that a phone camera cares about.
 *
 * The bug this pins: the code rendered, screenshotted fine, and an iPhone
 * camera would not see it at all. Four properties have to hold at once, and
 * every one of them reads as cosmetics in a diff — so all four are asserted
 * against the real DOM, on the desktop width where the code is actually shown
 * (below 700 px it is hidden, because there it would be a phone offering to
 * scan itself).
 *
 * The fifth property — that the modules decode to the payload — cannot be seen
 * from here; `src/app/config/qr.decode.test.ts` runs the matrix through a real
 * decoder for that.
 */
test('the pairing QR is dark-on-light, quiet-zoned, big enough, and holds the link', async ({
  context,
}) => {
  const remote = await context.newPage();
  await remote.setViewportSize({ width: 1000, height: 900 });
  await remote.goto(scannedLink('MNPQ2345'));
  await expect(remote.getByTestId('paired-summary')).toBeVisible();

  // Round 4 folded the square into "Pairing options": on a card that is already
  // paired the QR is a way to pair a SECOND device, and at 176 px plus its
  // caption it was the loudest object on the screen, pushing the one line the
  // card exists to say below the fold.
  await remote.getByTestId('pairing-options').locator('summary').first().click();

  const qr = remote.getByTestId('pair-qr').locator('svg.kh-qr');
  await expect(qr).toBeVisible();

  // 1. INVERTED CODES DO NOT SCAN. The app is dark; this tile is not. A light
  //    module on a dark ground is not a QR code with the colours swapped, it is
  //    a code iOS declines to recognise.
  const tile = await qr.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      background: s.backgroundColor,
      rect: el.querySelector('rect')?.getAttribute('fill'),
      path: el.querySelector('path')?.getAttribute('fill'),
    };
  });
  expect(tile.background).toBe('rgb(255, 255, 255)');
  expect(tile.rect).toBe('#ffffff');
  expect(tile.path).toBe('#000000');

  // 2. THE QUIET ZONE — four light modules on every side, inside the viewBox so
  //    it survives whatever the card does to the box.
  const geometry = await qr.evaluate((el) => {
    const box = el.getAttribute('viewBox')?.split(' ') ?? [];
    return {
      side: Number(box[2]),
      d: el.querySelector('path')?.getAttribute('d') ?? '',
    };
  });
  const modules = [...geometry.d.matchAll(/M(\d+) (\d+)h/g)].map(([, x, y]) => [
    Number(x),
    Number(y),
  ]);
  expect(modules.length).toBeGreaterThan(0);
  for (const [x = 0, y = 0] of modules) {
    expect(Math.min(x, y)).toBeGreaterThanOrEqual(4);
    expect(Math.max(x, y) + 1).toBeLessThanOrEqual(geometry.side - 4);
  }

  // 3. SIZE. The 56 px thumbnail this replaced drew a module at ~1.5 CSS px —
  //    decorative, not scannable. A scan target on the pairing card is ≥ 160.
  const box = await boxOf(qr);
  expect(box.width).toBeGreaterThanOrEqual(160);
  expect(box.height).toBeGreaterThanOrEqual(160);

  // 4. THE PAYLOAD is an ABSOLUTE URL with a scheme. A scheme-less or relative
  //    payload decodes as plain text and a camera offers nothing to tap. (It is
  //    `http` here only because the preview server is; in production the app is
  //    served over https and the link inherits that, which is the point of
  //    deriving it from `location` rather than writing a host down.)
  const payload = `${new URL('./', remote.url()).href}#/remote?room=MNPQ2345`;
  await expect(qr).toHaveAttribute('data-qr-payload', payload);
  // …and that string really is an absolute URL carrying the room in the hash,
  // rather than a path the camera would read as text.
  expect(payload).toMatch(/^https?:\/\//);
  expect(new URL(payload).hash).toBe('#/remote?room=MNPQ2345');
});
