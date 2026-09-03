/**
 * The store React binds to.
 *
 * `getSnapshot` returns a stable reference until something actually changes, so
 * `useSyncExternalStore` does not tear or loop. Invariant I4: a notification
 * raised from inside a `FrameClock` tick is a bug (per-frame work must write to
 * the DOM directly, never through React) — the DEV guard below catches it.
 */

import { createLogger } from '../lib/log';
import { isInFrame } from '../platform/fpsGovernor';

import { resolveState } from './precedence';
import { type AppState, type DeepPartial, type Role } from './schema';
import { commit as commitToStorage, watchState } from './storage';

const log = createLogger('state/store');

/**
 * Who asked for a `commit()`, and it is not bookkeeping.
 *
 * `'local'` is a person: a click, a slider, a pasted link. `'sync'` is this
 * page writing down what a PEER said, which the display does on every remote
 * frame when `persistRemote` is on.
 *
 * The distinction exists because `src/sync/appSync.ts` folds every local commit
 * into its `local` precedence layer — the layer whose entire job is to protect
 * a user's edit from a stale replay. Without an origin, the write that persists
 * a remote frame looks exactly like the click it may have just overwritten, so
 * the layer ends up defending the very value it was supposed to lose to. That
 * is not hypothetical: it is the second half of the "it flips back to Video"
 * bug (`src/sync/roomConvergence.dom.test.ts`), and it is what made the revert
 * permanent instead of momentary.
 */
export type CommitOrigin = 'local' | 'sync';

export interface Store {
  /** Function properties, not methods: React passes these around unbound. */
  getSnapshot: () => AppState;
  subscribe: (listener: () => void) => () => void;
  commit: (mutate: (s: AppState) => AppState, meta?: { origin?: CommitOrigin }) => AppState;
  /** Replace the snapshot without persisting — used for the resolved URL/remote layers. */
  replace: (next: AppState) => void;
  /**
   * Fires ONLY for a `commit()` — a deliberate local write — and never for a
   * `replace()` or a document arriving from storage.
   *
   * `subscribe()` cannot answer this: it fires for every snapshot change, and
   * the difference between "this page decided something" and "this page was
   * told something" is exactly what the sync layer needs to know. Without it, a
   * local edit is indistinguishable from an echo of a remote one, and the
   * precedence layers cannot tell which of the two is newer — which is how a
   * stale remote snapshot silently rolls back a setting the user just changed.
   *
   * The `origin` argument draws the same line one level finer: a `'sync'`
   * commit IS a write this page made, but it is not a decision this page took.
   */
  onCommit: (
    listener: (next: AppState, origin: CommitOrigin, before: AppState) => void,
  ) => () => void;
  /**
   * How a document that arrived FROM STORAGE becomes this page's snapshot.
   *
   * Installed by `src/sync/appSync.ts`, which is the only thing that holds the
   * precedence layers, and `null` when no sync layer is running.
   *
   * It exists because the other CAM browser writes to the same document, and
   * the display writes to it about twice a second whenever `persistRemote` is
   * on. Without a resolver, every one of those writes replaced this page's
   * carefully resolved snapshot with the RAW stored document — dropping the
   * `remote`, `local` and `url` layers on the floor — and the config page then
   * republished that raw document as its own desire, laundering a value the
   * user had just overridden back onto the wire. That is the loop behind
   * "everything repaints every two seconds", and it is why a stale `video`
   * could come back for good after a single late frame.
   *
   * Deliberately NOT applied to `commit()`: a commit is this page DECIDING
   * something, and `local` still holds the previous value of the very key being
   * changed, so resolving a commit through it would mask the new value with the
   * old one. A document from storage is this page being TOLD something, which
   * is exactly the case the layers exist to arbitrate.
   */
  setResolve: (resolve: ((persisted: AppState) => AppState) | null) => void;
  dispose: () => void;
}

export interface StoreOptions {
  /**
   * What a `commit()` mutation is applied TO.
   *
   * `'stored'` (default) applies it to the freshly-read persisted document —
   * the right base for the DISPLAY, because it is what stops a `?room=` in a
   * shared link from being written to disk and permanently repointing somebody's
   * LCD (design-architecture.md §4.2).
   *
   * `'snapshot'` applies it to the RESOLVED state the user is looking at, and
   * is the right base for the configuration and remote surfaces. Without it,
   * every edit silently drops the URL layer: open `…?fit=contain&room=ABCD1234`,
   * change one unrelated setting, and `commit` would rebuild the document from
   * storage — where neither value exists — so the fit override vanishes and the
   * remote's sync connection tears itself down mid-session. Measured, not
   * feared: that is exactly what the first version of the remote page did.
   *
   * The Lamport `rev` is computed from storage either way, so concurrent edits
   * from the other CAM browser still resolve last-writer-wins.
   */
  commitBase?: 'stored' | 'snapshot';
  /**
   * The URL layer, re-applied on top of ANY state that arrives from storage.
   *
   * Precedence says URL parameters always win (plan, "State & sync"), and that
   * has to keep being true after boot. Without this, a write from the OTHER CAM
   * browser — the display persisting a remote change, say — would replace this
   * page's snapshot with the raw persisted document and silently drop every
   * `?` override. On the remote page that showed up as the sync connection
   * tearing itself down the moment the display wrote back, because `?room=` had
   * vanished from the snapshot the effect depends on.
   *
   * The overlay is applied to the in-memory snapshot only. It is never written
   * to storage from the display, which is what keeps a shared `?room=` link
   * from permanently repointing somebody's LCD.
   */
  overlay?: DeepPartial<AppState>;
  /**
   * Who this store's document writes claim to be. Defaults to `clientId()`.
   *
   * Only the room harness passes it: every peer there lives in one process and
   * therefore shares one `clientId()`, so CAM's browser and the display's
   * browser are indistinguishable as writers of the shared document — which is
   * exactly the distinction `src/sync/appSync.ts` makes to tell "somebody else
   * on this origin decided something" from "this is my own write coming back".
   */
  writerId?: string;
}

