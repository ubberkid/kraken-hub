/**
 * The phone editor, on the phone's own terms.
 *
 * Three properties, and every one of them is a rule this wave could quietly
 * have broken:
 *
 *  1. **It edits the same Look through the same store.** Adding a layer is a
 *     commit; Undo is `lookHistoryStore` walking that commit back. Asserted on
 *     the STORE rather than on the DOM, because the DOM would look identical if
 *     the phone had grown its own private copy of the document.
 *  2. **It is still a remote.** No file input, no drop target, no library — the
 *     surface gate (`surface.test.ts`) is a rule about a boolean, and this is
 *     the same rule about the pixels the boolean is supposed to govern.
 *  3. **It says only what it may say.** The arrangement claim renders in the
 *     tense `lookReach` allows — which since W1c depends on whether the room is
 *     actually connected, not on which browser this is. A phone that cannot
 *     deliver still never reaches the live tense.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultAppState } from '../../../../state/defaults';
import { createStore, type Store } from '../../../../state/store';

import { RemoteEditor } from './RemoteEditor';

import type { ConfigRuntime } from '../../runtime';
import type { RemoteRingProps } from '../RemoteRing';

/** A panel the display has REPORTED — the canvas refuses to exist without one. */
const RING: Omit<RemoteRingProps, 'sizePx'> = {
  moduleId: 'video',
  config: null,
  render: defaultAppState().render,
  display: { w: 640, h: 640, shape: 'circle', targetFps: 30 },
  monitor: null,
  monitorAt: 0,
  posterUrl: null,
  name: '',
  progress: null,
  held: false,
};

let host: HTMLDivElement;
let root: Root;
let store: Store;
let runtime: ConfigRuntime;

/**
 * A phone: `camDetected` false, `role` remote — the pair `ownsBytes` refuses.
 *
 * Stated as the two signals rather than as a flag, because that is what the
 * real surface gate reads and a test that stubbed the answer would be testing
 * its own stub.
 */
function phoneRuntime(): ConfigRuntime {
  return {
    store,
    role: 'remote',
    camDetected: false,
    persisted: {},
    url: {},
    phoneOverride: true,
    appUrl: 'https://example.test/',
  };
}

/** Whether the room this phone is in is joined AND up — `lookReach.delivers`. */
let delivers = false;

/** Every `onDone` this render has been asked for, in order. */
let escapes: (string | undefined)[] = [];

function draw(): void {
  act(() => {
    root.render(
      <RemoteEditor
        runtime={runtime}
        delivers={delivers}
        state={store.getSnapshot()}
        presence="live"
        ring={RING}
        onDone={(wanted) => {
          escapes.push(wanted);
        }}
      />,
    );
  });
}

beforeEach(() => {
  // The overlay asks for pointer capture on every grab; jsdom may not have it.
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto['setPointerCapture'] ??= () => undefined;
  proto['releasePointerCapture'] ??= () => undefined;
  // The inspector scrolls to the section the strip asked for; jsdom has no
  // layout and therefore no `scrollIntoView`.
  proto['scrollIntoView'] ??= () => undefined;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  store = createStore(defaultAppState(), 'remote');
  runtime = phoneRuntime();
  delivers = false;
  escapes = [];
  draw();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  localStorage.clear();
});

function click(testId: string): void {
  const el = host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  expect(el, `no control called ${testId}`).not.toBeNull();
  act(() => {
    el?.click();
  });
  // The component renders from the caller's snapshot, exactly as `RemoteView`
  // hands it one, so a commit is followed by a redraw here too.
  draw();
}

/** A transform at rest — what a layer without one would wear. */
const T0 = { x: 0, y: 0, s: 1, r: 0, a: 1 };

/**
 * One finger, on the overlay, in the overlay's own arithmetic.
 *
 * The conversion is `EditorOverlay`'s, backwards: units → panel px → stage px
 * through `k`. jsdom's rectangle is at the origin with zero size, which is
 * exactly what `toPanel` divides by `k` — so the numbers here are the ones a
 * finger on a 300 px ring would produce.
 */
function drag(
  panel: { width: number; height: number; radiusPx: number },
  t: { x: number; y: number },
  by: { dx: number; dy: number },
): void {
  const svg = host.querySelector('[data-testid="editor-overlay"]');
  expect(svg).not.toBeNull();
  const k = 300 / panel.width;
  const from = {
    x: (panel.width / 2 + t.x * panel.radiusPx) * k,
    y: (panel.height / 2 + t.y * panel.radiusPx) * k,
  };
  const send = (type: string, x: number, y: number): void => {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    svg?.dispatchEvent(event);
  };
  act(() => {
    send('pointerdown', from.x, from.y);
    send('pointermove', from.x + by.dx / 2, from.y + by.dy / 2);
    send('pointermove', from.x + by.dx, from.y + by.dy);
    send('pointerup', from.x + by.dx, from.y + by.dy);
  });
  draw();
}

