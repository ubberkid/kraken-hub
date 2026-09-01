import { expect, test, type Page } from '@playwright/test';

import { SCHEMA_VERSION } from '../../src/state/schema';
import {
  YT_PLAYER_STATE,
  emitPlayerState,
  emitQuality,
  installFakeYouTube,
  readFakeCalls,
  readPrereadyCalls,
} from '../support/fakeYouTube';

/**
 * The YouTube geometry engine end to end, against a stubbed player.
 *
 * The assertions here are the numbers from design-videoEngine.md §2.3 —
 * literally the worked examples — because those numbers ARE the product: an
 * element that is the wrong size gets served 360p, and a transform that is off
 * by a few pixels puts YouTube's watermark back on the panel.
 */

const STATE_KEY = 'kraken-hub:v1:state';
const YOUTUBE_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

interface VideoCfg {
  url?: string;
  perf?: 'auto' | 'quality' | 'performance';
  loop?: { enabled: boolean; start: number; end: number | null; mode: 'hard'; crossfadeMs: number };
  render?: Record<string, unknown>;
  youtube?: Record<string, unknown>;
}

async function seed(page: Page, cfg: VideoCfg): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key, value);
    },
    [
      STATE_KEY,
      JSON.stringify({
        // Current schema on purpose. `perf`, `youtube.mode` and the crossfade are
        // no longer things a user can set — the settings census retired those
        // controls and the 5 → 6 migration retires the stored values with them.
        // This suite drives the ENGINE, not the panel, so it seeds a document
        // that is already current and hands the display the levers directly.
        schema: SCHEMA_VERSION,
        rev: 1,
        updatedAt: Date.now(),
        writerId: 'e2e-config',
        writerRole: 'config',
        activeModuleId: 'video',
        modules: { video: { v: 1, cfg: { url: YOUTUBE_URL, perf: 'quality', ...cfg } } },
      }),
    ] as const,
  );
}

function iframe(page: Page) {
  return page.locator('.kh-video__stage iframe.kh-video__yt');
}

function stageTransform(page: Page): Promise<string> {
  return page.evaluate(
    () => document.querySelector<HTMLElement>('.kh-video__stage')?.style.transform ?? '',
  );
}

function maskOpacity(page: Page): Promise<string> {
  return page.evaluate(
    () => document.querySelector<HTMLElement>('.kh-video__mask')?.style.opacity ?? '',
  );
}

test.describe('YouTube geometry — §2.3 worked examples at every device preset', () => {
  /**
   * `perf` is pinned to `quality` in every row: `auto` would promote to
   * `performance` on the Kraken Z (targetFps 1), which is correct behaviour but
   * would make this table assert two different things at once. The performance
   * levers get their own test below.
   *
   * Each row is (preset, element side, stage transform), and every transform
   * satisfies the §2.3 invariant `tx = ty = −0.388889 × displayW`.
   */
  const rows = [
    ['elite', 1920, 'translate(-248.889px, -248.889px) scale(0.592593)'],
    ['plus', 1920, 'translate(-248.889px, -248.889px) scale(0.592593)'],
    ['z', 1920, 'translate(-124.444px, -124.444px) scale(0.296296)'],
    ['kraken2023', 1920, 'translate(-93.333px, -93.333px) scale(0.222222)'],
  ] as const;

  for (const [preset, side, transform] of rows) {
    test(`${preset} mounts a ${String(side)} px square element and crops the centre`, async ({
      page,
    }) => {
      await installFakeYouTube(page);
      await seed(page, {});
      await page.goto(`/?kraken=1&sim=${preset}`);

      await expect(iframe(page)).toBeAttached({ timeout: 15_000 });
      // The ATTRIBUTE is what the player measures — the CSS alone would not
      // raise the served resolution. Both must carry the size (§2.5).
      await expect(iframe(page)).toHaveAttribute('width', String(side));
      await expect(iframe(page)).toHaveAttribute('height', String(side));
      await expect(iframe(page)).toHaveCSS('width', `${String(side)}px`);

      await expect.poll(() => stageTransform(page), { timeout: 10_000 }).toBe(transform);
    });
  }

  test('the embed URL is the §2.5 parameter set on the privacy-enhanced host', async ({ page }) => {
    await installFakeYouTube(page);
    await seed(page, {});
    await page.goto('/?kraken=1&sim=elite');
    await expect(iframe(page)).toBeAttached({ timeout: 15_000 });

    const src = (await iframe(page).getAttribute('src')) ?? '';
    const url = new URL(src);
    expect(url.origin).toBe('https://www.youtube-nocookie.com');
    expect(url.pathname).toBe('/embed/dQw4w9WgXcQ');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      enablejsapi: '1',
      autoplay: '1',
      mute: '1',
      playsinline: '1',
      controls: '0',
      rel: '0',
      iv_load_policy: '3',
      disablekb: '1',
      fs: '0',
      cc_load_policy: '0',
      color: 'white',
      loop: '0',
    });
    // The measured finding: `vq` does nothing, so it is not sent (§2.5).
    expect(url.searchParams.has('vq')).toBe(false);
    // `sandbox` would break the postMessage handshake the API needs (§2.5).
    expect(await iframe(page).getAttribute('sandbox')).toBeNull();
    expect(await iframe(page).getAttribute('allow')).toContain('autoplay');
    expect(await iframe(page).getAttribute('allow')).toContain('encrypted-media');
  });

  test('performance mode pulls the §8.3 levers: 1280 floor and tight geometry', async ({
    page,
  }) => {
    await installFakeYouTube(page);
    await seed(page, { perf: 'performance' });
    await page.goto('/?kraken=1&sim=elite');

    await expect(iframe(page)).toBeAttached({ timeout: 15_000 });
    await expect(iframe(page)).toHaveAttribute('width', '1280');
    // Tight: the same 720 crop and the same measured width, in a 1280×1080
    // element instead of 1280×1280 — a quarter less composited surface.
    await expect(iframe(page)).toHaveAttribute('height', '1080');
    await expect
      .poll(() => stageTransform(page), { timeout: 10_000 })
      // Chromium re-serialises `-160.000px` as `-160px` when reading back
      // `style.transform`; the value we write is the 3-decimal form (§4.4).
      .toBe('translate(-248.889px, -160px) scale(0.888889)');
  });
});

