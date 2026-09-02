/**
 * A room, with distance in it — the harness the convergence suites share.
 *
 * This file is imported ONLY by `*.dom.test.ts` and is never in the app graph
 * (nothing under `src/app`, `src/display` or `src/modules` imports it), so it
 * costs no bytes in a build. It lives in `src/` rather than beside the tests
 * because three suites now need the same broker, and a harness copied three
 * times is a harness that drifts three ways — which is exactly what happened
 * while the ack design was being probed: every skeptic pasted lines 1-648 of
 * `threePeerConvergence.dom.test.ts` into a throwaway file, and each copy then
 * modelled a slightly different room.
 *
 * What it models that a microtask loopback does not:
 *
 *  - **Latency.** Frames take `LATENCY_MS` to arrive, which is what gives the
 *    publish throttle something to be late about. A harness that delivers
 *    instantly cannot see a stale snapshot at all.
 *  - **A retained slot.** The broker keeps the last `state` frame and hands it
 *    to whoever subscribes next, exactly as MQTT does.
 *  - **A radio that drops.** `mute()`/`unmute()` cut delivery in both
 *    directions and replay the retained slot on the way back in.
 *  - **A phone with its own document.** `createIsolatedStore` shares no
 *    localStorage with the display and CAM, because a phone does not.
 */

import { defaultAppState } from '../state/defaults';
import { readState } from '../state/storage';
import { createStore } from '../state/store';

import { startAppSync, stateToSyncBody, type AppSync } from './appSync';
import { decodeEnvelope, encodeEnvelope } from './envelope';
import { PROTOCOL_VERSION } from './types';

import type { Channel, FrameHandler, SyncTransport, TransportStatus } from './types';
import type { AppState } from '../state/schema';
import type { CommitOrigin, Store } from '../state/store';

// ---------------------------------------------------------------------------
// Timings
// ---------------------------------------------------------------------------

/**
 * One-way delivery time. A public MQTT broker over a phone's radio is this or
 * worse, and the whole bug class lives inside the interval.
 */
export const LATENCY_MS = 120;

/** How long after `connect()` the retained bootstrap actually lands. */
export const HANDSHAKE_MS = 400;

/** The display's telemetry cadence, compressed so the suite stays quick. */
export const TELE_PERIOD_MS = 120;

/** How long a tapped value has to hold. Two full persist cycles and then some. */
export const HOLD_MS = 5000;

export const ROOM = 'ABCD1234';

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Device clocks
// ---------------------------------------------------------------------------

/**
 * A per-device wall clock, because `Date.now()` is where a device clock enters
 * the model and nowhere else.
 *
 * `appSync`'s `nextStamp()` reads `Date.now()`, so a phone whose clock is a
 * minute behind stamps a minute behind — and the whole room-time question is
 * about what that does after an outage. Modelling it needs more than skewing
 * one call: a peer's OWN throttle arithmetic (`Date.now() - lastPublishAt`)
 * has to stay internally consistent, as it is on a real device. So the offset
 * is AMBIENT — set for the duration of any window that peer's code runs in
 * (its taps, its publishes, its inbound deliveries) — and `setTimeout` /
 * `setInterval` capture it, so a callback a peer scheduled runs on that peer's
 * clock rather than on whoever happened to be running when it fired.
 *
 * Installed lazily, on the first peer that actually wants a skew, so every
 * suite that does not ask for one runs on the untouched globals.
 */
let ambientOffset = 0;
const realDateNow = Date.now.bind(Date);
type TimerFn = (handler: TimerHandler, timeout?: number, ...args: unknown[]) => number;
const realSetTimeout = globalThis.setTimeout.bind(globalThis) as unknown as TimerFn;
const realSetInterval = globalThis.setInterval.bind(globalThis) as unknown as TimerFn;
let clocksInstalled = false;

/** Run `fn` on the clock of a device `offset` ms away from this machine's. */
export function withAmbient<T>(offset: number, fn: () => T): T {
  const previous = ambientOffset;
  ambientOffset = offset;
  try {
    return fn();
  } finally {
    ambientOffset = previous;
  }
}

