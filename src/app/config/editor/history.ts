/**
 * Undo: a 50-entry ring of `Look` snapshots, per editing surface.
 *
 * Snapshots rather than inverse operations, because a look is ≤ 3 kB and 50 of
 * them is a rounding error next to one video frame — and because an inverse-op
 * stack has to be right about every op forever, while a snapshot stack is right
 * by construction.
 *
 * Never synced, never persisted. Undo is a property of the window you are
 * editing in, not of the document: two CAM browsers editing the same Kraken each
 * have their own history, and neither can undo the other's work by accident.
 *
 * **A remote change becomes an entry.** When the phone (or the other browser)
 * changes the look, it is pushed like any local edit and the redo stack is
 * cleared. The alternative — treating it as an interruption to be re-applied
 * over — is a merge, and this document is last-writer-wins by design (§11.9).
 * So undoing after somebody else edited walks back through THEIR change, which
 * is honest: it is what actually happened to the panel.
 *
 * One entry per gesture: `gesture.ts` produces one `Look` on release and the
 * caller pushes it once (§8).
 *
 * See docs/design/design-layers-architecture.md §8.
 */

import { lookBytes, type Look } from '../../../state/look/types';

export const HISTORY_LIMIT = 50;

/** Where a look change came from. Only `'local'` is the caller's own edit. */
export type LookChangeOrigin = 'local' | 'sync' | 'storage';

/**
 * The store seam. The real binding (W5) is
 * `getLook: () => selectLook(store.getSnapshot())`,
 * `setLook: (l) => store.commit((s) => withLook(s, l))`, and `subscribe` over
 * `store.onCommit` + the storage watcher. Kept as a port so the model stays
 * DOM-free and testable without a store.
 */
export interface LookHistoryStore {
  getLook: () => Look;
  setLook: (look: Look) => void;
  /** Optional: without it, remote changes simply never become entries. */
  subscribe?: (cb: (look: Look, origin: LookChangeOrigin) => void) => () => void;
}

export interface LookHistory {
  /** Record an edit that has ALREADY been committed. Clears redo. */
  push: (look: Look) => void;
  undo: () => boolean;
  redo: () => boolean;
  canUndo: () => boolean;
  canRedo: () => boolean;
  /** How many undo steps are available. Test seam; not for UI copy. */
  depth: () => number;
  dispose: () => void;
}

function same(a: Look, b: Look): boolean {
  if (a === b) return true;
  // Looks are ≤ MAX_LOOK_BYTES and this runs on a click, never per frame.
  return lookBytes(a) === lookBytes(b) && JSON.stringify(a) === JSON.stringify(b);
}

export function createLookHistory(
  store: LookHistoryStore,
  opts: { limit?: number } = {},
): LookHistory {
  const limit = Math.max(1, Math.trunc(opts.limit ?? HISTORY_LIMIT));
  const past: Look[] = [];
  const future: Look[] = [];
  let present: Look = store.getLook();

  const push = (look: Look): void => {
    if (same(look, present)) return;
    past.push(present);
    // A ring: the 51st push drops the oldest reachable state, it does not
    // refuse the edit.
    if (past.length > limit) past.shift();
    future.length = 0;
    present = look;
  };

  const step = (from: Look[], to: Look[]): boolean => {
    const next = from.pop();
    if (next === undefined) return false;
    to.push(present);
    present = next;
    store.setLook(next);
    return true;
  };

  const unsubscribe =
    store.subscribe?.((look, origin) => {
      // A local commit is pushed explicitly by the caller (it knows whether the
      // change was one gesture or one op). Our own undo/redo write echoes back
      // as a change equal to `present`, and `push` ignores it.
      if (origin === 'local') return;
      push(look);
    }) ?? null;

  return {
    push,
    undo: () => step(past, future),
    redo: () => step(future, past),
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    depth: () => past.length,
    dispose: () => {
      unsubscribe?.();
    },
  };
}
