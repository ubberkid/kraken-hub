/**
 * The versioned application state.
 *
 * One JSON document, written to one localStorage key in one `setItem`, so a
 * reader can never observe a torn state. `schema` is the *content* version and
 * is migrated forward; the key name itself never changes.
 */

export const SCHEMA_VERSION = 6;

export type ModuleId = string;
export type Role = 'display' | 'config' | 'remote';

export interface ModuleSlot {
  /** The module's own `configVersion` at write time. */
  v: number;
  cfg: unknown;
}

export interface PlaybackState {
  ownerModuleId: ModuleId;
  paused: boolean;
  /** The last SAMPLED position. Never transmitted without `posAtTs`. */
  posSec: number;
  posAtTs: number;
  durationSec: number | null;
  rate: number;
  muted: boolean;
  volume: number;
  loop: { enabled: boolean; startSec: number; endSec: number | null };
}

export interface RenderSettings {
  /**
   * `contain-circle` arrived with the video module (schema 2): it inscribes the
   * source rect in the round bezel instead of the bounding square, so nothing
   * is clipped by the curve. Additive, but a v1 reader would reject the value —
   * hence the version bump.
   */
  fit: 'cover' | 'contain' | 'contain-circle' | 'fill';
  zoom: number;
  offsetX: number;
  offsetY: number;
  rotate: 0 | 90 | 180 | 270;
  /** Square panels: inset as a fraction of the short edge. */
  safeAreaPct: number;
  /** Round panels: fraction of the radius treated as visible. */
  safeRadiusPct: number;
  maskCircle: 'auto' | 'on' | 'off';
  background: string;
}

/**
 * `fake` is the in-repo broker simulator (`src/sync/transports/FakeTransport.ts`).
 * It is reachable only through `?transport=fake` and is never offered in the
 * settings UI — it exists so the e2e suite can prove retained-snapshot cold
 * restore and transport failover without depending on a public broker.
 */
export type TransportPreference = 'auto' | 'mqtt' | 'ntfy' | 'off' | 'fake';

export interface SyncSettings {
  enabled: boolean;
  /**
   * The room code, stored in plaintext in this browser profile.
   *
   * Deliberate, and documented in docs/remote-control.md: the code IS the key,
   * so a device that has to reconnect after a reboot must be able to read it
   * back. Storing only a hash would make the display unable to derive the AES
   * key, and storing a "wrapped" copy would just move the wrapping key into the
   * same localStorage. What never gets persisted anywhere is a code that
   * arrived via `?room=` on the display page — a shared link must not silently
   * repoint somebody's LCD (see `src/state/urlParams.ts`).
   */
  roomCode: string | null;
  transport: TransportPreference;
  /** Empty means "use the default in src/sync/endpoints.ts". */
  mqttUrl: string;
  ntfyBase: string;
  persistRemote: boolean;
  publishTelemetry: boolean;
}

export interface PlatformPrefs {
  /** Display forces muted unless this is on: webview audio routing is unverified (H08). */
  audioOptIn: boolean;
  allowWatchdogReload: boolean;
  /** Used only when `window.nzxt` is absent. */
  fallbackTargetFps: number;
  lowFpsThreshold: number;
}

export interface DiagnosticsPrefs {
  showDebugOverlay: boolean;
  lowFpsBannerDismissedForFps: number | null;
  logLevel: 'error' | 'warn' | 'info' | 'debug';
}

export interface AppState {
  schema: number;
  /** Lamport counter: `max(localRev, anySeenRev) + 1`. */
  rev: number;
  updatedAt: number;
  writerId: string;
  writerRole: Role;

  activeModuleId: ModuleId;
  /** Unknown ids are preserved verbatim so a fork's module config survives us. */
  modules: Record<ModuleId, ModuleSlot>;

  playback: PlaybackState | null;
  render: RenderSettings;
  sync: SyncSettings;
  platform: PlatformPrefs;
  diagnostics: DiagnosticsPrefs;
}

/** Recursive partial used by the precedence layers. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object | null
      ? DeepPartial<NonNullable<T[K]>> | null
      : T[K];
};

/** Hard cap enforced before every write (invariant I6). Blobs live in IndexedDB. */
export const MAX_STATE_BYTES = 256_000;
