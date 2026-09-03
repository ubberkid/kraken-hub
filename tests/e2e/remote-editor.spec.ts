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
async function editingPhone(
  context: BrowserContext,
  room: string,
  /** The surface to emulate. Defaults to the 390 px phone. */
  size: { width: number; height: number } = PHONE,
): Promise<Page> {
  const display = await context.newPage();
  await display.setViewportSize({ width: 640, height: 640 });
  await display.goto(displayUrl(room));
  await expect(display.locator('.kh-stage')).toBeVisible();

  const phone = await context.newPage();
  await phone.setViewportSize(size);
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
// 1b. Two fingers — round 13, F5
// ---------------------------------------------------------------------------

/**
 * Pinch and twist, with two fingers that really are two fingers.
 *
 * `page.touchscreen` has exactly one finger, and `page.mouse` has none at all,
 * so nothing in this suite could reach `EditorCanvas`'s second-finger branch —
 * the whole of §8's pinch-to-scale and two-finger rotate shipped with no
 * end-to-end coverage, which is how round 13's audit came to report it broken.
 *
 * The only way to put two fingers on the glass from Playwright is the DevTools
 * protocol: `Input.dispatchTouchEvent` takes a LIST of touch points, and Chrome
 * turns the list into one `pointerdown` per point. That is what the helper
 * below does, and it is the reason these tests are worth their weight: they
 * exercise the exact code path a hand does and nothing else in the file can.
 *
 * ## What the audit actually saw
 *
 * The report was "`t.s` stayed 1 and the selection was dropped". Both halves
 * are measurement, not defect, and the assertions here are written to say so:
 *
 *  - A pinch on a layer whose kind resizes by FRAME (a clock does; `layer.resize`
 *    in the module manifest) is committed by `endGesture` into `layer.frame`,
 *    with `t.s` deliberately restored to where it started (`gesture.ts`). The
 *    scale is there — it is in the field that describes the layer's SIZE, which
 *    is the field a frame-resizing layer keeps its size in.
 *  - The selection survives the gesture, which is what these tests assert while
 *    the fingers are still down. What the audit measured afterwards is the
 *    two-peers-in-one-browser harness: the display page and the phone page share
 *    one `localStorage` origin here, and a commit from either settles a second
 *    or so later — a ONE-finger drag does exactly the same thing.
 */

/** One finger, in CSS pixels on the page. */
interface Finger {
  x: number;
  y: number;
}

/** A hand, dispatched through CDP. Playwright's own input has one finger. */
async function hand(phone: Page): Promise<{
  down: (points: readonly Finger[]) => Promise<void>;
  move: (points: readonly Finger[]) => Promise<void>;
  up: () => Promise<void>;
}> {
  const cdp = await phone.context().newCDPSession(phone);
  const send = async (
    type: 'touchStart' | 'touchMove' | 'touchEnd',
    points: readonly Finger[],
  ): Promise<void> => {
    await cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i, radiusX: 8, radiusY: 8 })),
    });
  };
  return {
    down: (points) => send('touchStart', points),
    move: (points) => send('touchMove', points),
    up: () => send('touchEnd', []),
  };
}

/** The document, layers and all — `look()` above keeps only what it needs. */
async function layers(page: Page): Promise<
  {
    id: string;
    kind: string;
    frame: { w: number; h: number } | 'panel';
    t: Record<string, number>;
  }[]
> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('kraken-hub:v1:state');
    return raw === null
      ? []
      : (
          JSON.parse(raw) as {
            look: {
              layers: {
                id: string;
                kind: string;
                frame: { w: number; h: number } | 'panel';
                t: Record<string, number>;
              }[];
            };
          }
        ).look.layers;
  });
}

/**
 * A layer's own box, insisted on.
 *
 * The base wears `frame: 'panel'` and has no box of its own; an overlay always
 * has one. Narrowing HERE rather than in the test keeps the assertions free of
 * branches — a conditional inside a test is a test with two meanings.
 */
