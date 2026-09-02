import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveRoomKeys, open as unseal } from './crypto';
import { decodeEnvelope } from './envelope';
import {
  CONNECT_TIMEOUT_MS,
  KEEPALIVE_MS,
  PUBLISH_THROTTLE_MS,
  createSyncService,
  type SyncServiceOptions,
} from './SyncService';

import type {
  Channel,
  Envelope,
  FrameHandler,
  RecvMeta,
  SyncStateBody,
  SyncTransport,
  TransportStatus,
} from './types';
import type { ModuleSlot, SyncSettings } from '../state/schema';

/**
 * Read a published frame the way a peer would: unseal it, then decode it.
 *
 * Needed by the stamp tests, which assert on a field of the ENVELOPE
 * rather than on what a subscriber was handed — `seen` is a promise the sender
 * makes on the wire, and the wire is where it has to be checked.
 */
async function peek(frame: Uint8Array | undefined): Promise<Envelope | null> {
  if (frame === undefined) return null;
  const keys = await deriveRoomKeys('ABCD1234');
  const plain = await unseal(keys, 'state', frame);
  return plain === null ? null : decodeEnvelope(plain);
}

/** The nth `state` frame a transport actually sent, decoded. */
async function decodeSent(wire: TestTransport, index: number): Promise<Envelope | null> {
  return peek(wire.published.filter((p) => p.ch === 'state')[index]?.frame);
}

/**
 * A transport the test drives by hand.
 *
 * The storage-backed `FakeTransport` proves retained semantics; this one exists
 * for the things a broker cannot be asked to do on cue — deliver the SAME frame
 * twice, refuse a connection, hang forever, or go offline mid-session.
 */
interface TestTransport extends SyncTransport {
  published: { ch: Channel; frame: Uint8Array; retained: boolean }[];
  deliver(ch: Channel, frame: Uint8Array, retained?: boolean): void;
  drop(): void;
  connects: number;
}

function makeTransport(behaviour: { connect?: 'ok' | 'reject' | 'hang' } = {}): TestTransport {
  const subs: Record<Channel, Set<FrameHandler>> = {
    state: new Set(),
    cmd: new Set(),
    tele: new Set(),
  };
  const statusSubs = new Set<(s: TransportStatus, d?: string) => void>();
  let status: TransportStatus = 'idle';

  const t: TestTransport = {
    id: 'fake',
    caps: {
      retained: true,
      replayMs: 0,
      cmdReplayMs: 0,
      needsNetwork: true,
      maxPayload: 64_000,
      channels: ['state', 'cmd', 'tele'],
      encrypted: true,
    },
    published: [],
    connects: 0,
    connect() {
      t.connects += 1;
      if (behaviour.connect === 'reject') return Promise.reject(new Error('refused'));
      if (behaviour.connect === 'hang') return new Promise<void>(() => undefined);
      status = 'online';
      return Promise.resolve();
    },
    disconnect() {
      status = 'idle';
      return Promise.resolve();
    },
    publishState(frame) {
      t.published.push({ ch: 'state', frame, retained: true });
      return Promise.resolve();
    },
    publishCmd(frame) {
      t.published.push({ ch: 'cmd', frame, retained: false });
      return Promise.resolve();
    },
    publishTele(frame) {
      t.published.push({ ch: 'tele', frame, retained: false });
      return Promise.resolve();
    },
    onState(cb) {
      subs.state.add(cb);
      return () => subs.state.delete(cb);
    },
    onCmd(cb) {
      subs.cmd.add(cb);
      return () => subs.cmd.delete(cb);
    },
    onTele(cb) {
      subs.tele.add(cb);
      return () => subs.tele.delete(cb);
    },
    status: () => status,
    onStatus(cb) {
      statusSubs.add(cb);
      return () => statusSubs.delete(cb);
    },
    deliver(ch, frame, retained = false) {
      for (const cb of subs[ch]) cb(frame, { retained });
    },
    drop() {
      status = 'offline';
      for (const cb of statusSubs) cb('offline', 'simulated drop');
    },
  };
  return t;
}

