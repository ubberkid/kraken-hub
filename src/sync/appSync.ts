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
import { noteSeenRev } from '../state/storage';

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

/**
 * ── The DEV-only layer trace ─────────────────────────────────────────────────
 *
 * "Which layer won this key, and when did that change?" is the one question
 * this whole class of bug turns on, and until now the only way to answer it was
 * to read four files and guess. Two reports of "it flips back to Video" were
 * diagnosed that way; the first fix was wrong because the guess was wrong.
 *
 * It ships dark. Every call site is inside `if (import.meta.env.DEV)`, which
 * Vite replaces with `false` in a production build, so the constant folder
 * removes the branch and the tree shaker removes everything only it referenced.
 * `npm run size` is what keeps that honest.
 *
 * Logged ONLY on change: the state channel is chatty and a line per frame is
 * noise nobody reads. A line appears when the winning layer for a contested key
 * actually moves, which is exactly the moment worth seeing.
 */
const TRACE_LAYERS = ['url', 'local', 'remote', 'persisted'] as const;

function leafPaths(patch: unknown, prefix: string, out: Set<string>): void {
  if (patch === undefined) return;
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    if (prefix.length > 0) out.add(prefix);
    return;
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    leafPaths(value, prefix.length > 0 ? `${prefix}.${key}` : key, out);
  }
}

