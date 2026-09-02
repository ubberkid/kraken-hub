import { expect, test, type Page } from '@playwright/test';

import { MAX_STRIP_CONTROLS } from '../../src/modules/stripContract';

/**
 * The editor's fidelity assertions — `docs/design/design-editor-ux.md` §11.
 *
 * Everything in that list which can only be measured in a real layout engine is
 * here; the rest (undo across ten random ops, snapping, placement, the strip
 * enumeration, the write path) is unit-tested, because a jsdom "layout" is a
 * fiction and a property test over 120 seeds is not something a browser should
 * be asked to run.
 *
 * ## The four this file exists for
 *
 *  1. **The halo is >= 400 px at 866x537.** Principle 1, and the number the
 *     whole two-column layout is built around. It cannot be asserted anywhere
 *     but here: jsdom reports zero for every box.
 *  2. **Handles are >= 24 px (44 on touch).** Same reason.
 *  3. **Page-fit across every editor state** — the enumeration
 *     `home-composition.spec.ts` makes for the module states, extended with the
 *     ones the editor adds: a selection, the add sheet, the inspector.
 *  4. **No native controls.** The rule round 2 set, applied to the surfaces this
 *     wave added.
 */

/** The CAM Configuration Browser, measured. Every assertion here is about it. */
const CAM = { width: 866, height: 537 } as const;

/** §2: "at 866x537 the halo is >= 400px". */
const MIN_HALO_PX = 400;

/** §2.1: all hit targets >= 24 px, 44 on touch. */
const MIN_HANDLE_PX = 24;

/** The steady state: a Kraken has connected, so the install band is gone. */
async function cam(page: Page): Promise<void> {
  await page.setViewportSize({ width: CAM.width, height: CAM.height });
  await page.addInitScript(() => {
    localStorage.setItem('kraken-hub:v1:config:displaySeen', '1');
  });
}

/** Wait for the composition to stop moving — the same instrument round 3 built. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const running = document.getAnimations().filter((a) => a.playState === 'running');
    await Promise.race([
      Promise.all(running.map(async (a) => a.finished.catch(() => undefined))),
      new Promise((resolve) => {
        setTimeout(resolve, 1500);
      }),
    ]);
  });
}

/**
 * The page's own overflow, and what any box inside it is hiding.
 *
 * Identical to `home-composition.spec.ts`'s metric, with ONE addition: a sheet's
 * body is allowed to scroll inside itself (§2.4/§9 ask for exactly that), the
 * same documented exemption `.kh-list--shelf` already has. Everything else is
 * held to the original rule: content that IS there, IS reachable, and is not on
 * the screen is a composition that hid rather than fitted.
 */
async function overflowOf(page: Page): Promise<{ overflow: number; clipped: number }> {
  await settle(page);
  return page.evaluate(() => {
    const doc = document.scrollingElement ?? document.documentElement;
    let clipped = 0;
    for (const el of document.querySelectorAll('.kh-home, .kh-home *')) {
      if (el.classList.contains('kh-list--shelf')) continue;
      if (el.classList.contains('kh-sheet__body')) continue;
      const overflow = getComputedStyle(el).overflowY;
      if (overflow !== 'auto' && overflow !== 'scroll') continue;
      clipped = Math.max(clipped, el.scrollHeight - el.clientHeight);
    }
    return { overflow: doc.scrollHeight - doc.clientHeight, clipped };
  });
}

async function addLayer(page: Page, kind: string): Promise<void> {
  await page.getByTestId('rail-add').click();
  await expect(page.getByTestId('add-sheet')).toBeVisible();
  await page.getByTestId(`add-tile-${kind}`).click();
  await expect(page.getByTestId('add-sheet')).toHaveCount(0);
}

// ---------------------------------------------------------------------------
// §11 — the canvas is the halo
// ---------------------------------------------------------------------------

test('the halo is at least 400 px at CAM’s window', async ({ page }) => {
  await cam(page);
  await page.goto('/');

  await expect(page.locator('.kh-home')).toHaveAttribute('data-editor', 'true');
  await settle(page);

  const size = await page.evaluate(() => {
    const r = document.querySelector('[data-testid="mirror"]')?.getBoundingClientRect();
    return r === undefined ? { w: 0, h: 0 } : { w: r.width, h: r.height };
  });
  expect(
    size.w,
    'the canvas is the halo, at the largest size the window allows',
  ).toBeGreaterThanOrEqual(MIN_HALO_PX);
  // Round: the two must agree, or the "halo" is an ellipse.
  expect(Math.abs(size.w - size.h)).toBeLessThanOrEqual(1);
});

test('a phone gets the remote, not half an editor', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem('kraken-hub:v1:config:displaySeen', '1');
  });
  await page.goto('/');
  await expect(page.locator('.kh-home')).toHaveAttribute('data-editor', 'false');
  await expect(page.getByTestId('layer-rail')).toHaveCount(0);
  // …and the composition it does get is the one it has always had.
  await expect(page.getByTestId('mirror')).toBeVisible();
  await expect(page.getByTestId('ops-strip')).toBeVisible();
});

// ---------------------------------------------------------------------------
// §11 — handles, and the strip
// ---------------------------------------------------------------------------