const SETTINGS: SyncSettings = {
  enabled: true,
  roomCode: 'ABCD1234',
  transport: 'fake',
  mqttUrl: '',
  ntfyBase: '',
  persistRemote: true,
  publishTelemetry: true,
};

function body(activeModuleId = 'video'): SyncStateBody {
  return {
    activeModuleId,
    modules: { video: { v: 1, cfg: { url: 'https://example.test/a.mp4' } } },
    playback: null,
    render: {
      fit: 'cover',
      zoom: 1,
      offsetX: 0,
      offsetY: 0,
      rotate: 0,
      safeAreaPct: 0.08,
      safeRadiusPct: 0.88,
      maskCircle: 'auto',
      background: '#000000',
    },
  };
}

/** Two services joined by the single transport pair the test controls. */
async function pair(aOpts: Partial<SyncServiceOptions> = {}): Promise<{
  a: ReturnType<typeof createSyncService>;
  b: ReturnType<typeof createSyncService>;
  wire: TestTransport;
  peer: TestTransport;
  pump: () => void;
}> {
  const wire = makeTransport();
  const peer = makeTransport();
  const a = createSyncService({
    role: 'remote',
    clientId: 'peer-a-000001',
    settings: SETTINGS,
    withLocal: false,
    factories: { fake: () => wire },
    ...aOpts,
  });
  const b = createSyncService({
    role: 'display',
    clientId: 'peer-b-000002',
    settings: SETTINGS,
    withLocal: false,
    factories: { fake: () => peer },
  });
  await a.start();
  await b.start();
  let forwarded = 0;
  return {
    a,
    b,
    wire,
    peer,
    pump: () => {
      for (const p of wire.published.slice(forwarded)) peer.deliver(p.ch, p.frame, p.retained);
      forwarded = wire.published.length;
    },
  };
}

/**
 * Captured before `useFakeTimers()` replaces the global.
 *
 * The sync layer's publish path goes through WebCrypto, and in Node
 * `subtle.encrypt` resolves from the thread pool — an event-loop *task*, not a
 * microtask. `advanceTimersByTimeAsync` drains microtasks only, so a test that
 * used it alone would assert on a frame that had not been sealed yet. Yielding
 * to the real loop either side of the fake clock is what makes the two work
 * together.
 */
const realSetTimeout = globalThis.setTimeout;
const tick = (): Promise<void> =>
  new Promise<void>((resolve) => {
    realSetTimeout(resolve, 0);
  });

/**
 * Two trailing ticks were a guess, and on a loaded machine — a full `npm run
 * check`, several vitest workers competing for the same libuv thread pool — it
 * was sometimes one short: `subtle.encrypt` had not resolved, so the frame under
 * assertion did not exist yet. The seal is a fixed, small amount of work, so
 * yielding a few more times costs microseconds and removes the race rather than
 * making it rarer.
 */
const TRAILING_TICKS = 8;

async function flush(ms = 0): Promise<void> {
  await tick();
  if (ms > 0) await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < TRAILING_TICKS; i += 1) await tick();
}

/**
 * Yield to the real event loop until `predicate` holds.
 *
 * Needed wherever a test advances the FAKE clock past something that is only
 * scheduled after a WebCrypto call: `deriveRoomKeys` and the last-will `seal`
 * both resolve from the thread pool, so `service.start()` reaches its
 * `setTimeout(CONNECT_TIMEOUT_MS)` a macrotask or two later. Advancing the fake
 * clock before that timer exists means it is never fired at all — the fake clock
 * does not move again — and the awaited promise hangs until the test times out.
 * Waiting for the observable effect instead of guessing a tick count is the
 * difference between "usually passes" and "passes".
 */