function leafAt(patch: unknown, path: string): unknown {
  let cursor: unknown = patch;
  for (const part of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/** `activeModuleId←local` for every key more than one layer has an opinion about. */
function describeLayers(layers: Record<(typeof TRACE_LAYERS)[number], unknown>): string {
  const paths = new Set<string>();
  for (const name of TRACE_LAYERS) leafPaths(layers[name], '', paths);
  const contested: string[] = [];
  for (const path of [...paths].sort()) {
    const holders = TRACE_LAYERS.filter((name) => leafAt(layers[name], path) !== undefined);
    if (holders.length < 2) continue;
    contested.push(`${path}←${holders[0] ?? '?'}`);
  }
  return contested.join(' ');
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
  /** The last layer summary printed, so DEV logs only the transitions. */
  let lastTrace: string | null = null;

  /*
   * ── Persisting remote state: throttled with a TRAILING edge ────────────────
   *
   * Leading-edge alone DROPS the last write of a burst, and the last write of a
   * burst is the only one that matters — it is the value that is still true.
   * Measured, not feared: two frames a fifth of a second apart left the stored
   * document holding the FIRST one for the next two seconds, so the config page
   * read a superseded module out of storage and republished it, and a display
   * reloading inside that window cold-booted into a state nobody had asked for.
   */
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingPersist: AppState | null = null;

  function persistNow(next: AppState): void {
    lastPersistAt = Date.now();
    try {
      /*
       * The RESOLVED state, never the raw remote body.
       *
       * This was the bug. `commit()` overwrites the snapshot outright, so
       * writing `{...s, ...syncBodyToPatch(body)}` here threw away the answer
       * `resolveState` had produced three lines above and put the peer's value
       * straight back on screen — defeating `local` and `url` both, about two
       * seconds after every click. Persisting what we actually resolved is the
       * SAME write in the cold-boot case (a page with nothing local resolves to
       * exactly the remote body) and the correct one in every other.
       *
       * `origin: 'sync'` keeps it out of the `local` layer: this is the page
       * writing down what a peer said, not the page deciding anything.
       *
       * Writes only to localStorage. It reaches the CAM Configuration Browser
       * through the shared origin, so no peer ever echoes state back onto the
       * network — which is what stops a feedback loop between three surfaces.
       */
      o.store.commit((s) => ({ ...s, ...stateToSyncBody(next) }), { origin: 'sync' });
    } catch (err) {
      log.warn('could not persist remote state', err);
    }
  }

  function schedulePersist(next: AppState): void {
    const elapsed = Date.now() - lastPersistAt;
    if (elapsed >= PERSIST_REMOTE_THROTTLE_MS) {
      persistNow(next);
      return;
    }
    pendingPersist = next;
    if (persistTimer !== null) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      const value = pendingPersist;
      pendingPersist = null;
      if (value !== null) persistNow(value);
    }, PERSIST_REMOTE_THROTTLE_MS - elapsed);
  }

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

  /**
   * The `rev` of the newest DELIBERATE local commit this page has made.
   *
   * Arrival provenance for the remote layer, and the reason a retained replay
   * can be recognised as stale rather than merely out-ranked. `0` means "this
   * page has decided nothing yet", which is the cold-boot case: a display that
   * has never been touched must still take its whole world from the retained
   * snapshot, so the guard below is inert until a human has acted.
   */
  let lastLocalRev = 0;

  /*
   * A document arriving from storage is re-resolved through the layers.
   *
   * The other CAM browser writes to this document, and so does the display
   * every time `persistRemote` fires. Without this the store simply adopted
   * whatever it read, which threw away `remote`, `local` and `url` — and on the
   * config page the very next `store.subscribe` republished that raw document
   * as this page's own desire. See `Store.setResolve`.
   */
  o.store.setResolve(
    (persistedDoc) => resolveState({ persisted: persistedDoc, remote, local, url: o.url }).state,
  );

  const stopFolding = o.store.onCommit((next, origin) => {
    // A `'sync'` commit is this page WRITING DOWN what a peer said (the
    // `persistRemote` path below). Folding it in here would put the remote
    // value into the layer that exists to defend the user's own edit from it —
    // which is precisely how the revert became permanent instead of momentary.
    if (origin !== 'local') return;
    lastLocalRev = Math.max(lastLocalRev, next.rev);
    local = {
      ...local,
      ...syncBodyToPatch(next),
      modules: { ...local.modules, ...next.modules },
    };
  });

  service.onState((body, meta) => {
    const persisted = o.persisted();

    /*
     * The Lamport counter, finally closed.
     *
     * `rev` is only an ordering if a writer's next number exceeds everything it
     * has OBSERVED, and nothing in the app was feeding observations back into
     * the counter — `noteSeenRev` shipped exported and unreferenced. Without
     * this line two peers' counters drift apart on their own storage and the
     * comparison below is meaningless; with it, "newer" is a fact rather than a
     * coincidence, and the phone's genuine change still outranks the display.
     */
    if (meta.rev !== null) noteSeenRev(meta.rev);

    /*
     * A replay older than what we already know is DISCARDED, not merely
     * out-ranked.
     *
     * A retained frame is a broker reading back something a peer said once. It
     * exists to bootstrap somebody who knows nothing — and it is the whole
     * truth for exactly that reader. For anybody else it is a message from the
     * past, and the remote layer it lands in is sticky and in-memory, so once
     * `local` is next cleared by a genuine live frame the stale value wins for
     * the life of the page. That is the second half of the revert: the user's
     * `clock` sits in localStorage at a higher `rev` than the `video` the
     * broker is replaying, and `video` beat it anyway because the layer order
     * puts remote above persisted unconditionally.
     *
     * Ordering is the counter both sides now share (above), and the floor is
     * the higher of what this page has decided and what it has saved. A LIVE
     * frame is exempt: a peer speaking now is newer by definition, which is
     * what keeps the phone remote working.
     *
     * `floor > 0` keeps a genuinely cold page untouched: with nothing decided
     * and nothing saved, the retained snapshot is all there is.
     */
    const persistedRev = typeof persisted.rev === 'number' ? persisted.rev : 0;
    const floor = Math.max(lastLocalRev, persistedRev);
    if (meta.retained && meta.rev !== null && floor > 0 && meta.rev <= floor) {
      if (import.meta.env.DEV) {
        log.debug(
          `dropped a retained replay at rev ${String(meta.rev)}; this page is at ${String(floor)}`,
        );
      }
      return;
    }

    /*
     * A LIVE frame is deliberately NOT rev-guarded, and that was measured.
     *
     * The obvious next move is to drop any frame older than this page's own
     * last commit, live or not. It is wrong, and the e2e caught it: two peers
     * on ONE origin write to ONE document, so a display that commits anything
     * of its own between a remote's publish and its delivery ends up holding a
     * higher `rev` than the frame in flight — and drops it. That turned "a seek
     * on the remote moves the display" red, which is the whole product.
     *
     * A live frame is a peer speaking NOW. Last-writer-wins is the right answer
     * for it, and the `local` layer above already stops it from silently
     * undoing an edit this page has not yet published. Only replays need the
     * ordering guard, because only a replay claims to be news while being old.
     */

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
    const resolved = resolveState({ persisted, remote, local, url: o.url });
    if (import.meta.env.DEV) {
      const trace = describeLayers({ url: o.url, local, remote, persisted });
      if (trace !== lastTrace) {
        lastTrace = trace;
        log.debug(`layers: ${trace.length === 0 ? '(uncontested)' : trace}`);
      }
    }
    o.store.replace(resolved.state);
    o.onRemoteState?.(resolved.state, meta);

    if (o.settings.persistRemote) schedulePersist(resolved.state);
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
        if (persistTimer !== null) clearTimeout(persistTimer);
        persistTimer = null;
        pendingPersist = null;
        o.store.setResolve(null);
        await service.stop();
      })()),
  };
}
