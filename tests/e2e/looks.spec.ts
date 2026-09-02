import { expect, test, type Page } from '@playwright/test';

/**
 * Looks, end to end — §4 and §9, on the surface a person actually uses.
 *
 * The unit suite already proves the pieces: the store's cap and corruption
 * tolerance, the refusal table, the preview budget, the carousel's tick, and
 * that applying a Look is one operation and one undo step. What only a browser
 * can say is whether those pieces are WIRED — whether pressing the Looks menu
 * opens the sheet, whether a card applies the Look it is a picture of, whether
 * undo puts back what was there, and whether Export hands the browser a file.
 *
 * Written but **not run in this wave**: the suite's ports are in use by other
 * work in flight, and a spec that has never executed is a spec that says
 * nothing. The first run of this file is the first thing the next wave does.
 */

const CAM = { width: 866, height: 537 } as const;

/** The steady state: a Kraken has connected, so the install band is gone. */
async function cam(page: Page): Promise<void> {
  await page.setViewportSize({ width: CAM.width, height: CAM.height });
  await page.addInitScript(() => {
    localStorage.setItem('kraken-hub:v1:config:displaySeen', '1');
  });
}

async function openLooks(page: Page): Promise<void> {
  await page.getByTestId('looks-menu').click();
  await page.getByTestId('looks-browse').click();
  await expect(page.getByTestId('looks-sheet')).toBeVisible();
}

/** The base kind on the panel right now, read from the document rather than the DOM. */
async function baseKind(page: Page): Promise<string> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('kraken-hub:v1:state');
    const state =
      raw === null ? {} : (JSON.parse(raw) as { look?: { layers?: { kind?: string }[] } });
    return state.look?.layers?.[0]?.kind ?? '';
  });
}

