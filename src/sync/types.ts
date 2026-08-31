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
 */

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
 * rates. A peer that sees `v !== 1` drops the message rather than guessing.
 */
export interface Envelope<T = unknown> {
  v: 1;
  ch: Channel;
  /** Epoch ms on the SENDER's clock. Never trusted for ordering, only for age. */
  ts: number;
  /** 12-char per-page-load client id (`src/platform/env.ts`). */
  src: string;
  role: Role;
  /** Monotonic per `src`, reset on reload. `(src, seq)` is the dedup key. */
  seq: number;
  /** `ch === 'state'` only: the Lamport `AppState.rev`. */
  rev?: number;
  body: T;
}

export const PROTOCOL_VERSION = 1;

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
 * merge rather than replace — which it does anyway, because the remote layer
 * is a `DeepPartial` patch.
 */
export interface SyncStateBody {
  activeModuleId: string;
  modules: Record<string, ModuleSlot>;
  playback: PlaybackState | null;
  render: RenderSettings;
  partial?: true;
}

/**
 * Imperative, transient, NEVER retained.
 *
 * Commands are non-idempotent — replaying `seekBy(+10)` twice is a bug, not a
 * no-op — which is why they live on their own channel and why `SyncService`
 * drops any command envelope older than `CMD_MAX_AGE_MS`. That single rule is
 * what makes a 12-hour replay cache (ntfy) safe to subscribe to.
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
  'identify',
  'ping',
];

export interface CmdBody {
  op: CmdOp;
  arg?: unknown;
}

/** Commands older than this are dropped on receipt. */
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
  /** Broker/server timestamp where one exists. */
  ts?: number;
}

export type FrameHandler = (frame: Uint8Array, meta: FrameMeta) => void;
export type Unsub = () => void;

export interface TransportCaps {
  /** The transport itself stores a last-value for `state`. */
  retained: boolean;
  /** How far back a fresh subscriber can recover messages, in ms. */
  replayMs: number;
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
}