/**
 * The async form, for starting a peer.
 *
 * The offset stays set across the `await`, which is safe here for one reason:
 * peers are started sequentially, so no other device's code is running inside
 * the window. Concurrency between two skewed peers would need a real async
 * context, which this harness has no use for.
 */
export async function withAmbientAsync<T>(offset: number, fn: () => Promise<T>): Promise<T> {
  const previous = ambientOffset;
  ambientOffset = offset;
  try {
    return await fn();
  } finally {
    ambientOffset = previous;
  }
}

/**
 * A device's clock, which a test can move mid-session.
 *
 * Read through a getter everywhere rather than captured, because "the phone's
 * clock jumps an hour while the room is running" is a case worth pinning and a
 * captured number cannot express it.
 */
export interface DeviceClock {
  offset: () => number;
  jump: (ms: number) => void;
}

function makeDeviceClock(initial: number): DeviceClock {
  let value = initial;
  return {
    offset: () => value,
    jump: (ms) => {
      value = ms;
    },
  };
}

/**
 * Take over `Date.now`, `setTimeout` and `setInterval` for this process.
 *
 * Call it in a suite that skews any device — including one that starts at zero
 * and jumps later. With every offset at zero the wrappers are transparent.
 */
export function installDeviceClocks(): void {
  if (clocksInstalled) return;
  clocksInstalled = true;
  Date.now = () => realDateNow() + ambientOffset;
  const wrap =
    (real: TimerFn): TimerFn =>
    (handler, timeout, ...args) => {
      if (typeof handler !== 'function') return real(handler, timeout, ...args);
      const captured = ambientOffset;
      return real(() => {
        withAmbient(captured, () => {
          (handler as (...a: unknown[]) => void)(...args);
        });
      }, timeout);
    };
  (globalThis as { setTimeout: unknown }).setTimeout = wrap(realSetTimeout);
  (globalThis as { setInterval: unknown }).setInterval = wrap(realSetInterval);
}

/** Restore the real globals. `afterAll` in any suite that skews a peer. */
export function restoreDeviceClocks(): void {
  if (!clocksInstalled) return;
  clocksInstalled = false;
  ambientOffset = 0;
  Date.now = realDateNow;
  (globalThis as { setTimeout: unknown }).setTimeout = realSetTimeout;
  (globalThis as { setInterval: unknown }).setInterval = realSetInterval;
}

/** A store whose local commits happen on this device's clock. */
function onDeviceClock<T extends Store>(store: T, clock: DeviceClock): T {
  return {
    ...store,
    commit: (mutate, meta) => withAmbient(clock.offset(), () => store.commit(mutate, meta)),
  };
}

// ---------------------------------------------------------------------------
// The trace
// ---------------------------------------------------------------------------

let trace: string[] = [];
let traceStart = Date.now();

export function resetTrace(): void {
  trace = [];
  traceStart = Date.now();
}

export const stamp = (): string => String(Date.now() - traceStart).padStart(5, ' ');

export const note = (line: string): void => {
  trace.push(`${stamp()} ${line}`);
};

export const story = (): string => `\n${trace.join('\n')}\n`;

/**
 * A reading, with the room's whole log attached when it is the wrong one.
 *
 * `expect` takes one argument here (the lint rule that says so is right — a
 * second one is silently ignored by some matchers), so the log rides ON the
 * value: a passing assertion compares two identical strings and a failing one
 * prints the frame-by-frame story of how the room got there.
 */
export const withStory = (value: string, expected: string): string =>
  value === expected ? value : `${value}${story()}`;

// ---------------------------------------------------------------------------
// The broker
// ---------------------------------------------------------------------------

interface Sub {
  ch: Channel;
  cb: FrameHandler;
}

/**
 * THE BROKER'S OWN CLOCK, and the one clock in this file no device can move.
 *
 * A real server stamps every message it accepts (`NtfyTransport` reads
 * `parsed.time`), and `SyncService` compares those stamps to each other to
 * decide whether a `cmd` is a live message or something out of a replay cache.
 * That comparison is only skew-free because both halves come from the SAME
 * clock — so the broker here reads the real one rather than `Date.now()`, which
 * `installDeviceClocks` has bent to whichever peer happened to call `publish`.
 */
const brokerNow = (): number => realDateNow();

