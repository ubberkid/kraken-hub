import { devices, expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * The phone edits the same Look — §8, principle 10.
 *
 * Everything here runs under real touch emulation, with `tap()` rather than
 * `click()`, for the reason `touch-taps.spec.ts` gives: a synthesised mouse
 * click does not exercise the touch path at all, and this wave's whole subject
 * is the touch path.
 *
 * Three families of assertion, and they are deliberately different KINDS:
 *
 *  1. **The gesture works and undoes** — enter, drag, undo, Done. The state
 *     document is the witness, not the DOM, because the DOM would look
 *     identical if the phone were editing a private copy.
 *  2. **Every control is a thumb target** — `tap-targets.spec.ts`'s sweep,
 *     which names no element and therefore cannot go one gesture out of date,
 *     extended to the editing states this wave adds. The rail was a desktop
 *     column at 30 px a row before this, and it is a sheet on a phone now.
 *  3. **The page still fits** — `home-composition.spec.ts` crosses page fit
 *     with every `FlowStage` for exactly this reason: a state nobody wrote down
 *     is a state nobody measured. `REMOTE_EDIT_STAGES` is that enumeration for
 *     the editor, and every sheet it can open is in it.
 *
 * ## Unrun, and honestly so
 *
 * This file has never been executed: the wave that wrote it shares the tree
 * with other work and the suite's ports were another agent's. It is written to
 * the same conventions as the specs beside it and the same journey was walked
 * by hand against a scratch build (enter, add, drag, undo, Done — see the
 * wave's report), but it has not been through `npm run test:e2e`.
 */

/** A small modern phone — the surface all of this is designed for. */
const PHONE = { width: 390, height: 844 } as const;
const TAP_PX = 44;

test.use({ ...devices['iPhone 14'], defaultBrowserType: 'chromium' });

function phoneUrl(room: string): string {
  return `/?phone=1&transport=fake&room=${room}#/remote`;
}
function displayUrl(room: string): string {
  return `/?kraken=1&sim=elite&transport=fake&room=${room}`;
}

/**
 * A phone with a Kraken on the other end, editing.
 *
 * The display page is not scenery: the canvas refuses to exist until a panel
 * has been REPORTED (round 6's C4 — every module lays itself out against
 * `geometry()`), so the Edit affordance is disabled until the first monitor
 * packet lands. Waiting for it to enable is waiting for the thing under test.
 */
async function editingPhone(context: BrowserContext, room: string): Promise<Page> {
  const display = await context.newPage();
  await display.setViewportSize({ width: 640, height: 640 });
  await display.goto(displayUrl(room));
  await expect(display.locator('.kh-stage')).toBeVisible();

  const phone = await context.newPage();
  await phone.setViewportSize(PHONE);
  await phone.goto(phoneUrl(room));
  const edit = phone.getByTestId('remote-edit');
  await expect(edit).toBeVisible();
  await expect(edit).toBeEnabled({ timeout: 20_000 });
  await edit.tap();
  await expect(phone.getByTestId('remote-editor')).toBeVisible();
  return phone;
}

/** The document, as the phone wrote it. */
async function look(
  page: Page,
): Promise<{ layers: { kind: string; t: Record<string, number> }[] }> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('kraken-hub:v1:state');
    return raw === null
      ? { layers: [] }
      : (JSON.parse(raw) as { look: { layers: { kind: string; t: Record<string, number> }[] } })
          .look;
  });
}

// ---------------------------------------------------------------------------
// 1. The gesture
// ---------------------------------------------------------------------------

