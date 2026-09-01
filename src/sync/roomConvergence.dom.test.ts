/**
 * "It switches to Clock, holds for a second, then flips back to Video."
 *
 * The second report of that bug, after the `local` precedence layer (d6c164b)
 * failed to fix it. It failed because it was written without a reproduction,
 * and the reproduction was impossible against `FakeTransport`: that simulator
 * delivers its retained snapshot inside the same microtask as `connect()`, so
 * the bootstrap always lands BEFORE the user can click. A real broker over a
 * real network takes a few hundred milliseconds to finish the subscribe
 * handshake, and a finger is faster than that.
 *
 * So this harness models the transport semantics that actually matter and that
 * the fake lacked:
 *
 *  - **A retained snapshot from an EARLIER session**, delivered on subscribe,
 *    a beat after the page is already usable.
 *  - **Full fan-out with no coalescing** — a broker delivers every message, and
 *    `FakeTransport`'s single storage slot silently collapses bursts.
 *  - **Continuous telemetry** at the display's real cadence, because the user's
 *    report tied the glitch to the packet rate.
 *
 * What it caught, and what these tests now pin:
 *
 *  1. `persistRemote` wrote the RAW REMOTE BODY to the store — `store.commit(s
 *     => ({...s, ...syncBodyToPatch(body)}))` — which is not the resolved state.
 *     A `commit()` overwrites the snapshot outright, so the precedence layers
 *     that had just correctly answered "clock" were thrown away one line later
 *     and the stale retained `video` won anyway.
 *  2. That commit then fired `onCommit`, which folds a *deliberate local edit*
 *     into the `local` layer — so the layer whose entire job was to protect the
 *     user's click was poisoned with the value that had just overwritten it,
 *     making the revert permanent rather than momentary.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultAppState } from '../state/defaults';
import { withModuleConfig } from '../state/selectors';
import { commit as commitToStorage, readState, resetStateCache } from '../state/storage';
import { createStore } from '../state/store';

import { startAppSync, stateToSyncBody, type AppSync } from './appSync';
import { encodeEnvelope } from './envelope';

import type { Channel, FrameHandler, SyncTransport, TransportStatus } from './types';
import type { AppState } from '../state/schema';
import type { Store } from '../state/store';

// ---------------------------------------------------------------------------
// A broker with the semantics that matter
// ---------------------------------------------------------------------------

interface Sub {
  ch: Channel;
  cb: FrameHandler;
}

interface Broker {
  /** The last-value slot a subscriber is bootstrapped from. */
  retained: { state?: Uint8Array };
  subs: Set<Sub>;
  publish(ch: Channel, frame: Uint8Array): void;
  seedRetained(frame: Uint8Array): void;
}

function createBroker(): Broker {
  const subs = new Set<Sub>();
  const retained: { state?: Uint8Array } = {};
  return {
    retained,
    subs,
    seedRetained(frame) {
      retained.state = frame;
    },
    publish(ch, frame) {
      if (ch === 'state') retained.state = frame;
      for (const s of [...subs]) {
        if (s.ch !== ch) continue;
        // A broker echoes to every subscriber including the publisher's own
        // connection; `SyncService` is what drops our own `src`.
        queueMicrotask(() => {
          s.cb(frame, { retained: false });
        });
      }
    },
  };
}

/** How long after `connect()` resolves the retained bootstrap actually lands. */
const HANDSHAKE_MS = 400;

