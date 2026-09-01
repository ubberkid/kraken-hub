import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import { SAME_NETWORK_NOTE } from '../../src/config/vocabulary';

/**
 * "Send a file" — a REAL peer-to-peer transfer, between two real pages.
 *
 * The bytes of a photo on a phone cannot reach the Kraken by any path the app
 * had: they have to land in the browser profile the hidden LCD page can read,
 * and a phone shares nothing with it. So they go peer to peer over the LAN, with
 * the offer and the ICE candidates riding the encrypted sync channel that
 * already exists, and the DISPLAY as the receiver because the display is the
 * window that owns the store.
 *
 * These tests do not mock any of that. Two pages in one browser context open an
 * actual `RTCPeerConnection`, gather actual host candidates, open an actual
 * `RTCDataChannel` and move an actual mp4 across it — because every interesting
 * failure in this feature is in the handshake, and a mocked handshake proves
 * nothing about it. (`playwright.config.ts` turns off Chromium's mDNS candidate
 * obfuscation so headless CI, which often has no mDNS responder, gathers usable
 * host candidates.)
 *
 * The two claims:
 *
 *  1. a file chosen on the phone becomes a library row, visible in BOTH windows,
 *     through the ordinary ingest pipeline — not a second write path;
 *  2. a Kraken that is not there produces the one honest sentence about it, and
 *     only after it has genuinely failed.
 */

const FIXTURE_PATH = fileURLToPath(new URL('../../public/demo/demo.mp4', import.meta.url));

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

/** Open the Add control and hand it a file. */
async function sendFile(phone: Page, path: string): Promise<void> {
  await phone.getByTestId('remote-add').click();
  await expect(phone.getByTestId('remote-add-panel')).toBeVisible();
  await phone.locator('[data-testid="remote-file-input"]').setInputFiles(path);
}

test.describe('a file sent from the phone', () => {
  test('crosses a real data channel and becomes a row in the one library', async ({ context }) => {
    test.slow();
    const room = 'LANM2345';

    const display = await context.newPage();
    await openDisplay(display, room);

    const phone = await context.newPage();
    await phone.goto(phoneUrl(room));
    await expect(phone.getByTestId('paired-summary')).toBeVisible({ timeout: 20_000 });
    await expect(tiles(phone)).toHaveCount(0);

    await sendFile(phone, FIXTURE_PATH);

    // The progress line is the sender's half of the story; `stored` is the
    // receiver's, and it is the one that means "it is in your library".
    const progress = phone.getByTestId('remote-transfer');
    await expect(progress).toBeVisible({ timeout: 20_000 });
    await expect(progress).toHaveAttribute('data-phase', 'done', { timeout: 60_000 });
    await expect(progress).toContainText('Added to your library');

    // The phone's own shelf — which is the wire's shelf, republished by the
    // display the moment the row existed.
    await expect(tiles(phone)).toHaveCount(1, { timeout: 30_000 });
    await expect(tiles(phone).first()).toContainText('demo.mp4');

    /*
     * And the window that actually holds the bytes.
     *
     * Same browser context, same origin, therefore the same IndexedDB the
     * display wrote to — which is exactly the relationship CAM's two browser
     * windows have, and the entire reason the DISPLAY is the receiver.
     */
    const cam = await context.newPage();
    await cam.goto(camUrl(room));
    await expect(tiles(cam)).toHaveCount(1, { timeout: 30_000 });
    await expect(tiles(cam).first()).toContainText('demo.mp4');
    // It went through the ORDINARY ingest pipeline, so it is a clip like any
    // other — playable, and with a real id rather than a placeholder.
    await expect(tiles(cam).first()).toHaveAttribute('data-clip-id', /.+/);
    await expect(tiles(cam).first()).toHaveAttribute('data-tile-state', 'ready');
  });

  /**
   * The honest failure, and the discipline around it.
   *
   * One STUN server and deliberately no TURN relay, because a relay means
   * somebody's server carrying somebody's video and this project is not going to
   * run one. So the real constraint is that the two devices are on one network —
   * and the app says exactly that, once, AFTER it has genuinely failed.
   *
   * Saying it up front would be pre-emptively apologising for the case that
   * almost never happens (a phone and a PC on one home network), which is how a
   * feature teaches its user not to use it. Hence the second half of this test.
   */
  test('a Kraken that is not there says the one true thing, and not before', async ({
    context,
  }) => {
    test.slow();
    const room = 'LANM3456';

    // A display long enough to pair and hand over a shelf, and then gone — the
    // ordinary case of a PC that went to sleep between one tap and the next.
    const display = await context.newPage();
    await openDisplay(display, room);

    const phone = await context.newPage();
    await phone.goto(phoneUrl(room));
    await expect(phone.getByTestId('paired-summary')).toBeVisible({ timeout: 20_000 });

    await display.close();

    await phone.getByTestId('remote-add').click();
    await expect(phone.getByTestId('remote-add-panel')).toBeVisible();
    // Nothing has failed yet, so nothing apologises for a network.
    await expect(phone.locator('main')).not.toContainText(SAME_NETWORK_NOTE);

    await phone.locator('[data-testid="remote-file-input"]').setInputFiles(FIXTURE_PATH);

    const progress = phone.getByTestId('remote-transfer');
    await expect(progress).toBeVisible({ timeout: 20_000 });
    // Still reaching, still not blaming anything.
    await expect(progress).toHaveAttribute('data-phase', 'connecting');
    await expect(progress).not.toContainText(SAME_NETWORK_NOTE);

    // …and then, once the handshake has genuinely run out of time, the sentence
    // that names the actual requirement.
    await expect(progress).toHaveAttribute('data-phase', 'failed', { timeout: 45_000 });
    await expect(progress).toContainText(SAME_NETWORK_NOTE);
    // Nothing was invented in the library for a file that never arrived.
    await expect(tiles(phone)).toHaveCount(0);
  });
});