function frameOf(layer: { frame: { w: number; h: number } | 'panel' } | undefined): {
  w: number;
  h: number;
} {
  const frame = layer?.frame;
  expect(frame, 'the clock overlay is gone').toBeDefined();
  expect(frame, 'the clock overlay lost its own box').not.toBe('panel');
  return frame === undefined || frame === 'panel' ? { w: 0, h: 0 } : frame;
}

/** An editing phone with one clock overlay on it, selected, and where it is. */
async function phoneWithClock(
  context: BrowserContext,
  room: string,
): Promise<{ phone: Page; centre: Finger }> {
  const phone = await editingPhone(context, room);
  await phone.getByTestId('remote-add-layer').tap();
  await phone.getByTestId('add-tile-clock').tap();
  // The box only exists once the layer is committed AND selected, so waiting
  // for it is waiting for both.
  const box = phone.getByTestId('editor-selection');
  await expect(box).toBeVisible();
  await expect.poll(async () => (await layers(phone)).length).toBe(2);
  const rect = await box.boundingBox();
  expect(rect).not.toBeNull();
  return {
    phone,
    centre: {
      x: (rect?.x ?? 0) + (rect?.width ?? 0) / 2,
      y: (rect?.y ?? 0) + (rect?.height ?? 0) / 2,
    },
  };
}