async function until(predicate: () => boolean, ticks = 200): Promise<void> {
  for (let i = 0; i < ticks && !predicate(); i += 1) await tick();
  if (!predicate()) throw new Error('until(): the condition never became true');
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('state channel', () => {
  it('delivers a full snapshot to a peer', async () => {
    const { a, b, pump } = await pair();
    const seen: SyncStateBody[] = [];
    b.onState((s) => {
      seen.push(s);
    });

    a.publishState(body(), { rev: 1, immediate: true });
    await flush(1);
    pump();
    await flush(1);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.activeModuleId).toBe('video');
    await a.stop();
    await b.stop();
  });

  it('never applies its own echo', async () => {
    const { a, wire } = await pair();
    const seen: SyncStateBody[] = [];
    a.onState((s) => {
      seen.push(s);
    });

    a.publishState(body(), { rev: 1, immediate: true });
    await flush(1);
    // A real broker echoes a publish back to the publisher's own subscription.
    for (const p of wire.published) wire.deliver(p.ch, p.frame, p.retained);
    await flush(1);

    expect(seen).toHaveLength(0);
    await a.stop();
  });

  it('drops a duplicate (src, seq) — retained redelivery and replay are inert', async () => {
    const { a, b, wire, peer } = await pair();
    const seen: SyncStateBody[] = [];
    b.onState((s) => {
      seen.push(s);
    });

    a.publishState(body(), { rev: 5, immediate: true });
    await flush(1);
    const frame = wire.published[0]?.frame;
    expect(frame).toBeDefined();

    peer.deliver('state', frame ?? new Uint8Array(), true);
    await flush(1);
    peer.deliver('state', frame ?? new Uint8Array(), true);
    await flush(1);

    expect(seen).toHaveLength(1);
    await a.stop();
    await b.stop();
  });

  it('applies a snapshot whose rev is OLDER than the last one from that peer', async () => {
    /*
     * The rev floor is gone, and its removal is a fix rather than a
     * simplification. `rev` is a Lamport counter kept in each writer's own
     * localStorage document, and a reloaded page's persisted rev is by
     * construction at least the rev of the frame the broker retained — so the
     * floor dropped the bootstrap on EVERY reload, before any subscriber saw
     * it, which is the third of the four defects that killed the previous
     * design (S4, fact 3).
     *
     * Nothing is lost by deleting it: a redelivery of the same frame is stopped
     * by `(src, seq)` dedup one line earlier, and a genuinely older SNAPSHOT
     * carries older per-leaf stamps, so the merge ignores it on its own merits.
     */
    const { a, b, pump } = await pair();
    const seen: SyncStateBody[] = [];
    b.onState((s) => {
      seen.push(s);
    });

    a.publishState(body('video'), { rev: 9, immediate: true });
    await flush(1);
    pump();
    await flush(1);

    a.publishState(body('clock-lite'), { rev: 4, immediate: true });
    await flush(1);
    pump();
    await flush(1);

    expect(seen).toHaveLength(2);
    await a.stop();
    await b.stop();
  });

  it('is ciphertext on the wire, not readable JSON', async () => {
    const { a, wire } = await pair();
    a.publishState(body(), { rev: 1, immediate: true });
    await flush(1);
    const frame = wire.published[0]?.frame ?? new Uint8Array();
    const text = new TextDecoder().decode(frame);
    expect(text).not.toContain('example.test');
    expect(text).not.toContain('activeModuleId');
    expect(frame[0]).toBe(0x01);
    await a.stop();
  });
});

