/**
 * The bridge between the wire and the state model.
 *
 * `SyncService` deals in envelopes and bytes; `src/state/precedence.ts` deals in
 * layers. This file is the only place that knows both, which is what keeps the
 * sync layer free of app imports (invariant 6's `sync ↛ app` zone) and keeps
 * `precedence.ts` free of any idea that a network exists.
 *
 * The rule it enforces is the one from the plan: **inbound state is applied as
 * the `remote` layer**, never written straight over the store. So a URL
 * parameter still wins over a phone, a phone still wins over what CAM saved,
 * and a reload drops the remote layer — recovered a second later from the
 * retained snapshot, or immediately from localStorage when `persistRemote` is
 * on.
 */

import { createLogger } from '../lib/log';
import { resolveState } from '../state/precedence';

import { createSyncService, type SyncService, type SyncServiceOptions } from './SyncService';

import type { CmdBody, RecvMeta, Role, SyncStateBody, SyncStatus, TeleBody } from './types';
import type { AppState, DeepPartial } from '../state/schema';
import type { Store } from '../state/store';

const log = createLogger('sync/app');

/** Remote state is committed to localStorage no more often than this. */
export const PERSIST_REMOTE_THROTTLE_MS = 2000;

/** The four state fields that travel. Blobs and settings deliberately do not. */
export function stateToSyncBody(s: AppState): SyncStateBody {
  return {
    activeModuleId: s.activeModuleId,
    modules: s.modules,
    playback: s.playback,
    render: s.render,
  };
}

/**
 * The inverse, as a precedence PATCH rather than a whole state.
 *
 * `sync`, `platform` and `diagnostics` are missing on purpose: a remote peer
 * must not be able to change which broker a display talks to, whether its
 * watchdog may reload it, or whether audio is opted in. Those are local trust
 * decisions and they stay local.
 */
export function syncBodyToPatch(b: SyncStateBody): DeepPartial<AppState> {
  return {
    activeModuleId: b.activeModuleId,
    modules: b.modules,
    playback: b.playback,
    render: b.render,
  };
}

export interface AppSyncOptions {
  role: Role;
  clientId: string;
  store: Store;
  /**
   * The persisted layer, read **on every re-resolve** rather than captured once.
   *
   * A function, not a value, and that is the whole point. `resolveState` runs
   * again on every inbound state frame, and a layer frozen at start-up means
   * every local change made since then is invisible to it — so the first remote
   * frame after an edit silently rolls that edit back. That bug was fixed once
   * for `sync.*` (the phone unpaired itself a second after connecting, because
   * the room it had just joined was not in the boot-time document) and it was
   * fixed by re-reading at the call site, which left the same trap armed for
   * every other key. Re-reading here disarms it for all of them.
   */
  persisted: () => DeepPartial<AppState>;
  /** The URL layer, which still outranks anything a remote peer sends. */
  url: DeepPartial<AppState>;
  settings: AppState['sync'];
  factories?: SyncServiceOptions['factories'];
  onRemoteState?: (state: AppState, meta: RecvMeta) => void;
  onCmd?: (body: CmdBody, meta: RecvMeta) => void;
  onTele?: (body: TeleBody, meta: RecvMeta) => void;
  onStatus?: (status: SyncStatus) => void;
}

export interface AppSync {
  service: SyncService;
  /** The accumulated remote layer, for diagnostics. */
  remoteLayer(): DeepPartial<AppState>;
  /** Local edits no remote frame has superseded yet, for diagnostics. */
  localLayer(): DeepPartial<AppState>;
  stop(): Promise<void>;
}

/**
 * Starts a service already wired into the store. Never throws: a display whose
 * sync layer fails to start must keep playing from its persisted state.
 */