test.describe('two fingers on the phone canvas', () => {
  test('a pinch scales the selected layer, and the selection survives it', async ({ context }) => {
    const { phone, centre } = await phoneWithClock(context, 'EDITG234');
    const before = (await layers(phone))[1];

    const touch = await hand(phone);
    // Both fingers land ON the layer, 60 px apart, and spread to 120 px: a
    // factor of two, comfortably past `PINCH_DEADZONE_LN`.
    const r0 = 30;
    const r1 = 60;
    await touch.down([
      { x: centre.x - r0, y: centre.y },
      { x: centre.x + r0, y: centre.y },
    ]);
    for (let i = 1; i <= 12; i++) {
      const g = r0 + ((r1 - r0) * i) / 12;
      await touch.move([
        { x: centre.x - g, y: centre.y },
        { x: centre.x + g, y: centre.y },
      ]);
    }
    // Still selected with the hand on the glass — the box has not been dropped
    // by the second finger, which is what the audit believed had happened.
    await expect(phone.getByTestId('editor-selection')).toBeVisible();
    await touch.up();

    await expect
      .poll(async () => frameOf((await layers(phone))[1]).w)
      .toBeGreaterThan(frameOf(before).w);

    const after = (await layers(phone))[1];
    // The ratio the two fingers described, in the field a frame-resizing kind
    // keeps its size in. Loose, because `setFrame` clamps against the panel.
    const grew = frameOf(after).w / frameOf(before).w;
    expect(grew).toBeGreaterThan(1.5);
    expect(frameOf(after).h / frameOf(before).h).toBeCloseTo(grew, 3);
    // …and NOT in `t.s`, which `endGesture` restores on a frame resize. This
    // assertion is the audit's finding, written down as the intended design.
    expect(after?.t['s']).toBe(before?.t['s']);
  });

  test('two fingers twisting snap the layer to a rotation tick', async ({ context }) => {
    const { phone, centre } = await phoneWithClock(context, 'EDITH234');
    expect((await layers(phone))[1]?.t['r']).toBe(0);

    const touch = await hand(phone);
    const r = 45;
    const at = (deg: number): Finger[] => {
      const a = (deg * Math.PI) / 180;
      return [
        { x: centre.x - r * Math.cos(a), y: centre.y - r * Math.sin(a) },
        { x: centre.x + r * Math.cos(a), y: centre.y + r * Math.sin(a) },
      ];
    };
    await touch.down(at(0));
    for (let i = 1; i <= 12; i++) await touch.move(at((30 * i) / 12));
    await expect(phone.getByTestId('editor-selection')).toBeVisible();
    await touch.up();

    await expect.poll(async () => (await layers(phone))[1]?.t['r']).not.toBe(0);
    const r1 = (await layers(phone))[1]?.t['r'] ?? 0;
    // The ladder is every 15° (`snap.ts`), shared with the desktop rotate
    // handle: the phone does not get a snapping model of its own.
    expect(r1 % 15).toBe(0);
    expect(Math.abs(r1)).toBeLessThanOrEqual(45);
    // A twist is a rotation and NOT a resize — the intent is decided once.
    expect((await layers(phone))[1]?.t['s']).toBe(1);
  });

  test('the second finger may land late, the way a hand actually does', async ({ context }) => {
    const { phone, centre } = await phoneWithClock(context, 'EDITI234');
    const before = (await layers(phone))[1];

    const touch = await hand(phone);
    /*
     * Nobody puts two fingers down on the same millisecond. The first one lands
     * on the layer and starts a MOVE; the second converts that press into a
     * two-finger gesture, and the move it interrupted is put back rather than
     * being applied on top of the pinch (`abandonGesture`).
     */
    await touch.down([{ x: centre.x - 30, y: centre.y }]);
    await phone.waitForTimeout(60);
    await touch.down([
      { x: centre.x - 30, y: centre.y },
      { x: centre.x + 30, y: centre.y },
    ]);
    for (let i = 1; i <= 12; i++) {
      const g = 30 + (30 * i) / 12;
      await touch.move([
        { x: centre.x - g, y: centre.y },
        { x: centre.x + g, y: centre.y },
      ]);
    }
    await expect(phone.getByTestId('editor-selection')).toBeVisible();
    await touch.up();

    await expect
      .poll(async () => frameOf((await layers(phone))[1]).w)
      .toBeGreaterThan(frameOf(before).w);
    // The first finger's travel is not also applied: the layer grew where it
    // stood, rather than sliding 30 px left as well.
    expect((await layers(phone))[1]?.t['x']).toBe(before?.t['x']);
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
const REMOTE_EDIT_STAGES = ['editing', 'rail', 'add', 'context', 'looks', 'inspect'] as const;
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
  if (stage === 'inspect') {
    // `More` is the door that cannot scroll off the strip (round 11's F-3), so
    // it is the one press that reaches the inspector from any kind's strip.
    await phone.getByTestId('ops-more').tap();
    await expect(phone.getByTestId('remote-inspect')).toBeVisible();
    return;
  }
  if (stage === 'context') {
    await phone.getByTestId('remote-add-layer').tap();
    await phone.getByTestId('add-tile-clock').tap();
    /*
      Bring the canvas back under the finger first.

      On a short landscape window the add sheet is taller than the viewport, so
      closing it leaves the page scrolled past the ring — the stage's box comes
      back at a NEGATIVE y and the long press lands outside the document. A
      person scrolls back; so does this.
    */
    await phone.locator('.kh-redit__stage').scrollIntoViewIfNeeded();
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

/**
 * The surfaces the floor has to hold on — round 13's finding 2.
 *
 * The sweep below ran at 390×844 only, and passed, while a touch device one
 * pixel over the CSS's 700 px width query had **13 to 24** controls under the
 * floor in every stage: Done at 65×39, the base fill segments at 49×20, the
 * Looks tabs at 84×25, the wordmark at 90×26. That is the second half of the
 * user's own report — *"unless I resize the window larger"* — and the reason it
 * survived a round whose subject was tap targets is that the measurement could
 * not see it.
 *
 * So the floor is measured on a hand, not on a width: a phone in landscape and a
 * tablet are the same fingers on the same controls, and both are here.
 */
const TOUCH_SURFACES = [
  { name: 'phone', size: PHONE, tag: 'P' },
  // `W`, not `L`: a room code is Crockford, which has no I, L, O or U in it.
  { name: 'phone in landscape', size: { width: 780, height: 390 }, tag: 'W' },
  { name: 'tablet', size: { width: 800, height: 1180 }, tag: 'T' },
] as const;

test.describe('every control is a thumb target while editing', () => {
  for (const surface of TOUCH_SURFACES) {
    for (const stage of REMOTE_EDIT_STAGES) {
      test(`${surface.name}, ${stage}: nothing under the ${String(TAP_PX)} px floor`, async ({
        context,
      }) => {
        const phone = await editingPhone(
          context,
          `ED${surface.tag}${stage.slice(0, 1).toUpperCase()}2345`,
          surface.size,
        );
        await enterStage(phone, stage);
        await settle(phone);
        expect(
          await smallTargets(phone),
          `${surface.name}/${stage}: controls below the touch floor`,
        ).toEqual([]);
      });
    }
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

// ---------------------------------------------------------------------------
// 4. The phone edits the LOOKS, not just the arrangement — round 13
// ---------------------------------------------------------------------------

/**
 * The user's own report, as a suite.
 *
 * *"On my phone I can't edit the looks the same way as on my PC; selecting
 * effect presets and stuff is impossible unless I resize the window larger."*
 *
 * The cause was one line: every strip control of `control: 'action'` except
 * source, loop and quality was mapped to an escape called `more`, and `more`
 * closed the editor and opened nothing. On the effect module — the background
 * half the templates ship with — that is three of its four controls.
 */
test.describe('the strip’s deeper controls land somewhere', () => {
  /** Make the effect module the background, from the remote's own base row. */
  async function effectBase(phone: Page): Promise<void> {
    await phone.getByTestId('remote-module-effect').tap();
    await expect(phone.getByTestId('remote-module-effect')).toHaveAttribute('aria-checked', 'true');
  }

  test('the effect strip’s one control opens the module’s own panel, and a tap sticks', async ({
    context,
  }) => {
    const display = await context.newPage();
    await display.setViewportSize({ width: 640, height: 640 });
    await display.goto(displayUrl('EDITG234'));
    await expect(display.locator('.kh-stage')).toBeVisible();

    const phone = await context.newPage();
    await phone.setViewportSize(PHONE);
    await phone.goto(phoneUrl('EDITG234'));
    await effectBase(phone);

    const edit = phone.getByTestId('remote-edit');
    await expect(edit).toBeEnabled({ timeout: 20_000 });
    await edit.tap();
    await expect(phone.getByTestId('remote-editor')).toBeVisible();

    // The button that used to close the editor. The effect strip is one
    // control now — `Effect…` — and it is still the one that must not.
    await phone.getByTestId('ops-more').tap();
    await expect(phone.getByTestId('remote-editor')).toBeVisible();
    await expect(phone.getByTestId('remote-inspect')).toBeVisible();

    /*
     * …and it opened AT the panel rather than at Layout, which is the half of
     * round 11's F-7 that makes the difference between "the catalogue is in
     * this sheet somewhere" and "here it is". The section's top is measured
     * against the scroll port rather than against the window.
     */
    const options = phone.getByTestId('inspect-options');
    await expect(options).toBeVisible();
    const inView = await options.evaluate((el) => {
      const body = el.closest('.kh-sheet__body');
      if (body === null) return false;
      return el.getBoundingClientRect().top - body.getBoundingClientRect().top < 8;
    });
    expect(inView, 'the sheet did not open at the module’s panel').toBe(true);

    // The twelve-tile picker and the preset chips, on a 390 px screen.
    await expect(phone.getByTestId('effect-pick-plasma')).toBeVisible();
    const preset = phone.locator('#effect-preset [role="radio"]').nth(1);
    const wanted = await preset.getAttribute('data-testid');
    await preset.tap();

    // The document changed…
    await expect
      .poll(async () =>
        phone.evaluate(() => {
          const raw = localStorage.getItem('kraken-hub:v1:state');
          return raw === null
            ? null
            : ((JSON.parse(raw) as { modules?: Record<string, { cfg?: { preset?: string } }> })
                .modules?.['effect']?.cfg?.preset ?? null);
        }),
      )
      .toBe((wanted ?? '').replace('effect-preset-', ''));

    // …and the Kraken in the same room has it. Same document, one wire.
    await expect
      .poll(async () =>
        display.evaluate(() => {
          const raw = localStorage.getItem('kraken-hub:v1:state');
          return raw === null
            ? null
            : ((JSON.parse(raw) as { modules?: Record<string, { cfg?: { preset?: string } }> })
                .modules?.['effect']?.cfg?.preset ?? null);
        }),
      )
      .toBe((wanted ?? '').replace('effect-preset-', ''));
  });

  test('the icon picker is reachable too', async ({ context }) => {
    const phone = await editingPhone(context, 'EDITH234');
    await phone.getByTestId('remote-add-layer').tap();
    await phone.getByTestId('add-tile-icon').tap();
    await expect(phone.getByTestId('remote-strip')).toHaveAttribute('data-strip-kind', 'icon');

    // The icon strip calls its action `icon`, not `preset` — the id is the
    // control's, and the action is what it asks for.
    await phone.getByTestId('ops-icon-button').tap();
    await expect(phone.getByTestId('remote-inspect')).toBeVisible();
    await expect(phone.getByTestId('inspect-options')).toBeVisible();
    // Done gives the canvas back rather than leaving the editor.
    await phone.getByTestId('remote-inspect-done').tap();
    await expect(phone.getByTestId('remote-inspect')).toHaveCount(0);
    await expect(phone.getByTestId('remote-editor')).toBeVisible();
  });

  /**
   * Loop and quality still LEAVE — they have a truer control on the page under
   * the canvas — but the intent is no longer dropped on the floor.
   */
  test('Loop closes the editor onto the scrubber rather than onto nothing', async ({ context }) => {
    const phone = await editingPhone(context, 'EDITI234');
    await phone.getByTestId('ops-loop-button').tap();
    await expect(phone.getByTestId('remote-editor')).toHaveCount(0);
    const scrubber = phone.getByTestId('scrubber');
    await expect(scrubber).toBeVisible();
    // On the screen, not merely in the document: this is the whole finding.
    const onScreen = await scrubber.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight;
    });
    expect(onScreen, 'the scrubber is not on the screen after Loop').toBe(true);
  });

  /**
   * The base picker, on the phone, is the same list as everywhere else.
   *
   * Six base-capable kinds plus Solid colour. It used to be `listModules()` —
   * nine, including the three kinds whose manifests say they can only ever be
   * overlays, and without the Solid the add sheet one screen away offers.
   */
  test('the Showing row offers the backgrounds and only the backgrounds', async ({ context }) => {
    const phone = await context.newPage();
    await phone.setViewportSize(PHONE);
    await phone.goto(phoneUrl('EDITJ234'));

    const row = phone.locator('#remote-module [role="radio"]');
    await expect(row).toHaveCount(7);
    for (const overlayOnly of ['text', 'icon', 'date']) {
      await expect(phone.getByTestId(`remote-module-${overlayOnly}`)).toHaveCount(0);
    }
    await expect(phone.getByTestId('remote-module-base-solid')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 5. A finger is a finger at any width — round 13
// ---------------------------------------------------------------------------

/**
 * The second half of the user's report, and the reason "make the window bigger"
 * was a bad workaround rather than a fix.
 *
 * Past 700 px a phone stops being `phoneOnly` and gets CAM's editor — which was
 * deriving its touch behaviour from the WIDTH breakpoint. So the workaround
 * handed a thumb 24 px handles, no pinch, no two-finger rotate and 28–39 px
 * strip buttons. `useCoarsePointer` is a pointer query now, and this is the
 * surface that proves it: 780 px wide, real touch, no `phone=1`.
 */
test.describe('a touch device gets touch handling at desktop widths', () => {
  test.use({ viewport: { width: 780, height: 1000 }, hasTouch: true, isMobile: false });

  test('44 px handles and a thumb-sized strip on a 780 px touch window', async ({
    page: tablet,
  }) => {
    await tablet.addInitScript(() => {
      localStorage.setItem('kraken-hub:v1:config:displaySeen', '1');
    });
    await tablet.goto('/?transport=fake&room=EDITK234');

    await tablet.getByTestId('rail-add').tap();
    await expect(tablet.getByTestId('add-sheet')).toBeVisible();
    await tablet.getByTestId('add-tile-clock').tap();
    await expect(tablet.getByTestId('editor-selection')).toBeVisible();

    /*
      Rounded before comparing: the handle is 44 px of SVG scaled by the
      canvas's own k, and a browser reports that as 43.99998. The floor is a
      design rule about a fingertip, not about the fourth decimal place.
    */
    for (const handle of ['scale-nw', 'scale-se', 'rotate'] as const) {
      const box = await tablet.getByTestId(`editor-handle-${handle}`).evaluate((el) => ({
        width: Math.round(el.getBoundingClientRect().width),
        height: Math.round(el.getBoundingClientRect().height),
      }));
      expect(box.width, `${handle} is the mouse's size on a finger`).toBeGreaterThanOrEqual(TAP_PX);
      expect(box.height, `${handle} is the mouse's size on a finger`).toBeGreaterThanOrEqual(
        TAP_PX,
      );
    }

    // …and the strip's text buttons, which were 28–39 px here.
    const more = await tablet.getByTestId('ops-more').boundingBox();
    expect(more?.height ?? 0).toBeGreaterThanOrEqual(TAP_PX);
    expect(more?.width ?? 0).toBeGreaterThanOrEqual(TAP_PX);

    // The overlay is in touch mode, which is what carries pinch and long press.
    await expect(tablet.getByTestId('editor-overlay')).toHaveAttribute('data-touch', 'true');
  });

  test('a long press opens the layer’s actions on this surface too', async ({ page: tablet }) => {
    await tablet.addInitScript(() => {
      localStorage.setItem('kraken-hub:v1:config:displaySeen', '1');
    });
    await tablet.goto('/?transport=fake&room=EDITL234');
    await tablet.getByTestId('rail-add').tap();
    await tablet.getByTestId('add-tile-clock').tap();
    await expect(tablet.getByTestId('editor-selection')).toBeVisible();

    const box = await tablet.getByTestId('editor-selection').boundingBox();
    await tablet.mouse.move(
      (box?.x ?? 0) + (box?.width ?? 0) / 2,
      (box?.y ?? 0) + (box?.height ?? 0) / 2,
    );
    await tablet.mouse.down();
    await tablet.waitForTimeout(700);
    await tablet.mouse.up();

    await expect(tablet.getByTestId('layer-context')).toBeVisible();
  });
});

/** The same property one size up: a tablet, which is where it is most obvious. */
test.describe('a tablet is a touch device too', () => {
  test.use({ viewport: { width: 800, height: 1180 }, hasTouch: true, isMobile: false });

  test('800x1180 gets the touch editor, not the mouse’s', async ({ page: tablet }) => {
    await tablet.addInitScript(() => {
      localStorage.setItem('kraken-hub:v1:config:displaySeen', '1');
    });
    await tablet.goto('/?transport=fake&room=EDITM234');
    await tablet.getByTestId('rail-add').tap();
    await tablet.getByTestId('add-tile-clock').tap();
    await expect(tablet.getByTestId('editor-selection')).toBeVisible();

    await expect(tablet.getByTestId('editor-overlay')).toHaveAttribute('data-touch', 'true');
    const box = await tablet.getByTestId('editor-handle-rotate').evaluate((el) => ({
      width: Math.round(el.getBoundingClientRect().width),
      height: Math.round(el.getBoundingClientRect().height),
    }));
    expect(box.width).toBeGreaterThanOrEqual(TAP_PX);
    expect(box.height).toBeGreaterThanOrEqual(TAP_PX);

    const more = await tablet.getByTestId('ops-more').boundingBox();
    expect(more?.height ?? 0).toBeGreaterThanOrEqual(TAP_PX);
  });
});

// ---------------------------------------------------------------------------
// 6. The phone gets the phone's half of the panel — round 13
// ---------------------------------------------------------------------------

/**
 * The inspector mounts the module's real `ConfigPanel`, and the module's real
 * `ConfigPanel` was written for CAM.
 *
 * That is what makes the phone's editor the same editor, and it is also how the
 * audit found **"On this PC"**, a *Keep a copy* / *Stream only* row, a **Local
 * downloader** card with a port and a shared token, and a **"Get the
 * downloader"** button that opens a panel offering *Download for Windows* — all
 * on a phone that owns no storage, cannot run the program and has no PC in the
 * room to point the words at. Both vocabulary spines stayed green because
 * neither file was on their list.
 *
 * `ownsBytes` is the answer travelling with the panel. This measures the
 * rendered result rather than the import list, because the sentence is what the
 * reader gets.
 */
test.describe('the phone’s inspector never offers the owner’s controls', () => {
  test('the video panel on a phone has framing and quality, and no downloader', async ({
    context,
  }) => {
    const phone = await editingPhone(context, 'EDITN234');

    // Video is the default base, so `More` opens the video panel.
    await expect(phone.getByTestId('remote-strip')).toHaveAttribute('data-strip-kind', 'video');
    await phone.getByTestId('ops-more').tap();
    await expect(phone.getByTestId('remote-inspect')).toBeVisible();
    await expect(phone.getByTestId('inspect-options')).toBeVisible();

    // Every control whose subject is somebody else's disk. Counted in the DOM,
    // not on the screen: half of these live behind the Advanced disclosure, and
    // a control the reader can open is a control the reader has.
    const sheet = phone.getByTestId('remote-inspect');
    for (const owned of [
      'video-downloadmode-auto',
      'video-downloadmode-stream-only',
      'downloader-check',
      'resolver-get',
      'video-proxy-on',
      'video-proxy-off',
    ]) {
      await expect(sheet.getByTestId(owned), `${owned} is the owner's control`).toHaveCount(0);
    }
    for (const id of ['#video-resolver-port', '#video-resolver-token', '#video-proxy-base']) {
      await expect(sheet.locator(id)).toHaveCount(0);
    }

    // …and the machine's own nouns, as words on the screen.
    const words = (await sheet.innerText()).toLowerCase();
    for (const noun of ['this pc', 'this computer', 'the disk', 'download for windows']) {
      expect(words, `the phone was told about "${noun}"`).not.toContain(noun);
    }

    // What SHOULD be here is still here: the picture's own settings.
    await expect(sheet.getByTestId('video-advanced')).toBeVisible();
    await expect(sheet.locator('#video-yt-aspect-label')).toHaveCount(1);
  });

  /**
   * Source on an OVERLAY — the audit's finding 4.
   *
   * The paste row under the canvas speaks for `activeModuleId`, which is the
   * base. Pressing Source on an image overlay above a video base closed the
   * editor and focused a field labelled *"Paste a video link"* whose submit
   * writes the base's link. An overlay carries its own config, so its controls
   * are in its own panel.
   */
  test('Source on an overlay opens that layer’s panel, not the base’s field', async ({
    context,
  }) => {
    const phone = await editingPhone(context, 'EDITP234');

    await phone.getByTestId('remote-add-layer').tap();
    await phone.getByTestId('add-tile-image').tap();
    await expect(phone.getByTestId('remote-strip')).toHaveAttribute('data-strip-kind', 'image');

    await phone.getByTestId('ops-source-button').tap();

    // The editor stayed, and the layer's own panel opened.
    await expect(phone.getByTestId('remote-editor')).toBeVisible();
    await expect(phone.getByTestId('remote-inspect')).toBeVisible();
    await expect(phone.getByTestId('inspect-options')).toBeVisible();
    // …rather than the base's field, with the base's word on it.
    await expect(phone.locator('#remote-src')).toHaveCount(0);
  });

  /** …while the BASE's Source still leaves onto the real paste row. */
  test('Source on the base still lands on the paste row', async ({ context }) => {
    const phone = await editingPhone(context, 'EDITQ234');

    await expect(phone.getByTestId('remote-strip')).toHaveAttribute('data-strip-kind', 'video');
    await phone.getByTestId('ops-source-button').tap();

    await expect(phone.getByTestId('remote-editor')).toHaveCount(0);
    const src = phone.locator('#remote-src');
    await expect(src).toBeFocused();
    await expect(src).toHaveAttribute('placeholder', /video link/i);
  });
});
