import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * The video module end to end, with the download-first pipeline as the headline.
 *
 * The fixture is the bundled demo clip: it is a real 640×640 H.264 MP4 with a
 * `moov` atom up front, served from the preview server's own origin, so the
 * `fetch`-into-IndexedDB path is genuinely exercised rather than mocked.
 */

const STATE_KEY = 'kraken-hub:v1:state';
const FIXTURE_URL = 'http://127.0.0.1:4173/demo/demo.mp4';

interface VideoCfg {
  url?: string;
  downloadMode?: 'auto' | 'stream-only';
  loop?: {
    enabled: boolean;
    start: number;
    end: number | null;
    mode: 'hard' | 'crossfade';
    crossfadeMs: number;
  };
  perf?: 'auto' | 'quality' | 'performance';
  render?: Record<string, unknown>;
}

/** Seeds the state document before any app code runs. */
async function seedVideoConfig(page: Page, cfg: VideoCfg): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key, value);
    },
    [
      STATE_KEY,
      JSON.stringify({
        schema: 2,
        rev: 1,
        updatedAt: Date.now(),
        writerId: 'e2e-config',
        writerRole: 'config',
        activeModuleId: 'video',
        modules: { video: { v: 1, cfg } },
      }),
    ] as const,
  );
}

/** Everything that is not the preview server is unreachable. */
async function goOffline(context: BrowserContext): Promise<void> {
  await context.route(/^https?:\/\/(?!127\.0\.0\.1:4173)/, (route) => route.abort());
}

function media(page: Page) {
  return page.locator('.kh-video__stage video');
}

async function currentTime(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLVideoElement>('.kh-video__stage video');
    return el === null ? -1 : el.currentTime;
  });
}

