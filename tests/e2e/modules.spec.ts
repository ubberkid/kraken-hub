import { expect, test, type Page, type Request } from '@playwright/test';

/**
 * The M3 module suite: clock, image and stats, on every panel preset, plus the
 * chunk-isolation assertion that catches an accidental cross-module import.
 *
 * A new module is one row in `MODULES`, run against every row in `PRESETS` —
 * that is the deal `docs/modules.md` §11 makes with a contributor. The row
 * carries the module's id, its chunk name, the query it needs to boot, an
 * optional network setup, and one entry per thing worth asserting on a panel.
 * Nothing below the table names a module.
 */

const STATE_KEY = 'kraken-hub:v1:state';

/** An 8×8 PNG, small enough to inline and real enough for `<img>` to decode. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4YWODFTEMLQkAZZlQAVIPr1MAAAAASUVORK5CYII=';

/** Deliberately a third-party origin: the download path is a cross-origin fetch. */
const IMAGE_URL = 'https://images.example.test/wallpaper.png';

const PRESETS = [
  { sim: 'elite', width: 640, height: 640, shape: 'circle' },
  { sim: 'z', width: 320, height: 320, shape: 'circle' },
  { sim: 'kraken2023', width: 240, height: 240, shape: 'square' },
] as const;

/**
 * Serves the fixture image WITH `access-control-allow-origin`, so the module's
 * download-first path (fetch → IndexedDB → object URL) is genuinely exercised
 * rather than falling through to the streaming fallback.
 */
async function serveImage(page: Page): Promise<void> {
  await page.route(IMAGE_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'access-control-allow-origin': '*' },
      body: Buffer.from(PNG_BASE64, 'base64'),
    }),
  );
}

/** Seeds the state document before any app code runs. */
async function seed(page: Page, moduleId: string, cfg: unknown): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key, value);
    },
    [
      STATE_KEY,
      JSON.stringify({
        schema: 4,
        rev: 1,
        updatedAt: Date.now(),
        writerId: 'e2e',
        writerRole: 'config',
        activeModuleId: moduleId,
        modules: { [moduleId]: { v: 1, cfg } },
      }),
    ] as const,
  );
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

/** Everything the module painted must be inside the panel, at every preset. */
async function assertInsidePanel(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).boundingBox();
  const panel = page.viewportSize();
  expect(box).not.toBeNull();
  expect(panel).not.toBeNull();
  if (box === null || panel === null) return;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(panel.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(panel.height + 1);
}

// ---------------------------------------------------------------------------
// The module table — the only place a module is named
// ---------------------------------------------------------------------------

type Preset = (typeof PRESETS)[number];

/** One thing worth asserting about a module on a panel. */
interface PanelCase {
  /** Test title, prefixed with the module id. */
  readonly name: string;
  /** Extra query string appended after the module's own `sourceParam`. */
  readonly params?: string;
  readonly assert: (page: Page, preset: Preset) => Promise<void>;
}

interface ModuleCase {
  readonly id: string;
  /** Emitted chunk basename; the isolation test asserts nothing else loads. */
  readonly chunk: string;
  /** Query the module needs in order to render anything at all. */
  readonly sourceParam: string;
  /** Network the module needs served before it boots. */
  readonly setup?: (page: Page) => Promise<void>;
  /**
   * Empty means "chunk isolation only": the module is exercised by its own
   * spec file rather than by the panel matrix here.
   */
  readonly panelCases: readonly PanelCase[];
}

