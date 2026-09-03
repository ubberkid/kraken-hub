/**
 * The versioned application state.
 *
 * One JSON document, written to one localStorage key in one `setItem`, so a
 * reader can never observe a torn state. `schema` is the *content* version and
 * is migrated forward; the key name itself never changes.
 */

import type { Look } from './look/types';

export const SCHEMA_VERSION = 7;

/**
 * One line per schema version, so "what changed in 6?" has an answer that is not
 * a git archaeology exercise.
 *
 * A completeness test asserts every `MIGRATIONS` key + 1 has a line here.
 */
export const SCHEMA_HISTORY: Readonly<Record<number, string>> = {
  1: 'baseline',
  2: 'render.fit contain-circle',
  3: 'sync endpoints + fake transport',
  4: 'clock-lite → clock',
  5: 'video quality',
  6: 'settings census',
  7: 'looks: activeModuleId → look.layers[]',
};

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
  /**
   * Whether remote state is written to the state DOCUMENT, i.e. whether it is
   * authoritative on a cold boot. Off means a reload on a network-down display
   * comes back on the CAM-configured state instead of the last synced one.
   *
   * What it does NOT govern, and never did: whether this page remembers WHEN
   * each leaf was decided. The sync clock slot — a self-contained register
   * table of `{ stamp, value }` — is written either way, because a page that
   * remembers a stamp without the value it described will pair that stamp with
   * whatever its document happens to hold and then out-rank the truth on every
   * peer, forever. See `ClockSlot` in `src/sync/appSync.ts`.
   */
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

/**
 * A set of saved Looks and how long each one is shown — §4's carousel.
 *
 * **`lookIds` are ids in `kraken-hub:v1:looks`, not Looks.** The bodies stay in
 * the configuration window's own saved-Looks store and never enter the document,
 * because `look` rides an 8 kB sync envelope and five Looks in a field would be
 * five times the wire budget for four arrangements nobody is currently showing.
 *
 * What the document therefore holds is a POINTER and an interval, and exactly
 * one window may act on it: the one that owns the store the ids name. That
 * window commits the next Look into `look` on the tick; the display renders
 * whatever `look` says and knows nothing about a rotation. See
 * `src/app/config/views/editor/looks/carousel.ts` for the ownership rule and
 * why the display is not allowed to run the timer.
 */
export interface CarouselSettings {
  /** Ids of saved Looks, in the order they are shown. Two or more, or it is off. */
  lookIds: string[];
  /** How long each Look is shown. 30 s … 1 h. */
  intervalSec: number;
}

/** The floor and ceiling the picker offers, and the validator clamps to. */
export const CAROUSEL_MIN_SEC = 30;
export const CAROUSEL_MAX_SEC = 3600;

export interface AppState {
  schema: number;
  /** Lamport counter: `max(localRev, anySeenRev) + 1`. */
  rev: number;
  updatedAt: number;
  writerId: string;
  writerRole: Role;
  /**
   * Was this document write a DECISION, or a page writing down what it was told?
   *
   * `'local'` is a person: a click, a slider, a pasted link. `'sync'` is the
   * `persistRemote` transcription — a page committing the state it resolved from
   * the room so a cold boot has something to start from. `CommitOrigin` in
   * `src/state/store.ts` has drawn that line in memory since the first sync
   * layer; this puts it in the document, where the OTHER browser can read it.
   *
   * It is load-bearing for exactly one thing, and it is the difference between
   * a repair and a new bug. CAM's two browsers share one document, and
   * `src/sync/appSync.ts` treats a write by the other one as a decision worth
   * stamping and publishing — which is the only way an edit made on CAM's Home
   * screen ever reaches a phone. A transcription is NOT such a decision: a CAM
   * window whose radio is down transcribes the room as it last heard it, so
   * adopting that write re-stamps a stale value as fresh and reverts whatever
   * has happened since. Measured: a phone's tap reverted room-wide by a muted
   * CAM's routine 2 s save.
   *
   * A missing value reads as `'sync'` — the conservative direction, because it
   * means a document from a build that predates this field is never adopted,
   * which is exactly how those builds behaved.
   */
  writerOrigin: 'local' | 'sync';

  /**
   * The arrangement every window shares: what is on the panel, in what order,
   * at what size. `layers[0]` is the base and wears `modules[kind].cfg`;
   * overlays carry their own. See `src/state/look/types.ts`.
   */
  look: Look;

  /**
   * The base kind, mirrored, for one release of wire compatibility.
   *
   * §1.2 of the design has this field REMOVED at schema 7, with
   * `selectBaseKind(s)` (= `look.layers[0].kind`) in its place. It survives this
   * wave because it is still the only thing on the wire (`SyncStateBody`), and
   * because every writer in the app — the home chips, the library tiles, the
   * paste flow, the phone — commits `activeModuleId` and nothing else. So for
   * this release the two are kept in lockstep by `validateAppState`, with the
   * WRITE path here and the READ path on the base (`selectBaseKind`). The wave
   * that moves the writers to `switchBase` is the wave that deletes this field.
   */
  activeModuleId: ModuleId;
  /** Unknown ids are preserved verbatim so a fork's module config survives us. */
  modules: Record<ModuleId, ModuleSlot>;

  /**
   * The rotation, when one is set up. Absent is the ordinary case.
   *
   * **Optional, and the schema does not move for it — deliberately.** Every
   * past additive field DID move the version (`render.fit`'s `contain-circle`,
   * `transport: 'fake'`, the video quality pin), and the reason is written in
   * `migrations.ts`: an older build must STASH a document it cannot read rather
   * than write it back with a value the user chose silently deleted. That
   * argument does not reach this field, for two reasons that are properties of
   * the field rather than convenience:
   *
   *  1. **It is a pointer, not the data.** The Looks it names live in
   *     `kraken-hub:v1:looks`, a different key in the same profile that an older
   *     build neither reads nor writes and therefore cannot damage. A v7 build
   *     dropping this field stops a rotation; it destroys nothing. Re-choosing
   *     the set is the same two presses that made it, against Looks that are all
   *     still there.
   *  2. **It never leaves this profile.** `SyncStateBody` does not carry it and
   *     this wave does not add it, so there is no peer to disagree with.
   *
   * And a bump is not free here: `SCHEMA_VERSION` is stamped into every
   * `.krakenlook`, including the ten gallery files that `templates.test.ts`
   * asserts byte-identical against `templates.ts`. Moving the number would
   * rewrite ten checked-in files in a wave that adds nothing to the file format.
   *
   * If the carousel ever grows a field an older build could damage — a per-Look
   * dwell time, say, or anything the display itself reads — that is the wave
   * that bumps.
   */
  carousel?: CarouselSettings;

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
