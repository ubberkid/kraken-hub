/**
 * The sync wire contract.
 *
 * Two rules hold this design together and both are load-bearing:
 *
 *  1. **Transports move opaque bytes.** Encryption, envelope encoding, dedup,
 *     throttling and failover all live in `SyncService`, so a new transport is
 *     ~150 lines and inherits the entire security model for free.
 *  2. **`state` is always a FULL snapshot, never a delta.** A display that cold
 *     boots with nothing but one retained message must be completely correct.
 *     Deltas would make correctness depend on message history, which is exactly
 *     what a retained-message transport cannot promise.
 *  3. **Ordering is per leaf and lives in the stamps, not in the arrival.** The
 *     body says what the sender holds; `Envelope.stamps` says when each value
 *     was decided. See `src/sync/merge.ts`.
 */

import type { Stamp, StampTuple } from './hlc';
import type { Look } from '../state/look/types';
import type { ModuleSlot, PlaybackState, RenderSettings } from '../state/schema';

export type Channel = 'state' | 'cmd' | 'tele';
export type Role = 'display' | 'config' | 'remote';

/** `fake` is the in-repo network simulator; it is never offered in the UI. */
export type TransportId = 'localstorage' | 'mqtt' | 'ntfy' | 'fake';

export type TransportStatus = 'idle' | 'connecting' | 'online' | 'degraded' | 'offline' | 'error';

export const CHANNELS: readonly Channel[] = ['state', 'cmd', 'tele'];
export const ROLES: readonly Role[] = ['display', 'config', 'remote'];

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/**
 * `v` is the PROTOCOL version and is independent of `AppState.schema`: the wire
 * format and the document format evolve for different reasons and at different
 * rates. A peer that sees `v !== 2` drops the message rather than guessing.
 *
 * **It moved to 2 when the merge changed.** A `v: 1` peer arbitrates by an
 * acknowledgement map this build no longer sends and would read every frame
 * from a `v: 2` peer as "acknowledges nothing"; a `v: 2` peer would read every
 * leaf a `v: 1` peer wrote as unstamped, i.e. as older than the beginning of
 * time, and silently drop every edit made on the old build. Both directions are
 * data loss that looks like a working connection, so the two builds refuse each
 * other outright instead: `decodeEnvelope` returns `null`, the frame is counted
 * as undecodable, and the room reports no traffic — which is a fault somebody
 * investigates rather than a setting that will not stick.
 */
export interface Envelope<T = unknown> {
  v: 2;
  ch: Channel;
  /**
   * Epoch ms in ROOM time — the sender's `Date.now()` plus its best reading of
   * how far ahead the room is (`appSync`'s `roomNow()`), which for a device
   * that has heard nobody is exactly its own wall clock.
   *
   * Never trusted for ordering. Two things read it, and NEITHER of them
   * subtracts one device's reading from another's any more:
   *
   *  - the room-offset sample every receiver folds (`appSync`'s `noteRoomTime`),
   *    which is a `max` of clamped readings and is meant to be cross-device;
   *  - the `CMD_MAX_AGE_MS` staleness gate, which compares a sender's `ts` only
   *    to the newest `ts` THAT SAME SENDER has delivered here.
   *
   * The gate used to subtract two raw wall clocks — a phone a minute behind had
   * every command it sent dropped on arrival, for ever — and then two ROOM
   * clocks, which only moved the cliff out to `MAX_ROOM_OFFSET_MS`, because the
   * clamp lets two peers' room times legitimately disagree by more than any
   * threshold below 24 h. See `CMD_MAX_AGE_MS` and `SyncServiceOptions.roomNow`.
   */
  ts: number;
  /** 12-char per-page-load client id (`src/platform/env.ts`). */
  src: string;
  role: Role;
  /** Monotonic per `src`, reset on reload. `(src, seq)` is the dedup key. */
  seq: number;
  /** `ch === 'state'` only: the Lamport `AppState.rev`. Storage bookkeeping ONLY. */
  rev?: number;
  /**
   * ── The ordering ───────────────────────────────────────────────────────────
   *
   * `ch === 'state'` only: `leaf path → the hybrid-logical-clock stamp of the
   * write that produced the value the body carries at that path`. See
   * `src/sync/hlc.ts` for the clock, `src/sync/leaves.ts` for what a leaf is
   * and `src/sync/merge.ts` for the merge these stamps drive.
   *
   * Only leaves somebody has actually WRITTEN appear. Every state frame is a
   * full snapshot, so most of the body on most frames is defaults and settled
   * values nobody is arguing about; a missing stamp reads as `EPOCH`, which
   * loses to anything, so an unstamped leaf can fill a gap and can never
   * overturn a decision. That is the property that makes a retained replay safe
   * to treat as an ordinary frame, and it is what let the whole "is this a
   * replay?" special case — and the rev floor under it — be deleted.
   */
  stamps?: Record<string, StampTuple>;
  /**
   * The sender's own clock: the greatest stamp it has seen from anybody.
   *
   * A receiver folds it into its own clock, which is what makes the next write
   * this page makes order strictly after everything the sender had accounted
   * for — including writes whose stamps were trimmed off this frame, and
   * writes by peers this page has never heard from. It is one tuple, and it is
   * the whole of the causality machinery that remains.
   */
  clock?: StampTuple;
  body: T;
}

