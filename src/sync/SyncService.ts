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
 *  - `cmd` is deduped on `(src, seq)` like everything else, and passes three
 *    gates on top of that, none of which subtracts one device's clock from
 *    another's: a frame the transport flags RETAINED is refused (a command is
 *    never a stored last-value); a frame more than 15 s behind the newest
 *    BROKER stamp this link has delivered is refused (broker time against
 *    broker time — the only reading a cold receiver has, and what makes a
 *    replay cache safe); and a frame more than 15 s behind the newest `ts` THAT
 *    SENDER delivered is refused (one device's clock against itself, which is
 *    the only thing that can catch a peer re-sending out of its own past).
 *    `TransportCaps.cmdReplayMs` says what each transport actually replays.
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
  FrameMeta,
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
/**
 * How many of the NEWEST stamps ride on every frame, before anything rotates.
 *
 * The rotating window alone is fair and too slow. Measured, on a config peer
 * with a full look and 300 tuned knobs — 336 leaves, 29 stamps to a frame — the
 * just-made tap's stamp landed on 1 frame in 7, and a passive display (which
 * publishes telemetry and never state, so there is no ping-pong to make the
 * writer emit faster than its ~2 s persist tick) learned a SEQUENTIAL edit
 * after 12.2 s. The scaling law is steep and lives inside the shipped ceiling:
 * 150 knobs → 26 ms, 200 → 176 ms, 250 → 4.2 s, 300 → 10-12 s.
 *
 * The leaf a receiver most urgently needs to order is the one somebody just
 * touched, and `stampedNewestFirst()` hands the map in exactly that order. So
 * the newest few are reserved unconditionally on EVERY frame and the remaining
 * budget rotates over the rest — which closes the delay without reintroducing
 * the bug the rotation was written for, since a pure newest-N window would let
 * a leaf buried under newer edits fall out for good.
 *
 * Eight rather than one: a burst is what a user makes (a tap plus the module
 * config it drags with it), and eight stamps is about 300 bytes out of 8192.
 *
 * ## What it is NOT
 *
 * It is a RECENCY window, and recency is not the same question as "has the room
 * heard this?". Tap first and tune 300 knobs after — the order a person
 * actually works in — and the tap is out of the newest eight before the next
 * frame goes out; measured, a passive display then showed the wrong value for
 * 20.2 s at 300 knobs and 96.2 s at 400. So the unshipped writes come off the
 * budget BEFORE this reserve, and this reserve is what covers the leaf the room
 * has already heard about but only just. See `fitStateEnvelope`'s last rung.
 */
export const RESERVED_NEWEST_STAMPS = 8;

/**
 * What a refused frame says on the status line.
 *
 * Past the last rung the frame is not sent, and a room whose writer cannot send
 * is permanently silent and split — with no outage, no error and a status line
 * reading online. Measured: 500 knobs on the ACTIVE module make the BARE
 * envelope 8767 B with no stamps at all, so every rung throws and `trim` cannot
 * help, because the rung keeps the active module by construction.
 *
 * The honest claim names what the person can act on — the arrangement, not the
 * byte count — and it goes through the same `SyncStatus.lastError` the
 * connection panel already renders as a warning notice.
 */