export interface Broker {
  retained: { state?: Uint8Array; ts?: number };
  subs: Set<Sub>;
  /**
   * `as` models what a REPLAY is: the same bytes, delivered now, carrying the
   * stamp the server gave them when it first accepted them — and, for a
   * recovery poll, flagged `retained`. A live publish passes nothing and gets
   * `{ retained: false, ts: brokerNow() }`, which is every other caller.
   */
  publish(ch: Channel, frame: Uint8Array, as?: { ts?: number; retained?: boolean }): void;
  seedRetained(frame: Uint8Array, ts?: number): void;
}

export function createBroker(latency: () => number = () => LATENCY_MS): Broker {
  const subs = new Set<Sub>();
  const retained: { state?: Uint8Array; ts?: number } = {};
  return {
    retained,
    subs,
    seedRetained(frame, ts) {
      retained.state = frame;
      retained.ts = ts ?? brokerNow();
    },
    publish(ch, frame, as) {
      const ts = as?.ts ?? brokerNow();
      const flagged = as?.retained ?? false;
      if (ch === 'state') {
        retained.state = frame;
        retained.ts = ts;
        const env = decodeEnvelope(frame);
        if (env !== null) {
          const body = env.body as { activeModuleId?: string };
          note(`wire ${env.src} seq=${String(env.seq)} module=${String(body.activeModuleId)}`);
        }
      }
      for (const s of [...subs]) {
        if (s.ch !== ch) continue;
        setTimeout(() => {
          s.cb(frame, { retained: flagged, ts });
        }, latency());
      }
    },
  };
}

/**
 * The blip, modelled without the reconnect machinery.
 *
 * A radio drop is two facts: nothing this peer publishes reaches the room, and
 * nothing the room says reaches this peer — followed, when the link comes back,
 * by the broker handing over its RETAINED slot as a bootstrap.
 */
export interface FakeTransport extends SyncTransport {
  mute(): void;
  unmute(): void;
}