test('every selection handle is at least 24 px', async ({ page }) => {
  await cam(page);
  await page.goto('/');
  await addLayer(page, 'clock');

  await expect(page.getByTestId('editor-selection')).toBeVisible();
  const handles = ['scale-nw', 'scale-ne', 'scale-se', 'scale-sw', 'rotate'] as const;
  for (const handle of handles) {
    const box = await page.getByTestId(`editor-handle-${handle}`).boundingBox();
    expect(box, `${handle} has no box at all`).not.toBeNull();
    expect(box?.width ?? 0, `${handle} is under the floor`).toBeGreaterThanOrEqual(MIN_HANDLE_PX);
    expect(box?.height ?? 0, `${handle} is under the floor`).toBeGreaterThanOrEqual(MIN_HANDLE_PX);
  }
});

test('the strip shows at most five controls, and More is the last', async ({ page }) => {
  await cam(page);
  await page.goto('/');

  // Once per base kind, and once for an overlay — the strip changes with the
  // SELECTION and with nothing else (principle 3).
  /*
   * Every kind that can be a BASE has a chip, and the chip row is the base
   * picker (§2.2). Enumerated rather than discovered, so a kind that quietly
   * stopped offering a strip is a failure rather than a skipped loop.
   */
  for (const kind of ['video', 'clock', 'stats', 'image', 'effect', 'shape'] as const) {
    const chip = page.getByTestId(`module-chip-${kind}`);
    await expect(chip).toBeVisible();
    await chip.click();
    const controls = page.locator('[data-testid="ops-strip"] .kh-op');
    await expect(controls).not.toHaveCount(0);
    expect(await controls.count()).toBeLessThanOrEqual(MAX_STRIP_CONTROLS);
    await expect(page.getByTestId('ops-more')).toBeVisible();
  }
});

test('selecting a layer changes the strip and nothing else', async ({ page }) => {
  await cam(page);
  await page.goto('/');

  const railBefore = await page.getByTestId('layer-rail').boundingBox();
  const haloBefore = await page.getByTestId('mirror').boundingBox();

  await addLayer(page, 'text');
  await expect(page.locator('[data-testid="ops-strip"]')).toHaveAttribute(
    'data-strip-kind',
    'text',
  );

  const haloAfter = await page.getByTestId('mirror').boundingBox();
  expect(haloAfter?.width).toBe(haloBefore?.width);
  expect((await page.getByTestId('layer-rail').boundingBox())?.width).toBe(railBefore?.width);
});

// ---------------------------------------------------------------------------
// §11 — page-fit, across the editor's own states
// ---------------------------------------------------------------------------

test('the page fits at 866×537 in every editor state', async ({ page }) => {
  await cam(page);
  await page.goto('/');

  // 1. At rest.
  expect((await overflowOf(page)).overflow, 'at rest').toBe(0);

  // 2. With a layer selected — the state the whole surface is for.
  await addLayer(page, 'clock');
  const selected = await overflowOf(page);
  expect(selected.overflow, 'with a layer selected').toBe(0);
  expect(selected.clipped, 'with a layer selected').toBe(0);

  // 3. With the add sheet open. The sheet may scroll INSIDE itself (§2.4); the
  //    page may not, and every tile has to be reachable.
  await page.getByTestId('rail-add').click();
  await expect(page.getByTestId('add-sheet')).toBeVisible();
  expect((await overflowOf(page)).overflow, 'with the add sheet open').toBe(0);
  await expect(page.getByTestId('add-group-audio')).toBeVisible();
  await page.getByTestId('add-sheet-close').click();

  /*
   * 4. With the inspector open (§2.4).
   *
   * `More` used to open the home screen's module options panel — the same
   * 621 px wall every strip action opened, which is why Effect's "Effect" and
   * "Preset" were two buttons that did one thing. It opens the INSPECTOR now:
   * a sheet in the rail's column, like the add sheet, with its body the thing
   * that scrolls. The halo therefore does not yield the floor for it, which is
   * the difference the assertion below is really about.
   */
  const halo = (await page.getByTestId('mirror').boundingBox())?.width ?? 0;
  await page.getByTestId('ops-more').click();
  await expect(page.getByTestId('inspector-sheet')).toBeVisible();
  const inspector = await overflowOf(page);
  expect(inspector.overflow, 'with the inspector open').toBe(0);
  expect(inspector.clipped, 'with the inspector open').toBe(0);
  expect(
    (await page.getByTestId('mirror').boundingBox())?.width,
    'the inspector opens beside the canvas, not on top of it',
  ).toBe(halo);

  // Escape closes it, from anywhere on the page.
  await page.locator('body').press('Escape');
  await expect(page.getByTestId('inspector-sheet')).toHaveCount(0);
});

/**
 * …and it fits with a FULL look on it — round 10's F2.
 *
 * The state above adds one layer. The rail had no scroller of its own, so every
 * row past the fourth made the page taller: measured at 866×537, page overflow
 * went 0, 0, 0, 0, 8, 48, 88, 128 px as layers one to eight went on, and at
 * eight the BASE row — which is also the module chip row, the app's oldest
 * gesture — had its bottom edge at y = 569 in a 537 px window.
 *
 * Two assertions, because the fix is not "hide the rows": the page does not
 * grow, AND the four things that are not the list stay on the screen.
 */
