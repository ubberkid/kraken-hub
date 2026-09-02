/**
 * The seam `history.ts` was written against, bound to the real store.
 *
 * `createLookHistory` takes a `LookHistoryStore` port — `getLook`, `setLook`,
 * `subscribe` — precisely so the undo model could be finished and tested before
 * a store existed. This is the twelve lines that plug it in, and they are worth
 * their own file for one reason: WHICH look a change is.
 *
 * `history.ts` pushes anything that is not `'local'` as an entry and clears redo
 * (§8: a change this window did not make becomes an entry, because the document
 * is last-writer-wins and undoing after somebody else edited walks back through
 * THEIR change, which is what actually happened to the panel). What the seam
 * owes it is the look the document SETTLED on — and that is the whole of the
 * subtlety, because a store snapshot read at the wrong moment is neither.
 *
 * ## The torn read, and why an entry is deferred by one microtask
 *
 * `store.commit` fires the storage bus SYNCHRONOUSLY (see `store.ts`), so this
 * page's own write comes back through `watchState` and re-resolves the snapshot
 * BEFORE `commit` has assigned the result of its own mutation. For one turn of
 * the loop the snapshot is an intermediate value that the commit in flight is
 * about to overwrite. On CAM that intermediate happens to be the same document,
 * so nobody noticed. On the phone it is not: the sync layer's resolve puts the
 * ROOM's leaves back on top, and the room has not heard about the edit being
 * committed yet — so the intermediate look is the document as it was one edit
 * ago. Recorded as an entry, that is a stack with a stale state wedged into it:
 * add a layer, drag it, press undo once, and the layer is gone, because the
 * entry the undo landed on was the pre-add look rather than the post-add one.
 *
 * So every notification is coalesced into one flush on the microtask after the
 * turn that raised it, and the flush reports `getSnapshot()` — the look the
 * document settled on, once the commit that was in flight has finished. Nothing
 * else changes: an edit this page's caller has already pushed is reported too,
 * and `history.push` ignores it, because a push of the look that is already
 * `present` is not an entry. That idempotence is what lets this seam report the
 * settled document and nothing but, without having to know whose write it was —
 * including a look-changing `store.commit` made by a view that is not the
 * editor (a background switch from the add sheet), which has always been one
 * undo press and stays one.
 */

import { withBaseKind } from '../../state/switchBase';

import { createLookHistory, type LookHistory } from './history';

import type { Look } from '../../../state/look/types';
import type { Store } from '../../../state/store';

/**
 * An undo stack over the document's `look`.
 *
 * One per editing surface, never synced, never persisted — two CAM browsers
 * editing the same Kraken each have their own, and neither can undo the other's
 * work by accident.
 */
export function createStoreLookHistory(store: Store, limit?: number): LookHistory {
  return createLookHistory(
    {
      getLook: () => store.getSnapshot().look,
      /**
       * Undo and redo write the base kind BOTH ways round, through the one
       * helper allowed to (`switchBase.ts`).
       *
       * A plain `{ ...s, look }` is silently reverted whenever the step being
       * undone changed the base KIND: `validateAppState` rewrites
       * `look.layers[0].kind` from `activeModuleId` for this release, so an undo
       * that restores a look with an effect base while the flat field still says
       * `clock` gets its base rewritten back to `clock` on the way to storage —
       * and the user presses undo, watches the panel not change, and presses it
       * again.
       *
       * `withBaseKind` runs first and the restored look is written over the top,
       * for the same reason `useEditor.applyLook` does it in that order: the
       * helper settles the mirrored field, and the look that comes back out of
       * the undo stack is the one the user is owed, layer names and all.
       */
      setLook: (look: Look) => {
        store.commit((s) => {
          const kind = look.layers[0]?.kind;
          return { ...(kind === undefined ? s : withBaseKind(s, kind)), look };
        });
      },
      subscribe: (cb) => {
        let last = store.getSnapshot().look;
        let pending = false;
        let live = true;

        /** The look the document settled on, once the turn is over. */
        const flush = (): void => {
          pending = false;
          if (!live) return;
          const look = store.getSnapshot().look;
          if (look === last) return;
          last = look;
          cb(look, 'storage');
        };

        /*
         * `store.subscribe` fires for EVERY snapshot change — a commit this page
         * made, a document that arrived from the other CAM browser or the
         * display, a re-resolve by the sync layer. One flush covers the lot:
         * whatever the turn did, what the user is looking at afterwards is one
         * document, and one document is one entry.
         *
         * The flush is queued from the first notification of the turn and reads
         * the snapshot fresh, so the intermediate values in between — including
         * the torn one every `commit` publishes on its way through storage — are
         * never the look that gets recorded.
         */
        const offSnapshot = store.subscribe(() => {
          if (pending) return;
          pending = true;
          queueMicrotask(flush);
        });
        return () => {
          live = false;
          offSnapshot();
        };
      },
    },
    limit === undefined ? {} : { limit },
  );
}
