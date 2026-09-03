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
import type { Frame, Layer, LayerId, Transform, Units } from '../state/look/types';
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

/**
 * What one layer costs the panel, declared by the module rather than measured.
 *
 * It is an ESTIMATE and the UI says so (§7.2): the page can measure its own
 * frame times, but nothing on this side can see CAM's capture and compressor,
 * which is where a busy look actually gets expensive. Declaring the cost is how
 * the home screen can warn before the frame rate drops instead of after.
 *
 * `cost()` is called on every keystroke in the editor, so it must be pure,
 * eager and tiny — no DOM, no allocation worth naming, no registry lookup.
 */
export interface LayerCost {
  /** `'static'` never repaints; `'tick'` ≤ 1 Hz; `'frame'` every frame tick. */
  cadence: 'static' | 'tick' | 'frame';
  /** Fraction of its OWN frame repainted per change, `(0, 1]`. */
  coverage: number;
  /** What CAM's compressor sees when it changes. */
  entropy: 'low' | 'mid' | 'high';
  /** A video decoder. `Σ decoders ≤ 1` across a look (§3.4). */
  decoders: 0 | 1;
  /** A WebGL context. `Σ gl ≤ 2` across a look (§3.4). */
  gl: 0 | 1;
}

/**
 * Where a module is allowed to sit in a look, and what it costs there.
 *
 * The rules are DATA, declared once by the module, and they are enforced in
 * exactly one place — `normalizeLook()` in `src/modules/stack.ts`. A module
 * never checks its own role at runtime, and the editor never hardcodes "video
 * is base-only": it asks the placement.
 *
 * `EditorPlacement` (`src/app/config/editor/registryPort.ts`) is a structural
 * SUBSET of this, so a real placement satisfies the editor's port with no
 * adapter — the field names here are the contract for both.
 */
export interface LayerPlacement {
  /** Non-empty. `['base']` means "this kind can only be the bottom layer". */
  readonly roles: readonly ('base' | 'overlay')[];
  /** video 1, effect 2, everything else `MAX_LAYERS`. Always ≥ 1. */
  readonly maxInstances: number;
  /** What the editor's resize gesture commits to on release (§3.2). */
  readonly resize: 'frame' | 'scale';
  /** Diameter units; the editor clamps a frame to it. */
  readonly minFrame: Units;
  /**
   * Where a fresh overlay of this kind lands, in units, and (additive to §1.4)
   * the config patch that makes it an OVERLAY rather than a shrunken base —
   * stats' bottom scrim is `{ layout: 'strip' }`, and nothing else about the
   * module changes.
   */
  readonly overlayDefault: { frame: Exclude<Frame, 'panel'>; t: Transform; cfg?: unknown };
  /** Pure, eager, tiny. Called per keystroke by the editor's budget bar. */
  cost(cfg: unknown, layer: Pick<Layer, 'frame' | 't'>): LayerCost;
}

// ---------------------------------------------------------------------------
// The selection strip (design-editor-ux.md §2.3)
// ---------------------------------------------------------------------------

/**
 * The cap and the well-formedness rule live in `./stripContract.ts`, which is a
 * value module — this one stays types-only so every importer can keep saying
 * `import type`.
 */

/** Where a strip control writes: the layer's CONFIG, or the layer itself. */
export type StripTarget = 'cfg' | 'layer';

export interface StripOption {
  value: string;
  label: string;
  /** A CSS colour, for a control that shows the choice rather than naming it. */
  swatch?: string;
  /** The sentence a hover explains it with. Never read aloud on every render. */
  title?: string;
}

interface StripControlBase {
  /** Unique within the kind's strip. Also the control's `data-testid` suffix. */
  readonly id: string;
  /** The word above the control. Names the thing, never the system. */
  readonly label: string;
}

interface StripValueBase extends StripControlBase {
  readonly target: StripTarget;
  /**
   * A dot path into the target — `'render.fit'` on a config, `'t.a'` on a
   * layer. Read and written by `src/app/config/editor/strip.ts`, which is the
   * only module that knows how to walk one.
   */
  readonly path: string;
}