test('the page fits at 866×537 with the look full', async ({ page }) => {
  await cam(page);
  await page.goto('/');

  // Seven overlays over the base is `MAX_LAYERS`. Every kind here is
  // overlay-capable, so none of them is refused for a reason other than the cap.
  for (const kind of ['text', 'shape', 'icon', 'date', 'stats', 'clock', 'image']) {
    await addLayer(page, kind);
  }
  await expect(page.getByTestId('rail-add')).toBeDisabled();

  expect((await overflowOf(page)).overflow, 'with eight layers on the look').toBe(0);

  const onScreen = async (testId: string): Promise<boolean> =>
    page.evaluate((id) => {
      const r = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
      return r !== undefined && r.top >= -1 && r.bottom <= window.innerHeight + 1;
    }, testId);

  expect(await onScreen('layer-row-base'), 'the base row survives a full look').toBe(true);
  expect(await onScreen('rail-add'), 'the add button survives a full look').toBe(true);
  expect(await onScreen('paste-input'), 'the primary action survives a full look').toBe(true);

  // The list is the one box that scrolls, and it IS scrolling — otherwise the
  // page fitting would only mean the rows had been thrown away.
  const list = await page.evaluate(() => {
    const el = document.querySelector('.kh-rail__list');
    return el === null
      ? null
      : { scrolls: el.scrollHeight > el.clientHeight, overflowY: getComputedStyle(el).overflowY };
  });
  expect(list?.overflowY).toBe('auto');
  expect(list?.scrolls, 'the rows are there, inside a scroller').toBe(true);
});

/**
 * The cap is visible before it bites, and says why when it does — F4.
 *
 * It was a disabled button and a native `title`, which is the exact ESC failure
 * `research-esc-ux.md` §127 names: the limit is invisible until you hit it and
 * then it is announced by a tooltip a touch screen never shows. Two sentences
 * in the rail, and never both.
 */
test('the layer cap is visible before it is reached', async ({ page }) => {
  await cam(page);
  await page.goto('/');

  // Nothing to say while there is room to spare.
  await expect(page.getByTestId('rail-cap')).toHaveCount(0);

  for (const kind of ['text', 'shape', 'icon', 'date', 'stats', 'clock']) {
    await addLayer(page, kind);
  }
  // Seven of eight: the count appears while a decision can still be made.
  await expect(page.getByTestId('rail-cap')).toHaveText('7 of 8 layers');
  await expect(page.getByTestId('rail-add')).toBeEnabled();

  await addLayer(page, 'image');
  await expect(page.getByTestId('rail-cap')).toContainText('This look is full');
  await expect(page.getByTestId('rail-cap')).toContainText('eight layers');
  await expect(page.getByTestId('rail-add')).toBeDisabled();
  // The reason is on the page, not in a tooltip nobody on a touch screen sees.
  await expect(page.getByTestId('rail-add')).not.toHaveAttribute('title', /./);
});

/** §2.2: a rail row is 40 px — round 10's M6 measured 36. */
test('a rail row is at least 40 px tall', async ({ page }) => {
  await cam(page);
  await page.goto('/');
  await addLayer(page, 'clock');

  const heights = await page.evaluate(() =>
    [...document.querySelectorAll('.kh-rail__row')].map((e) => e.getBoundingClientRect().height),
  );
  expect(heights.length).toBeGreaterThan(0);
  for (const h of heights) expect(h).toBeGreaterThanOrEqual(40);
});

/**
 * A locked layer is still SELECTABLE, and the strip says why it is grey — M5.
 *
 * Refusing the selection would put a layer's own inspector — the only place its
 * lock can be undone from, other than the rail's own button — behind its own
 * lock. Selection is not a transform.
 */
test('a locked layer can still be selected, and says why it cannot be moved', async ({ page }) => {
  await cam(page);
  await page.goto('/');
  await addLayer(page, 'text');

  const id = await page.evaluate(
    () =>
      document
        .querySelector('[data-testid^="layer-row-"]')
        ?.getAttribute('data-testid')
        ?.replace('layer-row-', '') ?? '',
  );
  expect(id).not.toBe('');

  await page.getByTestId(`layer-lock-${id}`).click();
  /*
   * Selecting the base also opens the background picker over the rail now
   * (F12-2 — `BASE` is a disclosure), so the sheet is closed again before the
   * next press, which is a press on a row underneath it.
   */
  await page.getByTestId('layer-select-base').click();
  await page.getByTestId('add-sheet-close').click();
  await page.locator(`[data-testid="layer-row-${id}"] .kh-rail__pick`).click();

  await expect(page.locator(`[data-testid="layer-row-${id}"]`)).toHaveAttribute(
    'data-selected',
    'true',
  );
  await expect(page.getByTestId('ops-lock-reason')).toBeVisible();
  // …and the inspector is reachable, which is the point of allowing it.
  await page.getByTestId('ops-more').click();
  await expect(page.getByTestId('inspector-sheet')).toBeVisible();
});

/**
 * The drag HUD is in the reader's units — round 10's M1.
 *
 * It printed `0.04, −0.68`: the model's diameters, which is what the look file
 * and every clamp speak and what nobody is thinking in while they place a layer.
 */