describe('stamps and the clock on the wire', () => {
  /*
   * `SyncService` owns none of the merge policy any more — it carries what
   * `appSync` hands it and trims it when the envelope will not fit. These prove
   * the carrying and the trimming; `merge.ts` and the convergence suites prove
   * the policy.
   */

  it('publishes no stamps at all for a service that merges nothing', async () => {
    const { a, wire } = await pair();
    a.publishState(body(), { rev: 1, immediate: true });
    await flush(1);
    const env = await decodeSent(wire, 0);
    expect(env?.stamps).toBeUndefined();
    expect(env?.clock).toBeUndefined();
    await a.stop();
  });

  it('carries the stamps and the clock it is handed', async () => {
    const { a, wire } = await pair({
      wireStamps: () => ({
        map: { 'render.fit': [1_700_000_000_000, 0, 'phonepeer001'] },
        clock: [1_700_000_000_000, 0, 'phonepeer001'],
      }),
    });
    a.publishState(body(), { rev: 1, immediate: true });
    await flush(1);
    const env = await decodeSent(wire, 0);
    expect(env?.stamps).toEqual({ 'render.fit': [1_700_000_000_000, 0, 'phonepeer001'] });
    expect(env?.clock).toEqual([1_700_000_000_000, 0, 'phonepeer001']);
    await a.stop();
  });

  it('delivers them to the receiver as decoded stamps', async () => {
    const { a, b, pump } = await pair({
      wireStamps: () => ({ map: { 'render.fit': [17, 2, 'peer'] }, clock: [17, 2, 'peer'] }),
    });
    const metas: RecvMeta[] = [];
    b.onState((_s, m) => {
      metas.push(m);
    });
    a.publishState(body(), { rev: 1, immediate: true });
    await flush(1);
    pump();
    await flush(1);
    expect(metas[0]?.stamps.get('render.fit')).toEqual({ t: 17, c: 2, s: 'peer' });
    expect(metas[0]?.clock).toEqual({ t: 17, c: 2, s: 'peer' });
    await a.stop();
    await b.stop();
  });

  it('drops a trimmed module\u2019s stamps with the module (\u00a76.2)', async () => {
    /*
     * The converse of the ladder's rule, asserted at the one rung that can
     * break it: trimming the bank removes leaves from the BODY, and a stamp
     * left behind for a leaf the body no longer carries is a stamp with no
     * value \u2014 the mirror image of the defect the whole layer exists to stop.
     * It is also pure waste, since a receiver can pair it with nothing.
     *
     * There is no rung above this one any more. The ladder used to open by
     * dropping the stamps of every leaf whose value equalled the built-in
     * default while shipping those values anyway, which made setting anything
     * back to its default permanently unsendable on any frame over 8 kB. See
     * `fitStateEnvelope`.
     */
    const big: Record<string, ModuleSlot> = {};
    for (let i = 0; i < 40; i += 1)
      big[`mod${String(i)}`] = { v: 1, cfg: { blob: 'y'.repeat(150) } };
    const stamps: Record<string, [number, number, string]> = {};
    for (let i = 0; i < 32; i += 1)
      stamps[`modules.mod${String(i)}.cfg.blob`] = [1_700_000_000_000, i, 'phonepeer001'];
    stamps['render.fit'] = [1_700_000_000_000, 99, 'phonepeer001'];
    const { a, wire } = await pair({
      wireStamps: () => ({ map: stamps, clock: [1, 0, 'p'] }),
    });
    a.publishState({ ...body('mod7'), modules: big }, { rev: 1, immediate: true });
    await flush(1);
    const env = await decodeSent(wire, 0);
    expect(env).not.toBeNull();
    const shipped = Object.keys(env?.stamps ?? {});
    // The bank had to go at this size, and the stamps of the modules that went
    // with it went too \u2014 while the active module's stamp, and a stamp on a leaf
    // sitting at its built-in default, both travelled.
    expect(shipped).not.toContain('modules.mod0.cfg.blob');
    expect(shipped).toContain('modules.mod7.cfg.blob');
    expect(shipped).toContain('render.fit');
    await a.stop();
  });
});

describe('throttling', () => {
  it('coalesces rapid state publishes to 5 Hz', async () => {
    const { a, wire } = await pair();

    // The first goes out immediately; the next nine collapse into one.
    for (let i = 1; i <= 10; i += 1) a.publishState(body(), { rev: i });
    await flush(1);
    expect(wire.published).toHaveLength(1);

    await flush(PUBLISH_THROTTLE_MS + 10);
    expect(wire.published).toHaveLength(2);
    await a.stop();
  });

  it('throttles commands per operation, so a slider drag is not a command storm', async () => {
    const { a, wire } = await pair();
    for (let i = 0; i < 10; i += 1) a.sendCmd('seekTo', i);
    await flush(1);
    expect(wire.published.filter((p) => p.ch === 'cmd')).toHaveLength(1);

    // A DIFFERENT op is not throttled by the first one's window.
    a.sendCmd('play');
    await flush(1);
    expect(wire.published.filter((p) => p.ch === 'cmd')).toHaveLength(2);
    await a.stop();
  });
});