function brokerTransport(broker: Broker, handshakeMs = 0): SyncTransport {
  const subs = new Set<Sub>();
  const statusSubs = new Set<(s: TransportStatus, d?: string) => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let status: TransportStatus = 'idle';

  const attach = (ch: Channel, cb: FrameHandler): (() => void) => {
    const s: Sub = { ch, cb };
    subs.add(s);
    if (status === 'online') broker.subs.add(s);
    return () => {
      subs.delete(s);
      broker.subs.delete(s);
    };
  };

  return {
    id: 'fake',
    caps: {
      retained: true,
      replayMs: 0,
      needsNetwork: true,
      maxPayload: 64_000,
      channels: ['state', 'cmd', 'tele'],
      // Plaintext on purpose: this harness is about ordering and precedence,
      // and an AES round trip per frame would only add microtask depth.
      encrypted: false,
    },
    connect() {
      status = 'online';
      for (const s of subs) broker.subs.add(s);
      const retained = broker.retained.state;
      if (retained !== undefined) {
        for (const s of subs) {
          if (s.ch !== 'state') continue;
          const { cb } = s;
          const timer = setTimeout(() => {
            timers.delete(timer);
            cb(retained, { retained: true });
          }, handshakeMs);
          timers.add(timer);
        }
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
    publishState(frame) {
      broker.publish('state', frame);
      return Promise.resolve();
    },
    publishCmd(frame) {
      broker.publish('cmd', frame);
      return Promise.resolve();
    },
    publishTele(frame) {
      broker.publish('tele', frame);
      return Promise.resolve();
    },
    onState: (cb) => attach('state', cb),
    onCmd: (cb) => attach('cmd', cb),
    onTele: (cb) => attach('tele', cb),
    status: () => status,
    onStatus(cb) {
      statusSubs.add(cb);
      return () => statusSubs.delete(cb);
    },
  };
}

// ---------------------------------------------------------------------------
// The two pages
// ---------------------------------------------------------------------------

const ROOM = 'ABCD1234';

/** The display's real telemetry cadence, compressed so the suite stays quick. */
const TELE_PERIOD_MS = 120;
/** Longer than the revert ever took, and longer than the 2 s persist throttle. */
const HOLD_MS = 6000;
const SAMPLE_MS = 150;

function syncSettings(): AppState['sync'] {
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Peer {
  store: Store;
  sync: AppSync;
  stop(): Promise<void>;
}

/**
 * The config/remote page: `startAppSync` plus the one thing `useSync.ts` adds —
 * every store notification is republished as a full snapshot.
 */
async function startConfigPeer(broker: Broker, handshakeMs: number): Promise<Peer> {
  const store = createStore(readState().state, 'config', { commitBase: 'snapshot' });
  const sync = await startAppSync({
    role: 'config',
    clientId: 'configpeer01',
    store,
    persisted: () => readState().state,
    url: {},
    settings: syncSettings(),
    factories: {
      fake: () => brokerTransport(broker, handshakeMs),
      localstorage: () => brokerTransport(createBroker()),
    },
  });
  const stopPublishing = store.subscribe(() => {
    const next = store.getSnapshot();
    sync.service.publishState(stateToSyncBody(next), { rev: next.rev });
  });
  sync.service.publishState(stateToSyncBody(store.getSnapshot()), {
    rev: store.getSnapshot().rev,
    immediate: true,
  });
  return {
    store,
    sync,
    async stop() {
      stopPublishing();
      await sync.stop();
      store.dispose();
    },
  };
}

/** The display page: it applies state and publishes telemetry, and never publishes state. */
async function startDisplayPeer(broker: Broker): Promise<Peer> {
  const store = createStore(readState().state, 'display');
  const sync = await startAppSync({
    role: 'display',
    clientId: 'displaypeer1',
    store,
    persisted: () => readState().state,
    url: {},
    settings: syncSettings(),
    factories: {
      fake: () => brokerTransport(broker),
      localstorage: () => brokerTransport(createBroker()),
    },
  });
  // Two publishers on two periods, exactly like the real display: the video
  // module's `videoStats` and the replica feed's `monitor`.
  const stats = setInterval(() => {
    sync.service.publishTele({ ts: Date.now(), kind: 'videoStats' });
  }, TELE_PERIOD_MS);
  const monitor = setInterval(
    () => {
      sync.service.publishTele({ ts: Date.now(), kind: 'monitor' });
    },
    Math.round(TELE_PERIOD_MS * 1.25),
  );
  return {
    store,
    sync,
    async stop() {
      clearInterval(stats);
      clearInterval(monitor);
      await sync.stop();
      store.dispose();
    },
  };
}

/** A retained snapshot an earlier session left on the broker. */
function seedEarlierSession(broker: Broker, activeModuleId: string): void {
  broker.seedRetained(
    encodeEnvelope({
      v: 1,
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

/**
 * Asserts a reading HOLDS rather than merely being right once.
 *
 * The bug is a revert, so a single assertion straight after the click passes on
 * the broken build — it took about a second. Sampling across the window is the
 * only shape of test that could have caught it.
 */
async function holdsFor(read: () => string, expected: string, ms = HOLD_MS): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    expect(read()).toBe(expected);
    await sleep(SAMPLE_MS);
  }
}

function storedModule(): string {
  return readState().state.activeModuleId;
}

function storedFit(): string {
  const cfg = readState().state.modules['video']?.cfg as { render?: { fit?: string } } | undefined;
  return cfg?.render?.fit ?? 'unset';
}

describe('a room with a real broker under it', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStateCache();
    commitToStorage((s) => ({ ...s, activeModuleId: 'video' }), { role: 'config' });
  });

  afterEach(() => {
    localStorage.clear();
    resetStateCache();
  });

  it('holds a module switch made before the retained bootstrap lands', async () => {
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const display = await startDisplayPeer(broker);
    const config = await startConfigPeer(broker, HANDSHAKE_MS);

    try {
      // The user is quicker than the subscribe handshake, which is the entire
      // point: the stale `video` snapshot arrives AFTER the click.
      config.store.commit((s) => ({ ...s, activeModuleId: 'clock' }));
      expect(config.store.getSnapshot().activeModuleId).toBe('clock');

      await holdsFor(() => config.store.getSnapshot().activeModuleId, 'clock');
      expect(storedModule()).toBe('clock');
      // …and it converged on the other side of the room, so this is not a page
      // that has merely stopped listening.
      expect(display.store.getSnapshot().activeModuleId).toBe('clock');
    } finally {
      await config.stop();
      await display.stop();
    }
  }, 30_000);

  it('holds a module-config field through the same bootstrap', async () => {
    // The bug class is general: any setting the user changes has to survive a
    // stale replay, which is why the fix is architectural and not a special
    // case for `activeModuleId`.
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const display = await startDisplayPeer(broker);
    const config = await startConfigPeer(broker, HANDSHAKE_MS);

    try {
      config.store.commit((s) =>
        withModuleConfig(s, 'video', 1, {
          ...(s.modules['video']?.cfg as Record<string, unknown> | undefined),
          render: { fit: 'contain' },
          quality: { mode: 'fixed', height: 720 },
        }),
      );

      await holdsFor(storedFit, 'contain');
    } finally {
      await config.stop();
      await display.stop();
    }
  }, 30_000);

  it('holds on the DISPLAY when the switch came from the remote page', async () => {
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const display = await startDisplayPeer(broker);
    const config = await startConfigPeer(broker, HANDSHAKE_MS);

    try {
      config.store.commit((s) => ({ ...s, activeModuleId: 'stats' }));
      await sleep(HANDSHAKE_MS * 2);
      await holdsFor(() => display.store.getSnapshot().activeModuleId, 'stats');
    } finally {
      await config.stop();
      await display.stop();
    }
  }, 30_000);

  it('re-bootstraps after a transport drop without clobbering newer local state', async () => {
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const display = await startDisplayPeer(broker);
    const config = await startConfigPeer(broker, 0);

    try {
      await sleep(SAMPLE_MS);
      config.store.commit((s) => ({ ...s, activeModuleId: 'clock' }));
      await sleep(SAMPLE_MS);

      // The link drops and comes back, and the broker replays a snapshot that
      // predates the click — the exact shape of a reconnect on a phone radio.
      seedEarlierSession(broker, 'video');
      const second = await startConfigPeer(broker, HANDSHAKE_MS);
      try {
        await holdsFor(storedModule, 'clock');
      } finally {
        await second.stop();
      }
    } finally {
      await config.stop();
      await display.stop();
    }
  }, 30_000);
});
