# Kraken Layers — Build Specification (synthesis of A/B/C + judge verdicts)

## 0. Ten lines to hold in your head

1. **Base = Design A** (judge 1: 8.5). Grafts: B's `render-shared`-in-budget, singleton conformance test, normalised cost formula, `preview()` channel, MAX_LAYERS 8, never-truncate-layers, home-screen plan; C's deterministic migrated id, `usesMedia`-driven replica mode, legacy wire projection, opacity-surface cost charge, enumeration-test table. Rejected: C's two-decoder video, `z-index=index`, 240 ms fade, deleting `modules`; B's "no runtime lever"; A's dynamic-import budget dodge.
2. A **look** is `{ layers: Layer[] }`; array order is z-order (bottom first); `layers[0]` is always the base: `id:'base'`, `frame:'panel'`, `t:IDENTITY`, **no `cfg`** (it wears `modules[kind].cfg`). Overlays carry their own `cfg`. Validator enforces this by position, so a config has exactly one home.
3. Compositor = **one absolutely-positioned host `div` per ON layer under `.kh-stage`, DOM order = z, Chromium composites**; per-host republish of `--kh-w/--kh-h/--kh-r/--kh-safe/--kh-inscribed` so every module's CSS resolves against its own box with zero module edits (verified: `clock.css:30`, `image.css:43`, `video.css:34…195`, `stats.css:124` all read `var(--kh-safe)`/`var(--kh-inscribed)` from `:root`).
4. Transform commit = **one `style.transform` write**; layout kinds (clock/stats/text) resize by frame on gesture end (crisp), pixel kinds (image/shape/effect) by CSS scale. Video is **base-only, one instance** (decoder + `videoTelemetry.ts:231` `let context` + `RenderController.ts:103` promoted stage); the base never moves in the DOM (an `<iframe>` re-navigates when moved), so `insertBefore` reorders only ever touch overlays.
5. Registry-aware rules (roles, `maxInstances`, cost) live in `src/modules/stack.ts` (`normalizeLook`), **not** in `src/state/validate.ts`, which stays structural and module-agnostic. Byte cap is a **refusal at op time**, never a silent drop.
6. Governor (`src/render/layerGovernor.ts`): tiers `full → reduced (every 4th tick, phase = index % 4) → hz1`; `perfPromoter` hysteresis (0.6×target for 10 s; `targetFps ≤ 10` immediate); never hides or removes a layer. Per-layer p95 via EMA + 64-ring in closure state (I4).
7. Schema 6 → 7: `activeModuleId` → `look.layers = [BASE(kind)]`, deterministic (both CAM browsers migrate the same retained doc independently). `modules` stays as the bank/template. `SyncStateBody` carries `look` **and** a derived `activeModuleId` for one release; a reader without `look` synthesises it with the same `baseLook()` the migration uses.
8. Editor boundary: pure `ops/geometry/snap/gesture/history` in `src/app/config/editor/` over `src/render/layerBox.ts` math shared with the compositor; selection/drag/guides are React state only; undo = 50-entry ring of `Look` snapshots, push on gesture END; a remote change is pushed as an entry (LWW).
9. Performance: 25 ms frame @ 40 fps, JS ≤ 4 ms; per-layer p95 > 4 ms trips G1; critical path target ≤ 88.5 kB of 90 with `render-shared` **added to** `budgets.json`; W0 answers the one unmeasured question — does CAM's compressor backpressure the page's rAF? — and labels declared costs *estimates* until H09–H11/H24–H27 land.
10. Eight waves, dependency-ordered: W0 spike/instrument → W1 model+state → W2 contract → W3 compositor+display → W4 editor model ∥ W3 → W5 home editor → W6 phone → W7 new kinds (text, shape, effect) → W8 looks/files. Each ships its enumeration tests; W1–W3 land together behind the schema bump.

---

## 1. Final TypeScript types

### 1.1 `src/state/look/types.ts` (core chunk; no DOM, no registry)

```ts
import type { ModuleId } from '../schema';

/** Unit-radius panel coordinates: origin = panel centre, +x right, +y down,
 *  1.0 = Geometry.radiusPx (= min(w,h)/2). px = u * radiusPx. 3 decimals on the wire. */
export type Units = number;

export interface Transform {
  x: Units;   // centre of the frame, [-1.5, 1.5]
  y: Units;
  s: number;  // CSS scale, [0.1, 4]. Persisted ≠ 1 only for resize:'scale' kinds (§3.2)
  r: number;  // degrees clockwise, [-180, 180]
  a: number;  // opacity [0, 1]; < 1 costs one compositor surface (charged, §7.2)
}
export const IDENTITY: Transform = { x: 0, y: 0, s: 1, r: 0, a: 1 };
export const TRANSFORM_LIMITS = { pos: 1.5, sMin: 0.1, sMax: 4, rot: 180 } as const;

/** 'panel' = the whole LCD (base only). Box frames are in DIAMETER units: w = 2 is full width. */
export type Frame = 'panel' | { w: Units; h: Units; shape: 'square' | 'circle' };

export type LayerId = string;
export const LAYER_ID_RE = /^[a-z][a-z0-9]{3,11}$/;
export const BASE_LAYER_ID = 'base';          // layers[0].id, always. Deterministic across peers.
export const MAX_LAYERS = 8;                  // B's number; the wire-budget test is built on it
export const MAX_LAYER_NAME = 24;
export const MAX_LOOK_BYTES = 3072;           // JSON.stringify(look).length; refused by ops, noted by validator

export interface Layer {
  id: LayerId;
  kind: ModuleId;      // registered module id; unknown kinds preserved verbatim, skipped at render
  on: boolean;         // OFF = unmounted (costs nothing), config kept
  name?: string;       // ≤ MAX_LAYER_NAME; absent = kind's chipName ?? name
  frame: Frame;        // 'panel' iff index === 0 (validator forces both ways)
  t: Transform;        // IDENTITY at index 0 (validator forces)
  /** ABSENT at index 0 (base wears state.modules[kind].cfg). PRESENT (verbatim, unknown) for every overlay. */
  cfg?: unknown;
  /** kind.configVersion at write time; overlays only. Migrated by mod.migrateConfig at point of use. */
  v?: number;
}

export interface Look { layers: Layer[] }
export type LayerTemplate = Omit<Layer, 'id'>;

/** What a fresh document, a migration and a legacy wire body all produce. Deterministic. */
export function baseLook(kind: ModuleId): Look {
  return { layers: [{ id: BASE_LAYER_ID, kind, on: true, frame: 'panel', t: IDENTITY }] };
}
export function lookBytes(look: Look): number;                 // JSON.stringify(look).length
export function withIds(t: readonly LayerTemplate[]): Layer[]; // index 0 → 'base', others randomId(8) prefixed 'l'
export function toTemplates(l: readonly Layer[]): LayerTemplate[];
```

### 1.2 `src/state/schema.ts` delta

```ts
export const SCHEMA_VERSION = 7;
export interface AppState {
  …unchanged…
  // activeModuleId: REMOVED. selectBaseKind(s) === s.look.layers[0].kind
  look: Look;
  /** Unchanged role: per-kind memory (base config) + template for new overlays. Unknown ids verbatim. */
  modules: Record<ModuleId, ModuleSlot>;
  playback: PlaybackState | null;   // ownerModuleId unchanged (≤ 1 video per look keeps it unambiguous)
}
export const SCHEMA_HISTORY: Readonly<Record<number, string>> = {
  1: 'baseline', 2: 'render.fit contain-circle', 3: 'sync endpoints + fake transport',
  4: 'clock-lite → clock', 5: 'video quality', 6: 'settings census',
  7: 'looks: activeModuleId → look.layers[]',
};
```

### 1.3 `src/modules/layerKinds.ts` (core) — typed view, forks extend by declaration merging

```ts
export interface LayerConfigs { video: VideoModuleConfig; image: ImageModuleConfig; clock: ClockConfig;
  stats: StatsConfig; text: TextConfig; shape: ShapeConfig; effect: EffectConfig }
export type KnownLayer = { [K in keyof LayerConfigs]: Omit<Layer,'kind'|'cfg'> & { kind: K; cfg: LayerConfigs[K] } }[keyof LayerConfigs];
export type UnknownLayer = Layer & { unknown: true };
export function narrowLayer(l: Layer, cfg: unknown): KnownLayer | UnknownLayer; // through the kind's validate()
```