describe('command channel', () => {
  it('drops a command a peer re-sends out of its own past', async () => {
    /*
     * The staleness gate, at the only comparison it is allowed to make.
     *
     * It used to be `now - env.ts`, and this test used to justify that with "this
     * is exactly what an ntfy replay cache would hand a fresh subscriber" — which
     * was not true of any shipped transport (`NTFY_RECOVERY` polls for `state`
     * alone, and the live `/sse` subscription carries no `since=`) and was fatal
     * for a real device: a subtraction across two clocks made a phone with a
     * wrong clock permanently deaf. Redelivery is `(src, seq)`'s job and always
     * was. See `CMD_MAX_AGE_MS`.
     *
     * So the gate measures one sender against ITSELF: a fresh command arrives,
     * and then a second one, distinct `seq`, stamped twenty seconds behind the
     * first. That is a peer talking out of its own past, and it is refused.
     */
    const { a, b, wire, peer } = await pair();
    const seen: string[] = [];
    b.onCmd((cmd) => seen.push(cmd.op));

    a.sendCmd('play');
    await flush(1);
    const fresh = wire.published.find((p) => p.ch === 'cmd')?.frame;
    expect(fresh).toBeDefined();
    peer.deliver('cmd', fresh ?? new Uint8Array());
    await flush(1);
    expect(seen).toEqual(['play']);

    // `a`'s clock steps twenty seconds backwards, past `CMD_MAX_AGE_MS`, and it
    // taps again. Same `src`, new `seq`, a `ts` behind the one already accepted.
    vi.setSystemTime(new Date(Date.now() - 20_000));
    a.sendCmd('seekBy', 10);
    await flush(1);
    const stale = wire.published.filter((p) => p.ch === 'cmd').at(-1)?.frame;
    peer.deliver('cmd', stale ?? new Uint8Array());
    await flush(1);

    expect(seen).toEqual(['play']);
    await a.stop();
    await b.stop();
  });

  it('delivers a fresh command', async () => {
    const { a, b, pump } = await pair();
    const seen: { op: string; arg?: unknown }[] = [];
    b.onCmd((cmd) => seen.push(cmd));

    a.sendCmd('seekBy', 10);
    await flush(1);
    pump();
    await flush(1);

    expect(seen).toEqual([{ op: 'seekBy', arg: 10 }]);
    await a.stop();
    await b.stop();
  });

  /**
   * The remote diagnostics pull, at the wire level.
   *
   * `requestDiag` was added to `CmdOp` after the protocol shipped, and the
   * addition is only safe because it needed no envelope version bump — `v`
   * stays 1 and an older peer simply does not recognise the op. This asserts
   * both halves: the command crosses an encrypted channel unchanged, and it
   * does so under protocol version 1.
   */
  it('carries requestDiag, added to the contract without a protocol bump', async () => {
    const { a, b, pump, wire } = await pair();
    const seen: { op: string; arg?: unknown }[] = [];
    b.onCmd((cmd) => seen.push(cmd));

    a.sendCmd('requestDiag');
    await flush(1);
    pump();
    await flush(1);

    expect(seen).toEqual([{ op: 'requestDiag' }]);
    // Still ciphertext: the op name is nowhere in the frame.
    const frame = wire.published.at(-1);
    expect(frame).toBeDefined();
    expect(new TextDecoder().decode(frame?.frame)).not.toContain('requestDiag');
    await a.stop();
    await b.stop();
  });
});

describe('retained keepalive', () => {
  it('republishes the last snapshot every five minutes', async () => {
    const { a, wire } = await pair();
    a.publishState(body(), { rev: 1, immediate: true });
    await flush(1);
    expect(wire.published).toHaveLength(1);

    await flush(KEEPALIVE_MS + 10);
    expect(wire.published).toHaveLength(2);
    await flush(KEEPALIVE_MS);
    expect(wire.published).toHaveLength(3);

    // Same envelope, so a peer that already applied it drops the republish.
    expect(wire.published[1]?.retained).toBe(true);
    await a.stop();
  });

  it('publishes nothing when this peer has never written state', async () => {
    const { b, peer } = await pair();
    await flush(KEEPALIVE_MS * 2);
    expect(peer.published.filter((p) => p.ch === 'state')).toHaveLength(0);
    await b.stop();
  });
});