export function brokerTransport(
  broker: Broker,
  handshakeMs = 0,
  offset: () => number = () => 0,
): FakeTransport {
  const subs = new Set<Sub>();
  const statusSubs = new Set<(s: TransportStatus, d?: string) => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let status: TransportStatus = 'idle';
  let muted = false;
  /**
   * The last snapshot this peer ASKED to send, whether or not it went out.
   *
   * A real radio drop is a transport status change, so `SyncService` schedules a
   * reconnect and re-asserts `lastRetained` on the new connection
   * (`connectNetwork`). `mute()`/`unmute()` model the outage directly rather
   * than driving that machinery — its first backoff rung is a full second of
   * jitter — so the republish has to be modelled with it, or the harness would
   * be testing a peer that comes back permanently mute, which is not a thing
   * that happens.
   */
  let lastStateFrame: Uint8Array | null = null;

  const attach = (ch: Channel, cb: FrameHandler): (() => void) => {
    // Delivered ON THIS DEVICE'S CLOCK: the frame is handled by the peer's own
    // code, and every timer that handling schedules inherits the same offset.
    const s: Sub = {
      ch,
      cb: (frame, meta) => {
        withAmbient(offset(), () => {
          cb(frame, meta);
        });
      },
    };
    subs.add(s);
    if (status === 'online' && !muted) broker.subs.add(s);
    return () => {
      subs.delete(s);
      broker.subs.delete(s);
    };
  };

  const replayRetained = (): void => {
    const retained = broker.retained.state;
    if (retained === undefined) return;
    // The stamp the broker put on it when it was PUBLISHED, not now — that is
    // what makes a retained frame recognisable as old, on the wire and here.
    const retainedTs = broker.retained.ts;
    for (const s of subs) {
      if (s.ch !== 'state') continue;
      const { cb } = s;
      const timer = setTimeout(() => {
        timers.delete(timer);
        cb(retained, { retained: true, ...(retainedTs === undefined ? {} : { ts: retainedTs }) });
      }, handshakeMs);
      timers.add(timer);
    }
  };

  return {
    id: 'fake',
    mute() {
      muted = true;
      for (const s of subs) broker.subs.delete(s);
    },
    unmute() {
      muted = false;
      if (status !== 'online') return;
      for (const s of subs) broker.subs.add(s);
      if (lastStateFrame !== null) broker.publish('state', lastStateFrame);
      replayRetained();
    },
    caps: {
      retained: true,
      replayMs: 0,
      cmdReplayMs: 0,
      needsNetwork: true,
      maxPayload: 64_000,
      channels: ['state', 'cmd', 'tele'],
      // Plaintext on purpose: this harness is about ordering, and an AES round
      // trip per frame would only add microtask depth.
      encrypted: false,
    },
    connect() {
      status = 'online';
      if (!muted) {
        for (const s of subs) broker.subs.add(s);
        replayRetained();
      }
      for (const cb of statusSubs) cb('online');
      return Promise.resolve();
    },
    disconnect() {
      status = 'idle';
      for (const s of subs) broker.subs.delete(s);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      return Promise.resolve();
    },
    // A muted transport swallows publishes as well as deliveries: an outage is
    // symmetric, and a peer that could still write to the retained slot while
    // deaf would be a stranger thing than the one being modelled.
    publishState(frame) {
      lastStateFrame = frame;
      if (!muted) broker.publish('state', frame);
      return Promise.resolve();
    },
    publishCmd(frame) {
      if (!muted) broker.publish('cmd', frame);
      return Promise.resolve();
    },
    publishTele(frame) {
      if (!muted) broker.publish('tele', frame);
      return Promise.resolve();
    },
    onState: (cb) => attach('state', cb),
    onCmd: (cb) => attach('cmd', cb),
    onTele: (cb) => attach('tele', cb),
    /*
     * A MUTED radio is not online, and saying so is the whole point.
     *
     * `mute()` models an outage directly rather than through the status
     * machinery (see its comment above), so `status` itself stays `'online'` —
     * which is right for the reconnect logic and wrong for anybody asking "did
     * that publish actually reach the room?". `SyncService.onStateShipped` asks
     * exactly that, and a harness that answered "online" while swallowing every
     * frame would have made an offline phone's writes look shipped. Reported
     * here, and deliberately NOT pushed to `statusSubs`: a status EVENT would
     * schedule a reconnect, which is the machinery this outage model exists to
     * avoid.
     */
    status: () => (muted ? 'offline' : status),
    onStatus(cb) {
      statusSubs.add(cb);
      return () => statusSubs.delete(cb);
    },
  };
}

// ---------------------------------------------------------------------------
// Peers
// ---------------------------------------------------------------------------

export function syncSettings(): AppState['sync'] {
  return {
    enabled: true,
    roomCode: ROOM,
    transport: 'fake',
    mqttUrl: '',
    ntfyBase: '',
    persistRemote: true,
    publishTelemetry: true,
  };
}

export interface Peer {
  name: string;
  store: Store;
  sync: AppSync;
  /** This device's wall clock, and the handle a test moves it with. */
  clock: DeviceClock;
  /**
   * The DOCUMENT this device would boot from — what a reload inherits.
   *
   * For CAM and the display that is this process's shared `readState()`; for a
   * phone it is its own isolated store, which shares nothing with them.
   */
  doc(): AppState;
  /** Cut this peer's radio: it neither hears nor is heard. */
  mute(): void;
  /** Restore it, and take the broker's retained slot as a bootstrap. */
  unmute(): void;
  stop(): Promise<void>;
}

/**
 * The transports a peer built, so a test can reach in and blip the network one.
 */
function radio(offset: () => number = () => 0): {
  made: FakeTransport[];
  make: (broker: Broker, handshakeMs?: number) => FakeTransport;
} {
  const made: FakeTransport[] = [];
  return {
    made,
    make(broker, handshakeMs = 0) {
      const t = brokerTransport(broker, handshakeMs, offset);
      made.push(t);
      return t;
    },
  };
}

/**
 * Resolves the next time ANY peer hands a snapshot to its publish throttle.
 *
 * The tap is timed against this rather than against a wall clock: the window
 * this bug class lives in opens when a snapshot is taken and closes when it is
 * delivered, and waiting for the beat is what makes an intermittent race a
 * repeatable test.
 */
const publishWaiters = new Set<() => void>();

