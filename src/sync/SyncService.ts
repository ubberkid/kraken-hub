/**
 * The orchestrator: transport selection, failover, encryption, dedup,
 * throttling and the retained keepalive.
 *
 * Everything that is a *policy* lives here and everything that is a *pipe*
 * lives in `transports/`. A new transport implements nine small methods and
 * inherits AES-GCM, the 8 KB envelope cap, echo suppression, command staleness
 * and last-writer-wins ordering without writing a line of any of it.
 *
 * ## The slot model
 *
 * Two slots, and they are independent on purpose:
 *
 *  - the **local slot** (`LocalStorageTransport`) always runs. It is free, it
 *    needs no room code, it covers CAM's Configuration Browser ↔ Kraken Browser
 *    case, and its failure domain has nothing to do with the internet.
 *  - the **network slot** holds AT MOST ONE of mqtt / ntfy / fake. On a connect
 *    error or a 5 s timeout it advances down the ladder; `SyncStatus.failedOver`
 *    is what the remote UI renders as "fallback transport — higher latency".
 *
 * ## Rules the rest of the app relies on
 *
 *  - `state` is a FULL snapshot, retained, never a delta. A cold display must be
 *    right after exactly one message.
 *  - A peer NEVER applies its own echo (`env.src === clientId` is dropped before
 *    anything else), which is what keeps two config surfaces from ping-ponging.
 *  - `cmd` older than 15 s is dropped, which is what makes ntfy's 12 h replay
 *    cache safe to subscribe to.
 *  - A frame is deduped on `(src, seq)` and on nothing else. There is no rev
 *    floor and no "is this a replay?" branch: a retained redelivery or a
 *    keepalive republish is inert because the MERGE is idempotent
 *    (`src/sync/merge.ts`), not because this file recognised it.
 *  - Every `state` frame carries `stamps` and `clock`; `appSync.ts` owns both
 *    and this file only carries them, trims them and hands them over.
 */

import { createLogger } from '../lib/log';
import { monotonicNow } from '../lib/monotonic';

import { createBackoff } from './backoff';
import { deriveRoomKeys, seal, open, type RoomKeys } from './crypto';
import {
  DEFAULT_MQTT_URL,
  DEFAULT_NTFY_BASE,
  MQTT_SCHEMES,
  NTFY_SCHEMES,
  normalizeEndpoint,
} from './endpoints';
import {
  decodeEnvelope,
  encodeEnvelope,
  envelopeBytes,
  EnvelopeTooLargeError,
  stampsOf,
} from './envelope';
import { enumerateLeaves } from './leaves';
import { normalizeRoomCode } from './roomCode';
import { createFakeTransport } from './transports/FakeTransport';
import { createLocalStorageTransport } from './transports/LocalStorageTransport';
import { PROTOCOL_VERSION, CMD_MAX_AGE_MS, MAX_ENVELOPE_BYTES, type Channel } from './types';

import type { StampTuple } from './hlc';
import type {
  CmdBody,
  CmdOp,
  Envelope,
  RecvMeta,
  Role,
  SyncStatus,
  SyncStateBody,
  SyncTransport,
  TeleBody,
  TransportId,
  Unsub,
} from './types';
import type { SyncSettings } from '../state/schema';

const log = createLogger('sync/service');

/** Plan: auto-failover on connect error OR a 5 s timeout. */
export const CONNECT_TIMEOUT_MS = 5000;
/** Plan: publish throttling at 5 Hz. */
export const PUBLISH_THROTTLE_MS = 200;
/** Plan: 5-minute retained keepalive republish. */
export const KEEPALIVE_MS = 300_000;
/** Enough to cover a handover window plus a full ntfy replay. */
export const DEDUP_MAX = 256;
/** Ten failures inside this window means "wrong room code", not "bad luck". */
export const DECRYPT_ALARM_WINDOW_MS = 30_000;
export const DECRYPT_ALARM_COUNT = 10;

/**
 * The sequence counter is per DOCUMENT, not per service — and that is a fix, not
 * a shortcut.
 *
 * Every receiver dedupes on the pair `(src, seq)` (see `remember`), and `src` is
 * `clientId()`, which is deliberately one value for the whole page load. So the
 * uniqueness `seq` has to provide is uniqueness *within a document*, and a
 * counter that lived on the service restarted at zero every time a second
 * service was constructed — at which point every message it ever sent carried a
 * `(src, seq)` the peer had already seen, and was silently dropped as a replay.
 *
 * Not hypothetical: the config page starts a service on `#/remote` and another
 * on the merged About/Diagnostics page, so a user who walked from one to the
 * other had a connection that reported "online" and could not deliver a single
 * command — which is exactly how "Request hardware report" stopped answering
 * when the pull moved pages.
 */