describe('the phone edits the same Look', () => {
  it('draws the ring, with the editor’s overlay above it', () => {
    expect(host.querySelector('[data-testid="remote-mirror"]')).not.toBeNull();
    const overlay = host.querySelector('[data-testid="editor-overlay"]');
    expect(overlay).not.toBeNull();
    // The overlay is the desktop's, in touch mode — the whole point of the
    // split. A `false` here means the phone got the mouse's handles.
    expect(overlay?.getAttribute('data-touch')).toBe('true');
  });

  it('adds a layer to the DOCUMENT, not to a copy of it', () => {
    expect(store.getSnapshot().look.layers).toHaveLength(1);
    click('remote-add-layer');
    click('add-tile-clock');
    expect(store.getSnapshot().look.layers).toHaveLength(2);
    expect(store.getSnapshot().look.layers[1]?.kind).toBe('clock');
  });

  /**
   * Undo, through the store, on the phone surface.
   *
   * `createStoreLookHistory` is the seam and its origin mapping is the part
   * that goes wrong silently: a local commit recorded as a remote change is an
   * edit that cannot be undone, and it looks perfectly fine until somebody
   * presses the button.
   */
  it('undoes and redoes that layer through the same history', () => {
    click('remote-add-layer');
    click('add-tile-clock');
    expect(store.getSnapshot().look.layers).toHaveLength(2);

    click('remote-undo');
    expect(store.getSnapshot().look.layers).toHaveLength(1);

    click('remote-redo');
    expect(store.getSnapshot().look.layers).toHaveLength(2);
    expect(store.getSnapshot().look.layers[1]?.kind).toBe('clock');
  });

  /**
   * Add, drag, undo — the phone's journey, as TWO entries.
   *
   * The e2e asserts this on a real iPhone; this is the same property in jsdom,
   * where it can say WHICH step went missing. One gesture is one entry (§8), so
   * a drag after an add must leave two of them: the first undo puts the layer
   * back where the add placed it, and only the second takes the layer away.
   */
  it('records the drag as its own entry, so one undo is one gesture', async () => {
    const { replicaGeometry } = await import('../../replica');
    click('remote-add-layer');
    click('add-tile-clock');
    const added = store.getSnapshot().look.layers[1];
    expect(added).toBeDefined();
    const before = JSON.stringify(added?.t);

    drag(replicaGeometry(RING.display, store.getSnapshot().render), added?.t ?? T0, {
      dx: -40,
      dy: -30,
    });
    expect(JSON.stringify(store.getSnapshot().look.layers[1]?.t)).not.toBe(before);

    click('remote-undo');
    // One undo is one gesture: the layer is still there, back where it landed.
    expect(store.getSnapshot().look.layers).toHaveLength(2);
    expect(JSON.stringify(store.getSnapshot().look.layers[1]?.t)).toBe(before);

    click('remote-undo');
    expect(store.getSnapshot().look.layers).toHaveLength(1);
  });

  /**
   * The strip is the DECLARED strip — reused, not re-listed.
   *
   * `SelectionStrip` renders the kind's declared strip, so the assertion is
   * that the phone shows the same controls the module declares: every rendered
   * `ops-*` id belongs to the selected kind's own strip, and there are as many
   * of them as the module declares. A phone-shaped fork would drift from this
   * within one wave.
   */
  it('shows the selected layer’s own declared strip and nothing else', async () => {
    const { getModule } = await import('../../../../modules/registry');
    const kind = store.getSnapshot().look.layers[0]?.kind ?? '';
    const declared = (await getModule(kind)?.editor?.loadStrip())?.strip ?? [];
    expect(declared.length).toBeGreaterThan(0);

    const strip = host.querySelector('[data-testid="remote-strip"]');
    const rendered: string[] = [];
    for (const el of strip?.querySelectorAll('[data-testid^="ops-"]') ?? []) {
      const id = el.getAttribute('data-testid') ?? '';
      // A control is a wrapper plus a control, and two of them (`more`, the
      // actions) put an id on both. The strip is a SEQUENCE, so the dedupe is
      // "not the one before it" rather than a set: a kind that genuinely
      // declared the same control twice would still be visible here.
      //
      // `ops-scroll` is the row's own scroll box, not a control — round 11's
      // F-3 split the strip into a scroller and a pinned `More` so the door to
      // the inspector cannot scroll off the screen. It is skipped by name
      // rather than by shape, so a kind that ever declared a control called
      // `scroll` would still be checked.
      if (id === 'ops-scroll' || id.endsWith('-button') || rendered.at(-1) === id) continue;
      rendered.push(id);
    }
    expect(rendered).toEqual(declared.map((c) => `ops-${c.id}`));
  });
});