test.describe('§2.6 the overlay mask', () => {
  test('drops once the player is genuinely playing, and returns on BUFFERING', async ({ page }) => {
    await installFakeYouTube(page);
    await seed(page, {});
    await page.goto('/?kraken=1&sim=elite');
    await expect(iframe(page)).toBeAttached({ timeout: 15_000 });

    // Mount ⇒ VISIBLE: the first frame of an embed is its poster and title.
    await expect.poll(() => maskOpacity(page), { timeout: 10_000 }).toBe('0');

    await emitPlayerState(page, YT_PLAYER_STATE.buffering);
    await expect.poll(() => maskOpacity(page)).toBe('1');
    // Instant on the way in — a fade would show the spinner it is hiding.
    await expect
      .poll(() =>
        page.evaluate(
          () => document.querySelector<HTMLElement>('.kh-video__mask')?.style.transition ?? '',
        ),
      )
      .toBe('none');

    await emitPlayerState(page, YT_PLAYER_STATE.playing);
    await expect.poll(() => maskOpacity(page), { timeout: 5000 }).toBe('0');
  });

  test('a seek raises the mask until the clock proves the seek landed', async ({ page }) => {
    await installFakeYouTube(page);
    await seed(page, {});
    await page.goto('/?kraken=1&sim=elite');
    await expect.poll(() => maskOpacity(page), { timeout: 15_000 }).toBe('0');

    await emitPlayerState(page, YT_PLAYER_STATE.cued);
    await expect.poll(() => maskOpacity(page)).toBe('1');
    await emitPlayerState(page, YT_PLAYER_STATE.playing);
    await expect.poll(() => maskOpacity(page), { timeout: 5000 }).toBe('0');
  });
});

