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
 *  - `state` is applied only when `rev` strictly exceeds the last applied one,
 *    so a retained redelivery or a keepalive republish is inert.
 */

import { createLogger } from '../lib/log';

import { createBackoff } from './backoff';
import { deriveRoomKeys, seal, open, type RoomKeys } from './crypto';
import {
  DEFAULT_MQTT_URL,
  DEFAULT_NTFY_BASE,
  MQTT_SCHEMES,
  NTFY_SCHEMES,
  normalizeEndpoint,
} from './endpoints';
import { decodeEnvelope, encodeEnvelope, EnvelopeTooLargeError } from './envelope';
import { normalizeRoomCode } from './roomCode';
import { createFakeTransport } from './transports/FakeTransport';
import { createLocalStorageTransport } from './transports/LocalStorageTransport';
import { PROTOCOL_VERSION, CMD_MAX_AGE_MS, type Channel } from './types';

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
  publishTele(body: TeleBody): void;
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
  let seq = 0;
  let started = false;
  let reconnecting = false;
  const backoff = createBackoff();

  const seen = new Set<string>();
  let lastAppliedRev = -1;
  let lastSeenAt: number | null = null;
  let decryptFailures = 0;
  let decryptWindowStart = 0;
  let lastError: string | null = null;
  let failedOver = false;

  // Pending publishes, coalesced by the 5 Hz throttle.
  let pendingState: { env: Envelope<SyncStateBody> } | null = null;
  let stateTimer: ReturnType<typeof setTimeout> | null = null;
  let lastStatePublishAt = 0;
  let lastRetained: Envelope<SyncStateBody> | null = null;
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
    };

    if (ch === 'cmd') {
      if (Date.now() - env.ts > CMD_MAX_AGE_MS) return;
      const body = env.body as CmdBody;
      if (typeof body !== 'object' || typeof body.op !== 'string') return;
      for (const cb of [...cmdSubs]) cb(body, recv);
      return;
    }

    if (ch === 'state') {
      const rev = env.rev ?? null;
      if (rev !== null && rev <= lastAppliedRev) return;
      if (rev !== null) lastAppliedRev = rev;
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
    try {
      encodeEnvelope(env);
      return env;
    } catch (err) {
      if (!(err instanceof EnvelopeTooLargeError)) return null;
    }
    const active = env.body.modules[env.body.activeModuleId];
    const trimmed: Envelope<SyncStateBody> = {
      ...env,
      body: {
        ...env.body,
        modules: active === undefined ? {} : { [env.body.activeModuleId]: active },
        partial: true,
      },
    };
    try {
      encodeEnvelope(trimmed);
      return trimmed;
    } catch (err) {
      log.error('state snapshot does not fit the 8 KB sync cap even when trimmed', err);
      lastError = err instanceof Error ? err.message : String(err);
      emitStatus();
      return null;
    }
  }

  function flushState(): void {
    if (stateTimer !== null) {
      clearTimeout(stateTimer);
      stateTimer = null;
    }
    const pending = pendingState;
    pendingState = null;
    if (pending === null) return;
    const fitted = fitStateEnvelope(pending.env);
    if (fitted === null) return;
    lastRetained = fitted;
    lastStatePublishAt = Date.now();
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
      seq += 1;
      const env: Envelope<SyncStateBody> = {
        v: PROTOCOL_VERSION,
        ch: 'state',
        ts: Date.now(),
        src: clientId,
        role,
        seq,
        rev: opts.rev,
        body,
      };
      pendingState = { env };
      const elapsed = Date.now() - lastStatePublishAt;
      if (opts.immediate === true || elapsed >= PUBLISH_THROTTLE_MS) {
        flushState();
        return;
      }
      if (stateTimer !== null) return;
      stateTimer = setTimeout(flushState, PUBLISH_THROTTLE_MS - elapsed);
    },

    sendCmd(op, arg) {
      const now = Date.now();
      const previous = lastCmdAt.get(op) ?? 0;
      if (now - previous < PUBLISH_THROTTLE_MS) return;
      lastCmdAt.set(op, now);
      seq += 1;
      publishEnvelope(
        {
          v: PROTOCOL_VERSION,
          ch: 'cmd',
          ts: now,
          src: clientId,
          role,
          seq,
          body: arg === undefined ? { op } : { op, arg },
        },
        'cmd',
      );
    },

    publishTele(body) {
      const now = Date.now();
      if (now - lastTeleAt < PUBLISH_THROTTLE_MS) return;
      lastTeleAt = now;
      seq += 1;
      publishEnvelope(
        { v: PROTOCOL_VERSION, ch: 'tele', ts: now, src: clientId, role, seq, body },
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