/**
 * Make `kind` the background, and wait for its strip chunk.
 *
 * `SelectionStrip` fetches the kind's own declaration on first selection, so a
 * render taken before that lands shows `ops-loading` and no controls at all —
 * which is exactly what a test that pressed a button too early would report as
 * "there is no Preset button".
 */
async function baseKind(kind: string): Promise<void> {
  const { withBaseKind } = await import('../../../state/switchBase');
  const { getModule } = await import('../../../../modules/registry');
  act(() => {
    store.commit((s) => withBaseKind(s, kind));
  });
  await getModule(kind)?.editor?.loadStrip();
  draw();
}

describe('the strip’s deeper controls land somewhere', () => {
  /**
   * The finding, as a test.
   *
   * On the effect module — the default background of half the templates —
   * `Effect`, `Preset` and `Colours` are `control: 'action'`, and on the phone
   * every one of them called `escape('more')`, which closed the editor and
   * opened nothing. The catalogue, the preset chips and the colour wells were
   * unreachable at any number of presses. The property is stated in both
   * directions: the inspector is up, AND the editor was not asked to leave.
   */
  it('opens the inspector instead of closing the editor', async () => {
    await baseKind('effect');
    expect(host.querySelector('[data-testid="ops-preset-button"]')).not.toBeNull();

    click('ops-preset-button');
    expect(host.querySelector('[data-testid="remote-inspect"]')).not.toBeNull();
    expect(escapes, 'a preset must not close the editor').toEqual([]);
  });

  it('opens it from Effect and Colours too, and Done gives the canvas back', async () => {
    await baseKind('effect');
    for (const id of ['ops-effect-button', 'ops-colours-button']) {
      click(id);
      expect(host.querySelector('[data-testid="remote-inspect"]')).not.toBeNull();
      click('remote-inspect-done');
      expect(host.querySelector('[data-testid="remote-inspect"]')).toBeNull();
    }
    expect(escapes).toEqual([]);
  });

  /**
   * The inspector is the SAME sheet, with the kind's own panel inside it.
   *
   * `loadConfigPanel` is the desktop's cache, so warming it is warming the one
   * the sheet reads; what is asserted is that the effect catalogue itself is on
   * the phone's screen, which is the thing the user could not reach.
   */
  it('renders the kind’s own ConfigPanel inside it', async () => {
    const { loadConfigPanel } = await import('../configPanels');
    await baseKind('effect');
    await loadConfigPanel('effect');
    click('ops-preset-button');
    draw();

    expect(host.querySelector('[data-testid="inspect-layout"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="inspect-options"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="inspect-visibility"]')).not.toBeNull();
    // The twelve-tile picker, on a 390 px screen at last.
    expect(host.querySelector('[data-testid="effect-pick-plasma"]')).not.toBeNull();
    expect(host.querySelector('#effect-preset')).not.toBeNull();
  });

  /**
   * …and the three that genuinely live on the page below still leave, saying
   * which one they meant. `RemoteView` scrolls onto them; the property here is
   * that the intent is not dropped, which is what `'more'` used to do to loop
   * and quality.
   */
  it('still leaves for the controls the remote itself owns', async () => {
    await baseKind('video');
    click('ops-source-button');
    click('ops-loop-button');
    click('ops-quality-button');
    expect(escapes).toEqual(['source', 'loop', 'quality']);
    expect(host.querySelector('[data-testid="remote-inspect"]')).toBeNull();
  });

  it('opens at the top for More, and at the panel for an action', async () => {
    await baseKind('effect');
    click('ops-more');
    expect(host.querySelector('[data-testid="remote-inspect"]')).not.toBeNull();
    expect(escapes).toEqual([]);
  });
});