### 1.4 `src/modules/types.ts` additive contract

```ts
export interface LayerCost {
  cadence: 'static' | 'tick' | 'frame';   // never | ≤ 1 Hz | every tick
  coverage: number;                        // fraction of its FRAME repainted per change, (0,1]
  entropy: 'low' | 'mid' | 'high';         // what the compressor sees when it changes
  decoders: 0 | 1;
  gl: 0 | 1;
}
export interface LayerPlacement {
  roles: readonly ('base' | 'overlay')[];
  maxInstances: number;                    // video 1, effect 2, everything else MAX_LAYERS
  resize: 'frame' | 'scale';               // what the editor's resize gesture commits to
  minFrame: Units;                         // diameter units; editor clamps
  overlayDefault: { frame: Exclude<Frame, 'panel'>; t: Transform };
  cost(cfg: unknown, layer: Pick<Layer, 'frame' | 't'>): LayerCost;   // pure, eager, tiny
}
export interface KrakenModule<C = unknown> {
  …existing…
  /** Optional in the TYPE so a fork compiles; REQUIRED by the registry conformance test. */
  readonly layer?: LayerPlacement;
}
export interface ModuleContext {
  …existing…  // geometry() = THIS LAYER's geometry (=== runtime's object for the base, by identity)
  layer?: { id: LayerId; index: number; role: 'base' | 'overlay'; frame: Frame; panel: () => Geometry };
}
export interface DisplayRenderer<C> {
  …existing…
  /** Governor tier hint. Effects halve resolution / drop detail; others ignore. */
  budget?(tier: 'full' | 'reduced'): void;
}
```

`placementOf(mod)` in `src/modules/stack.ts` derives a legacy placement for a module without `layer`: `{ roles:['base'], maxInstances:1, resize:'scale', minFrame:0.5, overlayDefault:{frame:{w:1,h:1,shape:'square'},t:IDENTITY}, cost: () => ({ cadence: motionLevel==='full'?'frame':motionLevel==='low'?'tick':'static', coverage:1, entropy:'mid', decoders:0, gl:0 }) }` + one DEV warning. That is the backward-compat path: a fork's module keeps rendering as a base with no edit.

**Shipped kinds declare:**

| kind | roles | max | resize | minFrame | overlayDefault | cost(defaults) |
|---|---|---|---|---|---|---|
| video | base | 1 | scale | 0.5 | n/a (base only) | frame · 1 · high · dec 1 |
| image | base, overlay | 8 | scale | 0.3 | `{w:0.8,h:0.8,circle}` @ (0.45,-0.45) | static (slideshow: tick) · 1 · mid |
| clock | base, overlay | 8 | frame | 0.4 | `{w:1.0,h:0.5,square}` @ (0,0.55) | tick · 0.15 · low |
| stats | base, overlay | 8 | frame | 0.4 | `{w:1.6,h:0.5,square}` @ (0,0.6) + `layout:'strip'` | tick · 0.3 · low |
| text (W7) | overlay | 8 | frame | 0.2 | `{w:1.2,h:0.3,square}` @ (0,-0.6) | static · 1 · low |
| shape (W7) | base, overlay | 8 | scale | 0.1 | `{w:1.6,h:0.5,square}` @ (0,0.6) | static · 1 · low |
| effect (W7) | base, overlay | 2 | scale | 0.5 | `{w:0.6,h:0.6,circle}` @ (0.45,-0.45), `t.a` 0.85 | frame · 1 · mid (`high` for colour-spiral / infinite-rings) · gl 1 |
| date | overlay | 8 | frame | 0.2 | `{w:1.1,h:0.28,square}` @ (0,0.66) | tick · 1 · low |
| icon | overlay | 8 | frame | 0.1 | `{w:0.5,h:0.5,square}` @ (-0.45,-0.45) | static · 1 · low |

Every `overlayDefault` in that column is pinned by a property test in `src/modules/registry.test.ts`: each default box must fit inside the panel's chord at its own offset AND inside the `0.88` safe ring on both axis extents, so a drifting value fails the suite rather than the bezel.

`ModuleCapabilities.motionLevel` stays; conformance asserts `motionLevel` agrees with `cost(defaults).cadence` (`full`↔`frame`, `low`↔`tick`, `static`↔`static`).

---

## 2. Compositor (`src/render/compositor.ts`, render-shared chunk; pure TS + DOM; no React; no config; registry injected)

### 2.1 Substrate decision (all three designs agree; judges endorsed)

DOM stacking, one host per ON layer, Chromium composites. Not a single canvas (a `<video>` needs a decode→draw copy per frame; a cross-origin YouTube `<iframe>` cannot be sampled; every pixel would change per tick). Not a WebGL scene (text as textures, +15 kB). A layer whose renderer did not touch the DOM this tick costs zero raster and zero upload.

### 2.2 DOM per layer class

```
.kh-stage (unchanged: inset:0; contain:strict; overflow:hidden; border-radius:50% when masked — clips EVERY layer)
  base   → div.kh-layer.kh-stage__module[data-layer=base][data-kind=K][data-module=K][data-role=base]
             style: (nothing — inset:0 comes from .kh-stage__module). NO --kh-* vars (inherit :root).
             Byte-identical to today's ModuleHost host. Snapshot-tested per kind × preset.
  overlay→ div.kh-layer[data-layer=id][data-kind=K][data-role=overlay]
             position:absolute; left:50%; top:50%; width:Wpx; height:Hpx; pointer-events:none;
             transform: translate(-50%,-50%) translate(Xpx,Ypx) rotate(Rdeg)[ scale(S) when S≠1];
             transform-origin:50% 50%; [opacity:A when A<1];
             --kh-w --kh-h --kh-r --kh-safe --kh-inscribed  (this layer's geometry; custom props inherit)
             [frame.shape=circle AND kind.resize=scale] → border-radius:50%; overflow:hidden
             NO will-change on any host (the module's own stage may promote itself — video/image do)
  LowFpsBanner / DebugOverlay / DiagOverlay after the stack, unchanged
```

| layer class | substrate inside host | per-tick cost | clip | notes |
|---|---|---|---|---|
| base (any kind) | as today | as today | stage mask | `ctx.geometry()` returns the runtime object by identity |
| layout overlay (clock, stats, text) | DOM/SVG | 0 until its own timer paints (≤ 1 Hz) | none (lays out inside its own `safeInsetPx`) | frame change → `renderer.geometry(g)`; `t` change → one style write |
| pixel overlay (image, shape) | `<img>`/SVG | 0 | `border-radius:50%` only when frame is circle | image keeps its own `will-change` (image.css:27) → counted as a surface |
| effect overlay/base | `<canvas webgl2>` | uniforms + 1 draw | as pixel | `alpha:false` as base, `alpha:true, premultipliedAlpha:true` as overlay; drawing buffer = host px (halved under `reduced`) |
| any overlay with `a < 1` | — | — | — | forces an offscreen surface; counted in `surfaces`, charged +0.1 in cost |

### 2.3 Per-layer geometry (`src/render/layerBox.ts`, pure, shared with editor and replica)

```ts
export function hostBox(layer: Layer, panel: Geometry): Rect;              // panel frame → {0,0,W,H}; box → centred W/2 + x·R − w·R/2 …, size w·R × h·R (R = radiusPx)
export function layerGeometry(layer: Layer, panel: Geometry, render: GeometryRender): Geometry;
//   panel frame → panel (same object). Box → deriveGeometry({width:w·R, height:h·R, shape:frame.shape, targetFps, dpr, source: panel.source}, prefs, render)
export function hostStyle(layer: Layer, panel: Geometry): Record<string,string>; // exactly §2.2; '' for base
export function layerMatrix(layer: Layer, panel: Geometry): Mat2x3;         // translate·rotate·scale about frame centre, px
export function layerBounds(layer: Layer, panel: Geometry): { rect: Rect; corners: [x,y][] };
export function hitTest(look: Look, pt: {x,y}, panel: Geometry): LayerId | null; // top-most first, inverse matrix, overlays only
```
`ctx.render()` for an overlay returns the panel's `RenderSettings` **verbatim** (B's fabricated `safeAreaPct:0` rejected; safe area reaches modules through `Geometry`, which `layerGeometry` already derives for the box).