test('the drag HUD reads in pixels, per cent and degrees', async ({ page }) => {
  await cam(page);
  await page.goto('/');
  await addLayer(page, 'text');

  const box = await page.getByTestId('editor-selection').boundingBox();
  expect(box).not.toBeNull();
  const cx = (box?.x ?? 0) + (box?.width ?? 0) / 2;
  const cy = (box?.y ?? 0) + (box?.height ?? 0) / 2;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 30, cy - 40, { steps: 8 });

  const hud = await page.getByTestId('editor-hud').textContent();
  await page.mouse.up();

  /*
   * `x <int> · y <int> · <int>% · <int>°` — no bare fractions anywhere in it,
   * and the sign in front of a negative is U+2212 rather than a hyphen (round
   * 11's M-f). The readout is set in tabular figures; a hyphen among them is
   * the wrong glyph, and the class of bug that only a character check catches.
   */
  expect(hud ?? '').toMatch(/^x −?\d+ · y −?\d+ · \d+% · −?\d+°$/);
  expect(hud ?? '', 'the HUD must not print an ASCII hyphen as a minus').not.toContain('-');
});

// ---------------------------------------------------------------------------
// §2.1 — the overlay follows the finger, and agrees with the layer after it
// ---------------------------------------------------------------------------

/**
 * The audit's F3, and the desync the stats round found downstream of it.
 *
 * Two separate failures with one cause. DURING a drag the box and the five
 * handles did not move at all — the overlay is drawn from the committed layer,
 * and the commit is deliberately at release — so the cursor travelled −90, −90
 * and every handle centre travelled 0, 0. AFTER a drag that ended on a snap,
 * the box stayed where the drag had left it while the layer moved to the guide,
 * so the outline sat in the upper third of a panel whose text was centred.
 *
 * One assertion for each half: the handle follows the pointer within a pixel,
 * and once the gesture is over the box agrees with `layerBounds()` of what was
 * actually committed.
 */