export async function startAppSync(o: AppSyncOptions): Promise<AppSync> {
  const service = createSyncService({
    role: o.role,
    clientId: o.clientId,
    settings: o.settings,
    ...(o.factories === undefined ? {} : { factories: o.factories }),
  });

  let remote: DeepPartial<AppState> = {};
  let lastPersistAt = 0;

  /**
   * Edits this page made that no LIVE remote frame has superseded yet.
   *
   * The remote layer is STICKY: once a peer has said "the active module is
   * video", that entry outranks everything this page saves until the page is
   * reloaded. So a user switching to Clock in CAM wrote `clock` to storage,
   * watched it appear — and watched it revert the next time any state frame
   * arrived and `resolveState` ran again against a remote layer that still said
   * `video`.
   *
   * The frame that does this is almost always a **retained** one: a broker
   * replaying its last-value on a reconnect, a 5-minute keepalive republish, a
   * fresh subscriber's bootstrap. That is why the bug looks intermittent — it
   * needs a reconnect, not a user action.
   *
   * And that is also the discriminator, because it is a real semantic
   * difference rather than a heuristic:
   *
   *   a **retained** frame is a REPLAY of something a peer said once;
   *   a **live** frame is a peer saying something NOW.
   *
   * A replay exists to bootstrap a peer that has just arrived and knows
   * nothing. It has no business correcting a page that has been running, and
   * has just been told by a human to do something else. A live frame does: a
   * phone changing the module while you are watching is genuinely newer than
   * your last click, and last-writer-wins is the right answer there — so a live
   * frame clears this layer wholesale and the remote keeps working exactly as
   * it did.
   *
   * Deliberately NOT done with the Lamport `rev`: it only orders writers that
   * observe each other's counters, and the display and the phone keep separate
   * storage, so their revs can diverge arbitrarily. Comparing them would make
   * a phone's genuine change unapplyable on a display whose local counter had
   * run ahead — trading an intermittent revert for a silent dead remote.
   */
  let local: DeepPartial<AppState> = {};

  const stopFolding = o.store.onCommit((next) => {
    local = {
      ...local,
      ...syncBodyToPatch(next),
      modules: { ...local.modules, ...next.modules },
    };
  });

  service.onState((body, meta) => {
    // Merge rather than replace: a `partial` snapshot carries only the active
    // module, and the modules it omitted must keep the values we already have.
    remote = {
      ...remote,
      ...syncBodyToPatch(body),
      modules: { ...remote.modules, ...body.modules },
    };
    // A peer speaking now supersedes what this page last chose. A replay does
    // not — see above.
    if (!meta.retained) local = {};
    const resolved = resolveState({ persisted: o.persisted(), remote, local, url: o.url });
    o.store.replace(resolved.state);
    o.onRemoteState?.(resolved.state, meta);

    if (o.settings.persistRemote && Date.now() - lastPersistAt >= PERSIST_REMOTE_THROTTLE_MS) {
      lastPersistAt = Date.now();
      try {
        // Writes only to localStorage. It reaches the CAM Configuration Browser
        // through the shared origin, so no peer ever echoes state back onto the
        // network — which is what stops a feedback loop between three surfaces.
        o.store.commit((s) => ({ ...s, ...syncBodyToPatch(body) }) as AppState);
      } catch (err) {
        log.warn('could not persist remote state', err);
      }
    }
  });

  if (o.onCmd !== undefined) service.onCmd(o.onCmd);
  if (o.onTele !== undefined) service.onTele(o.onTele);
  if (o.onStatus !== undefined) service.onStatus(o.onStatus);

  try {
    await service.start();
  } catch (err) {
    log.warn('sync failed to start — the display keeps running without it', err);
  }

  /**
   * `stop()` is now reachable from two directions — React effect cleanup and
   * the `pagehide` flush listener — and both can fire for the same page load
   * (a tab close, then unmount). `SyncService.stop()` aborts a shared
   * `AbortController` and awaits every transport's `disconnect()`, so calling
   * it twice would race a second `end(false, …)` against the first one's flush
   * window. One promise, memoised, is the whole guard.
   */
  let stopping: Promise<void> | null = null;

  return {
    service,
    remoteLayer: () => remote,
    localLayer: () => local,
    stop: () =>
      (stopping ??= (async () => {
        stopFolding();
        await service.stop();
      })()),
  };
}