### 2.4 API

```ts
export interface CompositorContext {
  geometry: () => Geometry; frameClock: FrameClock; monitoring: MonitoringSource;
  render: () => RenderSettings; log: (scope: string) => Logger;
  load: (kind: ModuleId) => Promise<{ createRenderer(): DisplayRenderer<unknown> } | null>; // null → unknown kind, skipped + note
  placement: (kind: ModuleId) => LayerPlacement | null;
  /** Validated config for a layer. Display: base → modules bank + URL params; overlay → layer.cfg through validate(). */
  configOf: (layer: Layer) => unknown;
  governor: boolean;            // display true; replica false
}
export interface Compositor {
  update(look: Look, origin: UpdateReason['origin']): void;     // reconcile by id (§2.6)
  geometry(g: Geometry): void;                                  // resize every host, republish vars, renderer.geometry(layerGeometry)
  reinit(reason: ReinitReason): void;                           // fan-out
  visibility(v: 'hidden' | 'visible'): void;
  command(op: string, arg?: unknown, layerId?: LayerId): boolean; // to layerId, else the base; false = no handler
  preview(id: LayerId, t: Transform | null): void;              // host style only; never a renderer call
  stats(): { layers: { id; kind; tier; p95Ms; ema }[]; surfaces: number; governor: 'ok'|'g1'|'g2'|'g3'; stackCadence: 'static'|'tick'|'frame' };
  status(): { ready: boolean; failures: { id; kind; title; detail }[] };
  subscribe(cb: () => void): () => void;                        // status changes only (useSyncExternalStore)
  dispose(): void;
}
export function createCompositor(root: HTMLElement, ctx: CompositorContext): Compositor;
```

### 2.5 One frame clock, N subscribers, one subscription

The compositor subscribes to `frameClock` **once** and fans out in array order over ON entries whose renderer has `frame()`:

```ts
for (const e of entries) {
  if (!due(e.tier, f.frame, e.index)) continue;   // full: always; reduced: (f.frame + index) % 4 === 0; hz1: (f.frame + index*?) — once per 1000 ms via e.nextAt
  const t0 = performance.now();
  try { e.renderer.frame!(f); e.throws = 0; }
  catch (err) { if (++e.throws >= 3) { e.tier = 'off'; e.fail('Module error', msg); } }
  e.sample(performance.now() - t0);               // EMA(α=0.1) + 64-entry ring → p95; closure state only (I4)
}
```
`monitoring`, `geometry`, `visibility`, `reinit` fan out the same way. The per-entry machinery from `ModuleHost.tsx` (disposed flag, `AbortController`, latest-config ref, 3-strike wrapping, error card) moves verbatim into `LayerEntry`.

### 2.6 Reconcile by id (never remount for a transform)