test.describe('§3.4 A-B loop on a polled provider', () => {
  test('crosses by seeking, and NEVER calls pauseVideo', async ({ page }) => {
    await installFakeYouTube(page, { duration: 60 });
    await seed(page, {
      loop: { enabled: true, start: 1, end: 2, mode: 'hard', crossfadeMs: 250 },
    });
    await page.goto('/?kraken=1&sim=elite');
    await expect(iframe(page)).toBeAttached({ timeout: 15_000 });

    // The fake's clock advances in real time, so a 1 s span crosses repeatedly.
    await expect
      .poll(
        async () => (await readFakeCalls(page)).filter((c) => c.startsWith('seekTo:1.00')).length,
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(2);

    const calls = await readFakeCalls(page);
    // The single most important negative in the module: pausing raises a
    // suggested-video grid *inside* the video rect, where no crop can reach it.
    expect(calls).not.toContain('pauseVideo');
    // And the end screen is never reached either — every seek is to the span.
    const seeks = calls.filter((c) => c.startsWith('seekTo:'));
    expect(seeks.every((c) => Number(c.slice('seekTo:'.length)) < 59)).toBe(true);
  });
});

test.describe('§2.7 quality ladder', () => {
  test('steps 1920 → 2560 when the player reports a low quality on a healthy buffer', async ({
    page,
  }) => {
    // A size-limited report: a low label with plenty of buffer ahead.
    await installFakeYouTube(page, { quality: 'medium', loadedFraction: 0.9, duration: 600 });
    await seed(page, {});
    await page.goto('/?kraken=1&sim=elite');

    await expect(iframe(page)).toBeAttached({ timeout: 15_000 });
    await expect(iframe(page)).toHaveAttribute('width', '1920');

    await emitQuality(page, 'medium');
    // The watchdog is armed 6 s after the first PLAYING, so this is a real wait.
    await expect(iframe(page)).toHaveAttribute('width', '2560', { timeout: 20_000 });
    await expect(iframe(page)).toHaveAttribute('height', '2560');

    // The step is remembered for the session (§2.7), under the canonical prefix.
    const remembered = await page.evaluate(() =>
      sessionStorage.getItem('kraken-hub:v1:video:ytLadder'),
    );
    expect(remembered).toBe('2560');

    // The remount preserved the playhead rather than restarting the video.
    const calls = await readFakeCalls(page);
    expect(calls.filter((c) => c === 'construct').length).toBeGreaterThanOrEqual(2);
    expect(calls).toContain('destroy');

    // The invariant holds at the new rung too: tx = ty = −0.388889 × 640.
    await expect
      .poll(() => stageTransform(page), { timeout: 10_000 })
      .toBe('translate(-248.889px, -248.889px) scale(0.444444)');
  });

  test('does not step up when the buffer is starved — that would make it worse', async ({
    page,
  }) => {
    await installFakeYouTube(page, { quality: 'medium', loadedFraction: 0.01, duration: 600 });
    await seed(page, { perf: 'quality' });
    await page.goto('/?kraken=1&sim=elite');

    await expect(iframe(page)).toBeAttached({ timeout: 15_000 });
    await emitQuality(page, 'medium');
    /*
     * Asserting a NEGATIVE: the watchdog's 6 s window has to actually elapse
     * before "it did not step up" means anything. There is no event to wait on.
     */
    // eslint-disable-next-line playwright/no-wait-for-timeout
    await page.waitForTimeout(9000);
    // `perf: 'quality'` means the user pinned it, so we hold rather than step
    // down; either way, stepping UP under network pressure is never right.
    await expect(iframe(page)).toHaveAttribute('width', '1920');
  });
});

/**
 * The `onReady` gate (regression for `TypeError: r?.mute is not a function`).
 *
 * `new YT.Player()` returns immediately but the API only grafts its methods on
 * at the handshake, and `display.ts` calls `setMuted(true)` then `play()` the
 * instant `mount()` resolves. On a real Kraken Elite (CAM 4.76.5) that raced
 * and the video module died with `source-unplayable` before a frame existed.
 *
 * `readyDelayMs` is stretched far past the mount so the race is not a race:
 * every pre-ready call the adapter could make has already been made by the time
 * this asserts.
 */
test.describe('§2.5 — no player API call before onReady', () => {
  test('mounts, mutes and plays without touching a single method pre-ready', async ({ page }) => {
    await installFakeYouTube(page, { readyDelayMs: 3000 });
    await seed(page, {});
    await page.goto('/?kraken=1&sim=elite');

    await expect(iframe(page)).toBeAttached({ timeout: 15_000 });
    // Mounted, and display.ts has already issued setMuted(true) + play().
    expect(await readPrereadyCalls(page)).toEqual([]);

    // …and the deferred calls are not dropped: they land once ready fires.
    await expect.poll(() => readFakeCalls(page), { timeout: 15_000 }).toContain('playVideo');
    expect(await readFakeCalls(page)).toContain('mute');
    expect(await readPrereadyCalls(page)).toEqual([]);
  });

  test('a seek issued before the handshake is queued, not thrown away', async ({ page }) => {
    await installFakeYouTube(page, { readyDelayMs: 2500, duration: 600 });
    await seed(page, {});
    await page.goto('/?kraken=1&sim=elite');
    await expect(iframe(page)).toBeAttached({ timeout: 15_000 });

    await expect.poll(() => readFakeCalls(page), { timeout: 15_000 }).toContain('playVideo');
    expect(await readPrereadyCalls(page)).toEqual([]);
    // The error card is the visible symptom of the hardware bug; it must not
    // be there.
    await expect(page.locator('.kh-video__card')).toHaveCount(0);
  });
});