describe('failover', () => {
  it('advances to the next transport when the first refuses to connect', async () => {
    const primary = makeTransport({ connect: 'reject' });
    const fallback = makeTransport();
    const service = createSyncService({
      role: 'remote',
      clientId: 'peer-a-000001',
      settings: SETTINGS,
      withLocal: false,
      factories: { fake: (slot) => (slot === 'primary' ? primary : fallback) },
    });

    await service.start();
    expect(primary.connects).toBe(1);
    expect(fallback.connects).toBe(1);
    expect(service.status().failedOver).toBe(true);
    expect(service.status().network).toBe('online');
    await service.stop();
  });

  it('advances when the first transport hangs past the five-second timeout', async () => {
    const primary = makeTransport({ connect: 'hang' });
    const fallback = makeTransport();
    const service = createSyncService({
      role: 'remote',
      clientId: 'peer-a-000001',
      settings: SETTINGS,
      withLocal: false,
      factories: { fake: (slot) => (slot === 'primary' ? primary : fallback) },
    });

    const started = service.start();
    // `start()` derives the room keys and seals a last-will frame — two
    // WebCrypto round trips — BEFORE it calls `connect()` and arms the connect
    // timeout. Advancing the fake clock before that timer exists would leave it
    // armed for a moment that never comes, and the hung transport would hang the
    // test rather than fail it. So: wait for the attempt, then advance past it.
    await until(() => primary.connects === 1);
    await flush(CONNECT_TIMEOUT_MS + 100);
    await started;

    expect(service.status().failedOver).toBe(true);
    expect(fallback.connects).toBe(1);
    await service.stop();
  });

  it('goes offline, not broken, when every transport is unreachable', async () => {
    const primary = makeTransport({ connect: 'reject' });
    const fallback = makeTransport({ connect: 'reject' });
    const service = createSyncService({
      role: 'display',
      clientId: 'peer-b-000002',
      settings: SETTINGS,
      withLocal: false,
      factories: { fake: (slot) => (slot === 'primary' ? primary : fallback) },
    });

    await service.start();
    expect(service.status().network).toBe('offline');
    expect(service.status().networkTransport).toBeNull();
    expect(service.status().lastError).toContain('refused');
    await service.stop();
  });

  it('re-runs the ladder when a live transport drops', async () => {
    const primary = makeTransport();
    const fallback = makeTransport();
    const service = createSyncService({
      role: 'remote',
      clientId: 'peer-a-000001',
      settings: SETTINGS,
      withLocal: false,
      factories: { fake: (slot) => (slot === 'primary' ? primary : fallback) },
    });
    await service.start();
    expect(primary.connects).toBe(1);

    primary.drop();
    await flush(5000);

    expect(primary.connects + fallback.connects).toBeGreaterThan(1);
    await service.stop();
  });
});

describe('rooms', () => {
  it('reports no room and starts no network slot when none is configured', async () => {
    const service = createSyncService({
      role: 'display',
      clientId: 'peer-b-000002',
      settings: { ...SETTINGS, roomCode: null },
      withLocal: false,
    });
    await service.start();
    expect(service.status().roomConfigured).toBe(false);
    expect(service.topicId()).toBeNull();
    await service.stop();
  });

  it('counts decrypt failures so a wrong room code is visible, not silent', async () => {
    const wire = makeTransport();
    const service = createSyncService({
      role: 'display',
      clientId: 'peer-b-000002',
      settings: SETTINGS,
      withLocal: false,
      factories: { fake: () => wire },
    });
    await service.start();

    for (let i = 0; i < 12; i += 1) {
      wire.deliver('state', new Uint8Array([0x01, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]));
    }
    await flush(1);

    expect(service.status().decryptFailures).toBeGreaterThanOrEqual(10);
    expect(service.status().lastError).toContain('room code');
    await service.stop();
  });
});