test.describe('the ring becomes the canvas', () => {
  test('the remote is a remote until you ask for the canvas', async ({ context }) => {
    const phone = await context.newPage();
    await phone.setViewportSize(PHONE);
    await phone.goto(phoneUrl('EDITA234'));

    // Play, hold, skip — the remote's first job, before anything is edited.
    await expect(phone.getByTestId('transport-hold')).toBeVisible();
    await expect(phone.getByTestId('remote-mirror')).toBeVisible();
    await expect(phone.getByTestId('remote-editor')).toHaveCount(0);

    // …and with no panel reported, the canvas is refused rather than guessed.
    await expect(phone.getByTestId('remote-edit')).toBeDisabled();
  });

  test('one tap opens the editor over the same ring, and Done gives it back', async ({
    context,
  }) => {
    const phone = await editingPhone(context, 'EDITB234');

    // The ring is still the ring: the replica underneath, not a stand-in.
    await expect(phone.getByTestId('remote-mirror')).toBeVisible();
    await expect(phone.getByTestId('editor-overlay')).toHaveAttribute('data-touch', 'true');
    // The transport steps aside — two instruments, one at a time, on 390 px.
    await expect(phone.getByTestId('transport-hold')).toHaveCount(0);

    await phone.getByTestId('remote-edit-done').tap();
    await expect(phone.getByTestId('remote-editor')).toHaveCount(0);
    await expect(phone.getByTestId('transport-hold')).toBeVisible();
    await expect(phone.getByTestId('remote-mirror')).toBeVisible();
  });

  /**
   * The journey: add, drag, undo. Asserted on the DOCUMENT.
   *
   * The drag goes through the pure model — `beginGesture`, `applyGesture`,
   * `endGesture` — so what lands in `t` is the snapped result, and undo returns
   * the transform the finger found rather than the penultimate frame.
   */
  test('a drag moves the layer in the document, and undo puts it back', async ({ context }) => {
    const phone = await editingPhone(context, 'EDITC234');

    await phone.getByTestId('remote-add-layer').tap();
    await phone.getByTestId('add-tile-clock').tap();
    const added = await look(phone);
    expect(added.layers).toHaveLength(2);
    const before = JSON.stringify(added.layers[1]?.t);

    // Panel px → screen px through the stage's own rectangle, which is exactly
    // the conversion the overlay does.
    const stage = await phone.locator('.kh-redit__stage').boundingBox();
    expect(stage).not.toBeNull();
    const panel = 640;
    const k = (stage?.width ?? panel) / panel;
    const t = added.layers[1]?.t ?? { x: 0, y: 0 };
    const from = {
      x: (stage?.x ?? 0) + (panel / 2 + (t['x'] ?? 0) * (panel / 2)) * k,
      y: (stage?.y ?? 0) + (panel / 2 + (t['y'] ?? 0) * (panel / 2)) * k,
    };

    await phone.mouse.move(from.x, from.y);
    await phone.mouse.down();
    await phone.mouse.move(from.x - 40, from.y - 30, { steps: 12 });
    await phone.mouse.up();

    await expect
      .poll(async () => JSON.stringify((await look(phone)).layers[1]?.t))
      .not.toBe(before);
    await expect(phone.getByTestId('editor-selection')).toBeVisible();

    await phone.getByTestId('remote-undo').tap();
    await expect.poll(async () => JSON.stringify((await look(phone)).layers[1]?.t)).toBe(before);

    /*
     * …and ONE gesture per press, which is the part that actually broke.
     *
     * The add and the drag are two entries: the layer is still THERE after the
     * first press and only leaves on the second. It went the other way for a
     * wave — one press walked back both, because the seam under the phone was
     * recording the torn snapshot a commit publishes mid-flight as if it were
     * somebody else's edit (`lookHistoryStore.ts`). Counting the layers says
     * which of the two happened; comparing transforms alone does not.
     */
    await expect.poll(async () => (await look(phone)).layers.length).toBe(2);
    await phone.getByTestId('remote-undo').tap();
    await expect.poll(async () => (await look(phone)).layers.length).toBe(1);
  });

  test('a long press opens the layer’s own actions', async ({ context }) => {
    const phone = await editingPhone(context, 'EDITD234');
    await phone.getByTestId('remote-add-layer').tap();
    await phone.getByTestId('add-tile-clock').tap();

    const added = await look(phone);
    const stage = await phone.locator('.kh-redit__stage').boundingBox();
    const panel = 640;
    const k = (stage?.width ?? panel) / panel;
    const t = added.layers[1]?.t ?? { x: 0, y: 0 };
    const at = {
      x: (stage?.x ?? 0) + (panel / 2 + (t['x'] ?? 0) * (panel / 2)) * k,
      y: (stage?.y ?? 0) + (panel / 2 + (t['y'] ?? 0) * (panel / 2)) * k,
    };

    await phone.mouse.move(at.x, at.y);
    await phone.mouse.down();
    // The platform's own half-second, and nothing may move while it passes.
    await phone.waitForTimeout(700);
    await phone.mouse.up();

    await expect(phone.getByTestId('remote-context')).toBeVisible();
    await phone.getByTestId('remote-context-duplicate').tap();
    await expect.poll(async () => (await look(phone)).layers.length).toBe(3);
  });

  /**
   * The claim, which is the one sentence this surface says about the panel.
   *
   * W1c landed `look` in the sync body, so a phone in a CONNECTED room really
   * does deliver, and this is the state where it says so — the room is joined,
   * the fake transport is up, and the display on the other page has been heard
   * from. Before W1c the live sentence in `CLAIM_ARRANGEMENT` was three
   * registered strings nothing could render.
   *
   * The assertion is on the state that produced the sentence rather than on the
   * sentence, so a wording change is not a test change; `lookReach.test.ts`
   * holds the other half — a window that cannot deliver never reaches this
   * tense, whatever the telemetry says.
   */
  test('claims the arrangement only once the room can carry it', async ({ context }) => {
    const phone = await editingPhone(context, 'EDITE234');
    await expect(phone.getByTestId('remote-edit-claim')).toHaveAttribute('data-presence', 'live');
  });

  /** The phone is still the remote: no bytes, on the screen that moves layers. */
  test('offers nothing that would put bytes in the wrong browser', async ({ context }) => {
    const phone = await editingPhone(context, 'EDITF234');
    await phone.getByTestId('remote-add-layer').tap();
    await expect(phone.locator('input[type="file"]')).toHaveCount(0);
    await expect(phone.getByTestId('library-add')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// 2 & 3. The enumerations
// ---------------------------------------------------------------------------

/**
 * Every state the editor can be in on a phone.
 *
 * A list, in the shape `FLOW_STAGES` is a list: the two sweeps below visit it
 * rather than visiting the states somebody photographed, so a sheet added next
 * wave is measured by adding one line here.
 */
const REMOTE_EDIT_STAGES = ['editing', 'rail', 'add', 'context', 'looks'] as const;
type RemoteEditStage = (typeof REMOTE_EDIT_STAGES)[number];

async function enterStage(phone: Page, stage: RemoteEditStage): Promise<void> {
  if (stage === 'rail') {
    await phone.getByTestId('remote-rail-button').tap();
    await expect(phone.locator('#remote-rail-sheet')).toBeVisible();
    return;
  }
  if (stage === 'add') {
    await phone.getByTestId('remote-add-layer').tap();
    await expect(phone.getByTestId('add-sheet')).toBeVisible();
    return;
  }
  if (stage === 'looks') {
    await phone.getByTestId('remote-looks-button').tap();
    await expect(phone.getByTestId('remote-looks-menu')).toBeVisible();
    return;
  }
  if (stage === 'context') {
    await phone.getByTestId('remote-add-layer').tap();
    await phone.getByTestId('add-tile-clock').tap();
    const stageBox = await phone.locator('.kh-redit__stage').boundingBox();
    const current = await look(phone);
    const panel = 640;
    const k = (stageBox?.width ?? panel) / panel;
    const t = current.layers[1]?.t ?? { x: 0, y: 0 };
    await phone.mouse.move(
      (stageBox?.x ?? 0) + (panel / 2 + (t['x'] ?? 0) * (panel / 2)) * k,
      (stageBox?.y ?? 0) + (panel / 2 + (t['y'] ?? 0) * (panel / 2)) * k,
    );
    await phone.mouse.down();
    await phone.waitForTimeout(700);
    await phone.mouse.up();
    await expect(phone.getByTestId('remote-context')).toBeVisible();
  }
}

/** Wait for the composition to stop moving — `tap-targets.spec.ts`'s reason. */
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

/** The same measurement `tap-targets.spec.ts` makes: the box, or a pseudo bleed. */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate((floor) => {
    const SELECTOR = [
      'a[href]',
      'button',
      'input:not([type="hidden"])',
      'select',
      'textarea',
      'summary',
      '[role="button"]',
      '[role="radio"]',
      '[role="slider"]',
      '[role="switch"]',
      '[tabindex]:not([tabindex="-1"])',
    ].join(', ');

    const out: string[] = [];
    for (const el of document.querySelectorAll(SELECTOR)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (getComputedStyle(el).visibility === 'hidden') continue;
      let w = r.width;
      let h = r.height;
      for (const pseudo of ['::before', '::after']) {
        const ps = getComputedStyle(el, pseudo);
        if (ps.content === 'none' || ps.position !== 'absolute') continue;
        const pw = Number.parseFloat(ps.width);
        const ph = Number.parseFloat(ps.height);
        if (Number.isFinite(pw)) w = Math.max(w, pw);
        if (Number.isFinite(ph)) h = Math.max(h, ph);
      }
      if (w >= floor && h >= floor) continue;
      const name = el.textContent.trim().slice(0, 30);
      out.push(`${String(Math.round(w))}x${String(Math.round(h))} ${el.tagName} "${name}"`);
    }
    return out;
  }, TAP_PX);
}

test.describe('every control is a thumb target while editing', () => {
  for (const stage of REMOTE_EDIT_STAGES) {
    test(`${stage}: nothing under the ${String(TAP_PX)} px floor`, async ({ context }) => {
      const phone = await editingPhone(context, `EDT${stage.slice(0, 1).toUpperCase()}2345`);
      await enterStage(phone, stage);
      await settle(phone);
      expect(await smallTargets(phone), `${stage}: controls below the touch floor`).toEqual([]);
    });
  }
});

test.describe('the editor fits the phone in every state it can be in', () => {
  for (const stage of REMOTE_EDIT_STAGES) {
    test(`${stage}: nothing runs off the side, and every sheet scrolls itself`, async ({
      context,
    }) => {
      const phone = await editingPhone(context, `EDF${stage.slice(0, 1).toUpperCase()}2345`);
      await enterStage(phone, stage);
      await settle(phone);

      /*
       * Horizontal overflow is the failure that matters on a phone: the page
       * is a vertical flow and is allowed to scroll down, but a control off
       * the right-hand edge is a control nobody can reach. §9's rule for
       * sheets is the second half — a sheet scrolls INSIDE itself rather than
       * pushing the page.
       */
      const fit = await phone.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      }));
      expect(fit.scrollW, `${stage}: the page runs off the side`).toBeLessThanOrEqual(fit.clientW);

      // The canvas is on the screen, at a size a thumb can work on.
      const canvas = await phone.locator('.kh-redit__stage').boundingBox();
      expect(canvas?.width ?? 0).toBeGreaterThanOrEqual(240);
      expect(canvas?.width ?? 0).toBeLessThanOrEqual(PHONE.width);
    });
  }
});

/**
 * A code that cannot work is REFUSED where the reader is looking — round 11's
 * F-6.
 *
 * Round 10's M4 built the diagnosis: `#/remote?room=UUUUUUUU` carries four
 * glyphs Crockford removed precisely because people confuse them, and the app
 * names them instead of rendering the ordinary pairing card as though no code
 * had been offered. What it did not do was SHOW it — the Notice was rendered
 * inside the "Type a code instead" disclosure, which is closed, so the sentence
 * was in the DOM at y = 642 with no rendered text and the screen said nothing
 * about the link the person had just followed.
 *
 * Two links, because there are two places a link can carry a code and only one
 * of them was ever read: the fragment is what the QR encodes, and the ordinary
 * query string is what a retyped or rewritten link ends up with —
 * `?phone=1&room=UUUUUUUU` was rejected in complete silence.
 */
test.describe('a link with an impossible code says so', () => {
  for (const [name, url] of [
    ['in the fragment', '/#/remote?room=UUUUUUUU'],
    ['in the query string', '/?phone=1&room=UUUUUUUU#/remote'],
  ] as const) {
    test(`the refusal is visible without opening anything — ${name}`, async ({ page }) => {
      await page.goto(url);

      const notice = page.getByTestId('pair-code-error');
      await expect(notice).toBeVisible();
      // The diagnosis, not the generic rule: these four glyphs are the one
      // failure a person can act on without counting characters.
      await expect(notice).toContainText('I, L, O or U');

      // …and it is not behind the disclosure it used to be trapped in.
      const behindADoor = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="pair-code-error"]');
        const details = el?.closest('details') ?? null;
        return details !== null && !details.open;
      });
      expect(behindADoor, 'the refusal is inside a collapsed disclosure').toBe(false);
      await expect(notice).toBeInViewport();
    });
  }
});