export function nextPublish(): Promise<void> {
  return new Promise<void>((resolve) => {
    const fire = (): void => {
      publishWaiters.delete(fire);
      resolve();
    };
    publishWaiters.add(fire);
  });
}

function firePublishWaiters(): void {
  for (const waiter of [...publishWaiters]) waiter();
}

/**
 * A page that publishes its snapshot on every store notification — what
 * `src/app/config/useSync.ts` does, and what both CAM's config browser and the
 * phone's remote do.
 */
function publishOnEveryChange(
  name: string,
  store: Store,
  sync: AppSync,
  offset: () => number = () => 0,
): () => void {
  return store.subscribe(() => {
    withAmbient(offset(), () => {
      const next = store.getSnapshot();
      note(`${name} publishes module=${next.activeModuleId} rev=${String(next.rev)}`);
      sync.service.publishState(stateToSyncBody(next), { rev: next.rev });
    });
    firePublishWaiters();
  });
}

/**
 * A per-peer clock slot.
 *
 * The real thing is a localStorage key, and on one origin CAM's config browser
 * and the display would share it if it were not keyed. In this process every
 * peer is in the SAME localStorage, so the harness hands each device its own
 * in-memory slot instead — which is also what makes "the phone reloads" a real
 * reload: the new page gets the same slot the closed one wrote.
 */
const clockSlots = new Map<string, string>();

export function resetClockSlots(): void {
  clockSlots.clear();
}

/**
 * What a device left in its clock slot — the bytes the next page load reads.
 *
 * For a test that needs to model a slot written by an OLDER build: read it,
 * remove the key that build did not have, and hand it back through
 * `PhoneOptions.slotRaw`.
 */
export function readClockSlot(device: string): string | null {
  return clockSlots.get(device) ?? null;
}

function slotFor(device: string): { read: () => string | null; write: (raw: string) => void } {
  return {
    read: () => clockSlots.get(device) ?? null,
    write: (raw) => {
      clockSlots.set(device, raw);
    },
  };
}

/** CAM's configuration browser: shares the storage document with the display. */
export async function startConfigPeer(
  broker: Broker,
  handshakeMs: number,
  offsetMs = 0,
): Promise<Peer> {
  if (offsetMs !== 0) installDeviceClocks();
  const clock = makeDeviceClock(offsetMs);
  const store = onDeviceClock(
    createStore(readState().state, 'config', { commitBase: 'snapshot' }),
    clock,
  );
  const net = radio(clock.offset);
  const sync = await withAmbientAsync(offsetMs, () =>
    startAppSync({
      role: 'config',
      clientId: 'configpeer01',
      store,
      persisted: () => readState().state,
      url: {},
      settings: syncSettings(),
      clockSlot: slotFor('CAM'),
      factories: {
        fake: () => net.make(broker, handshakeMs),
        localstorage: () => brokerTransport(createBroker()),
      },
      onRemoteState: (state, meta) => {
        note(
          `CAM applied ${meta.src}#${String(meta.seq)} retained=${String(meta.retained)} -> module=${state.activeModuleId} fit=${state.render.fit}`,
        );
      },
    }),
  );
  const stopPublishing = publishOnEveryChange('CAM', store, sync, clock.offset);
  withAmbient(offsetMs, () => {
    sync.service.publishState(stateToSyncBody(store.getSnapshot()), {
      rev: store.getSnapshot().rev,
      immediate: true,
    });
  });
  return {
    name: 'CAM',
    store,
    sync,
    clock,
    doc: () => readState().state,
    mute: () => {
      for (const t of net.made) t.mute();
    },
    unmute: () => {
      for (const t of net.made) t.unmute();
    },
    /*
     * ON THIS DEVICE'S CLOCK — `stop()` is the page's own shutdown flush.
     *
     * `appSync`'s `stop()` writes the document and the clock slot, and the slot
     * carries `base`/`baseAt`, which are readings of the DEVICE's clock. Running
     * it on the test's clock handed a skewed phone a correct one for the one
     * write where it matters, so a device whose clock had moved looked, in its
     * own slot, as though it never had.
     */
    async stop() {
      stopPublishing();
      await withAmbientAsync(clock.offset(), () => sync.stop());
      store.dispose();
    },
  };
}

