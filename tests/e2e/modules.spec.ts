import { expect, test, type Page, type Request } from '@playwright/test';

/**
 * The module suite: clock, image and stats from M3, plus text, shape and effect
 * from W7, on every panel preset — and the chunk-isolation assertion that
 * catches an accidental cross-module import.
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
  /*
   * The three W7 LAYER kinds. They are booted through `?module=` like every
   * other row — that still sets the base kind — so the matrix exercises them at
   * every panel preset without knowing anything about looks.
   *
   * `text` declares `roles: ['overlay']`, so as a base `normalizeLook` draws it
   * over the stage background rather than dropping it (the `base-not-base-capable`
   * path). That is deliberate here: it is the one row that proves the fallback
   * paints something instead of a black panel.
   */
  {
    id: 'text',
    chunk: 'module-text',
    sourceParam: '',
    panelCases: [
      {
        name: 'renders a line of type',
        assert: async (page) => {
          await expect(page.locator('.kh-text__line')).toBeVisible();
          await assertInsidePanel(page, '.kh-text__line');
        },
      },
    ],
  },
  {
    id: 'shape',
    chunk: 'module-shape',
    sourceParam: '',
    panelCases: [
      {
        name: 'renders a full-panel ground',
        assert: async (page) => {
          await expect(page.locator('.kh-shape')).toBeVisible();
          await assertInsidePanel(page, '.kh-shape');
        },
      },
    ],
  },
  {
    id: 'effect',
    chunk: 'module-effect',
    // One of the twelve, by id — the module's only URL parameter. There is no
    // `?preset=`: a preset is a palette, and the palette table is lazy.
    sourceParam: '&effect=voronoi',
    panelCases: [
      {
        name: 'paints a canvas for the selected effect',
        // Attached, not visible-with-pixels: whether the fragment program
        // actually compiles depends on the runner's GL, and the module's
        // documented fallback is the CSS gradient on `.kh-effect` underneath.
        assert: async (page) => {
          await expect(page.locator('.kh-effect')).toBeVisible();
          await expect(page.locator('.kh-effect__canvas')).toBeAttached();
          await assertInsidePanel(page, '.kh-effect');
        },
      },
    ],
  },
  /*
   * The two §10 parity kinds. Both declare `roles: ['overlay']`, so as a base
   * they take the same `base-not-base-capable` path `text` does above: the look
   * normaliser draws them over the stage background rather than dropping them,
   * which is why booting them through `?module=` still paints something on
   * every preset.
   */
  {
    id: 'icon',
    chunk: 'module-icon',
    sourceParam: '',
    panelCases: [
      {
        name: 'draws one glyph on the 24 grid',
        assert: async (page) => {
          const svg = page.locator('.kh-icon__svg');
          await expect(svg).toBeVisible();
          await expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
          await assertInsidePanel(page, '.kh-icon__svg');
        },
      },
    ],
  },
  {
    id: 'date',
    chunk: 'module-date',
    sourceParam: '',
    panelCases: [
      {
        name: "renders today's date as one line",
        assert: async (page) => {
          const line = page.locator('.kh-date__line');
          await expect(line).toBeVisible();
          await expect(line).not.toBeEmpty();
          await assertInsidePanel(page, '.kh-date__line');
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
    // The placeholder is an em dash (`src/modules/stats/format.ts`): two hyphens
    // read as a minus sign next to a temperature, which is the one misreading a
    // cooler's dial cannot afford.
    .poll(async () => page.locator('.kh-stats__value', { hasText: '—' }).count(), {
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

/**
 * The no-source stand-in is a CARD, not a paragraph (audit 11, M-d).
 *
 * It used to print *"Demo clip — paste a video link in CAM → Lighting → your
 * Kraken → your kraken-hub card → Configure"* as one sentence, which is three
 * full-width lines of body type on a 640 Elite — a menu route read out to
 * somebody standing a metre from a screen they cannot touch. The shape is what
 * this pins, because the shape is the fix: a short headline, one line of advice,
 * and the CAM route demoted to the small footer every other card puts it in.
 *
 * Line counts, not character counts: the wall of text was a rendering, and only
 * a rendering can say whether it came back. Three lines at 640 is the budget for
 * a glance; the footer is dropped entirely on the small panels, where 62
 * characters could only be set at a size nobody can read.
 */
test('the no-source stand-in is an instruction card, not a paragraph', async ({ page }) => {
  await page.goto('/?kraken=1&sim=elite');
  const card = page.locator('.kh-video__hint');
  await expect(card).toBeVisible({ timeout: 10_000 });

  await expect(card.locator('.kh-video__card-title')).toHaveText('Nothing chosen yet');
  await expect(card.locator('.kh-video__card-body')).toHaveText('Pick a video in CAM');
  // The route is present, and it is ONLY in the footer.
  await expect(card.locator('.kh-video__hint-footer')).toContainText('Configure');
  await expect(card.locator('.kh-video__card-title')).not.toContainText('→');
  await expect(card.locator('.kh-video__card-body')).not.toContainText('→');

  const shape = await page.evaluate(() => {
    const inner = document.querySelector('.kh-video__hint-inner');
    if (inner === null) return null;
    const walker = document.createTreeWalker(inner, NodeFilter.SHOW_TEXT);
    let lines = 0;
    let node = walker.nextNode();
    while (node !== null) {
      if ((node.textContent ?? '').trim() !== '') {
        const range = document.createRange();
        range.selectNodeContents(node);
        lines += [...range.getClientRects()].filter((r) => r.width >= 1 && r.height >= 1).length;
      }
      node = walker.nextNode();
    }
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const safeR = (Math.min(window.innerWidth, window.innerHeight) / 2) * 0.88;
    const b = inner.getBoundingClientRect();
    const corners: [number, number][] = [
      [b.left, b.top],
      [b.right, b.top],
      [b.left, b.bottom],
      [b.right, b.bottom],
    ];
    return {
      lines,
      // Every line of it is inside the safe circle, not merely inside the box.
      worstRadius: Math.max(...corners.map(([x, y]) => Math.hypot(x - cx, y - cy))),
      safeR,
    };
  });
  expect(shape).not.toBeNull();
  expect(shape?.lines).toBeLessThanOrEqual(3);
  expect(shape?.worstRadius ?? Infinity).toBeLessThanOrEqual((shape?.safeR ?? 0) + 1);
});

test('the stand-in drops the CAM route rather than shrink it off a small panel', async ({
  page,
}) => {
  await page.goto('/?kraken=1&sim=kraken2023');
  const card = page.locator('.kh-video__hint');
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card.locator('.kh-video__card-title')).toHaveText('Nothing chosen yet');
  await expect(card.locator('.kh-video__hint-footer')).toHaveCount(0);
  // Still names where the fix lives, which is the part that has to survive.
  await expect(card).toContainText('CAM');
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
      /*
       * No version, deliberately (wave 2, C2).
       *
       * The seed used to name v3 and the schema is at v4, which would make this
       * open fail outright the moment the app got there first. Opening without
       * one means "whatever version this is" — and the point of the test is
       * unchanged either way: the rows go into the LEGACY `images` store, so
       * what it now also proves is that the merged library still reads them.
       */
      const req = indexedDB.open('kraken-hub.v1');
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
// The two things a browser has to prove, because a jsdom test cannot (audit 10)
// ---------------------------------------------------------------------------

/**
 * F6 — the text-first face has a meter, and it has a SIZE.
 *
 * `--kh-stats-dial` computed to `0px` on this face, so all six `<svg>`s were
 * 0 × 0 while the renderer went on writing a fresh `stroke-dasharray` into
 * them. Nothing in a unit test could see that: jsdom has no layout, so an
 * element with no box measures the same as one with a box. Only a real engine
 * can be asked how big the mark actually is.
 */
test('stats grid draws six meters with a size, and paints the accent on them', async ({ page }) => {
  await page.goto('/?kraken=1&sim=elite&module=stats&layout=grid&monitor=load');

  const dials = page.locator('.kh-stats__dial');
  await expect(dials).toHaveCount(6);
  // The face is hidden behind "waiting for CAM data" until the simulator's 1 Hz
  // feed delivers its first sample, and a hidden grid measures 0 for the same
  // reason the bug did. Wait for the face itself, not for a fixed delay.
  await expect(page.locator('.kh-stats__grid')).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(async () => dials.first().evaluate((n) => n.getBoundingClientRect().width), {
      timeout: 10_000,
    })
    .toBeGreaterThan(0);

  const boxes = await dials.evaluateAll((nodes) =>
    nodes.map((n) => {
      const b = n.getBoundingClientRect();
      const arc = n.querySelector('.kh-stats__arc');
      return {
        w: b.width,
        h: b.height,
        stroke: arc === null ? '' : getComputedStyle(arc).stroke,
        dash: arc?.getAttribute('stroke-dasharray') ?? '',
      };
    }),
  );
  for (const dial of boxes) {
    expect(dial.w).toBeGreaterThan(0);
    expect(dial.h).toBeGreaterThan(0);
    // The series colour is on the arc — not `none`, and not the ink the digits
    // wear. A face whose thresholds can change a colour must have a mark.
    expect(dial.stroke).toMatch(/^rgb/);
    expect(dial.stroke).not.toBe('rgb(0, 0, 0)');
    // And the arc is DASHED to a reading rather than sitting at the default.
    expect(dial.dash).not.toBe('0 100');
  }
  // The numbers are still the point of this face.
  await expect(page.locator('.kh-stats__value').first()).not.toBeEmpty();
});

/**
 * F7 — the date fits the panel at its longest, on the panels that are circles.
 *
 * The old corrective pass compared the line's SCROLL width, padding included,
 * against the host's width, and could not converge: "Wed, Sep 2" came out
 * 673.9 px wide inside a 640 px panel and 337.2 px inside a 320 px one. The
 * shortest preset failed, so the longest is what this asserts — the longest
 * weekday and the longest month en-US has, at the largest size the schema
 * allows, in the heaviest weight, uppercased.
 */
const LONGEST_DATES = [
  // "September 30" — the longest month name, on a Wednesday in 2026.
  { name: 'the longest month', format: 'month-day' },
  // "Wednesday" — the longest weekday.
  { name: 'the longest weekday', format: 'weekday' },
  // The preset that spells both out shortest is still the one with the most
  // pieces; it must fit at max size too.
  { name: 'a weekday and a date', format: 'weekday-day-month' },
] as const;

for (const preset of PRESETS) {
  test.describe(`${preset.sim} (${String(preset.width)} ${preset.shape})`, () => {
    test.use({ viewport: { width: preset.width, height: preset.height } });

    for (const one of LONGEST_DATES) {
      test(`date fits the panel with ${one.name}`, async ({ page }) => {
        const errors = collectErrors(page);
        // Wednesday 30 September 2026, midday, so the format is not a function
        // of the day the suite happens to run.
        await page.clock.install({ time: new Date('2026-09-30T12:00:00') });
        await seed(page, 'date', {
          format: one.format,
          locale: 'en-us',
          // `SIZE_MAX`, `800` and uppercase: every dial in the panel turned up.
          size: 0.6,
          color: '#f2f4f8',
          weight: 800,
          uppercase: true,
        });
        await page.goto(`/?kraken=1&sim=${preset.sim}&module=date`);

        const line = page.locator('.kh-date__line');
        await expect(line).toBeVisible();
        await expect(line).not.toBeEmpty();
        await assertInsidePanel(page, '.kh-date__line');
        expect(errors).toEqual([]);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Switching effect at runtime — the regression guard for the white panel
// ---------------------------------------------------------------------------

/**
 * Picking a second effect painted the panel WHITE on a real Kraken.
 *
 * The switch used to free the whole GL resource — `WEBGL_lose_context.
 * loseContext()` included — and then ask the SAME canvas for a context again.
 * Per the WebGL spec that hands back the same context, still lost: the new
 * program linked against a dead context, `draw()` bailed, and the canvas
 * presented its lost drawing buffer, which is white on ANGLE/D3D11. Switching
 * module and back "fixed" it because the layer remounted onto a fresh canvas.
 *
 * Nothing in jsdom could see it, and headless SwiftShader tolerated the lost
 * context outright — so this asserts on the two things that cannot be faked:
 * the renderer named on the element, and the pixels the panel is showing.
 */
const EFFECT_SWITCHES = ['voronoi', 'twisted-nebula', 'satin-swirl'] as const;

/** Read-modify-write of the state document, from a second same-origin page. */
async function commitEffect(page: Page, id: string): Promise<void> {
  await page.evaluate(
    ([key, effect]) => {
      const raw = localStorage.getItem(key);
      const state: Record<string, unknown> =
        raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
      const modules = (state['modules'] ?? {}) as Record<string, { v?: number; cfg?: object }>;
      const entry = modules['effect'] ?? { v: 1, cfg: {} };
      localStorage.setItem(
        key,
        JSON.stringify({
          ...state,
          schema: state['schema'] ?? 4,
          rev: typeof state['rev'] === 'number' ? state['rev'] + 1 : 1,
          updatedAt: Date.now(),
          writerId: 'e2e-effect-switch',
          writerRole: 'config',
          activeModuleId: 'effect',
          modules: { ...modules, effect: { ...entry, cfg: { ...(entry.cfg ?? {}), effect } } },
        }),
      );
    },
    [STATE_KEY, id] as const,
  );
}

/**
 * What the panel is SHOWING, decoded from a screenshot.
 *
 * A screenshot rather than `toDataURL()`: the context is created with
 * `preserveDrawingBuffer: false`, so reading the canvas back outside the draw
 * task returns a blank buffer — and blank is precisely the answer a broken
 * switch would give, which would make the instrument agree with the bug. The
 * composited image is what the user's eyes get.
 */
interface Pixels {
  /** Mean of R, G and B over the panel, 0–255. */
  mean: number;
  /** An 8 × 8 luminance grid, as a string — "is this a different picture". */
  signature: string;
}

async function readPanel(page: Page): Promise<Pixels> {
  const shot = await page.locator('.kh-effect').screenshot();
  return page.evaluate(async (b64: string) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const GRID = 8;
    const c = document.createElement('canvas');
    c.width = GRID;
    c.height = GRID;
    const ctx = c.getContext('2d');
    if (ctx === null) throw new Error('no 2d context in the test harness');
    ctx.drawImage(img, 0, 0, GRID, GRID);
    const { data } = ctx.getImageData(0, 0, GRID, GRID);
    let total = 0;
    const cells: string[] = [];
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      total += (r + g + b) / 3;
      cells.push(`${String(r)}.${String(g)}.${String(b)}`);
    }
    return { mean: total / (GRID * GRID), signature: cells.join(',') };
  }, shot.toString('base64'));
}

const WHITE = 240;
const BLACK = 8;

test('choosing a second effect keeps the context and keeps painting', async ({ context }) => {
  const display = await context.newPage();
  const errors = collectErrors(display);
  // Seeded rather than `&effect=plasma`: a URL parameter is the TOP precedence
  // layer, so it would keep winning over every runtime change the test makes.
  await seed(display, 'effect', { effect: 'plasma' });
  await display.goto('/?kraken=1&sim=elite&module=effect');

  const panel = display.locator('.kh-effect');
  await expect(panel).toBeVisible();
  // SwiftShader still grants a real context, so this is a genuine assertion on
  // both the CI runner and a GPU machine.
  await expect(panel).toHaveAttribute('data-gl', /^webgl[12]$/, { timeout: 10_000 });
  await expect(panel).toHaveAttribute('data-effect', 'plasma');

  let previous = await readPanel(display);
  expect(previous.mean).toBeLessThan(WHITE);
  expect(previous.mean).toBeGreaterThan(BLACK);

  // A second same-origin page is the config side of the sanctioned channel, so
  // the switch happens the way a user's does: a write, a `storage` event, and
  // the display's own `update()`.
  const config = await context.newPage();
  await config.goto('/');
  await expect(config.locator('.kh-app')).toBeVisible();

  for (const id of EFFECT_SWITCHES) {
    await commitEffect(config, id);
    await expect(panel).toHaveAttribute('data-effect', id, { timeout: 5000 });

    /*
     * The picture has to CHANGE — a dead context leaves the last frame (or a
     * white one) sitting there — so the wait is on the pixels rather than on a
     * duration. `expect.poll` owns the loop, so there is no conditional here.
     */
    const before = previous.signature;
    let now = previous;
    await expect
      .poll(
        async () => {
          now = await readPanel(display);
          return now.signature;
        },
        { timeout: 10_000 },
      )
      .not.toBe(before);

    // The element still names a live renderer: the switch reused the context.
    await expect(panel).toHaveAttribute('data-gl', /^webgl[12]$/);
    await expect(panel).not.toHaveAttribute('data-gl-lost', 'true');
    expect(now.mean, `${id} is white`).toBeLessThan(WHITE);
    expect(now.mean, `${id} is black`).toBeGreaterThan(BLACK);
    expect(now.signature, `${id} painted the same pixels as the effect before it`).not.toBe(
      previous.signature,
    );
    previous = now;
  }

  expect(errors).toEqual([]);
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