export const WIRE_TOO_LARGE_CLAIM =
  'Too much to send — this arrangement no longer fits on the wire';

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
  wireStamps?: (body: SyncStateBody) => {
    map: Record<string, StampTuple>;
    clock: StampTuple;
    /**
     * Which of `map`'s paths the ROOM has not heard yet, newest first.
     *
     * `fitStateEnvelope`'s rotating rung takes these before anything else, so a
     * write nobody else has seen cannot be rotated off the wire behind a burst
     * of newer stamps. Absent (the live smoke test, `SyncService.test.ts`) the
     * rung behaves exactly as it did: reserved head, then rotation.
     */
    unshipped?: readonly string[];
  };
  /**
   * ROOM time — `appSync`'s `roomNow()`, the one number in the app that both
   * ends of a frame can agree on.
   *
   * It writes the `ts` on every outbound envelope, and that is now ALL it does
   * on this side of the wire — the receiver folds it as a room-offset sample.
   * The `CMD_MAX_AGE_MS` gate used to read it too, and no longer does: see
   * `lastCmdTsBySrc` below for why room time was not enough to save that
   * subtraction. The history is still worth keeping, because it is two rounds of
   * the same mistake. The gate used to subtract two RAW wall clocks,
   * which is a bug with a clean cliff in it: a phone more than fifteen seconds
   * BEHIND had every command it ever sent dropped on arrival — play, pause,
   * seek, setModule, requestLibrary, the lot — with the status line reading
   * online and `useSync`'s cold library pull retrying forever into the void. The
   * shelf stayed blank for the life of the device, across every reload, because
   * what was wrong was the phone's clock and nothing in the room corrected it.
   * The `state` path was made skew-proof (room offset, HLC floor, monotonic
   * base, intent layer) and `cmd` was left as a bare two-clock subtraction.
   *
   * Room time on both ends fixed that for every skew the 24 h clamp can absorb
   * and left the cliff standing at `MAX_ROOM_OFFSET_MS`, because a clamped
   * offset is precisely a room time that is allowed to be wrong. Only removing
   * the cross-device subtraction closed it.
   *
   * Absent (the live smoke test, `SyncService.test.ts`) it falls back to
   * `Date.now()`, which is exactly the old behaviour.
   */
  roomNow?: () => number;
  /**
   * "These leaf paths have now left this device on the room's transport."
   *
   * The one fact `appSync` cannot work out for itself. Its clock slot must never
   * evict a register for a write the room has not heard (see
   * `MAX_SLOT_REGISTERS`), and "has the room heard it?" is answered here and
   * nowhere else: the paths are the stamps of the frame that was actually
   * published, after `fitStateEnvelope` trimmed it, and they are reported only
   * once a transport's `publishState` has RESOLVED while that transport reads
   * `online`.
   *
   * "The room's transport" means the network slot when there is one, and the
   * zero-network slot only when there is not — a page with a network transport
   * that is offline has not shipped anything, however happily its localStorage
   * echo resolved. There is no acknowledgement protocol on this wire, so this is
   * the strongest honest signal available; it can only be too CONSERVATIVE (a
   * register kept unshipped longer than it needed to be), which costs a little
   * slot budget and never a user's edit.
   */
  onStateShipped?: (paths: readonly string[]) => void;
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
  /**
   * Raise a claim on `SyncStatus.lastError` from outside the service.
   *
   * One caller: `appSync`'s clock slot, when what it has to write down does not
   * fit even the unshipped safety bound. That is the same fact as a refused
   * frame — this arrangement is bigger than the machinery can carry — and it
   * deserves the same sentence in the same place rather than a second vocabulary
   * nobody has taught the UI. See `WIRE_TOO_LARGE_CLAIM`.
   */
  noteError(message: string): void;
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
      cmdReplayMs: Number.POSITIVE_INFINITY,
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
  /** Room time for everything that crosses the wire. See `SyncServiceOptions.roomNow`. */
  const wireNow = (): number => o.roomNow?.() ?? Date.now();
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

  /**
   * The newest `ts` this page has accepted from each command sender.
   *
   * The `cmd` age gate used to be `wireNow() - env.ts > CMD_MAX_AGE_MS` — a
   * subtraction across TWO DEVICES. Room time made both halves comparable for
   * most peers, but only for a sender that has already folded a frame AND whose
   * skew fits the 24 h `MAX_ROOM_OFFSET_MS` clamp, so the cliff moved rather
   * than closed: a phone more than 24 h behind clamps its offset at 24 h, keeps
   * a residual hour of error, and had every command it ever sent dropped on
   * arrival — permanently, across reloads, with the status line reading online.
   * The same subtraction ate the FIRST tap of any phone unlocked and tapped
   * before its first inbound frame (the `cmd` channel has no intent layer), and
   * a correct-clock phone could be made deaf by a departed peer that had pinned
   * this receiver's `roomOffset` at the clamp.
   *
   * So the gate is now SELF-REFERENTIAL: one device's clock against itself. The
   * first command from an unseen `src` is accepted unconditionally — a sender
   * with no history here has nothing to be stale against — and afterwards a
   * frame is dropped only when it is `CMD_MAX_AGE_MS` behind the newest `ts`
   * THIS SAME sender has delivered. No cross-device reading enters the
   * decision, so no skew of any magnitude can reach it.
   *
   * On its own it was not enough, and the hole was in the word "first". A page
   * mints a fresh `clientId` on every load (`src/platform/env.ts`), so a display
   * that reboots — or whose `EventSource` is torn down and rebuilt after
   * `NTFY_LIVENESS_MS` — starts with an EMPTY map, and every command still
   * sitting in a broker's replay cache is then a first sighting from a src it
   * has never seen. Measured on a cold display: `seekBy(+10)` frames 20 s, 6 h
   * and 3 days old, all executed, on the exact op `CmdOp` names as the hazard.
   * `newestBrokerTs` below is the reading that closes it.
   */
  const lastCmdTsBySrc = new Map<string, number>();

  /**
   * The newest BROKER timestamp seen on each transport — one clock, per link.
   *
   * `FrameMeta.ts` is the server's own stamp on a message (`NtfyTransport`
   * passes `parsed.time * 1000`; the last-value transports pass the slot's
   * `ts`), and it was decoded and thrown away. It is the one reading a COLD
   * receiver can use, because comparing it to another frame's broker stamp is
   * broker time against broker time: one clock against itself, skew-free in
   * exactly the way `lastCmdTsBySrc` is, but available before this page has any
   * history with the sender.
   *
   * Fed by `state` and `tele` and NOT by `cmd`, deliberately: a command's own
   * broker stamp must not be allowed to vouch for the command. A room produces
   * state and telemetry continuously — a display publishes telemetry every two
   * seconds and hears its own echo — so the high-water is fresh whenever there
   * is a room at all. Where a transport supplies no `ts` (MQTT's packets carry
   * none) there is no reading, and the gate abstains rather than guesses.
   */
  const newestBrokerTs = new Map<SyncTransport, number>();

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
  /**
   * The rotation cursor for the UNSHIPPED head, kept apart from `stampCursor`.
   *
   * It only ever moves in the one case the head does not fit whole — a page with
   * more unheard writes than 8 kB of stamps can carry — and mixing it into the
   * ordinary cursor would make the two rungs steal each other's position.
   */
  let unshippedCursor = 0;
  /**
   * The unshipped paths of the snapshot currently waiting on the throttle.
   *
   * Read at REQUEST time with the stamps, for the same reason the stamps are:
   * the answer belongs to the body being handed over, and re-reading it at flush
   * time would describe a different moment.
   */
  let pendingUnshipped: readonly string[] = [];
  /**
   * Per-op command throttle, and the telemetry throttle, BOTH on the monotonic
   * clock and both seeded `-Infinity` — the repair `publishState` already had.
   *
   * `Date.now() - previous` after a backward step (one NTP correction, one
   * hour) is a large negative, so `< PUBLISH_THROTTLE_MS` held for the whole
   * hour and every command returned early before it reached a transport.
   * Measured: one play landed, the clock stepped back an hour, and the next
   * four taps produced nothing at all. Telemetry carried the identical
   * arithmetic, and in a display-only room the display's telemetry is the
   * phone's ONLY inbound frame — the sole source of `heard` and of the room
   * offset — so an hour of silence there takes the phone's clock with it.
   *
   * A negative elapsed now reads as what it is: the clock moved, send now.
   */
  const lastCmdAt = new Map<CmdOp, number>();
  let lastTeleAt = -Infinity;
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
    meta: FrameMeta,
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
      /*
       * ── Three gates, and each one answers a question the others cannot ─────
       *
       * 1. A command is NEVER retained (`CmdOp`), so a frame the transport
       *    flags as a stored last-value or a recovery replay is refused
       *    outright. The rule was written down and never enforced; enforcing it
       *    costs one comparison and closes every retained/recovery path at once.
       */
      if (meta.retained) return;
      /*
       * 2. BROKER time against BROKER time — see `newestBrokerTs`. This is the
       *    gate a cold receiver needs: `lastCmdTsBySrc` has nothing to say about
       *    a `src` it has never seen, and after a reboot every `src` is one of
       *    those, so an unguarded first sighting executed anything a broker's
       *    replay cache still held. Both halves of this subtraction are stamped
       *    by the same server, so no device's clock enters it; when the
       *    transport supplies no stamp there is nothing to compare and the gate
       *    abstains.
       */
      const brokerHighWater = newestBrokerTs.get(transport);
      if (
        brokerHighWater !== undefined &&
        meta.ts !== undefined &&
        brokerHighWater - meta.ts > CMD_MAX_AGE_MS
      ) {
        return;
      }
      /*
       * 3. ONE DEVICE's clock, against ITSELF. See `lastCmdTsBySrc`. Gate 2
       *    cannot see this one: a peer that re-sends a command out of its own
       *    past hands the broker a FRESH message carrying a stale `env.ts`, so
       *    only the sender's own history tells them apart.
       *
       * `(src, seq)` dedup above already refuses a duplicate delivery, so none
       * of these three is doing dedup's job.
       */
      const newestFromSrc = lastCmdTsBySrc.get(env.src);
      if (newestFromSrc === undefined) {
        if (lastCmdTsBySrc.size >= DEDUP_MAX) {
          const oldest = lastCmdTsBySrc.keys().next().value;
          if (oldest !== undefined) lastCmdTsBySrc.delete(oldest);
        }
        lastCmdTsBySrc.set(env.src, env.ts);
      } else {
        if (newestFromSrc - env.ts > CMD_MAX_AGE_MS) return;
        if (env.ts > newestFromSrc) lastCmdTsBySrc.set(env.src, env.ts);
      }
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
      const handler = (frame: Uint8Array, meta: FrameMeta): void => {
        /*
         * The broker-clock high-water, fed BEFORE anything else looks at the
         * frame — before decryption, before echo suppression, before dedup.
         * What is wanted is "how late is it, according to this link's server",
         * and a frame this page will go on to discard answers that just as well
         * as one it keeps. `cmd` is excluded on purpose: see `newestBrokerTs`.
         */
        if (ch !== 'cmd' && meta.ts !== undefined) {
          const seen = newestBrokerTs.get(transport);
          if (seen === undefined || meta.ts > seen) newestBrokerTs.set(transport, meta.ts);
        }
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

  /**
   * The transports that ARE the room, as opposed to the ones that merely exist.
   *
   * When a network slot is configured it is the room, and the zero-network slot
   * is a same-origin convenience between two windows on one machine; when there
   * is no network slot at all, localStorage genuinely is the whole room. Only a
   * publish that resolved on one of these — and on a transport still reading
   * `online` when it did — counts as "the room has heard it". See
   * `SyncServiceOptions.onStateShipped`.
   */
  function roomTransports(): SyncTransport[] {
    if (network !== null) return [network];
    return local === null ? [] : [local];
  }

  function publishEnvelope(
    env: Envelope,
    kind: 'state' | 'cmd' | 'tele',
    onSent?: (t: SyncTransport) => void,
  ): void {
    for (const t of activeTransports()) {
      if (!t.caps.channels.includes(env.ch)) continue;
      void frameFor(t, env)
        .then(async (frame) => {
          if (frame === null) return;
          if (kind === 'state') await t.publishState(frame);
          else if (kind === 'cmd') await t.publishCmd(frame);
          else await t.publishTele(frame);
          onSent?.(t);
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
     * So the window ROTATES, and it is split in four passes: two small
     * unconditional reserves, then two rotations, unshipped-first. Three
     * different failures need three different answers and this rung gives all
     * three:
     *
     *  - **the newest UNSHIPPED stamps, reserved.** A write the room has not heard
     *    is the one stamp nobody else can supply, and until it travels the room
     *    holds a value nobody chose. `RESERVED_NEWEST_STAMPS` used to be the
     *    whole answer and it answers the wrong question — it is a RECENCY
     *    window, and one ordinary multi-leaf config commit issues a stamp per
     *    leaf, so tapping FIRST and tuning 300 knobs after pushes the tap out of
     *    the newest eight immediately. Measured on that order: a passive display
     *    showed the wrong value for 20.2 s at 300 knobs and 96.2 s at 400, on a
     *    plain sequential edit. This is the wire twin of `saveClock`'s two
     *    passes, and it makes the invariant statable in both places: a budget may
     *    only ever drop a stamp the room already holds.
     *  - **the reserved newest of the rest, also on every frame.** A leaf
     *    somebody just touched must be orderable by the very next frame even
     *    once the room has heard it, or a passive display sits on the old value
     *    for a full turn of the window — measured at 12.2 s under 300 knobs.
     *    This reserve is taken BEFORE the unshipped head is allowed to rotate,
     *    because the two reserves cost ~600 bytes of 8192 between them and each
     *    answers a question the other cannot: measured with the head taking the
     *    whole budget first, a tap that SHIPPED on the frame right after it was
     *    made then queued behind 300 freshly-tuned knobs and arrived 20 s late.
     *  - **everything else, rotating, unshipped first.** A leaf buried under
     *    newer edits must still climb back, or it is lost for good — which is
     *    what a pure newest-N window costs, and is the bug the rotation was
     *    written for.
     *
     * `wireStamps` hands the map in `stampedNewestFirst()` order, so "the
     * newest" is the front of `entries` and needs no second sort, and the
     * unshipped paths arrive in that same order.
     *
     * If the unshipped head ALONE does not fit, it rotates within itself — the
     * loss is bounded rather than permanent — and the page says so through
     * `WIRE_TOO_LARGE_CLAIM`, exactly as the slot does when its own unshipped
     * pass overflows. That is a fact about the arrangement, not a hiccup.
     *
     * The bound: with `n` stamps, `u` unshipped, `r` reserved and `k` rotating
     * entries per frame, every stamped leaf carries its stamp within
     * `ceil((n - u - r) / k)` frames, and the unshipped and the newest `r`
     * within ONE. This rung is NOT rare — measured on a full look plus tuned
     * settings it fires on 96-101 % of frames. `lookWireBudget.test.ts` pins
     * both halves.
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
      const costOf = (path: string, stamp: [number, number, string]): number =>
        JSON.stringify(path).length + JSON.stringify(stamp).length + 2;

      const unheard = new Set(pendingUnshipped);
      const head = entries.filter(([path]) => unheard.has(path));
      const rest = entries.filter(([path]) => !unheard.has(path));

      /*
       * Pass 1: every unshipped stamp, before anything else.
       *
       * Newest-first, and the newest few UNCONDITIONALLY — the same two-part
       * shape as passes 2 and 3, for the same reason and one more. A cursor
       * walking a list whose length changes every frame (each shipped stamp
       * leaves the head) does not stay pointed at anything, so a rotation over
       * the whole head skipped the leaf that had just been tapped: measured, the
       * tap's own stamp missed eleven consecutive frames while 300 freshly-tuned
       * knobs took their turn, and the display sat on the old value for 8.2 s.
       * The newest unshipped write is the one the room most urgently cannot
       * supply for itself, so it never rotates.
       */
      const headReserved = Math.min(RESERVED_NEWEST_STAMPS, head.length);
      let refusedUnshipped = 0;
      for (let i = 0; i < headReserved; i += 1) {
        const entry = head[i];
        if (entry === undefined) break;
        const cost = costOf(entry[0], entry[1]);
        if (cost > budget) {
          refusedUnshipped = head.length - i;
          break;
        }
        budget -= cost;
        kept[entry[0]] = entry[1];
      }
      /*
       * Pass 2: the reserved newest of what the room has already heard, taken
       * BEFORE the unshipped head is allowed to rotate.
       *
       * The two reserves are ~600 bytes of 8192 between them and they answer
       * two different questions, so neither may starve the other. Measured with
       * the head taking the whole budget first: 300 knobs tuned after a tap left
       * `render.rotate` off 33-stamp frames indefinitely — the tap SHIPPED on
       * the frame right after it was made, so it is not in the head any more,
       * and a rotation it has to queue behind 300 fresh knobs for is a rotation
       * that arrives twenty seconds late. Unshipped-first is about the ROTATING
       * budget; the reserves come first, both of them.
       */
      const reserved = Math.min(RESERVED_NEWEST_STAMPS, rest.length);
      for (let i = 0; i < reserved; i += 1) {
        const entry = rest[i];
        if (entry === undefined) break;
        const cost = costOf(entry[0], entry[1]);
        if (cost > budget) break;
        budget -= cost;
        kept[entry[0]] = entry[1];
      }

      // Pass 3: the rest of the unshipped head rotates, ahead of anything the
      // room has already heard.
      const headRotating = head.slice(headReserved);
      let headTaken = 0;
      if (refusedUnshipped === 0) {
        for (let i = 0; i < headRotating.length; i += 1) {
          const entry = headRotating[(unshippedCursor + i) % headRotating.length];
          if (entry === undefined) break;
          const cost = costOf(entry[0], entry[1]);
          if (cost > budget) {
            refusedUnshipped = headRotating.length - i;
            break;
          }
          budget -= cost;
          kept[entry[0]] = entry[1];
          headTaken += 1;
        }
      }
      if (headTaken > 0 && headRotating.length > 0) {
        unshippedCursor = (unshippedCursor + headTaken) % headRotating.length;
      }
      if (refusedUnshipped > 0) {
        log.warn(
          `${String(refusedUnshipped)} unsent write(s) could not fit this frame's stamp budget`,
        );
        lastError = WIRE_TOO_LARGE_CLAIM;
        emitStatus();
      }

      // Pass 4: everything older rotates through whatever budget is left.
      const rotating = rest.slice(reserved);
      let taken = 0;
      for (let i = 0; i < rotating.length; i += 1) {
        const entry = rotating[(stampCursor + i) % rotating.length];
        if (entry === undefined) break;
        const cost = costOf(entry[0], entry[1]);
        if (cost > budget) break;
        budget -= cost;
        kept[entry[0]] = entry[1];
        taken += 1;
      }
      if (taken > 0) stampCursor = (stampCursor + taken) % rotating.length;
      if (Object.keys(kept).length === 0) return null;
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
    /*
     * OBSERVABLE, not merely logged.
     *
     * A refused frame is the one failure in this file with no symptom: the room
     * simply stops converging, with the status line still reading online. The
     * byte-count message the encoder throws is true and unactionable, so the
     * status carries a claim about the thing the person can actually change —
     * see `WIRE_TOO_LARGE_CLAIM`.
     */
    lastError = WIRE_TOO_LARGE_CLAIM;
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
    /*
     * The stamps of the frame that is ACTUALLY going out, read after the ladder
     * has trimmed it — a stamp `fitStateEnvelope` rotated off this frame has not
     * shipped, whatever the body carried.
     */
    const shipped = Object.keys(fitted.stamps ?? {});
    if (shipped.length === 0 || o.onStateShipped === undefined) {
      publishEnvelope(fitted, 'state');
      return;
    }
    const room = new Set(roomTransports());
    publishEnvelope(fitted, 'state', (t) => {
      if (!room.has(t) || t.status() !== 'online') return;
      o.onStateShipped?.(shipped);
    });
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
        ts: wireNow(),
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
        ts: wireNow(),
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
      pendingUnshipped = wire?.unshipped ?? [];
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
      const previous = lastCmdAt.get(op) ?? -Infinity;
      const elapsed = monotonicNow() - previous;
      if (elapsed >= 0 && elapsed < PUBLISH_THROTTLE_MS) return;
      lastCmdAt.set(op, monotonicNow());
      publishEnvelope(
        {
          v: PROTOCOL_VERSION,
          ch: 'cmd',
          ts: wireNow(),
          src: clientId,
          role,
          seq: nextSeq(),
          body: arg === undefined ? { op } : { op, arg },
        },
        'cmd',
      );
    },

    publishTele(body, opts) {
      const elapsed = monotonicNow() - lastTeleAt;
      // `immediate` still moves the clock: a burst of report chunks should push
      // the next routine packet out, not race it.
      if (opts?.immediate !== true && elapsed >= 0 && elapsed < PUBLISH_THROTTLE_MS) return;
      lastTeleAt = monotonicNow();
      publishEnvelope(
        {
          v: PROTOCOL_VERSION,
          ch: 'tele',
          ts: wireNow(),
          src: clientId,
          role,
          seq: nextSeq(),
          body,
        },
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
    noteError(message) {
      if (lastError === message) return;
      lastError = message;
      emitStatus();
    },
    topicId: () => keys?.topicId ?? null,
  };
}

/** The transport ladder a given settings object produces. Diagnostics only. */
export function describeLadder(settings: SyncSettings): TransportId[] {
  return ladderFor(settings, undefined).map((r) => r.id);
}