/**
 * One control on a selection strip, as DATA.
 *
 * Declared by the module and rendered by the editor, so a kind's four essential
 * controls are a fact in its manifest rather than a branch in a view — which is
 * exactly the shape the old `OpsStrip` was not, and why it knew about four
 * modules by name and nothing about the other three.
 */
export type StripControl =
  | (StripValueBase & { readonly control: 'segmented'; readonly options: readonly StripOption[] })
  | (StripValueBase & { readonly control: 'swatches'; readonly options: readonly StripOption[] })
  | (StripValueBase & { readonly control: 'toggle' })
  | (StripValueBase & { readonly control: 'text'; readonly max?: number })
  | (StripValueBase & {
      readonly control: 'range';
      readonly min: number;
      readonly max: number;
      readonly step: number;
      readonly format?: 'percent' | 'number';
    })
  /**
   * The framing choice, in the app's ONE fit vocabulary.
   *
   * A `'segmented'` with the four fit words spelled out again in each manifest
   * would be a second copy of `ui/fitOptions.ts`, which is the exact drift that
   * file was written to end — and a manifest may not import `src/ui` (I8). So
   * the module says WHERE its fit lives and the editor renders the house
   * control.
   */
  | (StripValueBase & { readonly control: 'fit' })
  /** The layer's own size: the resize gesture, as two buttons (§3.2). */
  | (StripControlBase & { readonly control: 'size' })
  /**
   * Something that OPENS rather than sets.
   *
   * Every one of these needs data the manifest may not carry: the library and
   * the paste row, the A/B scrubber, the effect catalog (deliberately not on
   * the display path), the provider-dependent quality ladder. The module
   * declares that it wants the affordance; the editor owns what it opens.
   */
  | (StripControlBase & { readonly control: 'action'; readonly action: StripAction })
  /** Always last, always present. Opens the inspector sheet (§2.4). */
  | (StripControlBase & { readonly control: 'more' });

export type StripAction = 'source' | 'loop' | 'colours' | 'preset' | 'effect' | 'quality';

/**
 * What a kind's `editor.ts` exports — the strip, and nothing else yet.
 *
 * A named shape rather than an inline `{ strip }` because it is the resolved
 * value of a `Promise` in two places and a module's default export in nine, and
 * because the next thing the editor asks a kind for (an inspector layout, say)
 * belongs here rather than in a second loader.
 */
export interface StripDeclaration {
  /** ≤ `MAX_STRIP_CONTROLS`, and the last one is always `control: 'more'`. */
  readonly strip: readonly StripControl[];
}

/**
 * What a kind puts on the editor's surfaces — LAZILY.
 *
 * Optional in the type so a fork's module compiles untouched, required by the
 * registry conformance test — the same contract `layer` makes.
 *
 * ## Why this is a loader and not an array
 *
 * A strip is config-only DATA — five control declarations, a swatch table, a
 * font list — and it was riding the registry, which is eager, which puts it in
 * the display's `core` chunk. The LCD downloaded nine kinds' option tables
 * before it could show a frame and never read one of them: there is no editor
 * on the display. Measured at 3.2 kB raw across the nine manifests.
 *
 * So the declaration moved to `src/modules/<kind>/editor.ts` and the manifest
 * keeps only the promise of it. The config page loads a kind's strip when a
 * layer of that kind is first selected (`src/app/config/editor/strip.ts`), and
 * the LCD never loads one at all.
 */
export interface EditorContract {
  /** `() => import('./editor')`. One tiny chunk, fetched on first selection. */
  loadStrip: () => Promise<StripDeclaration>;
}

export interface UpdateReason {
  /** Dot paths that differ from the previous config. */
  changed: string[];
  origin: 'boot' | 'local' | 'remote' | 'url' | 'reinit';
}

export type ReinitReason =
  'resume' | 'raf-stall' | 'monitoring-stall' | 'media-stall' | 'geometry-change' | 'manual';