test.describe('the Looks sheet', () => {
  test('opens from the Looks menu and shows the Looks the app ships', async ({ page }) => {
    await cam(page);
    // The carousel's timer is mounted on this screen, and a rotation is OFF
    // until somebody switches one on. So booting home must not open the media
    // library at all: reading it here listed every clip and picture, and drove
    // the legacy→merged picture migration, on CAM's boot path for a feature
    // nobody had asked for. Counting `indexedDB.open` is the instrument,
    // because the chunk graph cannot answer it — `module-image` is on the home
    // path anyway, through `pasteLink`, without anybody touching a database.
    await page.addInitScript(() => {
      const opens: string[] = [];
      (window as unknown as { __dbOpens: string[] }).__dbOpens = opens;
      const open = indexedDB.open.bind(indexedDB);
      indexedDB.open = (name: string, version?: number) => {
        opens.push(name);
        return version === undefined ? open(name) : open(name, version);
      };
    });
    // `?cam=1` because that is the window the rule is about: `ownsBytes()` is
    // "CAM detected AND role config", and only that window runs the rotation —
    // so only that window could have opened the library for it.
    await page.goto('/?cam=1');
    // Nothing to wait FOR — the assertion is that nothing ever arrives — so a
    // fixed settle window is the honest instrument, as in `modules.spec.ts`.
    // eslint-disable-next-line playwright/no-wait-for-timeout
    await page.waitForTimeout(500);
    /*
     * Named, not counted-to-zero.
     *
     * The signal is "the LIBRARY database was not opened", and the library is
     * `kraken-hub.v1` — opening it is what lists every clip and picture and
     * what drives the legacy→merged picture copy. Asserting that NOTHING at all
     * opened a database would also fail the day some unrelated feature keeps a
     * few bytes of its own, which would be a spec failing for a reason it is
     * not about.
     *
     * An earlier version of this test asserted that no `module-video` or
     * `module-image` chunk had loaded, which was false by construction: the
     * home route statically imports the image module through `pasteLink.ts` and
     * `showTile.ts`, and video is `DEFAULT_MODULE_ID`, so both chunks are on
     * the boot path whether or not anybody touches a database.
     */
    expect(
      (await page.evaluate(() => (window as unknown as { __dbOpens: string[] }).__dbOpens)).filter(
        (name) => name === 'kraken-hub.v1',
      ),
    ).toEqual([]);

    await openLooks(page);

    const grid = page.getByTestId('looks-grid');
    await expect(grid).toBeVisible();
    // Ten templates, each a real file. The floor is §10's eight.
    expect(await grid.locator('.kh-looks-item').count()).toBeGreaterThanOrEqual(8);
  });

  test('a card is the Look running, not a picture of one', async ({ page }) => {
    await cam(page);
    await page.goto('/');
    await openLooks(page);

    // Single is the first card and contains no effect, so it is on screen, it
    // is allowed a live preview, and it gets one of the six slots.
    await expect(page.getByTestId('look-preview-template-tpl-single')).toHaveAttribute(
      'data-preview',
      'live',
    );

    // Nebula's base IS an effect: one graphics context per card would evict the
    // editor's own, so this one is a still frame by design, not by failure.
    await expect(page.getByTestId('look-preview-template-tpl-nebula-clock')).toHaveAttribute(
      'data-preview',
      'still',
    );

    // …and never more than the six the budget hands out, however far you scroll.
    const live = page.locator('[data-preview="live"]');
    expect(await live.count()).toBeLessThanOrEqual(6);
  });

  /**
   * …and a still card is still the LOOK — round 11's F-4.
   *
   * "Still" is a property of the effect LAYER, not of the card: an effect is a
   * WebGL context and a grid of them would evict the editor's own, but the
   * clock, the stats strip, the ring and the text over it are ordinary DOM.
   * The card used to be the ramp and nothing else, so five of the ten templates
   * — Overlay, Lava lamp + temps, Nebula clock, Sunset loop + clock and Focus —
   * rendered as one gradient div apiece: measured, a single node inside the
   * preview, and five cards a person cannot choose between.
   */
  test('a card whose Look has an effect still shows the rest of the Look', async ({ page }) => {
    await cam(page);
    await page.goto('/');
    await openLooks(page);

    const nebula = page.getByTestId('look-preview-template-tpl-nebula-clock');
    // The effect itself is not running — that part of the policy is unchanged.
    await expect(nebula).toHaveAttribute('data-preview', 'still');
    /*
     * Scrolled to first, because the OTHER cap is unchanged too: six live at a
     * time, claimed by whichever cards are on screen. A card waiting for a slot
     * shows the ramp alone, which is exactly what every card in this mode used
     * to show — the finding is about the card you are looking at.
     */
    await nebula.scrollIntoViewIfNeeded();
    // A compositor IS running, and the ramp is behind it rather than instead of it.
    await expect(nebula).toHaveAttribute('data-composited', 'true');
    await expect(nebula.locator('.kh-lookprev__still')).toHaveCount(1);

    /*
     * The measurable claim: the picture is more than one node. A ramp is one
     * `div` with a `background`; a composited Look is a stage with a host per
     * ON layer under it, so the clock this template is named after is there.
     */
    await expect
      .poll(async () => nebula.locator('.kh-lookprev__stage *').count(), { timeout: 10_000 })
      .toBeGreaterThan(0);

    // And this is a property of the MODE, not of one template: every still card
    // that currently holds a slot is drawing its Look, not just a ramp.
    const composited = await page.locator('[data-preview="still"][data-composited="true"]').count();
    expect(composited, 'no still card is compositing anything').toBeGreaterThan(0);
  });

  /**
   * …and the picture is IN the card — round 10's F1.
   *
   * `LookPreview` lays the stage out at the panel's real pixel size and shrinks
   * it with `transform: scale(calc(var(--kh-lookprev-size) / 640))`. The token
   * carried a unit (`120px`), so the calc produced a LENGTH, `scale()` takes a
   * number, and the whole declaration was invalid and dropped: every card in the
   * sheet rendered the top-left 4.6 % of a 640 px stage at 1:1, which reads as a
   * blank card with a corner of something in it.
   *
   * Measured as the fraction of the stage that lands inside the card's box,
   * because that is the failure — the compositor was running the whole time, and
   * `data-preview="live"` above was true throughout.
   */
  test('a card shows the whole Look, not a corner of it', async ({ page }) => {
    await cam(page);
    await page.goto('/');
    await openLooks(page);
    await expect(page.getByTestId('look-preview-template-tpl-single')).toHaveAttribute(
      'data-preview',
      'live',
    );

    const seen = await page.evaluate(() => {
      const out: { id: string; fraction: number; transform: string }[] = [];
      for (const card of document.querySelectorAll('[data-preview="live"]')) {
        const stage = card.querySelector('.kh-lookprev__stage');
        if (stage === null) continue;
        const c = card.getBoundingClientRect();
        const s = stage.getBoundingClientRect();
        const w = Math.max(0, Math.min(c.right, s.right) - Math.max(c.left, s.left));
        const h = Math.max(0, Math.min(c.bottom, s.bottom) - Math.max(c.top, s.top));
        out.push({
          id: card.getAttribute('data-testid') ?? '',
          fraction: (w * h) / (s.width * s.height),
          transform: getComputedStyle(stage).transform,
        });
      }
      return out;
    });

    expect(seen.length).toBeGreaterThan(0);
    for (const card of seen) {
      // A dropped declaration computes to `none`; a valid one is a matrix.
      expect(card.transform, `${card.id}: the scale was dropped`).not.toBe('none');
      expect(card.fraction, `${card.id}: only part of the Look is in the card`).toBeGreaterThan(
        0.99,
      );
    }
  });

  /**
   * The sheet stands over the RAIL, never over the halo — round 10's M2.
   *
   * It was `position: fixed; left: 12px; width: min(560px, …)`, measured at
   * x = 12 and 560 wide over a halo running x = 84 … 499: browsing Looks covered
   * the one thing on the screen that shows what a Look looks like, while the
   * editor's other two sheets stood politely over the rail.
   */
  test('the sheet takes the rail’s column and never covers the halo', async ({ page }) => {
    await cam(page);
    await page.goto('/');
    await openLooks(page);

    const geometry = await page.evaluate(() => {
      const box = (sel: string): { x: number; right: number } | null => {
        const r = document.querySelector(sel)?.getBoundingClientRect();
        return r === undefined ? null : { x: r.x, right: r.right };
      };
      const doc = document.scrollingElement ?? document.documentElement;
      return {
        sheet: box('[data-testid="looks-sheet"]'),
        halo: box('[data-testid="mirror"]'),
        rail: box('[data-testid="layer-rail"]'),
        overflowY: doc.scrollHeight - doc.clientHeight,
        overflowX: doc.scrollWidth - doc.clientWidth,
      };
    });

    expect(geometry.sheet).not.toBeNull();
    expect(geometry.halo).not.toBeNull();
    expect(
      geometry.sheet?.x ?? 0,
      'the sheet starts to the right of the halo',
    ).toBeGreaterThanOrEqual(geometry.halo?.right ?? 0);
    // Still no page growth in either direction — the sheet's BODY scrolls (M9).
    expect(geometry.overflowY).toBe(0);
    expect(geometry.overflowX).toBe(0);
    const body = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="looks-sheet"] .kh-sheet__body');
      return el === null
        ? null
        : { scrolls: el.scrollHeight > el.clientHeight, overflowY: getComputedStyle(el).overflowY };
    });
    expect(body?.overflowY).toBe('auto');
    expect(body?.scrolls, 'ten templates, in a box that scrolls').toBe(true);
  });

  test('applying a template changes the panel, and undo puts it back', async ({ page }) => {
    await cam(page);
    await page.goto('/');
    /*
     * The baseline comes from the RUNNING app, not from `localStorage`.
     *
     * A cold profile has never been written to — the store persists on the first
     * commit, not on boot — so `baseKind()` read `''` before anything had been
     * applied, and the undo at the end restored the real default (`video`)
     * against a baseline of `''`. The test was comparing a reading of the app
     * with a reading of an empty disk, and it was invisible for as long as the
     * two happened to agree.
     *
     * `data-strip-kind` is the selection's kind and the selection at rest IS the
     * base, so it answers the same question the moment the page is up.
     */
    const strip = page.getByTestId('ops-strip');
    await expect(strip).not.toHaveAttribute('data-strip-kind', '');
    const before = await strip.getAttribute('data-strip-kind');
    expect(before).not.toBeNull();

    await openLooks(page);
    await page.getByTestId('look-apply-tpl-minimal-clock').click();
    await expect.poll(async () => baseKind(page)).toBe('clock');
    // The header takes the Look's name, because it is the only place the live
    // Look is named.
    await expect(page.getByTestId('looks-menu')).toContainText('Minimal clock');

    // …and undo puts the document back, asserted on the document this time —
    // by now there IS one, because applying committed.
    await page.getByTestId('undo').click();
    await expect.poll(async () => baseKind(page)).toBe(before);
  });

  /**
   * The ellipsis asks, and the answer is a name — round 11's M-b.
   *
   * "Save as…" used to save silently under whatever the header said, which on a
   * Look nobody had renamed is the empty string: two presses produced two shelf
   * entries both reading "Untitled look", in the one place whose whole job is
   * telling saved Looks apart. The button opens a field now, and an empty name
   * is refused rather than defaulted.
   */
  test('Save as… asks for a name, and keeps the Look under it', async ({ page }) => {
    await cam(page);
    await page.goto('/');
    await openLooks(page);

    await page.getByTestId('looks-save-as').click();
    const field = page.getByTestId('looks-save-name');
    await expect(field).toBeVisible();
    // An unnamed Look opens the field empty, and Save is refused until it is not.
    await expect(page.getByTestId('looks-save-confirm')).toBeDisabled();

    await field.fill('Desk at night');
    await page.getByTestId('looks-save-confirm').click();

    await expect(page.getByTestId('looks-sheet')).toHaveAttribute('data-tab', 'yours');
    const kept = page.getByTestId('looks-grid-yours').locator('.kh-looks-item');
    await expect(kept).toHaveCount(1);
    await expect(kept.first()).toContainText('Desk at night');
    // …and never the name two silent presses used to produce.
    await expect(kept.first()).not.toContainText('Untitled look');
  });

  /**
   * …and two presses cannot produce two Looks with the same name — M-b.
   *
   * The second half of the finding: the field is what makes the shelf's entries
   * distinguishable, so pressing Save as… twice on the same arrangement has to
   * end with two names, not two copies of the same blank.
   */
  test('two saves of the same Look are two named Looks', async ({ page }) => {
    await cam(page);
    await page.goto('/');
    await openLooks(page);

    for (const label of ['First pass', 'Second pass']) {
      await page.getByTestId('looks-save-as').click();
      await page.getByTestId('looks-save-name').fill(label);
      await page.getByTestId('looks-save-confirm').click();
      await expect(page.getByTestId('looks-sheet')).toHaveAttribute('data-tab', 'yours');
    }

    const kept = page.getByTestId('looks-grid-yours').locator('.kh-looks-item');
    await expect(kept).toHaveCount(2);
    const names = await kept.locator('b').allTextContents();
    expect(new Set(names).size, 'two saves produced two identical names').toBe(2);
    expect(names).not.toContain('Untitled look');
  });

  test('Export hands the browser a .krakenlook', async ({ page }) => {
    await cam(page);
    await page.goto('/');
    await openLooks(page);

    const download = page.waitForEvent('download');
    await page.getByTestId('looks-export').click();
    expect((await download).suggestedFilename()).toMatch(/\.krakenlook$/);
  });

  test('a file that is not a Look gets words, never a code', async ({ page }) => {
    await cam(page);
    await page.goto('/');
    await openLooks(page);

    await page.getByTestId('looks-import-input').setInputFiles({
      name: 'notes.krakenlook',
      mimeType: 'application/json',
      buffer: Buffer.from('{"format":"somebody-elses-app"}'),
    });

    const card = page.getByTestId('looks-card').first();
    await expect(card).toBeVisible();
    await expect(card).toContainText('not a Look file');
    // The one thing a card may never contain is the value the program uses.
    await expect(card).not.toContainText('wrong-format');
  });

  test('the carousel needs two Looks and says so until it has them', async ({ page }) => {
    await cam(page);
    await page.goto('/');
    await openLooks(page);

    await page.getByTestId('looks-tab-carousel').click();
    await expect(page.getByTestId('looks-carousel-empty')).toBeVisible();

    // Keep two, then choose them both.
    // Save as… opens a field (M-b); an applied template pre-fills it with the
    // template's own name, so confirming is the whole gesture.
    for (const id of ['tpl-minimal-clock', 'tpl-single']) {
      await page.getByTestId('looks-tab-templates').click();
      await page.getByTestId(`look-apply-${id}`).click();
      await page.getByTestId('looks-save-as').click();
      await page.getByTestId('looks-save-confirm').click();
    }

    await page.getByTestId('looks-tab-carousel').click();
    const picks = page.locator('[data-testid^="carousel-pick-"]');
    await expect(picks).toHaveCount(2);

    /*
     * The first pick has to SURVIVE — round 10's F5.
     *
     * `toggleInRotation` read the picks back out of `state.carousel`, and
     * `state.carousel` is `undefined` for anything under two Looks. So press one
     * computed `[a]`, wrote `undefined`, and press two read an empty list and
     * computed `[b]` — the carousel could not be switched on from this sheet at
     * any number of presses, and the status line said "Off — pick two." forever.
     *
     * Asserted through the line a person actually reads, in all three states.
     */
    await expect(page.getByTestId('carousel-status')).toHaveText('Off — pick two.');
    await picks.nth(0).click();
    await expect(page.getByTestId('carousel-status')).toHaveText('1 picked — pick one more');
    await picks.nth(1).click();
    await expect(page.getByTestId('carousel-status')).toContainText('2 Looks');
    await expect(page.getByTestId('carousel-status')).toContainText('every');

    // …and it is a real rotation in the document, not a sentence.
    const stored = await page.evaluate(() => localStorage.getItem('kraken-hub:v1:state') ?? '');
    expect(stored).toContain('"carousel"');
  });

  test('the sheet never speaks the words the editor has retired', async ({ page }) => {
    await cam(page);
    await page.goto('/');
    await openLooks(page);

    const text = (await page.locator('.kh-home').innerText()).toLowerCase();
    for (const banned of ['element', 'z-index', 'shader', 'compositor', 'uniform']) {
      expect(text, `the Looks sheet said "${banned}"`).not.toContain(banned);
    }
  });
});