let documentSeq = 0;

function nextSeq(): number {
  documentSeq += 1;
  return documentSeq;
}

export interface SyncServiceOptions {
  role: Role;
  clientId: string;
  settings: SyncSettings;
  /**
   * Test seam. `SyncService.test.ts` injects fakes here rather than monkey
   * patching module state, so a test can run two peers in one process.
   */
  factories?: Partial<Record<TransportId, (slot?: 'primary' | 'fallback') => SyncTransport>>;
  /** Skip the zero-network slot (the live smoke test wants only the broker). */
  withLocal?: boolean;
  /**
   * The per-leaf stamps and the clock for the next state publish.
   *
   * Read at publish time rather than passed in with the body, because the answer
   * lives in `appSync`'s register table — the only place that knows when each
   * leaf was decided — while the body comes from the store, which knows nothing
   * about the wire. A service constructed without it publishes no stamps at
   * all, which is the honest answer for a peer that merges nothing (the live
   * smoke test) and reads on the far side as "every leaf is unstamped".
   *
   * It is handed the BODY it is stamping, and that is the whole of the converse
   * invariant: a stamp may only travel for a leaf whose value in this body is
   * the value the stamp describes. See `appSync.ts`'s implementation for what
   * happens without it.
   */
  wireStamps?: (body: SyncStateBody) => { map: Record<string, StampTuple>; clock: StampTuple };
}

export interface PublishStateOptions {
  /** `AppState.rev`, the Lamport counter used for last-writer-wins. */
  rev: number;
  /** Bypass the 5 Hz throttle — used on the first publish after connecting. */
  immediate?: boolean;
}

export interface SyncService {
  start(): Promise<void>;
  stop(): Promise<void>;
  publishState(body: SyncStateBody, opts: PublishStateOptions): void;
  sendCmd(op: CmdOp, arg?: unknown): void;
  /**
   * A telemetry packet, throttled to 5 Hz — EXCEPT when it is an answer.
   *
   * The throttle exists for the continuous stream a display volunteers, where
   * dropping a packet costs nothing: another one is 2 s away. A diagnostics
   * report is not that. It is a one-shot answer to a button somebody just
   * pressed on another machine, and losing it because a routine `videoStats`
   * packet happened to land 180 ms earlier makes that button silently do
   * nothing — which is the exact failure the remote pull exists to remove. Its
   * chunks pass `immediate`.
   */
  publishTele(body: TeleBody, opts?: { immediate?: boolean }): void;
  /**
   * A state subscriber.
   *
   * It reports nothing back, and that is the shape of the fix: under the
   * acknowledgement design a receipt travelled from here into the far peer's
   * arbitration, so every disagreement about what "applied" meant became a
   * disagreement about who was allowed to write. The merge is now a function of
   * the frame's own stamps, so there is nothing for the receiver to answer.
   */
  onState(cb: (body: SyncStateBody, meta: RecvMeta) => void): Unsub;
  onCmd(cb: (body: CmdBody, meta: RecvMeta) => void): Unsub;
  onTele(cb: (body: TeleBody, meta: RecvMeta) => void): Unsub;
  onStatus(cb: (s: SyncStatus) => void): Unsub;
  status(): SyncStatus;
  /** The derived topic, once `start()` has resolved. Diagnostics only. */
  topicId(): string | null;
}

interface Rung {
  id: TransportId;
  make: () => SyncTransport;
}

function ladderFor(settings: SyncSettings, factories: SyncServiceOptions['factories']): Rung[] {
  const make = (id: TransportId, slot?: 'primary' | 'fallback'): (() => SyncTransport) => {
    const override = factories?.[id];
    if (override !== undefined) return () => override(slot);
    switch (id) {
      case 'fake':
        return () => createFakeTransport(slot ?? 'primary');
      case 'mqtt':
        // Lazily imported inside the transport itself; the factory is cheap.
        return () => lazyMqtt();
      case 'ntfy':
        return () => lazyNtfy();
      default:
        return () => createLocalStorageTransport();
    }
  };

  switch (settings.transport) {
    case 'off':
      return [];
    case 'mqtt':
      return [{ id: 'mqtt', make: make('mqtt') }];
    case 'ntfy':
      return [{ id: 'ntfy', make: make('ntfy') }];
    case 'fake':
      return [
        { id: 'fake', make: make('fake', 'primary') },
        { id: 'fake', make: make('fake', 'fallback') },
      ];
    case 'auto':
    default:
      return [
        { id: 'mqtt', make: make('mqtt') },
        { id: 'ntfy', make: make('ntfy') },
      ];
  }
}

