import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * "Clicking on stuff on the PC doesn't change anything; only my phone changes
 * the live display."
 *
 * The one room every earlier spec was missing. `storage-sync.spec.ts` runs a
 * config page and a display with NO room at all, and `state-precedence.spec.ts`
 * gives both pages a room but puts the config page on `#/`, where nothing
 * mounts a sync layer — so in neither of them does the display ever fold an
 * inbound STATE frame. Both therefore measure the case that works.
 *
 * This one adds the third seat CAM's owner actually has: a phone on `#/remote`,
 * which is a page that DOES publish state. One inbound frame is enough to give
 * the display a register for every leaf of the synced body, and from that
 * instant the register table masked the persisted document unconditionally —
 * so CAM's configuration window, which reaches the LCD only through that shared
 * document, went silent, and the display's own `persistRemote` write then
 * erased CAM's value from storage as well.
 *
 * ONE browser context throughout, because that is what CAM is: two Chromium
 * browsers on one origin, sharing one localStorage. (`?transport=fake` is
 * backed by that same localStorage, which is also why the phone has to live in
 * the same context here; that a genuinely isolated phone learns CAM's change is
 * pinned in `src/sync/roomHarness.ts`'s suites instead.)
 */

const STATE_KEY = 'kraken-hub:v1:state';
const ROOM = 'CAM0HME9';

/** Longer than the display's 2 s `persistRemote` throttle and the 1 s poll. */
const HOLD_MS = 4000;

function displayUrl(): string {
  return `/?kraken=1&sim=elite&room=${ROOM}&transport=fake`;
}

function peerUrl(): string {
  return `/?room=${ROOM}&transport=fake#/remote`;
}

async function storedModule(page: Page): Promise<string | null> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const doc = JSON.parse(raw) as { activeModuleId?: string };
    return doc.activeModuleId ?? null;
  }, STATE_KEY);
}

/** The look, as the kinds on the panel in z-order — the shape the editor edits. */
async function storedKinds(page: Page): Promise<string | null> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const doc = JSON.parse(raw) as { look?: { layers?: { kind?: string }[] } };
    return (doc.look?.layers ?? []).map((l) => l.kind ?? '?').join(',');
  }, STATE_KEY);
}

/** The same reading off the display's own DOM — one `.kh-layer` per layer. */
async function shownKinds(page: Page): Promise<string> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.kh-layer')]
      .map((el) => (el as HTMLElement).dataset['kind'] ?? '?')
      .join(','),
  );
}

/** `rail-add` → the add sheet → one tile, which is how a person adds an overlay. */
async function addLayer(page: Page, kind: string): Promise<void> {
  await page.getByTestId('rail-add').click();
  await expect(page.getByTestId('add-sheet')).toBeVisible();
  await page.getByTestId(`add-tile-${kind}`).click();
  await expect(page.getByTestId('add-sheet')).toHaveCount(0);
}

async function storedFit(page: Page): Promise<string | null> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const doc = JSON.parse(raw) as {
      modules?: Record<string, { cfg?: { render?: { fit?: string } } }>;
    };
    return doc.modules?.['video']?.cfg?.render?.fit ?? null;
  }, STATE_KEY);
}

async function storedBackground(page: Page): Promise<string | null> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const doc = JSON.parse(raw) as { render?: { background?: string } };
    return doc.render?.background ?? null;
  }, STATE_KEY);
}

/**
 * A raw document write, exactly as `storage-sync.spec.ts` makes one.
 *
 * `render.background` is chosen because it is a leaf that SURVIVES the 8 kB
 * envelope trim — the module bank does not, which is why a module-config change
 * was never masked and a module switch always was.
 */
async function writeBackground(page: Page, hex: string): Promise<void> {
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
          rev: typeof state['rev'] === 'number' ? state['rev'] + 1 : 1,
          updatedAt: Date.now(),
          writerId: 'e2e-cam-config',
          writerRole: 'config',
          /*
           * A person clicked something. The display adopts a DECISION written
           * by the other browser on this origin and pointedly not a
           * `persistRemote` transcription, which is what a document with no
           * `writerOrigin` (or `'sync'`) is taken to be — see
           * `AppState.writerOrigin`.
           */
          writerOrigin: 'local',
          render: { ...render, background: value },
        }),
      );
    },
    [STATE_KEY, hex] as const,
  );
}