/** The Kraken browser: applies state, publishes telemetry, never publishes state. */
export async function startDisplayPeer(broker: Broker, offsetMs = 0): Promise<Peer> {
  if (offsetMs !== 0) installDeviceClocks();
  const clock = makeDeviceClock(offsetMs);
  const store = onDeviceClock(createStore(readState().state, 'display'), clock);
  const net = radio(clock.offset);
  const sync = await withAmbientAsync(offsetMs, () =>
    startAppSync({
      role: 'display',
      clientId: 'displaypeer1',
      store,
      persisted: () => readState().state,
      url: {},
      settings: syncSettings(),
      clockSlot: slotFor('display'),
      factories: {
        fake: () => net.make(broker),
        localstorage: () => brokerTransport(createBroker()),
      },
      onRemoteState: (state, meta) => {
        note(
          `display applied ${meta.src}#${String(meta.seq)} retained=${String(meta.retained)} -> module=${state.activeModuleId} rotate=${String(state.render.rotate)}`,
        );
      },
    }),
  );
  /*
   * The telemetry beats run on THIS DEVICE'S CLOCK, read at fire time.
   *
   * `installDeviceClocks` wraps `setInterval` and captures the ambient offset
   * when the interval is CREATED, which models a peer's own timers correctly
   * for every case but one: a clock that steps AFTER the interval was
   * scheduled. A real device has no such exemption — its intervals keep
   * firing and its `Date.now()` is simply different afterwards — so a jump has
   * to reach beats that already exist, or "does telemetry survive an NTP
   * correction?" is a question the harness cannot ask. It is exactly the case
   * skeptic 1 could not isolate.
   */
  const beat = (kind: 'videoStats' | 'monitor') => (): void => {
    withAmbient(clock.offset(), () => {
      sync.service.publishTele({ ts: Date.now(), kind });
    });
  };
  const stats = setInterval(beat('videoStats'), TELE_PERIOD_MS);
  const monitor = setInterval(beat('monitor'), Math.round(TELE_PERIOD_MS * 1.25));
  return {
    name: 'display',
    store,
    sync,
    clock,
    doc: () => readState().state,
    mute: () => {
      for (const t of net.made) t.mute();
    },
    unmute: () => {
      for (const t of net.made) t.unmute();
    },
    /*
     * ON THIS DEVICE'S CLOCK — `stop()` is the page's own shutdown flush.
     *
     * `appSync`'s `stop()` writes the document and the clock slot, and the slot
     * carries `base`/`baseAt`, which are readings of the DEVICE's clock. Running
     * it on the test's clock handed a skewed phone a correct one for the one
     * write where it matters, so a device whose clock had moved looked, in its
     * own slot, as though it never had.
     */
    async stop() {
      clearInterval(stats);
      clearInterval(monitor);
      await withAmbientAsync(clock.offset(), () => sync.stop());
      store.dispose();
    },
  };
}

/**
 * The phone's store: a DIFFERENT device, so a different document.
 *
 * `createStore` is bound to this process's one localStorage, which is the right
 * model for CAM's two browsers and the wrong one for a phone — the bug class
 * under test is precisely about a peer that shares nothing with them.
 */
export interface IsolatedStore extends Store {
  doc(): AppState;
  noteRev(rev: number): void;
}

export interface IsolatedStoreOptions {
  /**
   * Model `platform/storage.writeRaw` refusing a write on a full quota.
   *
   * The real thing catches the quota error, keeps the value in a memory map and
   * returns `false`, and `persistNow` does not look at the result — so the page
   * behaves normally and the DOCUMENT silently does not move. Across a reload
   * the memory map is gone. Suppressing the document half of every `'sync'`
   * commit is exactly that, and it is a shipped failure on default settings.
   */
  quotaOnSyncWrites?: boolean;
}

