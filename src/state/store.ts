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

export interface Store {
  /** Function properties, not methods: React passes these around unbound. */
  getSnapshot: () => AppState;
  subscribe: (listener: () => void) => () => void;
  commit: (mutate: (s: AppState) => AppState) => AppState;
  /** Replace the snapshot without persisting — used for the resolved URL/remote layers. */
  replace: (next: AppState) => void;
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
}

export function createStore(initial: AppState, role: Role, opts: StoreOptions = {}): Store {
  let snapshot = initial;
  const commitBase = opts.commitBase ?? 'stored';
  const overlay = opts.overlay;

  /** Re-apply the URL layer to a document that came from storage. */
  const withOverlay = (next: AppState): AppState =>
    overlay === undefined ? next : resolveState({ persisted: next, url: overlay }).state;
  const listeners = new Set<() => void>();

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

  const stopWatching = watchState((next) => {
    snapshot = withOverlay(next);
    notify();
  });

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    commit(mutate) {
      snapshot = withOverlay(
        commitToStorage((stored) => mutate(commitBase === 'snapshot' ? snapshot : stored), {
          role,
        }),
      );
      notify();
      return snapshot;
    },
    replace(next) {
      if (next === snapshot) return;
      snapshot = next;
      notify();
    },
    dispose() {
      stopWatching();
      listeners.clear();
    },
  };
}