export const PROTOCOL_VERSION = 2;

/**
 * How many leaf stamps a RECEIVER will remember from one frame.
 *
 * There used to be a fixed cap of 32 here that applied on the way OUT as well,
 * and it was wrong in a way that could not heal. A frame carries a full
 * snapshot; dropping a leaf's stamp while keeping its value does not send
 * "less information", it sends the strongest possible LIE about that leaf —
 * `EPOCH`, the beginning of time. A receiver that was not listening when the
 * stamp was fresh then loses that leaf forever, because a leaf buried under 33
 * newer edits can never climb back into the sender's newest 32. Measured: a
 * phone locked while CAM picked a module and then tuned 34 settings never
 * learned the module, through thirty seconds of continuous republishing.
 *
 * So the wire cap is gone. `fitStateEnvelope`'s byte ladder is the only
 * trimmer, it is measured against the real 8 kB budget, and its rule is that a
 * VALUE NEVER TRAVELS WITHOUT ITS STAMP. What remains here is a receive-side
 * sanity bound so a hostile peer cannot make us hold an unbounded map: an
 * envelope is already capped at 8 kB and the smallest possible entry is about
 * 16 bytes, so nothing honest can ever reach this number.
 */
export const MAX_WIRE_STAMP_ENTRIES = 1024;

/**
 * How many registers the localStorage clock slot keeps.
 *
 * ## What overflow actually costs, corrected
 *
 * This doc used to say a dropped register "costs ordering after a reload and
 * nothing more — the leaf simply restores unstamped and cannot win an argument.
 * Nobody else is misled." Both halves were false, and the second one was the
 * expensive one: an unstamped leaf cannot win an argument it SHOULD win, so a
 * write the room has not heard yet, dropped from the slot across a reload, loses
 * to the room's stale value and is silently reverted on every screen.
 *
 * Measured: a phone offline taps `render.fit=contain` — a leaf the room already
 * holds a register for — then turns 31 other knobs and reloads. At exactly 33
 * stamped registers the FIRST offline edit falls off the newest-first tail, and
 * the other 31 all land (the room holds no register for them, so an unstamped
 * value fills a gap unopposed). The user watches 31 of their 32 offline edits
 * arrive and exactly one silently undone, with no `lastError` and no way to tell
 * which.
 *
 * ## The rule that replaces "oldest first"
 *
 * `appSync.saveClock` packs in TWO passes: every register whose write has not
 * yet gone out on the room's transport (`unshipped`) first, newest-first among
 * themselves, and only then the rest, newest-first into whatever budget is left.
 * A cap may only evict a register the ROOM ALREADY HOLDS — a write nobody else
 * has heard is never evictable. That is the slot-side twin of the unshipped
 * head in `fitStateEnvelope` on the wire, and it is what makes the contract
 * statable rather than merely hopeful.
 *
 * The set SURVIVES A PAGE LOAD (`StoredClock.unshipped`), because in-memory it
 * bought only one reload: a second page load that never reached the room read
 * back "everything is shipped" and evicted the oldest offline write anyway.
 *
 * Registers whose leaf no longer exists in the document are dropped on commit,
 * so a deleted module-config key stops holding a slot forever.
 */