export function createStore(initial: AppState, role: Role, opts: StoreOptions = {}): Store {
  let snapshot = initial;
  const commitBase = opts.commitBase ?? 'stored';
  const overlay = opts.overlay;
  const writerId = opts.writerId;

  /** Re-apply the URL layer to a document that came from storage. */
  const withOverlay = (next: AppState): AppState =>
    overlay === undefined ? next : resolveState({ persisted: next, url: overlay }).state;

  /** The sync layer's full re-resolve, when one is installed. See `setResolve`. */
  let resolveFromStorage: ((persisted: AppState) => AppState) | null = null;
  const fromStorage = (next: AppState): AppState =>
    resolveFromStorage === null ? withOverlay(next) : resolveFromStorage(next);
  const listeners = new Set<() => void>();
  const commitListeners = new Set<
    (next: AppState, origin: CommitOrigin, before: AppState) => void
  >();

  const notify = (): void => {
    if (import.meta.env.DEV && isInFrame()) {
      log.error(
        'Invariant I4 violated: a store notification originated inside a FrameClock tick. ' +
          'Per-frame work must write to the DOM imperatively, not through React state.',
      );
    }
    for (const l of listeners) {
      try {
        l();
      } catch (err) {
        log.error('store listener threw', err);
      }
    }
  };

  /**
   * ── The re-entrancy guard, and the torn read it removes ────────────────────
   *
   * True only while THIS store's `commit()` is between writing to storage and
   * finishing. `commitToStorage` fires the in-memory bus synchronously, so this
   * page's own write comes straight back through `watchState` below, which
   * re-resolves the snapshot and — until this guard — NOTIFIED from inside the
   * commit. Every subscriber therefore ran once on a half-finished commit and
   * again on the finished one.
   *
   * That first run is not merely early, it is WRONG in a way that reaches the
   * wire. `src/app/config/useSync.ts` publishes on every notification, and the
   * sync layer stamps a commit in its `onCommit` listener, which runs AFTER the
   * storage write. So the first frame of every local commit carried the new
   * value with no stamp for it — `EPOCH`, a positive claim that nobody has ever
   * written that leaf. Convergence survived because the next frame was stamped,
   * but it is the same torn read that produced the phone's undo bug, which
   * `lookHistoryStore` had to work around with a microtask flush.
   *
   * The guard suppresses only the notification a commit provokes through its own
   * storage write. The snapshot re-resolution still happens — that is what the
   * comment inside `commit()` protects, and it is why the assignment below sits
   * outside the guard — and a write by ANY OTHER store on this bus (the display
   * watching CAM's document, and vice versa) is a different closure with its own
   * flag, so it notifies exactly as it always did.
   */
  let committing = false;

  const stopWatching = watchState((next) => {
    const resolved = fromStorage(next);
    if (resolved === snapshot) return;
    snapshot = resolved;
    if (committing) return;
    notify();
  });

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    commit(mutate, meta) {
      const origin = meta?.origin ?? 'local';
      /*
       * The snapshot BEFORE this commit, captured here and handed to the
       * listeners below — because by the time they run it is no longer readable
       * anywhere.
       *
       * `commitToStorage` fires the in-memory bus SYNCHRONOUSLY, so this page's
       * own write comes back through `watchState` and re-resolves the snapshot
       * before the assignment below has even happened. A listener that tried to
       * remember the previous state by watching `subscribe` therefore saw that
       * intermediate value, and "what did this commit actually change?" answered
       * NOTHING — which silently disarmed the `local` precedence layer for the
       * very key the user had just changed. Measured, not feared: it is how a
       * module switch in CAM still reverted with the causal fix in place.
       */
      const before = snapshot;
      committing = true;
      try {
        snapshot = withOverlay(
          commitToStorage((stored) => mutate(commitBase === 'snapshot' ? snapshot : stored), {
            role,
            // The other browser on this origin reads this to tell a decision
            // from a transcription. See `AppState.writerOrigin`.
            origin,
            ...(writerId === undefined ? {} : { writerId }),
          }),
        );
      } finally {
        committing = false;
      }
      // Commit listeners run BEFORE the ordinary notification on purpose: the
      // sync layer folds the new values into its remote layer here, and a React
      // render that read a half-updated set of layers would flash the old value.
      // With the re-entrancy guard above, the `notify()` below is now the ONLY
      // notification a commit raises — so the first frame it provokes carries
      // the stamps this loop has just written, not an EPOCH claim.
      for (const l of commitListeners) {
        try {
          l(snapshot, origin, before);
        } catch (err) {
          log.error('store commit listener threw', err);
        }
      }
      notify();
      return snapshot;
    },
    replace(next) {
      if (next === snapshot) return;
      snapshot = next;
      notify();
    },
    onCommit(listener) {
      commitListeners.add(listener);
      return () => commitListeners.delete(listener);
    },
    setResolve(resolve) {
      resolveFromStorage = resolve;
    },
    dispose() {
      resolveFromStorage = null;
      stopWatching();
      listeners.clear();
      commitListeners.clear();
    },
  };
}