/**
 * Has this page's sync layer folded an inbound frame yet?
 *
 * `StoredClock.heard` in the per-role clock slot, which is the flag the intent
 * layer arms itself on: false until the first frame of any kind arrives, and
 * written down on the spot. So it answers "is this page's transport up and is
 * the room reaching it", with no stopwatch involved.
 */
async function clockHeard(page: Page, role: 'display' | 'config' | 'remote'): Promise<boolean> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (raw === null) return false;
    return (JSON.parse(raw) as { heard?: boolean }).heard === true;
  }, `kraken-hub:v1:sync-clock:${role}`);
}

/** How many browsers the display has folded a STATE frame from — its readout. */
async function peersHeard(display: Page): Promise<number> {
  const raw = await display.locator('html').getAttribute('data-kh-sync');
  if (raw === null) return 0;
  const readout = JSON.parse(raw) as { peers?: number };
  return readout.peers ?? 0;
}

/** Asserts a value HOLDS rather than merely being true once: the bug was a revert. */
async function holdsFor(read: () => Promise<string | null>, expected: string): Promise<void> {
  const deadline = Date.now() + HOLD_MS;
  while (Date.now() < deadline) {
    expect(await read()).toBe(expected);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

/**
 * A display, and a peer that publishes state into the same room.
 *
 * The FOLD is the whole point of the fixture: it does not return until the
 * display has taken the remote's announce, which is what used to arm the mask.
 */
async function roomWithAPhone(context: BrowserContext): Promise<{ display: Page; peer: Page }> {
  const display = await context.newPage();
  await display.goto(displayUrl());
  await expect(display.locator('.kh-stage')).toBeVisible();

  const peer = await context.newPage();
  await peer.goto(peerUrl());
  await expect(peer.locator('.kh-app')).toBeVisible();
  // The handshake, the remote's immediate announce and the display's fold of
  // it — asked as a fact rather than waited out, because the fold is what arms
  // the mask this whole page is about. `peers` counts the browsers the display
  // has heard state from; the phone is the first of them.
  await expect.poll(() => peersHeard(display), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);

  return { display, peer };
}

test.describe("CAM's configuration window, after a phone has joined the room", () => {
  test('an unpaired CAM Home still moves the display, and is not rolled back', async ({
    context,
  }: {
    context: BrowserContext;
  }) => {
    const { display } = await roomWithAPhone(context);

    // CAM's configuration browser: no room of its own, exactly as it ships.
    // Its only channel to the LCD is the shared document.
    const config = await context.newPage();
    await config.goto('/?cam=1#/');
    await expect(config.getByTestId('module-chip-clock')).toBeVisible();

    await config.getByTestId('module-chip-clock').click();

    await expect
      .poll(async () => display.locator('[data-module]').getAttribute('data-module'), {
        timeout: 2000,
      })
      .toBe('clock');

    // …and the display's own `persistRemote` write does not put `video` back.
    await holdsFor(async () => storedModule(config), 'clock');
    await expect(config.getByTestId('module-chip-clock')).toHaveAttribute('aria-pressed', 'true');
  });

  test('a paired CAM Home still moves the display, and is not rolled back', async ({
    context,
  }: {
    context: BrowserContext;
  }) => {
    const { display } = await roomWithAPhone(context);

    // The same window, this time holding the room — the surface `useSync` was
    // never mounted on, because Home mounts no view that starts a sync layer.
    const config = await context.newPage();
    await config.goto(`/?cam=1&room=${ROOM}&transport=fake#/`);
    await expect(config.getByTestId('module-chip-clock')).toBeVisible();
    /*
     * PAIRED means paired, and it is asked rather than waited out.
     *
     * This page joins the room through a dynamic `import()` and a transport
     * handshake, and a click that lands inside that window is served by the
     * document channel instead — which is the OTHER test on this page. This
     * one is about the paired path, so it starts when the pairing is a fact:
     *
     *  1. the config page has FOLDED an inbound frame — `heard` in its own
     *     clock slot, which is the flag the intent layer itself trusts — so
     *     its transport is up and the room is reaching it; and
     *  2. the display has folded a frame FROM IT — `peers` on the display's
     *     `data-kh-sync` readout counts the browsers it has heard state from,
     *     and there are exactly two of them here: the phone and this page.
     *
     * A fixed millisecond wait was what stood here, and under a fully parallel
     * suite one second was not always a handshake.
     */
    await expect.poll(() => clockHeard(config, 'config'), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => peersHeard(display), { timeout: 20_000 }).toBe(2);

    await config.getByTestId('module-chip-clock').click();

    await expect
      .poll(async () => display.locator('[data-module]').getAttribute('data-module'), {
        timeout: 2000,
      })
      .toBe('clock');

    await holdsFor(async () => storedModule(config), 'clock');
  });

  test('an ordinary setting made on CAM Home survives too', async ({
    context,
  }: {
    context: BrowserContext;
  }) => {
    // The bug class is not about `activeModuleId`: every leaf of the synced
    // body was masked, so a fit change made in CAM was erased the same way.
    const { display } = await roomWithAPhone(context);

    const config = await context.newPage();
    await config.goto('/?cam=1#/module/video');
    const contain = config.getByTestId('ed-base-fill-contain');
    await expect(contain).toBeVisible();

    await contain.click();
    await expect(contain).toHaveAttribute('aria-checked', 'true');

    await holdsFor(async () => storedFit(config), 'contain');
    // The display is still the video module, i.e. the change was a setting on
    // the thing that is playing rather than a module switch.
    await expect(display.locator('[data-module]')).toHaveAttribute('data-module', 'video');
  });

  test('overlays added in the editor accumulate instead of replacing each other', async ({
    context,
  }: {
    context: BrowserContext;
  }) => {
    /*
     * ── The same defect, seen from the editor ────────────────────────────────
     *
     * Every add is a document write built on the look the editing page is
     * holding right now, and the editing page reads that look back out of the
     * shared document. So the display's routine two-second save, writing the
     * MASKED look — the one with no overlays — over CAM's write, did not merely
     * lose an overlay: it made the NEXT add start from a look that had lost it.
     * Measured on a pristine HEAD build, one origin, adds 1.5 s apart: the rail
     * dropped to zero overlays about 1.2 s after each commit and three adds
     * ended stored as `video,date` — each one replacing the last.
     */
    const { display } = await roomWithAPhone(context);

    const config = await context.newPage();
    // CAM's own window size, and the flag that puts the editor on Home.
    await config.setViewportSize({ width: 866, height: 537 });
    await config.addInitScript(() => {
      localStorage.setItem('kraken-hub:v1:config:displaySeen', '1');
    });
    await config.goto('/?cam=1#/');
    await expect(config.getByTestId('rail-add')).toBeVisible();

    await addLayer(config, 'clock');
    await config.waitForTimeout(2000);
    await addLayer(config, 'text');
    await config.waitForTimeout(2000);

    const want = 'video,clock,text';
    await expect.poll(async () => shownKinds(display), { timeout: 4000 }).toBe(want);
    await holdsFor(async () => storedKinds(config), want);
    // …and the rail the person is looking at still lists all three, which is
    // the reading that decides whether the NEXT add starts from the right look.
    await expect(config.locator('[data-testid^="layer-row-"]')).toHaveCount(3);
  });

  test('a document write from CAM reaches the display, and stays written', async ({
    context,
  }: {
    context: BrowserContext;
  }) => {
    const { display } = await roomWithAPhone(context);

    const config = await context.newPage();
    await config.goto('/?cam=1#/');
    await expect(config.locator('.kh-app')).toBeVisible();

    /*
     * TWO writes, and the second one is the test.
     *
     * An unstamped document write used to reach the display by accident: with
     * no arbitration left, `mergeInto` falls through to comparing the values
     * themselves as canonical JSON, so a colour that sorted ABOVE the one the
     * display held got through and one that sorted below did not. `#ffffff`
     * then `#123456` is one change in each direction, so the accident cannot
     * carry the test.
     */
    await writeBackground(config, '#ffffff');
    await expect(display.locator('.kh-stage')).toHaveCSS('background-color', 'rgb(255, 255, 255)', {
      timeout: 3000,
    });

    await writeBackground(config, '#123456');
    await expect(display.locator('.kh-stage')).toHaveCSS('background-color', 'rgb(18, 52, 86)', {
      timeout: 3000,
    });
    // And `persistRemote` does not put the old colour back underneath it.
    await holdsFor(async () => storedBackground(config), '#123456');
  });
});