export const MAX_SLOT_REGISTERS = 32;

/**
 * A ceiling on the serialized clock slot, because the slot now carries VALUES
 * as well as stamps (see `appSync.ts`'s `StoredClock`) and one module's config
 * leaf can be a URL. Registers are added newest-first until either cap bites.
 *
 * The byte rung SKIPS an oversized register and keeps going; it used to `break`,
 * which threw away every older register behind one fat leaf.
 */
export const MAX_SLOT_BYTES = 32_768;

/**
 * The hard safety bound on unshipped registers, and the only thing that can
 * evict one.
 *
 * `unshipped` outranks both ordinary caps, so it needs its own ceiling or a page
 * that never reaches a transport would grow the slot without bound. When the
 * unshipped set alone exceeds it, the newest are kept, the rest are dropped, and
 * the page surfaces `WIRE_TOO_LARGE_CLAIM` — the same "Too much to send" claim
 * an oversized frame raises, because it is the same fact from the same cause and
 * the person can act on it the same way.
 */
export const MAX_UNSHIPPED_REGISTERS = 256;

/** The matching byte ceiling for the unshipped pass. See `MAX_UNSHIPPED_REGISTERS`. */
export const MAX_UNSHIPPED_SLOT_BYTES = 131_072;

/** Invariant I6: a sync payload is capped at 8 KB. */
export const MAX_ENVELOPE_BYTES = 8192;

// ---------------------------------------------------------------------------
// Channel bodies
// ---------------------------------------------------------------------------

/**
 * The full desired configuration. Idempotent, retained, merged into the
 * `remote` precedence layer by whoever receives it.
 *
 * `partial` is set only when the complete module map did not fit in 8 KB and
 * everything but the active module had to be dropped. A receiver must then
 * merge rather than replace — which it does anyway, because every leaf is
 * merged on its own stamp and a leaf the body does not mention is a leaf the
 * receiver keeps.
 */
export interface SyncStateBody {
  /**
   * The base kind. LEGACY for one release: always written as
   * `look.layers[0].kind`, and forced back into it on receipt, so the two can
   * never disagree on the wire. Removed at schema 8 (§1.2 of the layers
   * design); until then `src/sync/leaves.ts` treats them as ONE leaf.
   */
  activeModuleId: string;
  /**
   * The arrangement: what is on the panel, in what order, at what size.
   *
   * Optional because a body written by a build that predates §6 carries none,
   * and `syncBodyToPatch` projects that losslessly through `baseLook`.
   */
  look?: Look;
  modules: Record<string, ModuleSlot>;
  playback: PlaybackState | null;
  render: RenderSettings;
  partial?: true;
}

/**
 * Imperative, transient, NEVER retained.
 *
 * Commands are non-idempotent — replaying `seekBy(+10)` twice is a bug, not a
 * no-op — which is why they live on their own channel and why `(src, seq)`
 * dedup refuses a redelivery outright.
 *
 * "NEVER retained" used to be a claim this comment made and nothing enforced:
 * `handleFrame`'s cmd branch did not read `meta.retained`, and no transport was
 * asked what it replays on this channel. Both are now real —
 * `TransportCaps.cmdReplayMs` is the question, a retained-flagged cmd frame is
 * refused outright, and `CMD_MAX_AGE_MS` is measured twice: once against the
 * newest BROKER stamp this link has delivered, which is what a receiver with no
 * history of the sender has to go on, and once against the same sender's own
 * newest frame. See `CMD_MAX_AGE_MS` and `FrameMeta.ts`.
 */