export function createIsolatedStore(
  initial: AppState,
  writerId: string,
  o: IsolatedStoreOptions = {},
): IsolatedStore {
  let snapshot = initial;
  let doc = initial;
  let highWater = initial.rev;
  const listeners = new Set<() => void>();
  const commitListeners = new Set<
    (next: AppState, origin: CommitOrigin, before: AppState) => void
  >();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  return {
    doc: () => doc,
    noteRev(rev) {
      highWater = Math.max(highWater, rev);
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    commit(mutate, meta) {
      const before = snapshot;
      const draft = mutate(snapshot);
      highWater = Math.max(highWater, draft.rev, doc.rev) + 1;
      const next = { ...draft, rev: highWater, updatedAt: Date.now(), writerId };
      const origin = meta?.origin ?? 'local';
      if (!((o.quotaOnSyncWrites ?? false) && origin === 'sync')) doc = next;
      snapshot = next;
      for (const listener of commitListeners) listener(snapshot, origin, before);
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
    setResolve() {
      /* nothing arrives from storage on a device of its own */
    },
    dispose() {
      listeners.clear();
      commitListeners.clear();
    },
  };
}

export interface PhoneOptions {
  name?: string;
  id?: string;
  /**
   * How long the retained bootstrap takes to arrive.
   *
   * `0` is the settled case every other test wants. A non-zero value models a
   * phone unlocked and TAPPED before its first inbound state frame has landed.
   */
  handshakeMs?: number;
  /**
   * The DEVICE this page load belongs to. Two page loads with the same device
   * share a clock slot, which is what makes a reload a reload rather than a new
   * phone.
   */
  device?: string;
  /**
   * How far this phone's wall clock is from the room's, in ms.
   *
   * Negative is the interesting direction: a device running behind stamps its
   * writes behind, and after an outage longer than the skew it has heard none
   * of the writes that would have floored it. See `appSync.ts`'s room clock.
   */
  offsetMs?: number;
  /**
   * The document this page load starts from.
   *
   * A phone shares no localStorage with CAM and the display, so a RELOAD has to
   * boot from the document the closed page left — `peer.store.doc()` — not from
   * this process's one shared `readState()`. Getting that wrong is the
   * difference between modelling a reload and modelling a factory reset.
   */
  initial?: AppState;
  /** `sync.persistRemote`. False is a shipped user toggle, not a corner case. */
  persistRemote?: boolean;
  /** Model a full localStorage quota swallowing every DOCUMENT write. */
  quotaOnSyncWrites?: boolean;
  /** Seed this device's clock slot before the page starts — a damaged slot pin. */
  slotRaw?: string;
}

export async function startPhonePeer(broker: Broker, o: PhoneOptions = {}): Promise<Peer> {
  const name = o.name ?? 'phone';
  const id = o.id ?? 'phonepeer001';
  const offsetMs = o.offsetMs ?? 0;
  if (offsetMs !== 0) installDeviceClocks();
  const clock = makeDeviceClock(offsetMs);
  const store = onDeviceClock(
    createIsolatedStore(o.initial ?? readState().state, id, {
      quotaOnSyncWrites: o.quotaOnSyncWrites ?? false,
    }),
    clock,
  );
  if (o.slotRaw !== undefined) slotFor(o.device ?? name).write(o.slotRaw);
  const net = radio(clock.offset);
  const sync = await withAmbientAsync(offsetMs, () =>
    startAppSync({
      role: 'remote',
      clientId: id,
      store,
      persisted: () => store.doc(),
      url: {},
      settings: { ...syncSettings(), persistRemote: o.persistRemote ?? true },
      clockSlot: slotFor(o.device ?? name),
      factories: {
        fake: () => net.make(broker, o.handshakeMs ?? 0),
        localstorage: () => brokerTransport(createBroker()),
      },
      onRemoteState: (state, meta) => {
        if (meta.rev !== null) store.noteRev(meta.rev);
        note(
          `${name} applied ${meta.src}#${String(meta.seq)} retained=${String(meta.retained)} -> module=${state.activeModuleId} fit=${state.render.fit} rotate=${String(state.render.rotate)}`,
        );
      },
    }),
  );
  const stopPublishing = publishOnEveryChange(name, store, sync, clock.offset);
  return {
    name,
    store,
    sync,
    clock,
    doc: () => store.doc(),
    mute: () => {
      for (const t of net.made) t.mute();
    },
    unmute: () => {
      for (const t of net.made) t.unmute();
    },
    /*
     * ON THIS DEVICE'S CLOCK — `stop()` is the page's own shutdown flush.
     *
     * `appSync`'s `stop()` writes the document and the clock slot, and the slot
     * carries `base`/`baseAt`, which are readings of the DEVICE's clock. Running
     * it on the test's clock handed a skewed phone a correct one for the one
     * write where it matters, so a device whose clock had moved looked, in its
     * own slot, as though it never had.
     */
    async stop() {
      stopPublishing();
      await withAmbientAsync(clock.offset(), () => sync.stop());
      store.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Rooms and readings
// ---------------------------------------------------------------------------

/**
 * Block until the broker's retained slot is a frame `src` published.
 *
 * The slot is last-value, so which peer owns it is a race in a chatty room —
 * and a test whose subject is "what does a newcomer inherit from the
 * bootstrap?" has to pin it or it is testing the race instead.
 */
export async function retainedAuthoredBy(
  broker: Broker,
  src: string,
  timeoutMs = 6000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = broker.retained.state;
    if (frame !== undefined && decodeEnvelope(frame)?.src === src) return;
    await sleep(50);
  }
  throw new Error(`the retained slot never became ${src}'s${story()}`);
}

/** A retained snapshot an earlier session left on the broker. */
export function seedEarlierSession(broker: Broker, activeModuleId: string): void {
  broker.seedRetained(
    encodeEnvelope({
      v: PROTOCOL_VERSION,
      ch: 'state',
      ts: Date.now() - 60_000,
      src: 'earliersess',
      role: 'config',
      seq: 1,
      rev: 2,
      body: stateToSyncBody({ ...defaultAppState(), activeModuleId }),
    }),
  );
}

export interface Room {
  display: Peer;
  config: Peer;
  phone: Peer;
  stop(): Promise<void>;
}

export interface RoomOptions {
  /** Per-device wall-clock offsets in ms. Absent is 0, which is every old test. */
  offsets?: { display?: number; config?: number; phone?: number };
}

export async function openRoom(broker: Broker, o: RoomOptions = {}): Promise<Room> {
  const display = await startDisplayPeer(broker, o.offsets?.display ?? 0);
  const config = await startConfigPeer(broker, HANDSHAKE_MS, o.offsets?.config ?? 0);
  const phone = await startPhonePeer(broker, { offsetMs: o.offsets?.phone ?? 0 });
  // Long enough for the retained bootstrap, the first publishes and the first
  // persist cycle: the room is settled and agreeing before anybody taps.
  await sleep(HANDSHAKE_MS * 3);
  return {
    display,
    config,
    phone,
    async stop() {
      await phone.stop();
      await config.stop();
      await display.stop();
    },
  };
}

/**
 * Watch one reading for `ms`, and answer with the first value that was not
 * `expected` — the shape of assertion this bug class requires, because a single
 * check straight after the tap passes on a broken build.
 */
export async function firstDeviation(
  read: () => string,
  expected: string,
  ms: number,
): Promise<string> {
  const deadline = Date.now() + ms;
  let deviation = '';
  while (Date.now() < deadline) {
    const got = read();
    if (got !== expected && deviation === '') {
      deviation = got;
      note(`DEVIATION: read ${got}, expected ${expected}`);
    }
    await sleep(20);
  }
  return deviation;
}

/** Poll until every reading agrees, or the deadline passes. Returns the readings. */
export async function settleWithin(
  read: () => string[],
  ms: number,
  quietMs = 300,
): Promise<string[]> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const readings = read();
    if (new Set(readings).size === 1) {
      // One agreeing sample is not agreement: hold it for `quietMs` so a frame
      // still in flight has time to disagree.
      await sleep(quietMs);
      const again = read();
      if (new Set(again).size === 1 && again[0] === readings[0]) return again;
      continue;
    }
    await sleep(20);
  }
  return read();
}

export function moduleOn(peer: Peer): string {
  return peer.store.getSnapshot().activeModuleId;
}

export function videoCfg(peer: Peer): Record<string, unknown> {
  return (peer.store.getSnapshot().modules['video']?.cfg ?? {}) as Record<string, unknown>;
}

export function rotateOn(peer: Peer): string {
  return String(peer.store.getSnapshot().render.rotate);
}

export function fitOn(peer: Peer): string {
  return peer.store.getSnapshot().render.fit;
}