const MODULES: readonly ModuleCase[] = [
  {
    // The flagship has its own suite (`video.spec.ts`); it appears here so the
    // isolation test knows its chunk must never be fetched by anyone else.
    id: 'video',
    chunk: 'module-video',
    sourceParam: '',
    panelCases: [],
  },
  {
    id: 'clock',
    chunk: 'module-clock',
    sourceParam: '',
    panelCases: [
      {
        name: 'renders a digital face',
        assert: async (page) => {
          await expect(page.locator('.kh-clock__time')).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
          await assertInsidePanel(page, '.kh-clock__time');
        },
      },
      {
        name: 'renders an analog face from a URL parameter',
        params: '&face=analog',
        assert: async (page, preset) => {
          const dial = page.locator('.kh-clock__dial');
          await expect(dial).toBeVisible();
          // The dial fits the visible disc, not the bounding square.
          const box = await dial.boundingBox();
          expect(box?.width).toBeGreaterThan(0);
          expect(box?.width ?? 0).toBeLessThanOrEqual(preset.width);
          await assertInsidePanel(page, '.kh-clock__dial');

          // Discrete ticks: the hands carry a whole-degree-family rotation,
          // never a CSS transition that would smear across CAM's frames.
          const transform = await page.locator('.kh-clock__hand--minute').getAttribute('transform');
          expect(transform).toMatch(/^rotate\(-?\d+(\.\d+)?\)$/);
        },
      },
    ],
  },
  {
    id: 'stats',
    chunk: 'module-stats',
    sourceParam: '&monitor=load',
    panelCases: [
      {
        name: 'renders dials from the simulated feed',
        assert: async (page) => {
          const tiles = page.locator('.kh-stats__tile');
          await expect(tiles).toHaveCount(2);
          await expect(page.locator('.kh-stats__value').first()).toHaveText(/^\d+$/, {
            timeout: 10_000,
          });
          await expect(page.locator('.kh-stats__waiting')).toBeHidden();
          await assertInsidePanel(page, '.kh-stats__grid');
        },
      },
      {
        name: 'renders the compact grid layout from a URL parameter',
        params: '&layout=grid',
        assert: async (page) => {
          await expect(page.locator('.kh-stats')).toHaveAttribute('data-layout', 'grid');
          await expect(page.locator('.kh-stats__tile')).toHaveCount(6);
          // The grid is hidden until the first 1 Hz sample lands, so wait for
          // the feed before measuring: a hidden element has no box.
          await expect(page.locator('.kh-stats__waiting')).toBeHidden({ timeout: 10_000 });
          await assertInsidePanel(page, '.kh-stats__grid');
        },
      },
    ],
  },
  {
    id: 'image',
    chunk: 'module-image',
    sourceParam: `&src=${encodeURIComponent(IMAGE_URL)}`,
    setup: serveImage,
    panelCases: [
      {
        name: 'downloads and paints a picture',
        assert: async (page) => {
          const img = page.locator('.kh-image__img');
          await expect(img).toBeVisible();
          // Download-first: the painted source is a local object URL, not the
          // remote link, which is what keeps the picture alive offline.
          await expect(img).toHaveAttribute('src', /^blob:/, { timeout: 10_000 });
          await expect(page.locator('.kh-image__message')).toBeHidden();
        },
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Every module, at every panel preset
// ---------------------------------------------------------------------------

for (const preset of PRESETS) {
  test.describe(`${preset.sim} (${String(preset.width)} ${preset.shape})`, () => {
    test.use({ viewport: { width: preset.width, height: preset.height } });

    for (const mod of MODULES) {
      for (const panelCase of mod.panelCases) {
        test(`${mod.id} ${panelCase.name}`, async ({ page }) => {
          const errors = collectErrors(page);
          await mod.setup?.(page);
          await page.goto(
            `/?kraken=1&sim=${preset.sim}&module=${mod.id}${mod.sourceParam}${panelCase.params ?? ''}`,
          );

          await expect(page.locator(`[data-module="${mod.id}"]`)).toBeAttached();
          await panelCase.assert(page, preset);
          expect(errors).toEqual([]);
        });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Degradation
// ---------------------------------------------------------------------------

test('stats shows placeholders — never NaN — when CAM drops fields', async ({ page }) => {
  await page.goto('/?kraken=1&sim=elite&module=stats&layout=grid&monitor=missing');

  await expect(page.locator('.kh-stats__tile')).toHaveCount(6);
  // `?monitor=missing` rotates fields in and out of `undefined`, so at least one
  // tile is always dashed and none may ever read NaN.
  await expect
    .poll(async () => page.locator('.kh-stats__value', { hasText: '--' }).count(), {
      timeout: 10_000,
    })
    .toBeGreaterThan(0);

  const text = await page.locator('.kh-stats').innerText();
  expect(text).not.toContain('NaN');
  expect(text.toLowerCase()).not.toContain('pump');
});

test('stats says it is waiting when no monitoring sample ever arrives', async ({ page }) => {
  // No `?sim=`, so nothing injects `window.nzxt` and the feed never starts.
  await page.goto('/?kraken=1&module=stats');
  await expect(page.locator('.kh-stats__waiting')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.kh-stats__waiting')).toHaveText(/Waiting for CAM data/);
  await expect(page.locator('.kh-stats__grid')).toBeHidden();
});

test('image explains itself rather than going black when nothing is configured', async ({
  page,
}) => {
  await page.goto('/?kraken=1&sim=elite&module=image');
  await expect(page.locator('.kh-image__message')).toBeVisible();
  await expect(page.locator('.kh-image__message')).toContainText('CAM');
});

// ---------------------------------------------------------------------------
// Slideshow, on a fake clock
// ---------------------------------------------------------------------------

test('the image slideshow advances on its interval', async ({ page }) => {
  // Ten seconds is the module's floor, so the test drives the clock rather than
  // waiting: `page.clock` patches timers before any app code runs.
  await page.clock.install();

  await seed(page, 'image', {
    url: '',
    downloadMode: 'stream-only',
    background: '#000000',
    slideshow: { enabled: true, intervalSec: 10 },
  });

  // Seed two images straight into the library the module reads.
  await page.goto('/?kraken=1&sim=elite&module=image');
  await page.evaluate(async (base64: string) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('kraken-hub.v1', 3);
      // The module only opens the database lazily, so the test may get here
      // first; create the two stores it needs rather than racing the app.
      req.onupgradeneeded = () => {
        const db2 = req.result;
        if (!db2.objectStoreNames.contains('images')) {
          db2.createObjectStore('images', { keyPath: 'id' });
        }
        if (!db2.objectStoreNames.contains('imageBlobs')) {
          db2.createObjectStore('imageBlobs', { keyPath: 'id' });
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
    for (const [i, name] of ['alpha.png', 'beta.png'].entries()) {
      const id = `seed-${String(i)}`;
      tx.objectStore('imageBlobs').put({
        id,
        blob: new Blob([bytes], { type: 'image/png' }),
      });
      tx.objectStore('images').put({
        id,
        name,
        mime: 'image/png',
        size: bytes.byteLength,
        width: 8,
        height: 8,
        animated: false,
        // `beta` is newer, and the library lists newest first.
        createdAt: 1000 + i,
        lastUsedAt: 0,
        sourceUrl: null,
        pinned: false,
      });
    }
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => {
        resolve();
      };
    });
    db.close();
  }, PNG_BASE64);

  // Reload so the module resolves against the seeded library.
  await page.reload();
  const img = page.locator('.kh-image__img');
  await expect(img).toBeVisible();
  await expect.poll(async () => img.getAttribute('alt'), { timeout: 10_000 }).toBe('beta.png');

  await page.clock.fastForward(11_000);
  await expect.poll(async () => img.getAttribute('alt'), { timeout: 10_000 }).toBe('alpha.png');

  // ...and it wraps.
  await page.clock.fastForward(11_000);
  await expect.poll(async () => img.getAttribute('alt'), { timeout: 10_000 }).toBe('beta.png');
});

// ---------------------------------------------------------------------------
// Chunk isolation
// ---------------------------------------------------------------------------

const MODULE_CHUNKS = MODULES.map((mod) => mod.chunk);

function moduleChunksFetched(requests: readonly Request[]): string[] {
  const seen = new Set<string>();
  for (const req of requests) {
    const file = new URL(req.url()).pathname.split('/').pop() ?? '';
    for (const name of MODULE_CHUNKS) {
      // `module-video-ingest` must not be mistaken for `module-video`.
      if (new RegExp(`^${name}-[A-Za-z0-9_-]+\\.js$`).test(file)) seen.add(name);
    }
  }
  return [...seen].sort();
}

for (const mod of MODULES.filter((m) => m.panelCases.length > 0)) {
  test(`booting ${mod.id} fetches only its own module chunk`, async ({ page }) => {
    const requests: Request[] = [];
    page.on('request', (req) => requests.push(req));
    // The table drives one test per module: its own network setup, its own
    // boot query, and the chunk it — and nothing else — is allowed to fetch.
    await mod.setup?.(page);
    await page.goto(`/?kraken=1&sim=elite&module=${mod.id}${mod.sourceParam}`);
    await expect(page.locator(`[data-module="${mod.id}"]`)).toBeAttached();
    // Give any stray lazy import a chance to appear before asserting an absence.
    // There is nothing to wait FOR here — the assertion is that nothing else
    // ever arrives — so a fixed settle window is the honest instrument.
    // eslint-disable-next-line playwright/no-wait-for-timeout
    await page.waitForTimeout(500);

    expect(moduleChunksFetched(requests)).toEqual([mod.chunk]);
    // And no configuration UI reached the LCD (invariant I8, at runtime).
    const configFetched = requests.some((r) => /\/config-ui-[A-Za-z0-9_-]+\.js$/.test(r.url()));
    expect(configFetched).toBe(false);
  });
}
