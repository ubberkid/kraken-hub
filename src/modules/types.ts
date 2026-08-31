/**
 * The module contract.
 *
 * The display is a React *shell* with an **imperative renderer** inside it. At
 * `targetFps = 40` the frame budget is 25 ms and CAM additionally compresses
 * every captured frame, so a per-frame `setState` would spend the budget on
 * reconciliation and GC. React therefore re-renders only on human-driven state
 * changes; everything per-frame is written straight to the DOM or a canvas
 * inside `frame()` (invariant I4).
 */

import type { Logger } from '../lib/log';
import type { FrameClock, FrameInfo } from '../platform/fpsGovernor';
import type { Geometry } from '../platform/geometry';
import type { MonitoringSource, NormalizedMonitoring } from '../platform/monitoring';
import type { RenderSettings } from '../state/schema';
import type { ComponentType } from 'react';

export type ModuleId = string;

export interface ModuleCapabilities {
  /** Subscribe to the 1 Hz CAM feed. */
  needsMonitoring: boolean;
  needsFrameLoop: boolean;
  /** Reads IndexedDB blobs. */
  usesMedia: boolean;
  /** Participates in `AppState.playback`. */
  hasTimeline: boolean;
  /** Drives the low-FPS advisory: only `'full'` motion is ruined at 1 FPS. */
  motionLevel: 'static' | 'low' | 'full';
  /**
   * The module renders the §8.1 advisory itself, inside its own safe-area
   * overlays, so the display shell's generic banner stands down. Set by `video`,
   * which owns the config-side dismiss key and the card→badge transition.
   */
  ownsFpsAdvisory?: boolean;
  substrate: 'dom' | 'canvas' | 'mixed';
  audio: 'none' | 'optional';
  /** Remote ops this module accepts on the `cmd` channel. */
  remoteCommands: readonly string[];
}

export interface UpdateReason {
  /** Dot paths that differ from the previous config. */
  changed: string[];
  origin: 'boot' | 'local' | 'remote' | 'url' | 'reinit';
}

export type ReinitReason =
  'resume' | 'raf-stall' | 'monitoring-stall' | 'media-stall' | 'geometry-change' | 'manual';

export interface ModuleContext {
  geometry: () => Geometry;
  frameClock: FrameClock;
  monitoring: MonitoringSource;
  render: () => RenderSettings;
  log: Logger;
  /** Aborted on unmount. Pass it to every fetch and every listener. */
  signal: AbortSignal;
}

/**
 * The imperative contract. `host` is an empty, absolutely-positioned div sized
 * to the full viewport; the renderer owns it entirely.
 */
export interface DisplayRenderer<C> {
  mount(host: HTMLElement, ctx: ModuleContext, config: C): void | Promise<void>;
  update(config: C, reason: UpdateReason): void;
  frame?(f: FrameInfo): void;
  monitoring?(n: NormalizedMonitoring, raw: NzxtV1.MonitoringData): void;
  geometry?(g: Geometry): void;
  visibility?(v: 'hidden' | 'visible'): void;
  /** Soft recovery. MUST be idempotent — the watchdog may call it repeatedly. */
  reinit?(reason: ReinitReason): void;
  /**
   * An imperative command off the sync `cmd` channel (`seekBy`, `play`, …).
   *
   * Separate from `update()` because commands are NOT idempotent and are NOT
   * state: `seekBy(+10)` twice means twenty seconds, and replaying it after a
   * reload would be a bug. `SyncService` guarantees a command is never
   * delivered twice and never delivered stale; the renderer just has to do it.
   * Unknown ops MUST be ignored, so a newer remote can talk to an older display.
   */
  command?(op: string, arg?: unknown): void;
  /** MUST revoke blob URLs, clear timers and remove listeners. */
  unmount(): void;
}

/**
 * Panel props are deliberately untyped: config arrives from localStorage as
 * `unknown`, and every panel calls its own module's `validate()` first. Keeping
 * the props non-generic is also what lets the registry hold a heterogeneous
 * list of modules without an `any`.
 */
export interface ModuleConfigProps {
  config: unknown;
  onChange: (next: unknown) => void;
}

export interface KrakenModule<C = unknown> {
  readonly id: ModuleId;
  readonly name: string;
  /** One line, shown in the module picker. */
  readonly summary: string;
  /** Inline SVG path data — no asset request on the display path. */
  readonly icon: string;
  /** Bumped on a breaking config change; `migrateConfig` becomes mandatory. */
  readonly configVersion: number;
  readonly capabilities: ModuleCapabilities;

  readonly defaults: C;
  /** MUST NOT throw. Coerce, clamp, drop unknown keys, fill from defaults. */
  validate(raw: unknown): C;
  migrateConfig?(fromVersion: number, raw: unknown): unknown;

  /** Applies raw URL params (`src`, `loop`, `mute`, …) onto a config. */
  applyUrlParams?(config: C, params: Readonly<Record<string, string>>): C;

  /** Lazy display renderer — the only module code the LCD ever downloads. */
  loadDisplay(): Promise<{ createRenderer(): DisplayRenderer<C> }>;
  /** Lazy React config panel — never reachable from the display chunk. */
  loadConfigPanel(): Promise<{ ConfigPanel: ComponentType<ModuleConfigProps> }>;
}

/** Erased form used by the registry, which cannot know each module's `C`. */
export type AnyKrakenModule = KrakenModule;