| change | action | cost on the LCD |
|---|---|---|
| id added / turned on | create host at index → `ctx.load(kind)` (cached per kind) → `createRenderer()` → `mount(host, ctx, configOf)` → subscribe | one lazy chunk (cached) |
| id removed / turned off | unsubscribe → `unmount()` → host removed | — |
| order changed (overlays only) | `root.insertBefore` in array order | 0 raster (WebGL canvases keep their context when moved; the base never moves) |
| `t` changed | `host.style.transform` / `opacity` | one style write |
| `frame` changed | host size + `--kh-*` republish → `renderer.geometry(layerGeometry)` | one re-layout (gesture end only) |
| `cfg` changed | `diffPaths(prev, next)` → `renderer.update(cfg, {changed, origin})` | as today |
| `kind` changed on same id | remove + add | — |
| base kind changed | remove base + add base (today's module switch) | as today |

### 2.7 Clipping

Stage mask clips the whole stack to the bezel (corners stay flat black — the compressor win). No per-layer `clip-path`. Circle frames on pixel kinds get `border-radius:50%; overflow:hidden` (one extra clip, only where asked). Layout kinds need none. The safe circle is **not** a clip: the editor surfaces `outsideSafeCircle()` as the words "may be cut by the bezel".

### 2.8 Live preview channel (from B)

`compositor.preview(id, t)` writes the CSS-only transform. CAM page: the halo is an iframe of the real display; the editor posts `{ kh:'preview', id, t }` with `postMessage(msg, location.origin)`; `src/app/display/mount.tsx` installs the `message` listener **only when `inConfigMirror()`** (moved from `image/display.ts` to `src/platform/env.ts`) and `event.origin === location.origin`. The LCD (top-level window) never has the listener. The next committed `look` (storage event) clears the preview. Phone: replica is in-process → `preview()` called directly.

### 2.9 `LayerHost.tsx` (replaces `ModuleHost.tsx`, display-shell)

Props `{ runtime, state }`. Creates the compositor once per runtime; effects: `update(state.look, origin)` on look/modules change, `geometry(g)` on geometry change; `useSyncExternalStore(subscribe, status)` for splash (`!ready`) and `ModuleErrorCard` per failure. `runtime.onReinit`/`onCommand` become `compositor.reinit` / `compositor.command`. `configOf`: base → `mod.validate(applyUrlParams(selectModuleConfig(state, kind), runtime.moduleParams))`; overlay → `mod.validate(migrateConfig?(layer.v, layer.cfg) ?? layer.cfg)`. `DisplayApp`: `motionLevel = max(cost.cadence over ON layers)` mapped back to `'static'|'low'|'full'`; `ownsFpsAdvisory` from the base only; `LowFpsBanner` unchanged otherwise. `display/sync.ts` `default:` branch → `compositor.command(op, arg, arg?.layer)`; `setModule` remains an alias for "replace the base".

---

## 3. Module → layer contract

### 3.1 What a module author does (docs/modules.md §7 gains one row + one "Placement" step)

Add `layer: { roles, maxInstances, resize, minFrame, overlayDefault, cost }` to the manifest; `_template` declares `roles:['base','overlay']`. A renderer that lays out from `ctx.geometry()` (all four do — `replica.ts` proved it) is already an overlay. Rules restated: no module-scope singletons keyed by "the" instance; `setReplicaThumb(ctx.layer?.id ?? 'base', blob)`; never write `will-change` on the host you were given; read `--kh-*` vars freely (they are now per-layer).

### 3.2 `resize` semantics (A's, with B's crispness on settle)

During a drag both kinds preview via CSS `scale` (one style write). On gesture END: `resize:'frame'` kinds commit `frame := frame × factor`, `t.s` stays 1 (re-layout, crisp text/SVG); `resize:'scale'` kinds commit `t.s` (no re-layout; a raster/canvas/video scales fine).

### 3.3 Singletons (B's inventory → a test, W2)

`replicaThumb` → keyed `Map<LayerId, Blob|null>` (`setReplicaThumb(layerId, blob)`, `subscribeReplicaThumb((layerId, blob) => …)`, `currentReplicaThumbs()`); `videoTelemetry.ts:231` `let context` and `downloadsModule` cache → untouched, made safe by `video.maxInstances = 1, roles:['base']`; stats' 1 s timer is per closure (fine). Conformance test mounts two instances of every `roles ⊇ overlay` kind in jsdom and asserts no cross-talk.

### 3.4 `src/modules/stack.ts` (core; registry-aware; the ONLY place placement rules run)

```ts
export function placementOf(mod: AnyKrakenModule): LayerPlacement;               // §1.4 legacy derivation
export interface StackNote { id: LayerId; reason: 'unknown-kind' | 'role' | 'max-instances' | 'base-not-base-capable' }
export interface RenderPlan { layers: Layer[]; notes: StackNote[] }               // reference-stable when nothing changed
export function normalizeLook(look: Look, getModule: (id: string) => AnyKrakenModule | null): RenderPlan;
//  - unknown kind → excluded from plan (state untouched), note
//  - roles:['base'] kind at index > 0 → on:false in plan, note
//  - instances beyond maxInstances (array order) → on:false in plan, note   (Σ decoders ≤ 1 and Σ gl ≤ 2 fall out of video.max=1, effect.max=2)
//  - layers[0] not base-capable → plan renders it as an overlay over the stage background, note
export function lookCost(look: Look, getModule): { total: number; worst: { id; w }; verdict: 'calm'|'busy'|'rich'; surfaces: number; decoders: number; gl: number };
```

---

## 4. State: validation, migration, selectors, URL

### 4.1 `validateLook` (in `src/state/validate.ts`; structural; never throws; no registry)

Per layer: `id` by `LAYER_ID_RE` (else dropped + note), duplicates → later dropped + note, `kind` by `MODULE_ID_RE`, `on` bool, `name` ≤ 24, `frame` coerced (`'panel'` or `{w,h ∈ [0.1,3], shape}`), `t` clamped to `TRANSFORM_LIMITS`, `cfg` verbatim, `v` finite. Positional rules: index 0 → `id:'base'`, `frame:'panel'`, `t:IDENTITY`, `cfg`/`v` **stripped** (note if present); index ≥ 1 → `frame` coerced to `overlayDefault`-shaped box if `'panel'` (note), `cfg` kept (absent → `{}`). Empty/missing → `baseLook(DEFAULT_MODULE_ID)`. `> MAX_LAYERS` → tail dropped + note (only reachable from a corrupt/foreign document; ops refuse earlier). `lookBytes > MAX_LOOK_BYTES` → **note only**. Idempotent; fixture-tested.

### 4.2 Migration 6 → 7 (`src/state/migrations.ts`)

```ts
6: (s) => toLook({ ...s, schema: 7 })
// kind = MODULE_ID_RE.test(s.activeModuleId) ? s.activeModuleId : DEFAULT_MODULE_ID
// drop activeModuleId; look = baseLook(kind)   ← cfg deliberately absent; modules untouched (it is the bank)
// DETERMINISTIC on purpose: both CAM browsers migrate the same retained v6 snapshot independently and must agree byte-for-byte, or last-writer-wins picks one browser's stack.
```
Fixture `src/state/__fixtures__/state-v6.json` → asserted v7; e2e seeds at schema 4 keep flowing 4→5→6→7. `SCHEMA_HISTORY` completeness test: every `MIGRATIONS` key+1 has a line.

### 4.3 Selectors (`src/state/selectors.ts`)

`selectBaseLayer(s)`, `selectBaseKind(s)`, `selectLayer(s,id)`, `selectLayerConfig(s, layer) = layer.cfg ?? s.modules[layer.kind]?.cfg`, `selectOverlays(s)`, `withLook(s, look)`, `withLayer(s, id, patch)`, `withLayerConfig(s, id, v, cfg)` (index 0 → `withModuleConfig`), `switchBase(s, kind)` (= `withLook(s, { layers: [ {…baseLook(kind).layers[0]}, ...s.look.layers.slice(1) ] })` — overlays survive a base switch; bank keeps the outgoing cfg). The 21 `activeModuleId` sites (`HomeView`, `RemoteView`, `LibraryView`, `RemoteAdd`, `RemoteLibrary`, `pasteLink`, `showTile`, `display/sync.ts:134,484`, `replicaFeed.ts:177`, `urlParams`, `curation.ts` comment, `clock/index.ts` comment, `appSync`, `SyncService`) become `selectBaseKind` / `switchBase` — mechanical.

### 4.4 URL

`?module=<kind>` → `patch.look = baseLook(kind)` (a link is a one-layer look; arrays replace wholesale, "URL always wins"). Module-scoped params (`src`, `loop`, `mute`, `face`, `layout`, `demo`) apply to the base via `runtime.moduleParams`, as today.

### 4.5 Precedence and sync merge

`mergeLeaf` replaces arrays wholesale → `look.layers` is atomic on every channel. `appSync.ts:393,466` keep the `modules` per-key merge (bank semantics); nothing new for `look`. `diffPaths` reports `['look.layers']` as one change; the compositor diffs by id.

---

## 5. Looks, templates, look files

> **Superseded on 2026-09-02.** W8 shipped a different file format, a different
> home for the saved-Look shelf and one field this section says is not needed;
> the bullets below are the design as written, and **Outcome (as shipped)** at
> the end of this section is what exists. Where they disagree, the code wins.

- **Live look** = `state.look`. **Saved looks** = IDB store `looks` (`DB_VERSION 4 → 5`, additive `createObjectStore` in `idb.ts` upgrade, keyPath `id`): `{ id, name, layers: Layer[] (cfg FROZEN for the base too), background, createdAt, updatedAt, pinned }`, ≤ 20 rows. Never inside `AppState` (would ride every 8 kB frame). Apply = `withLook(s, {layers: withIds(toTemplates(row.layers))})` + for the base `withModuleConfig(kind, v, frozenCfg)` — one commit, one history entry.
- **Templates** `src/looks/templates.ts` (config-ui): `LayerTemplate[]` — *Stats over video* (video + stats strip), *Dial + clock*, *Lava + stats* (W7), *Clock + date*; ids assigned on apply.
- **Look file** `src/looks/lookFile.ts` (pure, tested): extension `.krakenhub-look`
  ```ts
  { format:'kraken-hub-look', v:1, app: __APP_VERSION__, schema: 7, exportedAt, name,
    panel: { shape }, layers: LayerTemplate[] /* base carries its frozen cfg */,
    media: Record<string, { name: string; bytes: number; sha256?: string }> }  // for every kraken-hub-clip:/kraken-hub-image: ref
  ```
  Export rewrites local refs to `media` keys. Import returns `{ look, warnings[] }`: ids regenerated; per-layer `v` run through `migrateConfig`; unknown kinds preserved (warning); `v > 1` refused ("made by a newer version", file untouched); optional fields never fatal; a media ref re-links by `sha256`, then `name+bytes` via `listMedia()`; unmatched → layer `on:false` + warning naming the file. Bytes never travel in a look file.
- **Phone**: `tele kind:'looks'` index `{id,name,kinds,pinned}` ≤ 20 rows under `LIBRARY_BODY_BUDGET_BYTES` (chunked via `chunkedTele` if over); additive `CmdOp`s `requestLooks`, `applyLook {id}`, `saveLook {name}`, `deleteLook {ids}` — absolute, idempotent by id, answered by a re-announce (curation rules verbatim).

**Outcome (as shipped).** The format is `src/state/look/file.ts`, not
`src/looks/lookFile.ts`, and the extension is **`.krakenlook`**, not
`.krakenhub-look`. The file is:

```ts
interface LookFile {
  format: 'kraken-hub-look';
  version: number;            // the SCHEMA_VERSION it was written at — not a private `v:1`
  name: string;
  author?: string;
  description?: string;
  createdAt: string;          // ISO 8601
  look: Look;                 // real Layers, with their ids
  configs: Record<ModuleId, unknown>;        // the base kind's config bank entry
  configVersions?: Record<ModuleId, number>; // each cfg's own configVersion at write time
  media: MediaRef[];          // [{ role, kind: 'url'|'hash', value, name? }]
}
```

Five differences from the bullet above, each deliberate:

- **`version` is the schema version.** A file records `SCHEMA_VERSION` and an
  older file is stepped forward by the document's own `migrate()`, run over a
  minimal wrapper document — one migration ladder, not a second one maintained
  beside it. A file whose `version` is **greater** than this build's is refused.
- **Layer ids are KEPT on import, never regenerated.** A Look replaces the whole
  stack, so there is nothing for a file's ids to collide with, and keeping them
  makes an import deterministic — the same argument the 6 → 7 migration makes
  about its base id (§4.2): two CAM browsers importing one file must not end up
  with two stacks that differ by a generated id, or last-writer-wins picks one
  at random. It also keeps `LookPlaceholder.layerId` pointing at a real layer.
- **`media` is a list of refs, not a `Record` of `{name,bytes,sha256}`**, and
  the config's `url` is emptied on the way out. Resolution is three-way, as §4
  of the UX spec asks: in the library → the local id; a fetchable URL → kept;
  neither → a `LookPlaceholder` whose only reason today is **`not-in-library`**.
- **The cap is `MAX_LOOK_FILE_BYTES` = 64 kB** — a different number from
  `MAX_LOOK_BYTES` (3072), which is the wire budget for the look inside a
  document (§6.2). One number could not have served both.
- **The refusals are five and typed**: `not-json`, `not-an-object`,
  `wrong-format`, `too-big`, `future-version`. Everything else — an unknown
  kind, a missing optional field, a layer out of range — is repaired and noted.

Also shipped differently:

- **Templates** live in `src/state/look/templates.ts` (a `looks` chunk, kept off
  the display's critical path by a grep test), not `src/looks/templates.ts`, and
  each is a whole `LookFile` rather than a bare `LayerTemplate[]`.
- **The gallery data is `public/looks/`** — the one directory the build copies
  next to the page — served at `<base>/looks/` and read with a document-relative
  `fetch`. `templates.test.ts` asserts the on-disk files are byte-identical to
  the in-app table.
- **Saved Looks are `kraken-hub:v1:looks` in localStorage, capped at fifty**,
  not an IndexedDB store at `DB_VERSION 5` capped at twenty.
- **The carousel is `carousel?: { lookIds: string[]; intervalSec: number }` on
  `AppState`**, repaired by `validateAppState` and deliberately **not** a schema
  bump (`SCHEMA_VERSION` stays 7): it is a pointer into a store an older build
  never reads or writes, so dropping it stops a rotation and destroys nothing.
  Only the window owning the saved-Looks store commits a tick; the panel renders
  whatever `look` it was last given, and a tick is not an undo entry.
- **The phone's `tele kind:'looks'` index and the four `CmdOp`s are not built.**
  Saved Looks live in one browser profile, which is what makes them un-nameable
  from another window.

---

## 6. Sync and the phone

### 6.1 Wire (`src/sync/types.ts`)

```ts
export interface SyncStateBody {
  /** LEGACY for one release: always written as look.layers[0].kind. A reader that finds `look` ignores it. Removed at schema 8. */
  activeModuleId: string;
  look?: Look;
  modules: Record<string, ModuleSlot>;
  playback: PlaybackState | null;
  render: RenderSettings;
  partial?: true;
}
```
`stateToSyncBody`: writes both. `syncBodyToPatch`: `look: b.look ?? baseLook(b.activeModuleId)` — the same function as the migration, so an old phone's body projects losslessly and a new body still drives an old display (which reads `activeModuleId`). Protocol `v` stays 1.

### 6.2 Size and trim order (`SyncService.ts:600 fitStateEnvelope`)

Per-layer bytes: overlay ≈ 95 + cfg (clock/stats ≈ 90, text ≈ 130, effect ≈ 160); base ≈ 60 (no cfg); bank video ≈ 650. Worst legal doc: base video + 7 overlays with maximal cfgs ≈ 1.7 kB look + 4-kind bank ≈ 1.2 kB + playback/render ≈ 0.4 kB. Trim: (1) drop the bank to the base kind + `partial:true` (exists); (2) **never truncate or strip `layers`** — log, set `lastError`, refuse. Unit test `src/sync/lookWireBudget.test.ts` builds the worst legal stack (8 layers at `MAX_LOOK_BYTES`, full video bank, `MAX_SEEN_ENTRIES` seen map) and asserts `encodeEnvelope(fitStateEnvelope(env))` succeeds ≤ 8192 after step 1.

### 6.3 Telemetry (`replicaFeed.ts` `monitor` packet, same period — two publishers on one period collide)

Add `fps: { t, a, l }` (target, achieved ×10 int, longFrames), `lyr: [[id, p95×10 int], …]`, `gov: 'ok'|'g1'|'g2'|'g3'` (≈ 60 B). `module` stays (= base kind) for old phones. Thumb chunks gain `layer: LayerId`; `sentThumbHash` becomes `Map<LayerId, hash>`. `useSync.ts:336` decodes the new fields; `videoTelemetry`'s tele mirror carries them to `homeState.readDisplayFacts()` → the home budget bar draws **only on a reported number**.

### 6.4 Replica composites the stack (`src/app/config/replica.ts` → `startReplicaStack`)

`createCompositor(host, { frameClock: idleFrameClock(), monitoring: wired, geometry: () => replicaGeometry(display, render), governor:false, load: kind => usesMedia ? stillRenderer(thumbs.get(layerId) ?? poster) : mod.loadDisplay(), placement, configOf })`, driven by the existing 1 Hz timer (`compositor` exposes `tick(f)` for hosts whose clock never fires). Replica mode per layer = `capabilities.usesMedia ? 'still' : 'render'` — replaces the `RemoteRing.tsx:114` hardcode. Geometry rule unchanged: no `display` report → no replica (card). Hidden tab → nothing.

### 6.5 Editing from the phone

No new channel, no commands: `runtime.store.commit(withLook(s, op(look)))` → `publishState` (200 ms trailing, ≤ 5 Hz, retained full snapshot). Phone previews its own replica instantly via `preview()`; the LCD applies one style write per frame. LWW on the whole document. `arg.layer?: LayerId` on any `cmd` routes to that renderer.

---

## 7. Performance plan

### 7.1 Budget and measured facts

Elite 40 fps → 25 ms/frame, JS ≤ 4 ms (design §2.1). H12 measured: rAF locked at 40, `longFrames` 0, video alone. Critical path measured now: **84.7 kB** (index 0.6 + vendor-react 57.5 + core 20.7 + display-shell 5.9); `render-shared` is **1090 B raw / 618 B gz and outside the gate** (B found it; verified in `dist/`).

### 7.2 Cost model (`lookCost`, pure)

Per ON layer: `w = C[cadence] × min(1, coverage × area(frame) × s²) × E[entropy] + (a < 1 ? 0.1 : 0) + (kind is video && a<1 ? 0.1 : 0)`, `C = {static:0, tick:0.05, frame:1}`, `E = {low:0.3, mid:0.6, high:1.0}`, `area('panel') = 1`, `area({w,h}) = w·h/4`. Normalised so one video base = 1.0. Verdicts: `calm ≤ 1.0`, `busy ≤ 1.5`, `rich > 1.5`; `worst` named in words on the home screen. Labelled **estimate** until H09–H11/H24–H27 are recorded; the measured half (below) only ever tightens.

> **Correction — the worked examples' arithmetic.** §9's acceptance row quotes "video + stats strip ≈ 1.01" and "plasma + stats ≈ 0.61". Under the constants above those two looks compute to **1.0009** and **0.6009**, not 1.01 and 0.61: a stats strip is `C[tick] × min(1, coverage × area) × E[low] = 0.05 × (0.3 × (1.6 × 0.5 / 4)) × 0.3 = 0.0009`. The spec's figures were rounded up one order of magnitude, and `stack.test.ts` pins the exact values while keeping the spec's ≤ 0.01 tolerance, so nobody has to chase the discrepancy. The point the figures were making is unaffected and is in fact stronger: a 1 Hz strip over a fifth of the panel costs a *thousandth* of a video, not a hundredth. One video base is still exactly 1.0, and an effect base is still exactly 0.6.

### 7.3 Expected numbers (page side; W0 verifies)

| layer | JS/tick | GPU | compressor entropy |
|---|---|---|---|
| video base | ~0 (off-thread) | 1 upload/frame | full (dominant, unchanged) |
| effect base (tier-1: plasma/nebula/satin/rings/triad) | 0.05 ms | < 1 ms on any iGPU at 640² | low–mid (smooth gradients) |
| stats/clock overlay | 0.01 ms guard, ~0.3 ms once/s | changed tiles only | ≈ 2 % px/s; an opaque scrim over video *reduces* changed area |
| text/shape/image overlay | 0 | 0 | static |
| fan-out | ≈ 0.01 ms × N, N ≤ 8 | — | — |

Headline stack (effect + stats + clock): ≈ 0.1 ms JS median, < 1 ms GPU, > 20 ms headroom on the page side.

### 7.4 Bundle

`core` +≈1.0 kB (look types/validate/stack); `render-shared` → ≈ 3.5 kB (compositor 2.0 + layerBox 0.5 + governor 0.5 + existing 0.6) and **added to `budgets.json` `displayCriticalPath.chunks`**; `display-shell` −≈1.0 (ModuleHost lifecycle leaves). Target **≤ 88.5 kB**, gate 90, `npm run size` decides. No dynamic-import fallback (that passes the gate while shipping the bytes). Escape hatch if over: the documented `VITE_PREACT=1` alias (design-architecture.md:209, ≈ −45 kB), or move video's eager `types.ts` tables out of `core`. New kinds: text ≤ 2 kB, shape ≤ 2 kB, effect ≤ 8 kB, each its own `module-*` chunk under 25 kB.

**Outcome (measured).** Adding `render-shared` to the counted chunks put the path
at **93.76 kB** — over the gate. Neither escape hatch was needed and the gate was
not touched. The fix was that the two chunking groups the LCD downloads claim by
PATH rather than by importer, so both carried code nothing on the first-paint
path imports:

- **`display-lazy`** (new group) — `src/app/display/sync.ts` and `replicaFeed.ts`.
  `mount.tsx` reaches `sync.ts` through `await import('./sync')` and only when a
  room is configured; they sat in `display-shell` because of where the files live.
  `display-shell` 5.82 → 2.98 kB.
- **`lazy-shared`** (new group) — `platform/{mediaStore,idb,capabilities}.ts`,
  `lib/{curation,chunkedTele,libraryPacket}.ts`, `config/knownHosts.ts`,
  `modules/replicaThumb.ts`. A static-import walk from `mount.tsx` reaches none of
  them; every importer is a lazy chunk (the module stores, `display/sync.ts`,
  the diagnostics probes, the config views). `core` 25.67 → 21.91 kB.
  `libraryPacket.ts` is in the list because it statically imports `mediaStore` and
  `chunkedTele` — excluding a leaf without its importer moves nothing.

Result **87.2 kB**, inside the ≤ 88.5 target with 2.8 kB of gate headroom. Nothing
was removed and nothing was re-labelled: if any of these files ever becomes a
static import of the display's boot path it belongs back in `core`/`display-shell`,
and the `displayGraph` (I8) walk plus the per-module chunk-isolation e2e keep the
split honest. Still eager on the path and still worth revisiting if it grows:
`src/modules/video/types.ts` (1.59 kB), `src/state/validate.ts` (1.58 kB),
`src/state/urlParams.ts` (1.05 kB), and the seven eager module manifests/schemas.

Diet round 2a, measured on a scratch build: `rolldown-runtime` (0.19 kB) is a static import of the display entry and is now counted in `displayCriticalPath.chunks`; `config/vocabulary.ts` (0.36 kB gzip) is config-only and its one display-path word was split into `config/words.ts`, but `core` claims `src/config/` by PATH so the bytes only leave when `vocabulary.ts` joins the `lazy-shared` group — **done in round 2b**, `vocabulary.ts` and `knownHosts.ts` now sit in `lazy-shared` (`core` 24.75 → 24.22 kB, `lazy-shared` 4.79 → 5.43 kB, path 90.4 → 89.8 kB, `displayGraph` clean); a shared five-colour swatch table across `text`/`icon`/`date` would save **5 bytes** gzip, because gzip already deduplicates three identical 246-byte literals inside one chunk; and the nine manifests' `editor.strip` blocks plus the option tables only they read are 0.77 kB gzip — the one cut on this path still worth making.

### 7.5 Enforcement and reporting

- **Measured**: per-layer `frame()` ms (EMA + 64-ring p95, closure state), `frameClock.stats()` (`achievedFps`, `longFrames`), `surfaces`. Published in the `monitor` tele packet every 2.5 s (§6.3); `DebugOverlay` prints one line per layer at 1 Hz; home "Frame budget" bar reads the tele mirror and draws only on a reported number; `?diag=1` report gains `layers[]`.
- **Governor** (`src/render/layerGovernor.ts`, pure, fake-clock tested; hysteresis from `createPerfPromoter`: 0.6×target sustained 10 s; `targetFps ≤ 10` immediate):
  - G1: a layer's p95 > 4 ms for 10 s → that layer `reduced` (phase-staggered: `(frame + index) % 4 === 0`) + `renderer.budget?.('reduced')`.
  - G2: `achievedFps < 0.6·target` for 10 s with ≥ 2 `cadence:'frame'` ON layers → every `frame` layer **except index 0** → `hz1` (staggered by `index × 250 ms`).
  - G3: still under 10 s later → every `gl` layer `reduced`.
  - Recovery: `achievedFps ≥ 0.9·target` for 30 s → step back one level.
  - Never removes, hides, or unmounts a layer; reason rides tele as `gov`, the config page says "this look is too rich for N fps — the costliest layer is X".
- **Static** (`normalizeLook`, at point of use; `addLayer` refuses with a typed reason): roles, `maxInstances` (video 1 → Σ decoders ≤ 1; effect 2 → Σ gl ≤ 2), `MAX_LAYERS`, `MAX_LOOK_BYTES`.
- **What the governor cannot see**: CAM's capture/compressor. W0's job is to find out whether compressor overload shows up as reduced page rAF (`achievedFps`) or not. If yes, G2/G3 cover it; if no, the declared cost (§7.2) is the only capture-side lever and the spec says so in the UI copy ("estimated").

---

## 8. Editor model boundary (`src/app/config/editor/`, config-ui chunk; pure, DOM-free, unit-tested)

The UI (halo handles, phone ring, chips) may only call these. Registry injected where needed.

```ts
// ops.ts — (look, …) → Result<Look>; every op runs validateLook and lookBytes on the way out
type OpResult = { ok: true; look: Look; id?: LayerId } | { ok: false; reason: 'max-layers'|'max-instances'|'role'|'too-big'|'unknown-kind' };
addLayer(look, kind, o?: { frame?; t?; cfg?; name? }): OpResult     // seeds from placementOf(mod).overlayDefault + modules bank cfg (or defaults); id = 'l' + randomId(7)
setBase(look, kind): Look                                            // replaces layers[0] (cfg-less), overlays kept
removeLayer / toggleLayer(id, on) / renameLayer(id, name) / duplicateLayer(id)
reorder(look, id, toIndex ≥ 1): Look                                 // 'bringForward'/'sendBackward' = ±1; base never moves
setTransform(look, id, patch: Partial<Transform>): Look              // clamped
setFrame(look, id, frame): Look                                      // clamped to minFrame
setConfig(look, id, v, cfg): OpResult                                // too-big refusal
resize(look, id, factor, g): Look                                    // resize:'frame' → setFrame(frame×factor); 'scale' → setTransform({s})
// gesture.ts — one gesture = one history entry, N previews, ≤ 5 Hz commits
beginGesture(layer, handle: 'move'|'scale-nw'|…|'rotate', p0: Units): GestureState
applyGesture(gs, p: Units, mods: { snap: boolean }): Transform       // move Δ; scale uniform by distance from centre; rotate Δangle
endGesture(gs, look, g): Look                                        // maps transient s → frame for resize:'frame' kinds
// hitTest via layerBox.hitTest; screen ↔ units through the surface's scale (halo: frame.width / panel.w; ring: RING_PX / display.w)
// snap.ts — all targets in units, so a 640 Elite and a 240 square snap identically
snap(t: Transform, layer, look, g, render): { t; guides: Guide[] }
//  centre lines x=0,y=0; polar 12 clock angles when |c| > 0.3; rings r ∈ {0, 0.5, safeRadiusPct}; tangent: farthest corner onto the safe circle;
//  rotation 0/±45/±90/180 and tangent (atan2(y,x)+90°); square panels: edges + thirds; other layers' centres and frame edges; threshold 0.03 u
// bounds.ts
outsideSafeCircle(layer, g, render): boolean      // isInsideSafeCircle over the corners → "may be cut by the bezel"
// history.ts — one stack per editing surface, never synced, never persisted
createLookHistory(store, { limit: 50 }): { push(look); undo(); redo(); canUndo(); canRedo() }
//  push on discrete ops and on gesture END; undo() = store.commit(s => withLook(s, prev)); a store commit whose origin is 'sync'/'storage' with a
//  different look is pushed as an entry and clears redo (undo of somebody else's edit is just LWW). ⌘Z/⇧⌘Z on home.
```
Selection, hover, drag draft, guides: React state in the editing window only.

### 8.1 Home screen (from B; the tested budgets hold)

The chip row **is** the stack: `[base][overlay]…[+]`, ≤ 8 + add, wraps to ≤ 2 rows; the active/selected chip is the door; the ops strip shows the **selected layer's** ≤ 3 quick ops (`On`, `Place`, `Options`) — `Place` takes the floor from the halo via the existing floor-yield mechanism and shows handles over the mirror iframe; options = `ModuleSettingsView` per layer through `withLayerConfig`; the budget bar appears only on a reported frame rate; `pasteAction`/`showTile`/library tiles → `setBase` + bank cfg. `home-composition.spec.ts` gains stack states (`[video]`, `[video,stats]`, `[effect,stats,clock,text]`, eight layers) asserting `overflow === 0` at 866×537 closed, options open, `Place` open; `tap-targets.spec.ts` covers chips + handles (≥ 44 px).

---

## 9. Build waves (dependency-ordered; one executor each; acceptance = tests green + listed assertions)

### W0 — Spike and instrument (throwaway compositor; 2 d; no schema change)
**Files**: `src/diag/patterns/stack.ts` (`?diag=1&pattern=stack&stack=a|b|c|d|e`), throwaway `src/render/compositor.spike.ts`, `DebugOverlay.tsx` per-layer lines, `docs/hardware-checklist.md` rows H24–H28.
**Stacks**: (a) video + stats strip, (b) video + stats + clock + text, (c) plasma base + stats, (d) plasma + 4 overlays at `a:0.8`, (e) 8 layers. Each draws the H09 large rAF counter on top so the maintainer can film the LCD at 60 fps and count distinct values (capture-side FPS, manual).
**Acceptance**: sim run records per-layer p95/`achievedFps`/`longFrames` for all five; the checklist rows exist with the explicit question **"does compressor load reduce page `achievedFps`?"** (H28) and a space for the answer; verified in Chromium that a `<canvas webgl2>` moved by `insertBefore` keeps its context (unit dom test) and an `<iframe>` does not (documented as the reason the base never moves).

### W1 — Model + state (3 d) — depends: nothing
**Files**: `src/state/look/{types,validate,selectors}.ts`, `schema.ts` (v7, `SCHEMA_HISTORY`), `migrations.ts` 6→7 + `__fixtures__/state-v6.json`, `validate.ts` (`validateLook`), `defaults.ts`, `selectors.ts`, `urlParams.ts` (`?module=` → `baseLook`), `sync/types.ts` (`SyncStateBody`), `appSync.ts` (`stateToSyncBody`/`syncBodyToPatch`), `SyncService.ts` trim order, all `activeModuleId` sites → selectors (compile-only; UI behaviour unchanged).
**Acceptance**: `npm run typecheck && npm test`; `state-v6.json` → asserted v7 deep-equal; `validate(migrate(x))` idempotent on junk, on 9 layers, on a base with `cfg`, on an overlay with `frame:'panel'`; `SCHEMA_HISTORY` complete; wire-budget test (§6.2) passes; `syncBodyToPatch({activeModuleId:'clock'})` ≡ `baseLook('clock')`; grep test: no `zIndex|zOrder|z-index` under `src/state`, `src/render`, `src/modules/**/*.ts`; e2e `state-precedence`, `storage-sync`, `sync-remote` unchanged and green.

### W2 — Contract + registry (2 d) — depends: W1
**Files**: `modules/types.ts` (§1.4), `defineModule.ts` DEV asserts (`layer.roles` non-empty, `cost()` pure & < 1 kB, `overlayDefault` inside `[-1.5,1.5]`), `modules/stack.ts`, `modules/layerKinds.ts`, four manifests + `_template` annotated, stats `layout:'strip'` face (bottom scrim, `tabular-nums`), `replicaThumb.ts` keyed, `docs/modules.md` §7 + Placement step.
**Acceptance** (`registry.test.ts` extended): every registered module has `layer`; `cost(defaults, {frame:'panel',t:IDENTITY})` valid; `motionLevel` ↔ `cadence` agree; **two-instance test**: for every `roles ⊇ 'overlay'` kind mount two renderers into two jsdom hosts with different `ctx.layer.id`, call `update`/`frame`/`monitoring` on one, assert the other's DOM is unchanged and `currentReplicaThumbs()` has ≤ 1 entry per id; `normalizeLook` table: unknown kind skipped, video at index 2 → off + note, third effect → off + note, reference-stable on no-op; `lookCost` worked examples (video base = 1.0; video + stats strip ≈ 1.01; plasma + stats ≈ 0.61; `a:0.5` overlay over video adds 0.1).

### W3 — Compositor + display (4 d) — depends: W1, W2
**Files**: `src/render/{layerBox,compositor,layerGovernor}.ts`, `src/app/display/LayerHost.tsx` (deletes `ModuleHost.tsx`), `DisplayApp.tsx`, `display.css` (`.kh-layer`), `display/sync.ts` (command routing, readout `module` = base kind), `replicaFeed.ts` (§6.3), `mount.tsx` (preview listener, mirror-only), `platform/env.ts` (`inConfigMirror`), `DebugOverlay.tsx`, `budgets.json` (+`render-shared`), `vite.config.ts` unchanged.
**Acceptance**: `LayerHost.fastPath.dom.test.tsx` — for every kind × `DEVICE_PRESETS`, a one-layer look yields a host whose `outerHTML` attributes/style equal today's `ModuleHost` snapshot (`.kh-stage__module[data-module]`, `inset:0`, no `transform`, no `--kh-*`) and `ctx.geometry() === runtime.geometry.get()` by identity; `layerBox.test.ts` worked examples (0.6×0.6 square at x=0.5 on 640 → `192×192` at left `384−96`; circle frame `safeInsetPx` = `circleSafeInsetPx(192, 0.88)`); compositor dom test: reorder overlays → no `unmount` calls, `t` change → exactly one style mutation and zero renderer calls, `frame` change → one `geometry()` call, off → `unmount`; governor fake-clock test: G1 trips at 10 s not 9.9, staggered phases never coincide for 4 reduced layers, recovery at 30 s, never emits `off`; e2e `modules.spec.ts` gains a `box` column — every overlay-capable kind boots as a 0.5 u overlay over the flat pattern at every preset and `assertInsidePanel`; chunk isolation unchanged; `npm run size` ≤ 90 with `render-shared` counted; `?debug=1` shows one line per layer; `sync-remote`/`video`/`youtube` e2e green.

### W4 — Editor model (pure; 3 d) — depends: W1, W2 (∥ W3)
**Files**: `src/app/config/editor/{ops,gesture,snap,bounds,history}.ts` + tests.
**Acceptance**: ops refuse with typed reasons (9th layer, 2nd video, 3rd effect, 3.1 kB look, video at index 1); `resize` maps by kind; `snap` worked examples in units (a 0.4 u box at (0.49, 0.01) snaps to (0.5, 0) and reports a `ring` guide; a 200 px clock on 640 and the same on 240 produce identical unit output); `hitTest` picks top-most, respects rotation, never returns the base; history: 51 pushes keep 50, gesture = 1 entry, remote entry clears redo; `endGesture` on a `resize:'frame'` kind leaves `t.s === 1`.

### W5 — Home editor UI (5 d) — depends: W3, W4
**Files**: `HomeView.tsx` (chips = stack, per-layer ops strip, `Place`), `HaloEditor.tsx` (handles over the mirror, preview `postMessage`, 5 Hz commits), `ModuleSettingsView.tsx` per layer, `pasteLink.ts`/`showTile.ts`/`LibraryView.tsx` → `setBase`, `config/vocabulary.ts` (Layer/Look/Effect; never "element/shader/z-index"), `ui.css`.
**Acceptance**: `home-composition.spec.ts` stack states (§8.1) `overflow === 0`; `tap-targets.spec.ts` chips + handles ≥ 44 px; `vocabulary.test.ts` grep passes; e2e: add stats overlay from `+` → chip appears, LCD iframe shows `.kh-layer[data-kind=stats][data-role=overlay]`; drag in `Place` → iframe receives `kh:preview` messages and the top-level display test page (no frame) never does; ⌘Z restores; a paste sets the base and keeps overlays; `ux-round*` suites green.

### W6 — Phone (3 d) — depends: W3, W4
**Files**: `replica.ts` → `startReplicaStack`, `RemoteRing.tsx` (`look` prop, per-layer `data-mode` via `usesMedia`), `RemoteView.tsx` (base picker + overlay switches + ring gestures through `editor/*`, 200 ms trailing commits), `useSync.ts` (`fps`/`lyr`/`gov`, thumbs by layer).
**Acceptance**: `replica.test.ts`: a look `[video, stats, clock]` mounts one still + two real renderers positioned by the same `hostStyle()` as the display (assert equal strings); no `display` report → card; hidden tab → zero ticks; `RemoteRing` no longer contains the string `'clock' ||`; e2e `sync-remote`: toggling an overlay on the phone changes the display within one publish window; ring drag → ≤ 5 state frames/s; old-body compatibility test (body without `look`).

### W7 — New kinds (5 d; splittable W7a text+shape / W7b effect) — depends: W2 (W3 for e2e)
**Files**: `src/modules/{text,shape,effect}/*`, `registry.ts` (+3 lines), `vite.config.ts` (+3 groups), `tests/e2e/modules.spec.ts` (+3 rows), `budgets.json` per-module gates.
**Specs**: text `{text ≤ 120, size (u), weight, color, outline:{color,px}, align}`, DOM, `-webkit-text-stroke` + `paint-order: stroke fill`, `ch`-width box so ticking digits never reflow, `naturalSize` via one `measureText` per update; shape `{shape:'rect'|'ring'|'line', fill, stroke, radius}` inline SVG; effect `{effect:'plasma'|'nebula'|'satin'|'rings'|'triad', preset|colors[4], reactsToTemp, detail}`, WebGL2 fullscreen quad, uniforms `uTime uResolution uColor0..3 uTemp uDetail`, `antialias:false`, `powerPreference:'low-power'`, `preserveDrawingBuffer:false`, draws only when `f.t − last ≥ 1000/min(targetFps, preset.maxFps)`, `uTime` steps by whole seconds at 1 fps, `budget('reduced')` → half-res canvas + `uDetail=0`, `webglcontextlost` → `reinit`, no WebGL2 → two-colour DOM gradient still + telemetry note; the word "shader" never in a user string.
**Acceptance**: each chunk ≤ budget (text/shape ≤ 2 kB, effect ≤ 8 kB); conformance suite passes for all three (two-instance test included); e2e rows at every preset (base and box); effect at `targetFps=1` draws once per second (dom test with fake clock).

### W8 — Looks and files (3 d) — depends: W1, W4, W5 (W6 for phone ops)
**Files** (as shipped, not as planned): `src/state/look/{file,templates}.ts`, `src/app/config/editor/looksStore.ts` (the shelf, in the namespaced `kraken-hub:v1:looks` key, capped at 50), `src/app/config/editor/looksMenu.ts`, `src/app/config/views/editor/looks/**` (the sheet, the live previews, the gallery, the carousel), `public/looks/**` (ten template `.krakenlook` files + `index.json`). No idb store and no `CmdOp`s were added — see the **Outcome (as shipped)** note at the end of §5.
**Acceptance**: `lookFile.test.ts` round-trip modulo ids and media refs; unknown kind preserved with warning; `v:2` refused without loss; missing clip → `on:false` + warning; `idb.persist.test.ts` upgrade 4→5 keeps media; ≤ 20 looks enforced; `tele 'looks'` index ≤ 7000 B or chunked; apply = one history entry; templates apply on every preset (e2e).

---

## 10. Enumeration and invariant tests that ship (summary table)

| wave | test | asserts |
|---|---|---|
| W1 | `state/look/validate.test.ts` | total, idempotent, positional rules, byte note (never drop), MAX_LAYERS tail note |
| W1 | `migrations.test.ts` + fixture | v6→v7 deep-equal, deterministic (run twice, `deepEqual`), `SCHEMA_HISTORY` complete |
| W1 | `sync/lookWireBudget.test.ts` | worst legal doc ≤ 8192 after trim step 1; step 2 never touches `layers` |
| W1 | `scripts/check-invariants.mjs` new rule | no `zIndex`/`z-index` literal under `src/modules/**`, `src/render/**`, `src/state/**`; only `editor/history.ts` exports `undo` |
| W2 | `registry.test.ts` | `layer` present/valid on every module; two-instance no-cross-talk; `motionLevel`↔`cadence` |
| W2 | `modules/stack.test.ts` | normalize table, `lookCost` worked examples, reference stability |
| W3 | `LayerHost.fastPath.dom.test.tsx` | one-layer DOM byte-identical per kind × preset; geometry identity |
| W3 | `render/layerBox.test.ts` | worked examples; grep: only `compositor.ts`, `replica.ts`, `editor/*` import it |
| W3 | `render/compositor.dom.test.ts`, `layerGovernor.test.ts` | reconcile actions per change class; tiers/phases/hysteresis/never-off |
| W3 | `tests/e2e/modules.spec.ts` `box` column | every overlay kind at every preset inside the panel; chunk isolation |
| W4 | `editor/*.test.ts` | ops refusals, snap in units across presets, hitTest, history semantics |
| W5 | `home-composition`, `tap-targets`, `vocabulary.test.ts` | stack states fit 866×537; 44 px; word budget |
| W6 | `replica.test.ts`, `sync-remote.spec.ts` | same `hostStyle` string on both surfaces; still-vs-render by `usesMedia`; ≤ 5 Hz |
| W7 | conformance + e2e rows | budgets, two instances, 1 fps behaviour |
| W8 | `state/look/file.test.ts`, `state/look/templates.test.ts`, `config/editor/looksStore.test.ts` (+ `.dom`), `config/views/editor/looks/*.test.ts` | round-trip, refusal without loss, upgrade safety; saved Looks live in namespaced `localStorage`, so there is no IndexedDB persistence test |

---

## 11. Risks and decisions taken

1. **Capture-side FPS is unmeasurable from the page** (C was right). W0/H28 decides whether the governor can see compressor overload at all. Mitigation shipped regardless: declared cost labelled *estimate*, tier-1 shaders chosen for low entropy, stats strip on an opaque scrim, no full-surface fades ever.
2. **Bundle**: ≈ 88.5 of 90 kB with `render-shared` counted honestly. If W3 lands over: `VITE_PREACT=1` or evict video's eager tables from `core`. The gate is `npm run size`, not this estimate.
3. **Base never moves** (video `roles:['base']`, `max 1`) — removes the `insertBefore`-on-`<video>`/`<iframe>` gamble, the second decoder, and the telemetry-singleton corruption in one rule. Cost: no picture-in-picture video in v1. Accepted.
4. **Scale vs crispness**: CSS scale during gestures, frame re-layout on settle for layout kinds. Text stays crisp; drags stay one write.
5. **Two config homes** resolved positionally: base wears the bank, overlays carry cfg; validator strips/keeps by index so the invariant is structural, not procedural.
6. **Wire skew** for one release via the derived `activeModuleId` + `baseLook()` projection — dumb and reversible; delete at schema 8.
7. **Governor staggering** prevents the manufactured spike judge 1 named; G2 spares the base so the panel never slows the thing the user chose.
8. **Byte cap** is a refusal at op time with a typed reason; the validator only notes; the wire never truncates `layers`.
9. **Undo across peers** is LWW by design; a remote change becomes a history entry rather than being fought.
10. **Home-screen budgets** (`scrollHeight ≤ clientHeight` at 866×537, floor holds one object) are carried as tests in W5, not as prose.

---

### Critical Files for Implementation
- /Users/ubberkid/kraken-hub/src/app/display/ModuleHost.tsx (becomes `LayerHost.tsx`; its lifecycle moves into the compositor)
- /Users/ubberkid/kraken-hub/src/modules/types.ts (additive `LayerPlacement`, `LayerCost`, `ctx.layer`, `budget?()`)
- /Users/ubberkid/kraken-hub/src/state/validate.ts (`validateLook`, positional base rules; stays module-agnostic)
- /Users/ubberkid/kraken-hub/src/platform/geometry.ts (`deriveGeometry` reuse per layer; `applyGeometryToDom` vars republished per host)
- /Users/ubberkid/kraken-hub/src/app/config/replica.ts (becomes `startReplicaStack` over the same compositor and `layerBox` math)