import { expect, test, type Page } from '@playwright/test';

/**
 * "The live display in the hub is flickering and starting over from the
 * beginning constantly, like 5–10 times a second."
 *
 * The flicker had two halves and this file measures the second one, because it
 * is the half that was real even in a silent room.
 *
 * Every state delivery — a peer's snapshot, a routine `persistRemote` save, the
 * other CAM browser writing the shared document — used to DESTROY the hub's
 * compositor and build a new one. `HomeView` derived the halo's panel from
 * `state.render`, `resolveState` rebuilt `state.render` from scratch on every
 * resolve, and `EditorCanvas` keyed the `LayerHost`'s whole lifetime on that
 * panel object's identity. So a delivery that changed nothing about the
 * geometry still unmounted every layer, replaced the effect canvas, took out a
 * fresh WebGL context and reset `uTime` to zero. Measured on the reported
 * build: ten inbound documents, ten canvas teardowns.
 *
 * The assertion is on ELEMENT IDENTITY, not on presence, because a canvas that
 * is destroyed and rebuilt fifty times a second is attached every single time
 * you look at it. What is pinned here:
 *
 *  - nothing removes a `<canvas>` from the page while the document is written
 *    over and over;
 *  - the very canvas that was on screen at the start is the one still on screen
 *    at the end;
 *  - and the writes genuinely LANDED, so this is quiescence rather than a page
 *    that stopped listening.
 *
 * The writes here are real changes, not repeats: `render.background` moves on
 * every one of them. A no-op write is caught upstream by the store's value gate
 * (`src/state/store.ts`), and a test that only wrote no-ops would pass on a
 * build where the compositor still tears itself down for every genuine edit.
 */

const STATE_KEY = 'kraken-hub:v1:state';

/** CAM's real configuration window — wide enough that Home mounts the editor mirror. */
const CAM = { width: 866, height: 537 } as const;

/** Ten deliveries: the investigator's count, and about one second of the real fault. */
const WRITES = 10;

/** Two backgrounds, alternated, so no write is a repeat of the one before it. */
const COLOURS = ['rgb(18, 52, 86)', 'rgb(86, 52, 18)'] as const;

/**
 * The shared document, written the way the OTHER browser on this origin writes
 * it: straight into localStorage, which is the sanctioned config→display
 * channel (see `storage-sync.spec.ts`).
 */
async function writeDocument(page: Page, background: string): Promise<void> {
  await page.evaluate(
    ([key, value]) => {
      const raw = localStorage.getItem(key);
      const state: Record<string, unknown> =
        raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
      const render = (state['render'] ?? {}) as Record<string, unknown>;
      localStorage.setItem(
        key,
        JSON.stringify({
          ...state,
          schema: state['schema'] ?? 1,
          rev: typeof state['rev'] === 'number' ? state['rev'] + 1 : 1,
          updatedAt: Date.now(),
          writerId: 'e2e-mirror-writer',
          writerRole: 'config',
          activeModuleId: state['activeModuleId'] ?? 'effect',
          render: { ...render, background: value },
        }),
      );
    },
    [STATE_KEY, background] as const,
  );
}

/**
 * Watch the whole page for canvases leaving it, and remember the one that is
 * there now.
 *
 * `subtree` on `document.body` rather than a locator: a teardown removes the
 * host element the canvas lives inside, so a narrower observer would see the
 * container go and never count the canvas at all.
 */
async function watchCanvases(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __mirror?: { removals: number; original: Element | null };
    };
    const state = { removals: 0, original: document.querySelector('.kh-effect__canvas') };
    w.__mirror = state;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.tagName === 'CANVAS') state.removals += 1;
          state.removals += node.querySelectorAll('canvas').length;
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
}

async function readWatch(page: Page): Promise<{ removals: number; sameCanvas: boolean }> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __mirror?: { removals: number; original: Element | null };
    };
    const state = w.__mirror;
    if (state === undefined) return { removals: -1, sameCanvas: false };
    const now = document.querySelector('.kh-effect__canvas');
    return {
      removals: state.removals,
      sameCanvas: state.original !== null && state.original === now && state.original.isConnected,
    };
  });
}

test('a document written ten times never rebuilds the halo', async ({ context }) => {
  const config = await context.newPage();
  await config.setViewportSize(CAM);
  await config.addInitScript(
    ([key, seeded]) => {
      localStorage.setItem('kraken-hub:v1:config:displaySeen', '1');
      localStorage.setItem(key, seeded);
    },
    [
      STATE_KEY,
      JSON.stringify({
        schema: 4,
        rev: 1,
        updatedAt: Date.now(),
        writerId: 'e2e',
        writerRole: 'config',
        activeModuleId: 'effect',
        modules: { effect: { v: 1, cfg: { effect: 'voronoi' } } },
      }),
    ] as const,
  );

  await config.goto('/#/');
  await expect(config.getByTestId('mirror')).toBeVisible();
  // Attached rather than painted: whether the fragment program compiles is the
  // runner's GL's business, and this test is about the element's LIFETIME.
  await expect(config.locator('.kh-effect__canvas')).toBeAttached({ timeout: 15_000 });
  // Let the first mount settle, so the count below is steady-state only.
  await config.waitForTimeout(1000);

  await watchCanvases(config);

  const writer = await context.newPage();
  await writer.goto('/#/');
  await expect(writer.locator('.kh-app')).toBeVisible();

  /*
   * A display, as the WITNESS that the writes are being delivered.
   *
   * "Nothing was rebuilt" is worthless if it turns out nothing arrived, and the
   * config page's Home does not put `render.background` on screen anywhere. The
   * display does — it is the assertion `storage-sync.spec.ts` is built on — and
   * it rides the same localStorage bus on the same origin as the mirror under
   * test, so a colour that reaches it reached the config page too.
   *
   * `&module=clock` so the witness does not itself run the effect module. A
   * second live WebGL context in the same browser is a real way to lose the
   * first one, and a canvas the DRIVER killed is not the defect this file is
   * about — the module's own recovery would replace it and the count would
   * measure the runner's GPU budget instead of the compositor's lifetime. The
   * URL layer outranks the document, so the witness still reads every
   * `render.background` the writer commits.
   */
  const display = await context.newPage();
  await display.goto('/?kraken=1&sim=elite&module=clock');
  await expect(display.locator('.kh-stage')).toBeVisible();

  for (let i = 0; i < WRITES; i += 1) {
    await writeDocument(writer, COLOURS[i % COLOURS.length] as string);
    await config.waitForTimeout(150);
  }

  const last = COLOURS[(WRITES - 1) % COLOURS.length] as string;
  await expect(display.locator('.kh-stage')).toHaveCSS('background-color', last, {
    timeout: 5000,
  });

  const watch = await readWatch(config);
  expect(watch.removals, 'the compositor was torn down and rebuilt').toBe(0);
  expect(watch.sameCanvas, 'the canvas on screen is not the one that started there').toBe(true);
});
