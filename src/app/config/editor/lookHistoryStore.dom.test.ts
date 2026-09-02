/**
 * The seam, against a REAL store — and against the one moment it lies.
 *
 * `history.test.ts` owns the model over a fake port. What it cannot see is the
 * store's own publishing order: `commit` fires the storage bus synchronously,
 * so the snapshot goes through an intermediate value on its way to the one the
 * commit is actually writing. With the sync layer's resolve installed, that
 * intermediate is the ROOM's document — the look as it was BEFORE this edit,
 * because the room has not heard about it yet.
 *
 * Recorded as an entry, it is a stale state wedged into the stack: on the phone
 * it turned "add a layer, drag it, press undo" into a layer that vanished
 * instead of a layer that went back where the add had put it. So this file is
 * one property said twice — one entry per edit, and the entry is the document
 * the edit settled on.
 */

import { describe, expect, it } from 'vitest';

import { defaultAppState } from '../../../state/defaults';
import { createStore } from '../../../state/store';

import { testRegistry } from './__fixtures__/placements';
import { createStoreLookHistory } from './lookHistoryStore';
import { addLayer, setTransform } from './ops';

import type { Look } from '../../../state/look/types';
import type { AppState } from '../../../state/schema';
import type { Store } from '../../../state/store';

/**
 * The same look with one overlay added — the ordinary edit, in one call.
 *
 * An overlay rather than the base, because the base's transform is the identity
 * by law (`look/validate.ts`): a commit that moved the base would be written
 * back unmoved, and the test would be measuring the validator.
 */
function withOverlay(look: Look): Look {
  const added = addLayer(look, 'clock', testRegistry);
  if (!added.ok) throw new Error(added.reason);
  return added.look;
}

/** …and that overlay, moved. The journey the phone's bug was found on. */
function moved(look: Look, x: number): Look {
  const id = look.layers[1]?.id;
  if (id === undefined) throw new Error('no overlay to move');
  return setTransform(look, id, { x });
}

/** Where the overlay ended up, or `null` when there is no overlay at all. */
function overlayX(look: Look): number | null {
  return look.layers[1]?.t.x ?? null;
}

/** What `useEditor.commitLook` does: one commit, then one push. */
function commitLook(store: Store, history: { push: (l: Look) => void }, look: Look): void {
  store.commit((s) => ({ ...s, look }));
  history.push(store.getSnapshot().look);
}

/** Let the seam settle — it reports on the microtask after the turn. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('the undo stack over a real store', () => {
  it('records one entry per edit, even while a stale document is being resolved', async () => {
    localStorage.clear();
    const store = createStore(defaultAppState(), 'remote');
    const history = createStoreLookHistory(store);
    const start = store.getSnapshot().look;

    /*
     * The sync layer, as it behaves between an edit and the room hearing about
     * it: every document that arrives from storage is re-resolved with the
     * room's leaves on top, and the room still has the look this page started
     * from. `commit` publishes exactly this snapshot on its way past storage.
     */
    const room = store.getSnapshot();
    store.setResolve((): AppState => room);

    // The add.
    const added = withOverlay(start);
    commitLook(store, history, added);
    await settle();
    expect(history.depth(), 'the add is one entry, not two').toBe(1);

    // …and the drag, on the layer the add put there.
    commitLook(store, history, moved(added, 0.2));
    await settle();
    expect(history.depth(), 'the drag is the second entry').toBe(2);

    // One press, one gesture: the layer is still there, where the add left it —
    // not the document as it was before either of them.
    expect(history.undo()).toBe(true);
    expect(store.getSnapshot().look.layers).toHaveLength(2);
    expect(overlayX(store.getSnapshot().look)).toBe(added.layers[1]?.t.x ?? null);

    expect(history.undo()).toBe(true);
    expect(store.getSnapshot().look).toEqual(start);

    history.dispose();
    store.dispose();
  });

  /**
   * …and the other half, which the fix must not cost: a look-changing commit
   * that NOBODY pushed is still an entry.
   *
   * A background switch from the add sheet is `store.commit` in a view that is
   * not the editor (`HomeView`, `RemoteEditor`), and one undo press has always
   * put it back. It is the settled document that gets recorded, so it still is.
   */
  it('records a look-changing commit that the caller never pushed', async () => {
    localStorage.clear();
    const store = createStore(defaultAppState(), 'remote');
    const history = createStoreLookHistory(store);
    const start = store.getSnapshot().look;

    store.commit((s) => ({ ...s, look: withOverlay(start) }));
    await settle();

    expect(history.depth()).toBe(1);
    expect(history.undo()).toBe(true);
    expect(store.getSnapshot().look).toEqual(start);

    history.dispose();
    store.dispose();
  });

  /** A document that ARRIVED is an entry too — §8, and the reason for the seam. */
  it('records a document that arrived from somewhere else', async () => {
    localStorage.clear();
    const store = createStore(defaultAppState(), 'remote');
    const history = createStoreLookHistory(store);
    const start = store.getSnapshot().look;

    store.replace({ ...store.getSnapshot(), look: withOverlay(start) });
    await settle();

    expect(history.depth()).toBe(1);
    expect(history.undo()).toBe(true);
    expect(store.getSnapshot().look).toEqual(start);

    history.dispose();
    store.dispose();
  });
});