export interface ModuleContext {
  /**
   * THIS LAYER's geometry — its own box, its own safe inset.
   *
   * For the base it is the panel's own `Geometry` object, by identity, so the
   * one-layer fast path is byte-identical to what shipped before looks existed.
   */
  geometry: () => Geometry;
  frameClock: FrameClock;
  monitoring: MonitoringSource;
  render: () => RenderSettings;
  log: Logger;
  /** Aborted on unmount. Pass it to every fetch and every listener. */
  signal: AbortSignal;
  /**
   * Which layer this renderer IS.
   *
   * Absent only on the legacy single-module path, where "the" instance is the
   * base — `ctx.layer?.id ?? BASE_LAYER_ID` is the idiom, and it is what keeps
   * a per-instance key (`setReplicaThumb`) correct in both worlds. A module
   * that keys anything by "the current module" instead is a module that breaks
   * the moment somebody adds a second one.
   */
  layer?: {
    id: LayerId;
    /** Array index = z-order, bottom first. */
    index: number;
    role: 'base' | 'overlay';
    frame: Frame;
    /** The whole panel, for a layer that needs to know where it sits on it. */
    panel: () => Geometry;
  };
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
  /**
   * Governor tier hint (§7.5). Optional, and ignoring it is a valid answer.
   *
   * `'reduced'` = you are being ticked every 4th frame, so drop detail (an
   * effect halves its drawing buffer); `'hz1'` = once a second. The governor
   * NEVER hides or unmounts a layer, so this is the only lever a renderer has
   * to get cheaper, and it must stay correct — merely coarser — at every tier.
   */
  budget?(tier: 'full' | 'reduced' | 'hz1'): void;
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
  /**
   * Whether the window rendering this panel is the one whose storage the bytes
   * land in — `app/config/surface.ts`'s `ownsBytes()`, threaded in rather than
   * imported, because invariant I8 forbids a module reaching into `app/config`.
   *
   * Round 13's audit: the phone's inspector mounts these panels verbatim, so a
   * sofa got *"On this PC"*, *"Keep a copy"*, a **Local downloader** card
   * offering *"Download for Windows"*, and a port and token field for a program
   * running on a machine it cannot see. Every one of those controls acts on the
   * OWNER's disk; a window that owns none of it can neither perform nor check
   * them, so it does not render them.
   *
   * Optional and TRUE by default: the panel behaves exactly as it always has on
   * every surface that does not answer the question, and only a caller that
   * knows the answer is `false` has to say so.
   */
  ownsBytes?: boolean;
}

export interface KrakenModule<C = unknown> {
  readonly id: ModuleId;
  readonly name: string;
  /**
   * The name on the home screen's module chip, when the full one is too long.
   *
   * The four chips are a rhythm, not a list — one word each, tapped to switch
   * what the LCD is showing — so a module whose proper name is two words gives
   * the chip a short one. Everywhere a module is NAMED (its settings panel, the
   * docs, the README's module table) still uses `name`. Defaults to `name`.
   */
  readonly chipName?: string;
  /** One line, shown in the module picker. */
  readonly summary: string;
  /** Inline SVG path data — no asset request on the display path. */
  readonly icon: string;
  /** Bumped on a breaking config change; `migrateConfig` becomes mandatory. */
  readonly configVersion: number;
  readonly capabilities: ModuleCapabilities;
  /**
   * Where this module may sit in a look, and what it costs.
   *
   * OPTIONAL in the type so a fork's module compiles untouched — `placementOf()`
   * derives a base-only legacy placement for one — but REQUIRED by the registry
   * conformance test, so every module in THIS build declares it.
   */
  readonly layer?: LayerPlacement;
  /**
   * What this kind shows on the editor's selection strip (§2.3), behind a
   * loader — the declaration itself lives in `<kind>/editor.ts`.
   *
   * OPTIONAL for the same reason `layer` is — a fork's module must compile —
   * and REQUIRED by the registry conformance test, which awaits every
   * registered kind's loader and enforces the two rules the cap depends on:
   * ≤ `MAX_STRIP_CONTROLS`, `more` last.
   */
  readonly editor?: EditorContract;

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