test.describe('video module', () => {
  test('plays a direct URL in stream-only mode', async ({ page }) => {
    await seedVideoConfig(page, { url: FIXTURE_URL, downloadMode: 'stream-only' });
    await page.goto('/?kraken=1&sim=elite');

    await expect(media(page)).toBeAttached();
    // Stream-only means the element keeps the remote URL — no blob, no library.
    await expect(media(page)).toHaveAttribute('src', FIXTURE_URL);
    await expect.poll(() => currentTime(page), { timeout: 10_000 }).toBeGreaterThan(0);
    // RenderController owns the transform, and it is written imperatively.
    await expect
      .poll(() =>
        page.evaluate(
          () => document.querySelector<HTMLElement>('.kh-video__stage')?.style.transform ?? '',
        ),
      )
      .toContain('scale(');
  });

  test('auto-downloads a pasted URL into the clip library, then plays the local copy offline', async ({
    context,
    page,
  }) => {
    await seedVideoConfig(page, { url: FIXTURE_URL, downloadMode: 'auto' });
    await page.goto('/?kraken=1&sim=elite');

    // The featured flow: the DISPLAY page does the download itself and ends up
    // playing a blob URL out of IndexedDB.
    await expect(media(page)).toBeAttached({ timeout: 15_000 });
    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.querySelector<HTMLVideoElement>('.kh-video__stage video')?.src ?? '',
          ),
        { timeout: 15_000 },
      )
      .toMatch(/^blob:/);

    const clips = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const req = indexedDB.open('kraken-hub.v1');
          req.onsuccess = () => {
            const tx = req.result.transaction('clips', 'readonly');
            const count = tx.objectStore('clips').count();
            count.onsuccess = () => {
              resolve(count.result);
            };
          };
          req.onerror = () => {
            resolve(-1);
          };
        }),
    );
    expect(clips).toBe(1);

    // Now prove the copy is genuinely local: block the media URL entirely and
    // reload. A streaming implementation would show an error card here.
    await context.route('**/demo/demo.mp4', (route) => route.abort());
    await page.reload();
    await expect(media(page)).toBeAttached({ timeout: 15_000 });
    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.querySelector<HTMLVideoElement>('.kh-video__stage video')?.src ?? '',
          ),
        { timeout: 15_000 },
      )
      .toMatch(/^blob:/);
    await expect.poll(() => currentTime(page), { timeout: 10_000 }).toBeGreaterThan(0);
  });

  test('the A-B loop sends playback back to the start', async ({ page }) => {
    await seedVideoConfig(page, {
      url: FIXTURE_URL,
      downloadMode: 'stream-only',
      loop: { enabled: true, start: 0.5, end: 1.5, mode: 'hard', crossfadeMs: 250 },
    });
    await page.goto('/?kraken=1&sim=elite');
    await expect(media(page)).toBeAttached();
    await expect.poll(() => currentTime(page), { timeout: 10_000 }).toBeGreaterThan(0.5);

    // Sample the clock in-page and look for the crossing: a strictly increasing
    // series would mean the loop never fired.
    const samples = await page.evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          const out: number[] = [];
          const id = setInterval(() => {
            const el = document.querySelector<HTMLVideoElement>('.kh-video__stage video');
            out.push(el === null ? -1 : el.currentTime);
            if (out.length >= 60) {
              clearInterval(id);
              resolve(out);
            }
          }, 100);
        }),
    );
    const wrapped = samples.some((t, i) => i > 0 && t < (samples[i - 1] ?? 0) - 0.2);
    expect(wrapped, `no loop crossing in ${JSON.stringify(samples)}`).toBe(true);
    expect(Math.max(...samples)).toBeLessThan(2.5);
  });

  test('crossfade mode runs two decoders and swaps their roles at the seam', async ({ page }) => {
    await seedVideoConfig(page, {
      url: FIXTURE_URL,
      downloadMode: 'stream-only',
      perf: 'quality',
      loop: { enabled: true, start: 0.2, end: 1.2, mode: 'crossfade', crossfadeMs: 250 },
    });
    await page.goto('/?kraken=1&sim=elite');

    // §3.6 — the whole cost of this mode is the second element. If there is one
    // <video> on the stage, the crossfade silently did not install.
    await expect(page.locator('.kh-video__stage video')).toHaveCount(2, { timeout: 15_000 });

    const opacities = (): Promise<string[]> =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLVideoElement>('.kh-video__stage video')].map(
          (v) => v.style.opacity,
        ),
      );

    // The clone starts hidden, and only a real crossing makes it the visible
    // one — which is the role swap, observable from outside the module.
    expect((await opacities())[1]).toBe('0');
    await expect.poll(opacities, { timeout: 15_000 }).toEqual(['0', '1']);
  });

  test('cold boot with no state plays the bundled demo clip with no network', async ({
    context,
    page,
  }) => {
    await goOffline(context);
    await page.goto('/?kraken=1&sim=elite');

    await expect(media(page)).toBeAttached({ timeout: 15_000 });
    await expect(media(page)).toHaveAttribute('src', /demo\/demo\.mp4$/);
    await expect.poll(() => currentTime(page), { timeout: 10_000 }).toBeGreaterThan(0);
    // The 15 s first-run hint.
    await expect(page.locator('.kh-video__hint')).toContainText('CAM');
  });

  test('?demo=1 forces the demo clip over a configured source', async ({ page }) => {
    await seedVideoConfig(page, { url: FIXTURE_URL, downloadMode: 'stream-only' });
    await page.goto('/?kraken=1&sim=elite&demo=1');
    await expect(media(page)).toHaveAttribute('src', /demo\/demo\.mp4$/);
  });

  test('render controls change the stage transform', async ({ page }) => {
    await seedVideoConfig(page, {
      url: FIXTURE_URL,
      downloadMode: 'stream-only',
      render: { fit: 'cover', zoom: 1, offsetX: 0, offsetY: 0, rotate: 0, allowChrome: false },
    });
    await page.goto('/?kraken=1&sim=elite');
    await expect(media(page)).toBeAttached();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.querySelector<HTMLElement>('.kh-video__stage')?.style.transform ?? '',
        ),
      )
      .toContain('scale(');
    const atZoom1 = await page.evaluate(
      () => document.querySelector<HTMLElement>('.kh-video__stage')?.style.transform ?? '',
    );

    // A live config change must rewrite the transform WITHOUT recreating the
    // media element — that is the whole point of the imperative writer.
    const before = await media(page).getAttribute('src');
    await page.evaluate(
      ([key]) => {
        const raw = localStorage.getItem(key);
        const state = JSON.parse(raw ?? '{}') as Record<string, unknown>;
        const modules = state['modules'] as Record<
          string,
          { v: number; cfg: Record<string, unknown> }
        >;
        const slot = modules['video'];
        const cfg = slot === undefined ? {} : slot.cfg;
        const render = (cfg['render'] ?? {}) as Record<string, unknown>;
        modules['video'] = {
          v: 1,
          cfg: { ...cfg, render: { ...render, zoom: 2.5, rotate: 90 } },
        };
        state['rev'] = 2;
        state['updatedAt'] = Date.now();
        localStorage.setItem(key, JSON.stringify(state));
        window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify(state) }));
      },
      [STATE_KEY] as const,
    );

    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.querySelector<HTMLElement>('.kh-video__stage')?.style.transform ?? '',
          ),
        { timeout: 5000 },
      )
      .not.toBe(atZoom1);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.querySelector<HTMLElement>('.kh-video__rotor')?.style.transform ?? '',
        ),
      )
      .toContain('rotate(90deg)');
    await expect(media(page)).toHaveAttribute('src', before ?? '');
  });
});