describe('the phone is still a remote', () => {
  /**
   * The surface gate, as pixels.
   *
   * `ownsBytes` is false here, and the property that matters is not that the
   * function returned false — `surface.test.ts` owns that — but that nothing on
   * this screen offers to move bytes anyway. Enumerated rather than listed: any
   * file input at all fails, whatever it is called.
   */
  it('offers nothing that would put bytes in the wrong browser', () => {
    click('remote-add-layer');
    expect(host.querySelectorAll('input[type="file"]')).toHaveLength(0);
    expect(host.querySelector('[data-testid="library"]')).toBeNull();
    expect(host.querySelector('[data-testid="library-add"]')).toBeNull();
    expect(host.querySelector('[data-testid="drop-target"]')).toBeNull();
    expect(host.textContent).not.toContain('Browse');
  });

  /**
   * …including the inspector, which is the surface round 13 added.
   *
   * The sheet hosts the kind's own `ConfigPanel`, and the image kind's panel is
   * the one that could plausibly grow a picker into CAM's library. Enumerated
   * the same way as the sweep above rather than by naming a component: what
   * matters is that no file input, no library and no "Browse" reached this
   * screen, whatever put it there.
   */
  it('keeps the inspector free of anything that would move bytes', async () => {
    for (const kind of ['image', 'video', 'effect']) {
      await baseKind(kind);
      click('ops-more');
      expect(host.querySelector('[data-testid="remote-inspect"]')).not.toBeNull();
      expect(host.querySelectorAll('input[type="file"]')).toHaveLength(0);
      expect(host.querySelector('[data-testid="library"]')).toBeNull();
      expect(host.querySelector('[data-testid="library-add"]')).toBeNull();
      expect(host.querySelector('[data-testid="drop-target"]')).toBeNull();
      expect(host.textContent).not.toContain('Browse');
      click('remote-inspect-done');
    }
  });

  /**
   * Looks, on the phone, are DOCUMENTS — and the sheet says where they live.
   *
   * Save / rename / favourite / delete are rows in this device's own
   * namespaced storage, so they are allowed here; import, export and the
   * gallery download are files, so they are not. The sentence is asserted
   * because "Saved on this phone" is the honesty the feature rests on.
   */
  it('keeps Looks to what a phone may honestly do with them', () => {
    click('remote-looks-button');
    const yours = host.querySelector<HTMLButtonElement>('[data-testid="remote-looks-tab-yours"]');
    expect(yours).not.toBeNull();
    act(() => {
      yours?.click();
    });
    draw();

    expect(host.querySelector('[data-testid="remote-looks-save"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="remote-looks-where"]')?.textContent).toContain(
      'Saved on this phone',
    );
    expect(host.querySelectorAll('input[type="file"]')).toHaveLength(0);
    expect(host.textContent).not.toContain('Export');
    expect(host.textContent).not.toContain('Import');
  });

  it('saves a copy into this device’s own store, and can delete it again', async () => {
    const { readLooksDoc } = await import('../../editor/looksStore');
    click('remote-looks-button');
    const yours = host.querySelector<HTMLButtonElement>('[data-testid="remote-looks-tab-yours"]');
    act(() => {
      yours?.click();
    });
    draw();

    click('remote-looks-save');
    const field = host.querySelector<HTMLInputElement>('[data-testid="remote-save-name"]');
    expect(field).not.toBeNull();
    /*
      React tracks a controlled input's last value on the node, so assigning
      `.value` and firing `input` is swallowed as "nothing changed". The native
      setter is the documented way past that, and it is what makes this a real
      keystroke rather than a call to the handler.
    */
    act(() => {
      if (field === null) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        field,
        'On the sofa',
      );
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    draw();
    click('remote-save-confirm');

    const saved = readLooksDoc().looks;
    expect(saved).toHaveLength(1);
    expect(saved[0]?.file.name).toBe('On the sofa');

    const id = saved[0]?.id ?? '';
    // Delete confirms — the first press arms it, the second does it.
    click(`remote-del-${id}`);
    expect(readLooksDoc().looks).toHaveLength(1);
    click(`remote-del-${id}`);
    expect(readLooksDoc().looks).toHaveLength(0);
  });

  it('never claims the Kraken has an arrangement it cannot deliver', () => {
    const claim = host.querySelector('[data-testid="remote-edit-claim"]');
    expect(claim).not.toBeNull();
    /*
     * `presence="live"` went IN and the claim is still demoted, because the
     * room is not connected (`delivers: false`). This is the property W1c did
     * NOT make obsolete: the wire carrying looks is not the same fact as the
     * wire being up, and a phone with a joined-but-offline room delivers
     * nothing.
     */
    expect(claim?.getAttribute('data-presence')).toBe('quiet');
    expect(claim?.textContent).not.toContain('has this arrangement');
  });

  /**
   * …and the other half of W1c: a phone that CAN deliver says so.
   *
   * Before the wire carried `look` this was unreachable on a phone at any
   * setting — `delivers` was `ownsBytes(runtime)`, which is false here by
   * construction — so the live sentence in `CLAIM_ARRANGEMENT` was three
   * registered strings nothing could render. It is the ordinary case now.
   */
  it('says the Kraken has the arrangement once the room is connected', () => {
    delivers = true;
    draw();
    const claim = host.querySelector('[data-testid="remote-edit-claim"]');
    expect(claim?.getAttribute('data-presence')).toBe('live');
    expect(claim?.textContent).toContain('has this arrangement');
  });
});