test('the selection follows the finger, and agrees with the layer after the drop', async ({
  page,
}) => {
  await cam(page);
  await page.goto('/');
  await addLayer(page, 'clock');
  await expect(page.getByTestId('editor-selection')).toBeVisible();

  const centreOfLayer = async (): Promise<{ x: number; y: number }> =>
    page.evaluate(() => {
      const r = document
        .querySelector('.kh-ed-stage .kh-layer[data-role="overlay"]')
        ?.getBoundingClientRect();
      return r === undefined ? { x: 0, y: 0 } : { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
  const centreOfBox = async (): Promise<{ x: number; y: number }> =>
    page.evaluate(() => {
      const r = document.querySelector('.kh-ed-sel .kh-ed-box')?.getBoundingClientRect();
      return r === undefined ? { x: 0, y: 0 } : { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });

  const handle = page.getByTestId('editor-handle-scale-nw');
  const before = await handle.boundingBox();
  const from = await centreOfLayer();

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x - 40, from.y - 40, { steps: 4 });
  const during = await handle.boundingBox();
  await page.mouse.up();
  await settle(page);

  // Half one: the handle went where the pointer went, while the pointer was
  // still down. One pixel of slack for the snap the gesture may apply.
  expect((during?.x ?? 0) - (before?.x ?? 0), 'the handle did not follow the pointer').toBeCloseTo(
    -40,
    0,
  );
  expect((during?.y ?? 0) - (before?.y ?? 0), 'the handle did not follow the pointer').toBeCloseTo(
    -40,
    0,
  );

  // Half two: after the drop the outline is on the layer, not where the drag
  // happened to end.
  const box = await centreOfBox();
  const layer = await centreOfLayer();
  expect(Math.abs(box.x - layer.x), 'the box drifted from the layer after the drop').toBeLessThan(
    1,
  );
  expect(Math.abs(box.y - layer.y), 'the box drifted from the layer after the drop').toBeLessThan(
    1,
  );
});

// ---------------------------------------------------------------------------
// §2.1 — several layers at once
// ---------------------------------------------------------------------------

/**
 * F7: ⌘A, a marquee and a shift-tap all marked rail rows and then left the
 * canvas showing nothing and offering nothing.
 */
test('a multi selection has boxes on the canvas and group operations on the strip', async ({
  page,
}) => {
  await cam(page);
  await page.goto('/');
  await addLayer(page, 'clock');
  await addLayer(page, 'text');

  await page.locator('body').press('ControlOrMeta+a');
  await expect(page.getByTestId('editor-selection-group')).toBeVisible();
  await expect(page.locator('.kh-ed-box--member')).toHaveCount(2);
  await expect(page.getByTestId('editor-group-box')).toBeVisible();

  // …and the strip is about the SELECTION, not about the background.
  await expect(page.getByTestId('ops-align')).toBeVisible();
  await expect(page.getByTestId('ops-distribute-x')).toBeDisabled(); // needs three

  const lefts = async (): Promise<number[]> =>
    page.evaluate(() =>
      [...document.querySelectorAll('.kh-ed-stage .kh-layer[data-role="overlay"]')].map(
        (el) => el.getBoundingClientRect().left,
      ),
    );
  await page.getByTestId('ops-align-left').click();
  await settle(page);
  const after = await lefts();
  expect(
    Math.abs((after[0] ?? 0) - (after[1] ?? 1000)),
    'align left left them unaligned',
  ).toBeLessThan(1.5);

  // One gesture, one entry: a single undo puts both back.
  await page.getByTestId('undo').click();
  await settle(page);
  const back = await lefts();
  expect(
    Math.abs((back[0] ?? 0) - (back[1] ?? 0)),
    'undo did not restore both layers',
  ).toBeGreaterThan(1.5);
});

// ---------------------------------------------------------------------------
// §2.2 — the lock
// ---------------------------------------------------------------------------

test('a locked layer cannot be dragged, and Escape puts the selection down', async ({ page }) => {
  await cam(page);
  await page.goto('/');
  await addLayer(page, 'clock');

  const row = page.locator('[data-testid="layer-rail"] .kh-rail__row').first();
  const id = ((await row.getAttribute('data-testid')) ?? '').replace('layer-row-', '');
  const centre = async (): Promise<{ x: number; y: number }> =>
    page.evaluate(() => {
      const r = document
        .querySelector('.kh-ed-stage .kh-layer[data-role="overlay"]')
        ?.getBoundingClientRect();
      return r === undefined ? { x: 0, y: 0 } : { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });

  await page.getByTestId(`layer-lock-${id}`).click();
  await expect(page.getByTestId(`layer-lock-${id}`)).toHaveAttribute('aria-pressed', 'true');

  const from = await centre();
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x - 60, from.y - 60, { steps: 4 });
  await page.mouse.up();
  await settle(page);
  const to = await centre();
  expect(Math.abs(to.x - from.x), 'a locked layer moved').toBeLessThan(1);
  expect(Math.abs(to.y - from.y), 'a locked layer moved').toBeLessThan(1);

  // …and Escape deselects, which it did not do at all before round 10 (F8).
  await page.getByTestId(`layer-lock-${id}`).click();
  await row.locator('.kh-rail__pick').click();
  await expect(page.getByTestId('editor-selection')).toBeVisible();
  await page.locator('body').press('Escape');
  await expect(page.getByTestId('editor-selection')).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// §7 — nothing on this screen is a hard cut
// ---------------------------------------------------------------------------

test('adding, removing and switching the base all animate', async ({ page }) => {
  await cam(page);
  await page.goto('/');

  await page.getByTestId('rail-add').click();
  await page.getByTestId('add-tile-clock').click();
  expect(
    await page.evaluate(() => document.getAnimations().length),
    'a layer arrived with no animation at all',
  ).toBeGreaterThan(0);

  await settle(page);
  const row = page.locator('[data-testid="layer-rail"] .kh-rail__row').first();
  const id = ((await row.getAttribute('data-testid')) ?? '').replace('layer-row-', '');
  await page.getByTestId(`layer-remove-${id}`).click();
  expect(
    await page.evaluate(() => document.getAnimations().length),
    'a layer left with no animation at all',
  ).toBeGreaterThan(0);

  await settle(page);
  await page.getByTestId('module-chip-clock').click();
  expect(
    await page.evaluate(() => document.getAnimations().length),
    'the base switched with no cross-fade',
  ).toBeGreaterThan(0);
});

test('every kind in the add sheet is reachable at CAM size', async ({ page }) => {
  await cam(page);
  await page.goto('/');
  await page.getByTestId('rail-add').click();

  const tiles = page.locator('[data-testid="add-sheet"] .kh-tile');
  const count = await tiles.count();
  expect(count).toBeGreaterThan(4);
  for (let i = 0; i < count; i++) {
    await tiles.nth(i).scrollIntoViewIfNeeded();
    await expect(tiles.nth(i)).toBeVisible();
  }
  // The audio group is present and says why it is off, rather than being hidden.
  await expect(page.getByTestId('add-tile-visualizer')).toBeDisabled();
  await expect(page.getByTestId('add-group-audio')).toContainText('audio companion');
});

// ---------------------------------------------------------------------------
// Undo, the rail, the budget meter
// ---------------------------------------------------------------------------

test('undo walks back an add, and redo walks forward again', async ({ page }) => {
  await cam(page);
  await page.goto('/');

  const rows = page.locator('[data-testid="layer-rail"] .kh-rail__row');
  const before = await rows.count();

  await addLayer(page, 'clock');
  await expect(rows).toHaveCount(before + 1);

  await page.getByTestId('undo').click();
  await expect(rows).toHaveCount(before);

  await page.getByTestId('redo').click();
  await expect(rows).toHaveCount(before + 1);
});

test('the keyboard undoes from anywhere on the page', async ({ page }) => {
  await cam(page);
  await page.goto('/');

  const rows = page.locator('[data-testid="layer-rail"] .kh-rail__row');
  const before = await rows.count();
  await addLayer(page, 'shape');
  await expect(rows).toHaveCount(before + 1);

  await page.locator('body').press('ControlOrMeta+z');
  await expect(rows).toHaveCount(before);
});

test('the budget meter says whether it is reading or estimating', async ({ page }) => {
  await cam(page);
  await page.goto('/');

  const meter = page.getByTestId('budget-meter');
  await expect(meter).toBeVisible();
  // With no display on the other end there is no frame rate to report, so the
  // meter is an ESTIMATE and says so — §7.2, through the claims spine.
  await expect(meter).toHaveAttribute('data-estimated', 'true');
  await expect(meter).toHaveAttribute('data-verdict', /calm|busy|rich/);
});

test('a new layer never lands on top of the one before it', async ({ page }) => {
  await cam(page);
  await page.goto('/');

  await addLayer(page, 'clock');
  await addLayer(page, 'text');

  const overlap = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.kh-ed-stage .kh-layer[data-role="overlay"]')].map(
      (el) => el.getBoundingClientRect(),
    );
    if (boxes.length !== 2) return { count: boxes.length, overlaps: true };
    const [a, b] = boxes as [DOMRect, DOMRect];
    return {
      count: boxes.length,
      overlaps: a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom,
    };
  });
  expect(overlap.count).toBe(2);
  expect(overlap.overlaps, 'smart placement put the second layer on top of the first').toBe(false);
});

// ---------------------------------------------------------------------------
// The house rules the editor inherits
// ---------------------------------------------------------------------------

test('the editor ships no native checkbox and no native select', async ({ page }) => {
  await cam(page);
  await page.goto('/');
  await addLayer(page, 'stats');
  await page.getByTestId('rail-add').click();

  const natives = await page.evaluate(
    () => document.querySelectorAll('.kh-home select, .kh-home input[type="checkbox"]').length,
  );
  expect(natives).toBe(0);
});

test('the editor never says element, z-index, shader or compositor', async ({ page }) => {
  await cam(page);
  await page.goto('/');
  await page.getByTestId('rail-add').click();
  await page.getByTestId('looks-menu').click();

  const text = (await page.locator('.kh-home').innerText()).toLowerCase();
  for (const banned of ['element', 'z-index', 'shader', 'compositor', 'uniform']) {
    expect(text, `the editor said "${banned}"`).not.toContain(banned);
  }
});

// ---------------------------------------------------------------------------
// Round 11 — the editor's chrome, measured at CAM's window
// ---------------------------------------------------------------------------

/**
 * The rail is a STACK, not a porthole — round 11's F-2.
 *
 * The rail's column holds five things and only one of them grows: the row list.
 * Everything under it — the base row with the module chips, the paste field,
 * the nav and the status line — lays out first at its natural height, and the
 * list gets the remainder. Measured at 866x537 with seven overlays on the
 * panel, that block came to 286 px of a 380 px column and the list's own
 * `clientHeight` was 47: one row of seven, on the surface whose entire purpose
 * is showing the stack.
 *
 * The chip row is what it was spent on — nine chips wrapping four deep in a
 * 268 px column — so at CAM's height it becomes one row that scrolls sideways,
 * the same bargain the selection strip makes. Measured after: 200 px and four
 * whole rows.
 */
test('the rail shows at least four whole layer rows at CAM’s window', async ({ page }) => {
  await cam(page);
  await page.goto('/');
  for (const kind of ['stats', 'text', 'icon', 'date', 'shape', 'clock', 'effect']) {
    await addLayer(page, kind);
  }
  await settle(page);

  const rail = await page.evaluate(() => {
    const list = document.querySelector('.kh-rail__list');
    if (list === null) return null;
    const box = list.getBoundingClientRect();
    const rows = [...document.querySelectorAll('.kh-rail__row')];
    return {
      clientH: list.clientHeight,
      rows: rows.length,
      whole: rows.filter((row) => {
        const r = row.getBoundingClientRect();
        return r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
      }).length,
    };
  });

  expect(rail).not.toBeNull();
  expect(rail?.rows).toBe(7);
  expect(rail?.clientH ?? 0, 'the row list is a porthole again').toBeGreaterThanOrEqual(160);
  expect(rail?.whole ?? 0, 'fewer than four whole rows are visible').toBeGreaterThanOrEqual(4);
});

/**
 * `More` is never off the screen — round 11's F-3.
 *
 * The strip is one row that scrolls sideways when a kind declares more controls
 * than fit, and `More` — the door to everything the strip left out — was the
 * LAST control inside that scroller. Measured at 866x537: the row's box is
 * 542 px and Stats' content was 975, Text's 958, so `ops-more` sat at x = 957
 * and x = 940 with no affordance saying the row went further. It is pinned
 * outside the scroller now, at the row's right edge, for every kind.
 */
test('the strip’s More is on screen for every kind', async ({ page }) => {
  await cam(page);
  await page.goto('/');
  // The strip is a chunk fetched on first selection of a kind; nothing here is
  // measurable until the base's own declaration has landed.
  await expect(page.getByTestId('ops-more')).toBeVisible();

  const onScreen = async (): Promise<{ kind: string; visible: boolean; clipped: string }> =>
    page.evaluate(() => {
      const strip = document.querySelector('[data-testid="ops-strip"]');
      const more = document.querySelector('[data-testid="ops-more"]');
      const scroll = document.querySelector('[data-testid="ops-scroll"]');
      const box = more?.getBoundingClientRect();
      return {
        kind: strip?.getAttribute('data-strip-kind') ?? '',
        visible:
          box !== undefined &&
          box.width > 0 &&
          box.left >= -1 &&
          box.right <= window.innerWidth + 1,
        clipped: scroll?.getAttribute('data-clipped') ?? 'missing',
      };
    });

  /*
   * Polled rather than sampled: a kind's strip is a chunk fetched on the first
   * selection of that kind, so for one paint after an add the row is the
   * reserved-height placeholder and `ops-more` is not in the DOM at all. The
   * claim is about the settled row.
   */
  const settledKind = async (): Promise<string> => {
    await expect.poll(async () => (await onScreen()).visible, { timeout: 5000 }).toBe(true);
    const now = await onScreen();
    // …and the scroller says so when it IS cutting something off, so a row that
    // ends mid-control reads as a row rather than as a control that stopped.
    expect(['none', 'true', 'start', 'both']).toContain(now.clipped);
    return now.kind;
  };

  // The base first, then one of every overlay kind the sheet offers.
  const seen: string[] = [await settledKind()];
  for (const kind of ['stats', 'text', 'icon', 'date', 'shape', 'clock', 'effect']) {
    await addLayer(page, kind);
    seen.push(await settledKind());
  }
  expect(new Set(seen).size, 'the strip did not change with the selection').toBe(8);
});

/**
 * The chip row is the BASE picker, and it offers exactly the backgrounds —
 * round 11's M-a.
 *
 * Two pickers for one question used to disagree in both directions: the rail's
 * row was `listModules()` (nine chips, including Text, Icon and Date, which
 * declare `roles: ['overlay']` and cannot be a background), while the add
 * sheet's BACKGROUND row was derived from `roles` and carried a seventh entry
 * the rail did not have. One derivation now, in `editor/basePicker.ts`; this
 * asserts the two agree without naming a single kind, so a module added next
 * month is covered.
 */
test('the rail’s chips and the sheet’s Background row are the same list', async ({ page }) => {
  await cam(page);
  await page.goto('/');
  // The chips live in the rail, which mounts after the first paint.
  await expect(page.getByTestId('module-chip-video')).toBeVisible();

  const chips = await page.evaluate(() => [
    ...[...document.querySelectorAll('[data-testid^="module-chip-"]')].map((el) =>
      (el.getAttribute('data-testid') ?? '').replace('module-chip-', ''),
    ),
    ...(document.querySelector('[data-testid="base-chip-solid"]') === null ? [] : ['solid']),
  ]);

  await page.getByTestId('rail-add').click();
  await expect(page.getByTestId('add-sheet')).toBeVisible();
  const tiles = await page.evaluate(() => [
    ...[...document.querySelectorAll('[data-testid^="add-base-"]')].map((el) =>
      (el.getAttribute('data-testid') ?? '').replace('add-base-', ''),
    ),
    ...(document.querySelector('[data-testid="add-tile-solid"]') === null ? [] : ['solid']),
  ]);

  expect(chips.length).toBeGreaterThan(3);
  expect([...chips].sort()).toEqual([...tiles].sort());
  // The overlay-only kinds are in neither: they are tiles, not backgrounds.
  for (const overlayOnly of ['text', 'icon', 'date']) {
    expect(chips, `${overlayOnly} cannot be a background`).not.toContain(overlayOnly);
  }
});

/**
 * The inspector opens ON what the strip asked for — round 11's F-7.
 *
 * Effect, Preset and Colours are three doors into one room: the kind's own
 * panel. The inspector opened at the top of its body, which is Layout, and the
 * body scrolls — 365 px of window over 1,651 px of content on an effect layer
 * at 866x537 — so pressing **Effect** showed 0 of the 12 effect tiles and left
 * a person looking at an X/Y readout. `More` still opens at the top, because
 * `More` asks for the sheet rather than for anything in it.
 */
test('pressing Effect opens the inspector on the effect picker', async ({ page }) => {
  await cam(page);
  await page.goto('/');
  await addLayer(page, 'effect');

  const tilesInView = async (): Promise<number> =>
    page.evaluate(() => {
      const body = document.querySelector('.kh-sheet--inspect .kh-sheet__body');
      if (body === null) return -1;
      const box = body.getBoundingClientRect();
      return [...document.querySelectorAll('[data-testid^="effect-pick-"]')].filter((tile) => {
        const r = tile.getBoundingClientRect();
        return r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
      }).length;
    });

  await page.getByTestId('ops-effect-button').click();
  await expect(page.getByTestId('inspector-sheet')).toBeVisible();
  await expect.poll(tilesInView, { timeout: 5000 }).toBeGreaterThanOrEqual(6);

  // …and `More` is still the door with no destination: it opens at the top.
  await page.getByTestId('inspector-close').click();
  await page.getByTestId('ops-more').click();
  await expect(page.getByTestId('inspector-sheet')).toBeVisible();
  await expect(page.getByTestId('inspect-layout')).toBeInViewport();
});

/**
 * A tile's summary uses the tile's width — round 11's M-j.
 *
 * `white-space: nowrap` put every one of these sentences on one line and cut
 * it: the tiles are 242 px wide and the summaries measured 325 to 389 px, so
 * between a third and a half of each description was behind an ellipsis with a
 * whole second line free under it.
 */
test('the add sheet’s descriptions get two lines, not one clipped one', async ({ page }) => {
  await cam(page);
  await page.goto('/');
  await page.getByTestId('rail-add').click();
  await expect(page.getByTestId('add-sheet')).toBeVisible();

  const lines = await page.evaluate(() =>
    [...document.querySelectorAll('.kh-tile small')].map((el) => {
      const style = getComputedStyle(el);
      const lineHeight = Number.parseFloat(style.lineHeight);
      return {
        wraps: style.whiteSpace !== 'nowrap',
        lines: Math.round(el.getBoundingClientRect().height / lineHeight),
        fits: el.scrollHeight <= el.clientHeight + 1,
      };
    }),
  );

  expect(lines.length).toBeGreaterThan(4);
  for (const line of lines) {
    expect(line.wraps, 'a tile summary is still one clipped line').toBe(true);
    expect(
      line.lines,
      'a tile summary took more than the two lines it is given',
    ).toBeLessThanOrEqual(2);
  }
  // At least one of them genuinely needed the second line, or the rule is vacuous.
  expect(lines.some((l) => l.lines === 2)).toBe(true);
});

/**
 * Every background is reachable with a mouse — round 12's F12-2.
 *
 * The rail's BASE chip row is the base picker, and at CAM's height round 11
 * turned it into a one-line hidden-scrollbar scroller with none of the
 * machinery that makes a scroller usable. Measured at 866x537: a 231 px box
 * over 417 px of chips, so **Image** was sliced at the edge and **Shape**,
 * **Effect** and **Solid** were off-screen; a mouse wheel over it left
 * `scrollLeft` at 0, there was no fade, and the BASE label opened nothing.
 * Three of the seven backgrounds could not be reached with a mouse at all.
 *
 * The row wraps onto two lines now. This asserts the OUTCOME rather than the
 * technique — every chip inside its own box, in the viewport, and the rail
 * still showing four rows of the stack — so a future round may go back to a
 * scroller if it brings the fade and the wheel with it.
 */
test('all seven backgrounds are on screen at CAM’s window, with seven overlays up', async ({
  page,
}) => {
  await cam(page);
  await page.goto('/');
  for (const kind of ['text', 'shape', 'image', 'effect', 'icon', 'clock', 'stats']) {
    await addLayer(page, kind);
  }
  await settle(page);

  const row = await page.evaluate(() => {
    const mods = document.querySelector('[data-testid="mods-row"]');
    if (mods === null) return null;
    const box = mods.getBoundingClientRect();
    const chips = [...mods.querySelectorAll('button')];
    const list = document.querySelector('.kh-rail__list');
    const rowH = list?.querySelector('.kh-rail__row')?.getBoundingClientRect().height ?? 0;
    return {
      chips: chips.length,
      inside: chips.filter((c) => {
        const r = c.getBoundingClientRect();
        return (
          r.width > 0 &&
          r.left >= box.left - 0.5 &&
          r.right <= box.right + 0.5 &&
          r.right <= window.innerWidth + 0.5
        );
      }).length,
      hiddenBehindScroll: mods.scrollWidth - mods.clientWidth,
      clipped: mods.getAttribute('data-clipped'),
      railRows: rowH > 0 ? Math.floor((list?.getBoundingClientRect().height ?? 0) / rowH) : 0,
    };
  });

  expect(row?.chips, 'the seven backgrounds the registry declares').toBe(7);
  expect(row?.inside, 'a background that is off the edge cannot be chosen').toBe(row?.chips);
  expect(row?.hiddenBehindScroll, 'nothing is hiding behind a sideways scroll').toBe(0);
  expect(row?.clipped, 'nothing is cut, so nothing is faded').toBe('none');
  // …and the row that fits did not buy itself out of round 11's F-2.
  expect(row?.railRows, 'the rail still shows four rows of the stack').toBeGreaterThanOrEqual(4);
  /*
   * Page-fit only. The rail's row LIST is the one box on this screen that is
   * meant to scroll — with seven overlays there are more rows than a 537 px
   * window has room for, which is what the list exists to do — so `clipped`
   * here is that list doing its job, and the promise being kept is that the
   * document itself still fits.
   */
  expect((await overflowOf(page)).overflow, 'the composition runs past the fold').toBe(0);
});

/**
 * …and the second door to the same seven — the BASE label (F12-2).
 *
 * A label naming the thing you want to change, which does nothing when you
 * press it, is a disclosure that forgot to disclose. It opens the add sheet at
 * the Background row: one press, all seven as tiles, no sideways gesture
 * anywhere in the path.
 */
test('the rail’s BASE label opens the background picker', async ({ page }) => {
  await cam(page);
  await page.goto('/');

  const base = page.getByTestId('layer-select-base');
  await expect(base).toHaveAttribute('aria-expanded', 'false');
  await base.click();

  await expect(page.getByTestId('add-sheet')).toBeVisible();
  await expect(base).toHaveAttribute('aria-controls', 'kh-add-sheet');
  await expect(page.getByTestId('add-group-base')).toBeInViewport();

  // Every background the chip row offers is a tile in that row.
  const tiles = page.locator('[data-testid="add-group-base"] .kh-tile');
  await expect(tiles).toHaveCount(7);
  // …and choosing one is the whole gesture: the sheet closes onto the change.
  await page.getByTestId('add-tile-solid').click();
  await expect(page.getByTestId('add-sheet')).toHaveCount(0);
});