export type CmdOp =
  | 'play'
  | 'pause'
  | 'toggle'
  | 'seekTo'
  | 'seekBy'
  | 'previewSeek'
  | 'setRate'
  | 'setLoop'
  | 'clearLoop'
  | 'next'
  | 'prev'
  | 'setModule'
  | 'reinit'
  | 'reload'
  | 'requestState'
  /**
   * "Probe yourself and publish the result on `tele`."
   *
   * Additive: `v` stays 1, because a peer that has never heard of this op
   * already ignores it — `display/sync.ts` forwards unknown ops to the active
   * module's command handler, which drops what it does not recognise. The
   * answer comes back as `kind: 'diagReport'` chunks (`src/diag/wire.ts`),
   * which is what makes a hardware report readable from a DIFFERENT machine
   * than the one running CAM.
   */
  | 'requestDiag'
  /**
   * "Tell me what is on the shelf, now."
   *
   * Additive in exactly the way `requestDiag` was, so `v` stays 1: a peer that
   * has never heard of it forwards it to the active module's command handler,
   * which drops what it does not recognise.
   *
   * It exists because `tele` publishes UNRETAINED and the library keepalive is
   * five minutes apart, so a phone unlocked at the wrong moment stared at an
   * empty shelf for most of five minutes with nothing on screen to say it was
   * waiting. The answer is `kind: 'library'`, or `libraryPart` chunks when the
   * shelf does not fit one envelope.
   */
  | 'requestLibrary'
  /**
   * Curation — "change this row of the shelf", from a window that can see the
   * row but not reach the bytes.
   *
   * Play needed no op at all: it is a state commit, and state is a full retained
   * snapshot both windows already share. Pin, rename and delete have nothing to
   * commit — they change a database that lives in exactly one browser profile —
   * so they are the first library ACTS on this channel.
   *
   * Three properties, all of them load-bearing, all of them enforced by the
   * parsers in `src/lib/curation.ts`:
   *
   *  - **absolute, never a toggle** (`setPinned` carries the value it wants):
   *    the `cmd` channel is redelivered by a replaying transport, and this is
   *    the `seekBy` hazard;
   *  - **batched by id**: `sendCmd` throttles PER OP at 200 ms and DROPS what
   *    lands inside the window, so a five-item delete loop would send one;
   *  - **idempotent by id**: `patchMedia` and `deleteMedia` are both no-ops on
   *    an absent row, which is what makes it safe to have no ack protocol. The
   *    remote removes the tile optimistically and reconciles against the next
   *    library packet.
   *
   * Additive, exactly like `requestDiag` and `requestLibrary`, so `v` stays 1.
   */
  | 'setPinned'
  | 'renameMedia'
  | 'deleteMedia'
  /**
   * WebRTC signalling for a LAN file transfer — the one thing a phone genuinely
   * could not do before, because the bytes have to land in the browser profile
   * the LCD page can read and a phone shares nothing with it.
   *
   * There is no signalling server and there will not be one: the offer and the
   * ICE candidates ride this channel, which means the broker only ever sees
   * ciphertext and only a peer holding the room key can start a transfer. The
   * answer comes back on `tele` as `kind: 'transferAnswer'`, and the candidates
   * as `kind: 'transferIce'` — see `src/transfer/protocol.ts`, which also
   * explains why every one of these messages is CUMULATIVE rather than a delta
   * (both zero-network transports are a last-value slot, not a queue).
   */
  | 'transferOffer'
  | 'transferIce'
  | 'identify'
  | 'ping';

export const CMD_OPS: readonly CmdOp[] = [
  'play',
  'pause',
  'toggle',
  'seekTo',
  'seekBy',
  'previewSeek',
  'setRate',
  'setLoop',
  'clearLoop',
  'next',
  'prev',
  'setModule',
  'reinit',
  'reload',
  'requestState',
  'requestDiag',
  'requestLibrary',
  'setPinned',
  'renameMedia',
  'deleteMedia',
  'transferOffer',
  'transferIce',
  'identify',
  'ping',
];

