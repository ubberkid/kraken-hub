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

function draw(): void {
  act(() => {
    root.render(
      <RemoteEditor
        runtime={runtime}
        delivers={delivers}
        state={store.getSnapshot()}
        presence="live"
        ring={RING}
        onDone={() => undefined}
      />,
    );
  });
}

beforeEach(() => {
  // The overlay asks for pointer capture on every grab; jsdom may not have it.
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto['setPointerCapture'] ??= () => undefined;
  proto['releasePointerCapture'] ??= () => undefined;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  store = createStore(defaultAppState(), 'remote');
  runtime = phoneRuntime();
  delivers = false;
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
