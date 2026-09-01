import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * "Everything repaints every time the display says something."
 *
 * The second report of the module-switch revert came with two symptoms nobody
 * had connected to it: the quality picker appearing and disappearing about once
 * a second, and the whole remote screen flashing — both in lockstep with
 * `seen Xs ago` resetting to zero. One cause, three symptoms.
 *
 * The `tele` channel is SHARED. The video module publishes `videoStats` every
 * 2 s and the replica feed publishes `monitor` every 2.5 s, so packets of two
 * unrelated kinds interleave continuously. `useSync` exposed `lastTele` — "the
 * most recent packet of any kind" — and the remote read `provider`, `quality`
 * and `levels` off it, so every `monitor` packet answered "nothing known" and
 * the picker's whole subtree was torn down and rebuilt on the packet rate.
 *
 * The mechanism lives in `src/app/config/teleKinds.test.ts` and the revert
 * itself in `src/sync/roomConvergence.dom.test.ts`; this file is the guard on
 * the real product path, in a real browser, with two real pages in one room.
 */

const ROOM = 'JKLM4567';
/** Longer than the revert ever took, and longer than several telemetry periods. */
const WATCH_MS = 7000;
const SAMPLE_MS = 400;

function displayUrl(): string {
  return `/?kraken=1&sim=elite&room=${ROOM}&transport=fake`;
}

function remoteUrl(): string {
  return `/?room=${ROOM}&transport=fake#/remote`;
}

/** Samples a reading across a window rather than trusting one lucky moment. */
async function sampleAcross<T>(read: () => Promise<T>, ms = WATCH_MS): Promise<T[]> {
  const seen: T[] = [];
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    seen.push(await read());
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_MS));
  }
  return seen;
}

/**
 * Every reading after the first REAL one that fell back to "not reported".
 *
 * A helper rather than an `if` in the test body: the badge read `quality` off
 * the mixed feed, so it flipped to "not reported yet" on every `monitor` packet
 * and back on every `videoStats` one. An empty list is the whole assertion. A
 * source that never reports a quality at all (the bundled demo clip may not)
 * has nothing to oscillate between, and yields an empty list honestly.
 */
function fallbacksAfterFirstReading(readings: (string | null)[]): (string | null)[] {
  const first = readings.findIndex((line) => line !== null && !line.includes('not reported'));
  if (first === -1) return [];
  return readings.slice(first + 1).filter((line) => line?.includes('not reported') === true);
}

/** Waits until the remote has actually heard from the display. */
async function waitForTelemetry(remote: Page): Promise<void> {
  await expect(remote.getByTestId('link-status')).toHaveAttribute('data-display', 'online', {
    timeout: 20_000,
  });
}

test.describe('a telemetry packet is not a repaint', () => {
  test('the module chosen on the remote holds while telemetry keeps arriving', async ({
    context,
  }: {
    context: BrowserContext;
  }) => {
    const display = await context.newPage();
    await display.goto(displayUrl());

    const remote = await context.newPage();
    await remote.goto(remoteUrl());
    await waitForTelemetry(remote);

    // The module picker is one of the remote's compact essentials now, not
    // something behind a "More controls" door (design audit, F6).
    await remote.locator('#remote-module').selectOption('clock');

    // The revert took about a second and arrived with a telemetry packet, so a
    // single assertion after the click passes on the broken build.
    const values = await sampleAcross(async () => remote.locator('#remote-module').inputValue());
    expect(new Set(values)).toEqual(new Set(['clock']));

    await expect
      .poll(async () => display.locator('[data-module]').getAttribute('data-module'), {
        timeout: 15_000,
      })
      .toBe('clock');
  });

  test('the quality control is not torn down and rebuilt on the packet rate', async ({
    context,
  }: {
    context: BrowserContext;
  }) => {
    const display = await context.newPage();
    await display.goto(displayUrl());

    const remote = await context.newPage();
    await remote.goto(remoteUrl());
    await waitForTelemetry(remote);

    const quality = remote.locator(
      '.kh-remote [id="remote-quality"], [data-testid="remote-quality-readout"]',
    );
    await expect(quality.first()).toBeVisible();

    /*
     * Node identity, not merely presence.
     *
     * A control that is unmounted and remounted is still "visible" every time
     * you look at it — which is exactly why the bug survived a review. The
     * stamp is an expando the app never writes: it can only survive if React
     * kept the same DOM node across every packet in the window.
     */
    await quality.first().evaluate((el) => {
      (el as HTMLElement & { khStamp?: string }).khStamp = 'kept';
    });

    const stamps = await sampleAcross(async () =>
      quality
        .first()
        .evaluate((el) => (el as HTMLElement & { khStamp?: string }).khStamp ?? 'REMOUNTED'),
    );
    expect(new Set(stamps)).toEqual(new Set(['kept']));
  });

  test('the quality reading never falls back to "not reported" once it has reported', async ({
    context,
  }: {
    context: BrowserContext;
  }) => {
    // The sub-line's badge read `tele['quality']` off the same mixed feed, so it
    // flipped to "quality not reported yet" on every `monitor` packet and back
    // on every `videoStats` one — the visible half of the same fault.
    const display = await context.newPage();
    await display.goto(displayUrl());

    const remote = await context.newPage();
    await remote.goto(remoteUrl());
    await waitForTelemetry(remote);

    const readings = await sampleAcross(async () => remote.getByTestId('remote-sub').textContent());
    expect(fallbacksAfterFirstReading(readings)).toEqual([]);
  });
});