export interface CmdBody {
  op: CmdOp;
  arg?: unknown;
}

/**
 * How far a command may lag behind the newest one THE SAME SENDER delivered
 * before it is dropped as stale.
 *
 * Read that boundary carefully, because the obvious reading is the one that was
 * wrong for two rounds. This is NOT `now - env.ts`: comparing a receiver's clock
 * to a sender's is a subtraction across two devices, and no amount of room-time
 * correction makes it safe — `appSync`'s `roomNow()` clamps its offset at
 * `MAX_ROOM_OFFSET_MS`, so two peers' room times may legitimately differ by more
 * than any threshold smaller than 24 h, while this threshold is fifteen seconds.
 * A phone 25 h behind therefore had every command it ever sent dropped on
 * arrival, for ever, and so did any phone that tapped before folding its first
 * inbound frame. `SyncService.handleFrame` now compares a sender's `ts` only to
 * the newest `ts` that same sender has delivered here (`lastCmdTsBySrc`), which
 * is skew-free by construction.
 *
 * ## Why one measurement was not enough
 *
 * The sender-relative form has nothing to say about a `src` it has never seen,
 * and it accepted a first sighting UNCONDITIONALLY. A page mints a fresh
 * `clientId` on every load, so a display that reboots — or rebuilds its
 * `EventSource` after `NTFY_LIVENESS_MS` — meets every peer as a stranger, and
 * every command still in a broker's replay cache is a first sighting. Measured
 * on a cold display: `seekBy(+10)` frames 20 s, 6 h and 3 days old, all
 * executed. The safety argument at the time was PROSE — "no shipped transport
 * replays `cmd`" — asserted nowhere, contradicted by a transport-wide
 * `replayMs` of 600 000 ms, and irrelevant to a hostile or buggy peer anyway.
 *
 * So the threshold is applied twice, and neither application subtracts one
 * device's clock from another's:
 *
 *  - against `newestBrokerTs`, the newest BROKER stamp this transport has
 *    delivered on `state` or `tele`. Server time against server time, available
 *    to a receiver with no history at all, and the reading that actually makes
 *    a replay cache safe rather than merely believed to be safe.
 *  - against `lastCmdTsBySrc`, the newest `ts` that same sender delivered here.
 *    It is the only one of the two that can catch a peer re-sending an old
 *    command out of its own past, because such a frame is FRESH at the broker.
 *
 * Plus the rule `CmdOp` always stated and nothing enforced: a retained or
 * recovery-flagged frame on this channel is refused outright.
 */
export const CMD_MAX_AGE_MS = 15_000;

/**
 * Telemetry. Deliberately only structurally constrained: the `tele` channel
 * mirrors whatever the active module publishes (today `TelePacket` from
 * `src/modules/video/telemetry/videoTelemetry.ts`), and `src/sync` must not
 * depend on `src/modules`. Consumers narrow it themselves.
 */