/*
 * The Library page's own flows — the manual-upload fallback and adding a link —
 * moved to `library.spec.ts` when the page became one grid with a single **+**
 * add surface. Both assertions live on there, with the tile as the subject
 * rather than a row in one of four stacked sections.
 */

test.describe('cold-restore resume', () => {
  const CHECKPOINT_KEY = 'kraken-hub:v1:video:positionCheckpoint';

  /**
   * Records the largest FORWARD jump in `currentTime`, sampled in-page.
   *
   * On a six-second clip, "currentTime > 2 after a reload" passes for the wrong
   * reason two seconds later. A forward discontinuity cannot be produced by
   * playing — the A-B loop's wrap is backwards — so it is the resume seek and
   * nothing else. Installed with `addInitScript`, so it re-arms on the reload
   * and measures only what happened after it.
   */
  async function watchJumps(page: Page): Promise<void> {
    await page.addInitScript(() => {
      const w = window as unknown as { __khJump: number };
      w.__khJump = 0;
      // Starts at 0, not at "unseen": a resume that lands before the sampler
      // ever sees the element still moved playback away from the beginning, and
      // that is exactly the case a first-sighting sentinel would miss.
      let previous = 0;
      setInterval(() => {
        const el = document.querySelector<HTMLVideoElement>('.kh-video__stage video');
        if (el === null) return;
        const t = el.currentTime;
        if (t - previous > w.__khJump) w.__khJump = t - previous;
        previous = t;
      }, 50);
    });
  }

  const maxJump = async (page: Page): Promise<number> =>
    page.evaluate(() => (window as unknown as { __khJump?: number }).__khJump ?? 0);

  /** Read off the telemetry mirror the video module already writes. */
  const loopCrossings = async (page: Page): Promise<number> =>
    page.evaluate(() => {
      const raw = localStorage.getItem('kraken-hub:v1:video:tele') ?? '{}';
      const packet = JSON.parse(raw) as { stats?: { loopCrossings?: number } };
      return packet.stats?.loopCrossings ?? -1;
    });

  test('a reload resumes the same source where it left off', async ({ page }) => {
    await seedVideoConfig(page, { url: FIXTURE_URL, downloadMode: 'stream-only' });
    await watchJumps(page);
    await page.goto('/?kraken=1&sim=elite');

    await expect(media(page)).toBeAttached({ timeout: 15_000 });
    // Far enough in to be worth restoring, and far enough from the six-second
    // end that the resume is not discarded as "finished".
    await expect.poll(() => currentTime(page), { timeout: 15_000 }).toBeGreaterThan(2.5);

    // A reload fires `pagehide`, which is the checkpoint's flush path.
    await page.reload();
    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key), CHECKPOINT_KEY))
      .not.toBeNull();

    await expect(media(page)).toBeAttached({ timeout: 15_000 });
    await expect.poll(() => maxJump(page), { timeout: 15_000 }).toBeGreaterThan(1);
  });

  test('a different source starts from the beginning', async ({ page }) => {
    // A checkpoint for some other clip must not leak into this one.
    await page.addInitScript(
      ([key, value]) => {
        localStorage.setItem(key, value);
      },
      [
        CHECKPOINT_KEY,
        JSON.stringify({ key: 'url:deadbeef', posSec: 4, durationSec: 6, atMs: 1 }),
      ] as const,
    );
    await seedVideoConfig(page, { url: FIXTURE_URL, downloadMode: 'stream-only' });
    await watchJumps(page);
    await page.goto('/?kraken=1&sim=elite');

    await expect(media(page)).toBeAttached({ timeout: 15_000 });
    await expect.poll(() => currentTime(page), { timeout: 15_000 }).toBeGreaterThan(1);
    expect(await maxJump(page)).toBeLessThan(1);
  });

  test('an A-B loop wins over the checkpoint', async ({ page }) => {
    await seedVideoConfig(page, {
      url: FIXTURE_URL,
      downloadMode: 'stream-only',
      loop: { enabled: true, start: 0, end: 1.5, mode: 'hard', crossfadeMs: 250 },
    });
    await watchJumps(page);
    await page.goto('/?kraken=1&sim=elite');

    await expect(media(page)).toBeAttached({ timeout: 15_000 });
    // Wait on a CONDITION rather than a clock: a reported loop crossing means
    // playback has wrapped and the 0.5 Hz sampler — the thing that writes the
    // checkpoint — has run at least twice.
    await expect.poll(() => loopCrossings(page), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);

    // Nothing was written while a loop was configured, so there is nothing to
    // resume from — the loop's own start is the resume point by design.
    expect(await page.evaluate((key) => localStorage.getItem(key), CHECKPOINT_KEY)).toBeNull();
  });
});