/**
 * The two network transports are behind a deferred `import()` so that neither
 * mqtt.js nor the ntfy client is in the graph of a page that never configures a
 * room. The proxy shape keeps `ladderFor()` synchronous.
 */
function lazyMqtt(): SyncTransport {
  return deferredTransport('mqtt', async () => {
    const mod = await import('./transports/MqttTransport');
    return mod.createMqttTransport();
  });
}

function lazyNtfy(): SyncTransport {
  return deferredTransport('ntfy', async () => {
    const mod = await import('./transports/NtfyTransport');
    return mod.createNtfyTransport();
  });
}

/**
 * A transport that materialises its real implementation on `connect()`.
 *
 * Without this, `ladderFor()` would have to be async and every caller would
 * await a dynamic import even when the ladder is empty — which is the common
 * case on the LCD.
 */
function deferredTransport(id: TransportId, load: () => Promise<SyncTransport>): SyncTransport {
  let inner: SyncTransport | null = null;
  const pending: { ch: Channel; cb: Parameters<SyncTransport['onState']>[0] }[] = [];
  const statusSubs: ((
    s: Parameters<Parameters<SyncTransport['onStatus']>[0]>[0],
    d?: string,
  ) => void)[] = [];

  const subscribeAll = (t: SyncTransport): void => {
    for (const p of pending) {
      if (p.ch === 'state') t.onState(p.cb);
      else if (p.ch === 'cmd') t.onCmd(p.cb);
      else t.onTele(p.cb);
    }
    for (const cb of statusSubs) t.onStatus(cb);
  };

  return {
    id,
    // Conservative until the real one is loaded; `connect()` swaps it in.
    caps: {
      retained: true,
      replayMs: 0,
      needsNetwork: true,
      maxPayload: 64_000,
      channels: ['state', 'cmd', 'tele'],
      encrypted: true,
    },
    async connect(o) {
      const t = await load();
      inner = t;
      subscribeAll(t);
      await t.connect(o);
      // Adopt the real capabilities now that they exist.
      Object.assign(this.caps, t.caps);
    },
    disconnect: () => inner?.disconnect() ?? Promise.resolve(),
    publishState: (f) => inner?.publishState(f) ?? Promise.reject(new Error('not connected')),
    publishCmd: (f) => inner?.publishCmd(f) ?? Promise.reject(new Error('not connected')),
    publishTele: (f) => inner?.publishTele(f) ?? Promise.reject(new Error('not connected')),
    onState(cb) {
      if (inner !== null) return inner.onState(cb);
      pending.push({ ch: 'state', cb });
      return () => undefined;
    },
    onCmd(cb) {
      if (inner !== null) return inner.onCmd(cb);
      pending.push({ ch: 'cmd', cb });
      return () => undefined;
    },
    onTele(cb) {
      if (inner !== null) return inner.onTele(cb);
      pending.push({ ch: 'tele', cb });
      return () => undefined;
    },
    status: () => inner?.status() ?? 'idle',
    onStatus(cb) {
      if (inner !== null) return inner.onStatus(cb);
      statusSubs.push(cb);
      return () => undefined;
    },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${what} timed out after ${String(ms)} ms`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export function createSyncService(o: SyncServiceOptions): SyncService {
  const { role, clientId } = o;
  const settings = o.settings;
  const roomCode = settings.roomCode === null ? null : normalizeRoomCode(settings.roomCode);

  const mqttUrl = normalizeEndpoint(settings.mqttUrl, DEFAULT_MQTT_URL, MQTT_SCHEMES);
  const ntfyBase = normalizeEndpoint(settings.ntfyBase, DEFAULT_NTFY_BASE, NTFY_SCHEMES);

  const stateSubs = new Set<(b: SyncStateBody, m: RecvMeta) => void>();
  const cmdSubs = new Set<(b: CmdBody, m: RecvMeta) => void>();
  const teleSubs = new Set<(b: TeleBody, m: RecvMeta) => void>();
  const statusSubs = new Set<(s: SyncStatus) => void>();

  const abort = new AbortController();
  const ladder = roomCode === null ? [] : ladderFor(settings, o.factories);
  const withLocal = o.withLocal !== false;

  let keys: RoomKeys | null = null;
  let local: SyncTransport | null = null;
  let network: SyncTransport | null = null;
  /** Which rung of `ladder` the network slot currently holds. */
  let rungIndex = 0;
  let started = false;
  let reconnecting = false;
  const backoff = createBackoff();

  const seen = new Set<string>();

  let lastSeenAt: number | null = null;
  let decryptFailures = 0;
  let decryptWindowStart = 0;
  let lastError: string | null = null;
  let failedOver = false;

  // Pending publishes, coalesced by the 5 Hz throttle.
  let pendingState: Envelope<SyncStateBody> | null = null;
  let stateTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * On the MONOTONIC clock — see `src/lib/monotonic.ts`.
   *
   * `-Infinity` rather than `0`, and the difference is not cosmetic: a monotonic
   * clock's origin is somewhere near process start, so `0` would mean "published
   * a fraction of a second ago" and would throttle the FIRST publish of a page —
   * the one that carries the whole snapshot to a cold display. A wall clock hid
   * that by being an epoch number.
   */
  let lastStatePublishAt = -Infinity;
  let lastRetained: Envelope<SyncStateBody> | null = null;
  /**
   * Where `fitStateEnvelope`'s rotating stamp window starts next.
   *
   * Per service, so two peers in one test process rotate independently, and
   * only advanced when the rung that uses it actually fires.
   */
  let stampCursor = 0;
  const lastCmdAt = new Map<CmdOp, number>();
  let lastTeleAt = 0;
  let keepalive: ReturnType<typeof setInterval> | null = null;

  function currentStatus(): SyncStatus {
    return {
      local: local?.status() ?? 'idle',
      network: network?.status() ?? (ladder.length === 0 ? 'idle' : 'offline'),
      networkTransport: network?.id ?? null,
      failedOver,
      lastError,
      lastSeenAt,
      decryptFailures,
      roomConfigured: roomCode !== null,
    };
  }

  function emitStatus(): void {
    const snapshot = currentStatus();
    for (const cb of [...statusSubs]) {
      try {
        cb(snapshot);
      } catch (err) {
        log.warn('status subscriber threw', err);
      }
    }
  }

  function noteDecryptFailure(): void {
    const now = Date.now();
    if (now - decryptWindowStart > DECRYPT_ALARM_WINDOW_MS) {
      decryptWindowStart = now;
      decryptFailures = 0;
    }
    decryptFailures += 1;
    if (decryptFailures === DECRYPT_ALARM_COUNT) {
      lastError = 'No messages could be decrypted — check the room code.';
      log.warn(lastError);
    }
    emitStatus();
  }

  function remember(key: string): boolean {
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > DEDUP_MAX) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return true;
  }

  async function handleFrame(
    ch: Channel,
    transport: SyncTransport,
    frame: Uint8Array,
    meta: { retained: boolean },
  ): Promise<void> {
    let plain = frame;
    if (transport.caps.encrypted) {
      if (keys === null) {
        noteDecryptFailure();
        return;
      }
      const opened = await open(keys, ch, frame);
      if (opened === null) {
        noteDecryptFailure();
        return;
      }
      plain = opened;
    }

    const env = decodeEnvelope(plain);
    if (env?.ch !== ch) return;
    // Echo suppression comes before everything else, always.
    if (env.src === clientId) return;
    if (!remember(`${env.src}:${String(env.seq)}`)) return;

    lastSeenAt = Date.now();

    const recv: RecvMeta = {
      src: env.src,
      role: env.role,
      seq: env.seq,
      ts: env.ts,
      rev: env.rev ?? null,
      retained: meta.retained,
      via: transport.id,
      stamps: stampsOf(env),
      clock: env.clock === undefined ? null : { t: env.clock[0], c: env.clock[1], s: env.clock[2] },
    };

    if (ch === 'cmd') {
      if (Date.now() - env.ts > CMD_MAX_AGE_MS) return;
      const body = env.body as CmdBody;
      if (typeof body !== 'object' || typeof body.op !== 'string') return;
      for (const cb of [...cmdSubs]) cb(body, recv);
      return;
    }

    if (ch === 'state') {
      /*
       * Handed straight over — no rev floor, no replay branch, no receipt.
       *
       * There used to be a guard here that dropped any frame whose `rev` did
       * not strictly exceed the last one applied from that peer, and it was the
       * single most expensive line in the layer: a reloaded page's persisted
       * `rev` is by construction at least the rev of the frame the broker
       * retained, so on EVERY reload the bootstrap was dropped before any
       * subscriber saw it. The merge below is idempotent by construction
       * (`src/sync/merge.ts`), so a redelivery, a keepalive republish and a
       * retained replay are all no-ops on their own merits, and `(src, seq)`
       * dedup above already spares the work of merging the same frame twice.
       *
       * The whole envelope is handed over, because the stamps are what the
       * merge is made of — see `onState` in `appSync.ts`.
       */
      for (const cb of [...stateSubs]) cb(env.body as SyncStateBody, recv);
      emitStatus();
      return;
    }

    for (const cb of [...teleSubs]) cb(env.body as TeleBody, recv);
  }

  function wire(transport: SyncTransport): void {
    const bind = (ch: Channel): void => {
      if (!transport.caps.channels.includes(ch)) return;
      const handler = (frame: Uint8Array, meta: { retained: boolean }): void => {
        void handleFrame(ch, transport, frame, meta).catch((err: unknown) => {
          log.warn('inbound frame failed', err);
        });
      };
      if (ch === 'state') transport.onState(handler);
      else if (ch === 'cmd') transport.onCmd(handler);
      else transport.onTele(handler);
    };
    bind('state');
    bind('cmd');
    bind('tele');
    transport.onStatus((s, detail) => {
      if (s === 'error' || s === 'offline') {
        lastError = detail ?? lastError;
        // A network slot that drops after it was online re-runs the ladder from
        // its own rung: the same transport may simply have blipped, and if it
        // has not, `connectNetwork` walks down to the fallback on its own. This
        // is the runtime half of the failover the connect timeout covers.
        if (transport === network && started) scheduleReconnect();
      }
      emitStatus();
    });
  }

  function scheduleReconnect(): void {
    if (reconnecting) return;
    reconnecting = true;
    const dropped = network;
    network = null;
    emitStatus();
    setTimeout(() => {
      void (async () => {
        await dropped?.disconnect().catch(() => undefined);
        await connectNetwork(rungIndex);
        reconnecting = false;
      })();
    }, backoff.next());
  }

  async function frameFor(transport: SyncTransport, env: Envelope): Promise<Uint8Array | null> {
    let bytes: Uint8Array;
    try {
      bytes = encodeEnvelope(env);
    } catch (err) {
      if (err instanceof EnvelopeTooLargeError) throw err;
      return null;
    }
    if (!transport.caps.encrypted) return bytes;
    if (keys === null) return null;
    return seal(keys, env.ch, bytes);
  }

  function activeTransports(): SyncTransport[] {
    return [local, network].filter((t): t is SyncTransport => t !== null);
  }

  function publishEnvelope(env: Envelope, kind: 'state' | 'cmd' | 'tele'): void {
    for (const t of activeTransports()) {
      if (!t.caps.channels.includes(env.ch)) continue;
      void frameFor(t, env)
        .then((frame) => {
          if (frame === null) return undefined;
          if (kind === 'state') return t.publishState(frame);
          if (kind === 'cmd') return t.publishCmd(frame);
          return t.publishTele(frame);
        })
        .catch((err: unknown) => {
          lastError = err instanceof Error ? err.message : String(err);
          log.warn(`publish on ${t.id} failed`, err);
          emitStatus();
        });
    }
  }

  /**
   * Shrink an oversized snapshot rather than dropping it.
   *
   * The 8 KB cap is real and a fork with a dozen modules can hit it. Dropping
   * every module but the active one and setting `partial` is safe precisely
   * because the receiver merges the body as a patch onto its own state — the
   * modules that were left out keep whatever the receiver already had.
   */
  function fitStateEnvelope(env: Envelope<SyncStateBody>): Envelope<SyncStateBody> | null {
    const active = env.body.modules[env.body.activeModuleId];

    /**
     * Step 1: the module bank, down to the base kind — AND the stamps of the
     * leaves that went with it.
     *
     * Dropping those stamps is not a second rung, it is the other half of this
     * one: a stamp for a leaf the body no longer carries is a stamp with no
     * value, which is the mirror of the rule the ladder exists to protect. It
     * costs nothing to the receiver (a stamp it cannot pair with anything is
     * ignored on arrival) and it is exactly the bytes the trim was for.
     */
    const trim = (e: Envelope<SyncStateBody>): Envelope<SyncStateBody> => {
      const body: SyncStateBody = {
        ...e.body,
        modules: active === undefined ? {} : { [e.body.activeModuleId]: active },
        partial: true,
      };
      if (e.stamps === undefined) return { ...e, body };
      const leaves = enumerateLeaves(body);
      const kept: Record<string, [number, number, string]> = {};
      for (const [path, stamp] of Object.entries(e.stamps)) {
        if (!leaves.has(path)) continue;
        kept[path] = stamp;
      }
      const { stamps: _dropped, ...rest } = e;
      return Object.keys(kept).length === 0 ? { ...rest, body } : { ...rest, stamps: kept, body };
    };

    /**
     * Step 2: a ROTATING slice of the stamps that are left.
     *
     * This is the last rung, and the one that needs an argument. A stamp
     * dropped from a frame whose body still names the leaf is not an omission —
     * the receiver reads the unstamped value as `EPOCH`, the beginning of time,
     * so that leaf cannot win an argument it should win. Under a FIXED window
     * that is permanent: a leaf buried under newer edits never climbs back, and
     * a peer that was not listening when the stamp was fresh never converges.
     * Measured, before this existed: thirty seconds of continuous republishing
     * and the phone never learned the module CAM had picked.
     *
     * So the window ROTATES. Each frame takes as many stamps as the remaining
     * bytes hold, starting where the last frame stopped, and the cursor moves
     * on by that many. Since at least one stamp travels per frame, every
     * stamped leaf carries its stamp within at most `n` frames for `n` stamps —
     * in practice one or two, since the budget only bites on a snapshot near
     * the 8 kB cap. `lookWireBudget.test.ts` pins the bound.
     */
    const rotateStamps = (e: Envelope<SyncStateBody>): Envelope<SyncStateBody> | null => {
      const entries = Object.entries(e.stamps ?? {});
      if (entries.length === 0) return null;
      const { stamps: _all, ...bare } = e;
      const spent = envelopeBytes(bare);
      // `,"stamps":{}` is the wrapper the entries below go inside.
      let budget = MAX_ENVELOPE_BYTES - spent - 12;
      if (budget <= 0) return null;
      const kept: Record<string, [number, number, string]> = {};
      let taken = 0;
      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[(stampCursor + i) % entries.length];
        if (entry === undefined) break;
        const [path, stamp] = entry;
        const cost = JSON.stringify(path).length + JSON.stringify(stamp).length + 2;
        if (cost > budget) break;
        budget -= cost;
        kept[path] = stamp;
        taken += 1;
      }
      if (taken === 0) return null;
      stampCursor = (stampCursor + taken) % entries.length;
      return { ...bare, stamps: kept };
    };

    /*
     * ── The trim order, and why `look.layers` is not in it (§6.2) ─────────────
     *
     *  1. **The module bank, down to the base kind** (`partial: true`), with the
     *     stamps of the leaves it dropped. Costs a receiver the configuration of
     *     modules it is not showing, which it keeps from its own copy because
     *     every leaf merges on its own stamp.
     *  2. **A rotating slice of the remaining stamps.** Costs the leaves left
     *     out one frame's worth of ordering, and they are back in the next one.
     *  3. **Nothing else.** `look.layers` is NEVER truncated or stripped: a
     *     look with a layer missing is not a smaller look, it is a different
     *     arrangement, and half of somebody's panel silently disappearing is a
     *     worse failure than a refused publish. Past this rung the frame is
     *     dropped, logged and surfaced through `lastError`.
     *
     * What is NOT a rung, at any point: shipping a leaf's value while silently
     * dropping the stamp that dates it, FOR GOOD. There used to be a rung above
     * these that did exactly that — it dropped the stamps of every leaf whose
     * value happened to equal the built-in default, on the argument that "a
     * receiver that does not get one keeps whatever it already holds, which for
     * a leaf still sitting on its default is the same value". The premise was
     * false in the only case that mattered: the receiver is not holding the
     * default, it is holding the value the ROOM agreed on, and the unstamped
     * default reads as `EPOCH` and loses to it forever. Setting anything BACK to
     * its default — `render.fit` to 'cover', "undo my crop" — became unsendable
     * the moment a frame crossed 8 kB, on every frame, permanently. Unlike the
     * rotating rung below, nothing repaired it. Measured: CAM tunes 150 knobs
     * and commits fit=contain, the room agrees, the phone commits fit=cover 1.5 s
     * later, and eleven seconds and seven hundred frames on the room still holds
     * two values.
     *
     * So the ladder now has exactly one stamp-dropping rung and it ROTATES.
     */
    // Lazy, because rung 2 has a side effect (the cursor) that must not run for
    // a frame that fitted a rung earlier.
    const candidates: (() => Envelope<SyncStateBody> | null)[] = [
      () => env,
      () => trim(env),
      () => rotateStamps(trim(env)),
    ];
    let last: unknown = null;
    for (const build of candidates) {
      const candidate = build();
      if (candidate === null) continue;
      try {
        encodeEnvelope(candidate);
        return candidate;
      } catch (err) {
        if (!(err instanceof EnvelopeTooLargeError)) return null;
        last = err;
      }
    }
    log.error(
      'state snapshot does not fit the 8 KB sync cap even with the bank trimmed; ' +
        'the look is never truncated, so this frame is not sent',
      last,
    );
    lastError = last instanceof Error ? last.message : String(last);
    emitStatus();
    return null;
  }

  function flushState(): void {
    if (stateTimer !== null) {
      clearTimeout(stateTimer);
      stateTimer = null;
    }
    const pending = pendingState;
    pendingState = null;
    if (pending === null) return;
    const fitted = fitStateEnvelope(pending);
    if (fitted === null) return;
    lastRetained = fitted;
    lastStatePublishAt = monotonicNow();
    publishEnvelope(fitted, 'state');
  }

  /**
   * The last will, and the one place it is allowed to point.
   *
   * `tele` ONLY. A will on `state` would publish a tombstone over the retained
   * snapshot the instant a display dropped off the network — deleting the exact
   * message a reloading display cold-starts from.
   */
  async function buildWill(): Promise<Uint8Array | null> {
    if (keys === null || role === 'config') return null;
    try {
      const env: Envelope<TeleBody> = {
        v: PROTOCOL_VERSION,
        ch: 'tele',
        ts: Date.now(),
        src: clientId,
        role,
        seq: 0,
        body: { ts: Date.now(), kind: 'offline' },
      };
      return await seal(keys, 'tele', encodeEnvelope(env));
    } catch (err) {
      log.warn('could not build a last-will payload', err);
      return null;
    }
  }

  async function connectNetwork(from: number): Promise<void> {
    const will = await buildWill();
    for (let i = from; i < ladder.length; i += 1) {
      const rung = ladder[i];
      if (rung === undefined) continue;
      const transport = rung.make();
      // Subscribe BEFORE connecting, never after.
      //
      // A retained message can be delivered as part of the connect handshake
      // itself — that is exactly what "retained" means, and it is the single
      // most important message the whole layer carries. Wiring the handlers up
      // afterwards loses it, and the failure mode is a cold display that sits
      // on its defaults forever while the status line cheerfully says
      // "online". Measured, not feared: that is what the first version did.
      wire(transport);
      try {
        await withTimeout(
          transport.connect({
            topicId: keys?.topicId ?? '',
            clientId,
            role,
            mqttUrl,
            ntfyBase,
            signal: abort.signal,
            ...(will === null ? {} : { willFrame: will }),
          }),
          CONNECT_TIMEOUT_MS,
          `${rung.id} connect`,
        );
        network = transport;
        rungIndex = i;
        backoff.reset();
        failedOver = i > 0;
        lastError = failedOver ? `fell back to ${rung.id}` : null;
        emitStatus();
        // Re-assert our snapshot on the new transport, retained.
        if (lastRetained !== null) publishEnvelope(lastRetained, 'state');
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        log.warn(`${rung.id} connect failed — trying the next transport`, err);
        await transport.disconnect().catch(() => undefined);
      }
    }
    network = null;
    failedOver = ladder.length > 1;
    emitStatus();
  }

  return {
    async start() {
      if (started) return;
      started = true;

      if (withLocal) {
        local = o.factories?.localstorage?.() ?? createLocalStorageTransport();
        // Subscribe first, for the same reason as the network slot below.
        wire(local);
        await local.connect({
          topicId: '',
          clientId,
          role,
          mqttUrl,
          ntfyBase,
          signal: abort.signal,
        });
      }

      if (roomCode !== null && ladder.length > 0) {
        keys = await deriveRoomKeys(roomCode);
        await connectNetwork(0);
        const interval =
          network?.caps.keepaliveMs !== undefined
            ? Math.min(network.caps.keepaliveMs, KEEPALIVE_MS)
            : KEEPALIVE_MS;
        keepalive = setInterval(() => {
          // Only the last writer republishes: two peers taking turns would
          // otherwise fight over the retained slot forever.
          if (lastRetained !== null) publishEnvelope(lastRetained, 'state');
        }, interval);
      }
      emitStatus();
    },

    async stop() {
      started = false;
      /*
       * ── The last publish, BEFORE the transports go ────────────────────────
       *
       * A snapshot handed over inside the 200 ms throttle window is held in
       * `pendingState` waiting for a timer. `stop()` used to clear that timer
       * and drop it, so the last tap of a session — a tap and then a lock, a
       * tap and then a close, which is how a phone is actually used — never
       * reached the room at all. In a display-only room there is nobody to ask
       * for it afterwards, so it was gone: measured at `display=90` after the
       * phone tapped 90 and then 180 forty milliseconds later.
       *
       * `flushState()` is synchronous down to the transport's own publish, and
       * a `pagehide` handler has time for it — the same budget the two
       * localStorage writes in `appSync`'s `stop()` already spend.
       */
      flushState();
      abort.abort();
      if (stateTimer !== null) clearTimeout(stateTimer);
      stateTimer = null;
      if (keepalive !== null) clearInterval(keepalive);
      keepalive = null;
      await Promise.all(activeTransports().map((t) => t.disconnect().catch(() => undefined)));
      local = null;
      network = null;
      stateSubs.clear();
      cmdSubs.clear();
      teleSubs.clear();
      statusSubs.clear();
    },

    publishState(body, opts) {
      const seq = nextSeq();
      const wire = o.wireStamps?.(body);
      const env: Envelope<SyncStateBody> = {
        v: PROTOCOL_VERSION,
        ch: 'state',
        ts: Date.now(),
        src: clientId,
        role,
        seq,
        rev: opts.rev,
        /*
         * Stamped at REQUEST time, with the register table as it stands for
         * the body being handed over. Reading it again at flush time would be
         * wrong in the one direction that matters: the body is the state as of
         * NOW, and annotating it with stamps taken later would claim a decision
         * the body does not contain.
         */
        ...(wire === undefined || Object.keys(wire.map).length === 0 ? {} : { stamps: wire.map }),
        ...(wire === undefined ? {} : { clock: wire.clock }),
        body,
      };
      pendingState = env;
      /*
       * On the MONOTONIC clock, and clamped on top of that.
       *
       * `Date.now() - lastStatePublishAt` after a backward wall-clock step is
       * negative: the immediate branch is skipped AND the trailing flush is
       * scheduled `|step|` into the future, where the `stateTimer !== null`
       * guard below then swallows every publish until it fires. Measured on a
       * one-hour backward step: one state frame in the following ten seconds,
       * the room split in two, no outage, no error, no status change — and the
       * silence scaled linearly with the size of the step. A negative elapsed is
       * now read for what it is, "the clock moved, publish now", and no
       * arithmetic here can schedule a flush further out than one throttle
       * period. See `src/lib/monotonic.ts`.
       */
      const elapsed = monotonicNow() - lastStatePublishAt;
      if (opts.immediate === true || elapsed < 0 || elapsed >= PUBLISH_THROTTLE_MS) {
        flushState();
        return;
      }
      if (stateTimer !== null) return;
      const delay = Math.min(Math.max(PUBLISH_THROTTLE_MS - elapsed, 0), PUBLISH_THROTTLE_MS);
      stateTimer = setTimeout(flushState, delay);
    },

    sendCmd(op, arg) {
      const now = Date.now();
      const previous = lastCmdAt.get(op) ?? 0;
      if (now - previous < PUBLISH_THROTTLE_MS) return;
      lastCmdAt.set(op, now);
      publishEnvelope(
        {
          v: PROTOCOL_VERSION,
          ch: 'cmd',
          ts: now,
          src: clientId,
          role,
          seq: nextSeq(),
          body: arg === undefined ? { op } : { op, arg },
        },
        'cmd',
      );
    },

    publishTele(body, opts) {
      const now = Date.now();
      // `immediate` still moves the clock: a burst of report chunks should push
      // the next routine packet out, not race it.
      if (opts?.immediate !== true && now - lastTeleAt < PUBLISH_THROTTLE_MS) return;
      lastTeleAt = now;
      publishEnvelope(
        { v: PROTOCOL_VERSION, ch: 'tele', ts: now, src: clientId, role, seq: nextSeq(), body },
        'tele',
      );
    },

    onState(cb) {
      stateSubs.add(cb);
      return () => stateSubs.delete(cb);
    },
    onCmd(cb) {
      cmdSubs.add(cb);
      return () => cmdSubs.delete(cb);
    },
    onTele(cb) {
      teleSubs.add(cb);
      return () => teleSubs.delete(cb);
    },
    onStatus(cb) {
      statusSubs.add(cb);
      return () => statusSubs.delete(cb);
    },
    status: currentStatus,
    topicId: () => keys?.topicId ?? null,
  };
}

/** The transport ladder a given settings object produces. Diagnostics only. */
export function describeLadder(settings: SyncSettings): TransportId[] {
  return ladderFor(settings, undefined).map((r) => r.id);
}