export interface TeleBody {
  ts: number;
  kind: string;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface FrameMeta {
  /** True when the transport replayed a stored last-value, not a live message. */
  retained: boolean;
  /**
   * Broker/server timestamp where one exists, and the receiver's only skew-free
   * reading of how late a frame is.
   *
   * `SyncService` keeps a per-transport high-water of it across every `state`
   * and `tele` frame and refuses a `cmd` that lags it by more than
   * `CMD_MAX_AGE_MS`. Both halves of that subtraction are stamped by the SAME
   * server, so it is one clock against itself — the property `lastCmdTsBySrc`
   * has for a sender this page already knows, extended to one it has never
   * heard from. A transport that has no such stamp (MQTT packets carry none)
   * omits it, and the gate abstains rather than guessing.
   */
  ts?: number;
}

export type FrameHandler = (frame: Uint8Array, meta: FrameMeta) => void;
export type Unsub = () => void;

export interface TransportCaps {
  /** The transport itself stores a last-value for `state`. */
  retained: boolean;
  /**
   * How far back a fresh subscriber can recover `state` messages, in ms.
   *
   * TRANSPORT-WIDE was the mistake: this number was read as a statement about
   * everything the transport carries, while `types.ts` and `NtfyTransport`
   * separately promised in prose that `cmd` is never replayed. Prose is not a
   * capability, and `SyncService` had no way to ask. `cmdReplayMs` below is the
   * same question for the channel where the answer is load-bearing.
   */
  replayMs: number;
  /**
   * How far back a fresh subscriber can receive `cmd` messages, in ms.
   *
   * Zero on every shipped transport, and each one has to earn it: ntfy's
   * recovery poll takes only the last `state` message and its live `/sse`
   * subscription carries no `since=` at all; MQTT publishes `cmd` with
   * `retain: false`, so a broker hands a new subscriber nothing; the two
   * last-value transports seed their "already seen" marks on `connect()` so a
   * slot left by a previous page load is not replayed. Commands are imperative
   * — replaying `seekBy(+10)` is a bug, not a no-op — so a transport that
   * cannot say zero here is a transport whose commands `SyncService` must gate
   * on broker time, which it does for all of them regardless.
   */
  cmdReplayMs: number;
  needsNetwork: boolean;
  /** Frames larger than this are refused by the transport. */
  maxPayload: number;
  /** Channels this transport carries at all. */
  channels: readonly Channel[];
  /**
   * Whether `SyncService` must seal frames before handing them over. False for
   * `localstorage`, which never leaves the origin and must keep working with no
   * room code configured at all.
   */
  encrypted: boolean;
  /** How often the state owner should re-publish, when the transport forgets. */
  keepaliveMs?: number;
}

export interface TransportOpts {
  topicId: string;
  clientId: string;
  role: Role;
  mqttUrl: string;
  ntfyBase: string;
  /** `tele` channel ONLY. A will on `state` would wipe the retained snapshot. */
  willFrame?: Uint8Array;
  signal: AbortSignal;
}

/**
 * One transport. Every method moves opaque bytes; nothing here knows what a
 * room code, an envelope or a module is.
 */
export interface SyncTransport {
  readonly id: TransportId;
  readonly caps: TransportCaps;
  /** MUST resolve only once the channel is genuinely usable (MQTT: CONNACK + SUBACK). */
  connect(o: TransportOpts): Promise<void>;
  /** MUST flush pending publishes before tearing down. */
  disconnect(): Promise<void>;
  /** Retained/last-value where the transport supports it. */
  publishState(frame: Uint8Array): Promise<void>;
  publishCmd(frame: Uint8Array): Promise<void>;
  publishTele(frame: Uint8Array): Promise<void>;
  onState(cb: FrameHandler): Unsub;
  onCmd(cb: FrameHandler): Unsub;
  onTele(cb: FrameHandler): Unsub;
  status(): TransportStatus;
  onStatus(cb: (s: TransportStatus, detail?: string) => void): Unsub;
}

// ---------------------------------------------------------------------------
// Service-level status
// ---------------------------------------------------------------------------

export interface SyncStatus {
  /** The zero-network config↔display slot. */
  local: TransportStatus;
  /** The at-most-one network slot. */
  network: TransportStatus;
  networkTransport: TransportId | null;
  /** True once the network slot fell back off its first choice. */
  failedOver: boolean;
  lastError: string | null;
  /** Epoch ms of the last inbound message on any channel. */
  lastSeenAt: number | null;
  /** Decrypt failures since start — 10 in 30 s means "wrong room code". */
  decryptFailures: number;
  roomConfigured: boolean;
}

export interface RecvMeta {
  src: string;
  role: Role;
  seq: number;
  ts: number;
  rev: number | null;
  retained: boolean;
  via: TransportId;
  /**
   * The frame's per-leaf stamps, decoded. Empty for a frame that carried none —
   * which reads as "every leaf on this frame is unstamped", i.e. able to fill a
   * gap and unable to overturn anything.
   */
  stamps: ReadonlyMap<string, Stamp>;
  /** The sender's clock, or `null` on a frame that carried none. */
  clock: Stamp | null;
}
