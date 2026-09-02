/**
 * The compositor: one `Look` on one display, as DOM.
 *
 * Framework-free on purpose. The display is a React *shell* around an
 * imperative renderer (invariant I4, design-architecture.md §2.1) and this is
 * the imperative half: nothing here imports React, nothing here schedules a
 * render, and every per-frame number lives in closure state that React merely
 * *reads* once a second. It also has to stay out of `display-shell` for
 * invariant I8's byte budget, which a `.tsx` file could not.
 *
 * ## The substrate (§2.1, §2.2)
 *
 * One absolutely-positioned host `div` per ON layer under `.kh-stage`, and
 * **DOM order IS z-order** — bottom layer first, Chromium composites. There is
 * no `z-index` anywhere and `scripts/check-invariants.mjs` keeps it that way: a
 * look has exactly one stacking order and it is the array.
 *
 * Not a single canvas (a `<video>` would need a decode→draw copy every frame
 * and a cross-origin YouTube `<iframe>` cannot be sampled at all), not a WebGL
 * scene (text as textures, +15 kB). A layer whose renderer did not touch the DOM
 * this tick costs zero raster and zero upload, which is what makes a static text
 * overlay genuinely free.
 *
 * ## The base host never moves
 *
 * `layers[0]`'s host `div` is created once, in the constructor, and is always
 * `root.firstChild`. It is never detached, never re-created, and survives a base
 * *kind* change (the renderer is swapped inside it). `compositor.spike.dom.test`
 * measured why: re-inserting an `<iframe>` discards its `contentWindow` and
 * re-navigates — a YouTube embed would reload and lose its position — while a
 * `<canvas>` keeps its WebGL context across `insertBefore`. So overlays reorder
 * freely and the base does not move, which is the same rule that makes `video`
 * `roles: ['base'], maxInstances: 1`.
 *
 * ## Where the rules live
 *
 * Placement rules (roles, `maxInstances`, decoder/GL caps) are NOT decided here.
 * `normalizeLook()` in `src/modules/stack.ts` is the only site that runs them,
 * and this file mounts whatever plan comes back and surfaces its notes. Geometry
 * is likewise not decided here: `hostStyle()`/`layerGeometry()` in
 * `src/render/layerBox.ts` are shared verbatim with the editor and the phone
 * replica, which is what makes "the halo and the LCD agree" a fact.
 *
 * See docs/design/design-layers-architecture.md §2 and §7.5.
 */

import { diffPaths } from '../lib/diff';
import { createLogger, type Logger } from '../lib/log';
import { normalizeLook, placementOf, type GetModule, type StackNote } from '../modules/stack';

import { hostStyle, layerGeometry } from './layerBox';

import type { Tier } from './layerGovernor';
import type { DisplayRenderer, ModuleContext, ReinitReason } from '../modules/types';
import type { FrameClock, FrameInfo } from '../platform/fpsGovernor';
import type { Geometry } from '../platform/geometry';
import type { MonitoringSource, NormalizedMonitoring } from '../platform/monitoring';
import type { Layer, LayerId, Look } from '../state/look/types';
import type { ModuleId, RenderSettings } from '../state/schema';

/**
 * The validated config for every layer in the look, by layer id.
 *
 * Resolved by the CALLER, because the two homes a config can have are a state
 * question, not a compositor one: the base wears `state.modules[kind].cfg` (the
 * per-kind bank, plus any URL params), an overlay carries its own `cfg`.
 * `configsOf()` in `src/render/lookOf.ts` is the display's implementation.
 */
export type LayerConfigs = Readonly<Record<LayerId, unknown>>;

export interface LayerHostOptions {
  /** Injected, never imported: the replica and the tests hand in their own. */
  registry: GetModule;
  panel: Geometry;
  clock: FrameClock;
  render: () => RenderSettings;
  /** Passed through as `ctx.monitoring`. Fan-out is separate — see `setMonitoring`. */
  monitoring?: MonitoringSource;
  log?: (scope: string) => Logger;
}

export interface LayerStat {
  id: LayerId;
  kind: ModuleId;
  role: 'base' | 'overlay';
  /** Array index = z-order, bottom first. */
  index: number;
  tier: Tier;
  emaMs: number;
  p95Ms: number;
  maxMs: number;
  samples: number;
  /** False when the renderer has no `frame()` — its per-tick cost is zero. */
  ticks: boolean;
}

export interface LayerFailure {
  id: LayerId;
  kind: ModuleId;
  title: string;
  detail: string;
}

export interface LayerHostStats {
  tier: Tier;
  layers: LayerStat[];
  /** Layers forcing their own offscreen compositor surface (`t.a < 1`). */
  surfaces: number;
  notes: readonly StackNote[];
}

export interface LayerHostStatus {
  /** Every planned layer has a live renderer. */
  ready: boolean;
  failures: LayerFailure[];
  notes: readonly StackNote[];
}

/** 64 samples at 40 fps ≈ the last 1.6 s: long enough for a p95, short enough to react. */
const RING = 64;
const EMA_ALPHA = 0.1;
const P95 = 0.95;
/** Same three-strike rule the single-module host used before looks existed. */
const MAX_CONSECUTIVE_THROWS = 3;
/** `reduced` ticks every 4th frame; the phase is the layer's index, so they never coincide. */
const REDUCED_EVERY = 4;
const HZ1_INTERVAL_MS = 1000;
/** `hz1` layers are spread across the second rather than all firing on the same tick. */
const HZ1_STAGGER_MS = 250;

interface Entry {
  id: LayerId;
  kind: ModuleId;
  role: 'base' | 'overlay';
  index: number;
  layer: Layer;
  host: HTMLDivElement;
  renderer: DisplayRenderer<unknown> | null;
  abort: AbortController;
  offs: (() => void)[];
  /** The style properties currently written on the host, so a change writes only the delta. */
  style: Record<string, string>;
  /** Latest config handed in; `applied` is what the renderer has actually seen. */
  pending: unknown;
  applied: unknown;
  mounted: boolean;
  disposed: boolean;
  dead: boolean;
  throws: number;
  tier: Tier;
  nextAt: number;
  ring: Float64Array;
  ringAt: number;
  ringLen: number;
  ema: number;
  max: number;
  samples: number;
}

function p95Of(entry: Entry): number {
  if (entry.ringLen === 0) return 0;
  const vals = Array.from(entry.ring.slice(0, entry.ringLen)).sort((a, b) => a - b);
  return vals[Math.min(vals.length - 1, Math.floor(vals.length * P95))] ?? 0;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}

export class LayerHost {
  private readonly root: HTMLElement;
  private readonly registry: GetModule;
  private readonly clock: FrameClock;
  private readonly renderOf: () => RenderSettings;
  private readonly monitoringSource: MonitoringSource | undefined;
  private readonly makeLog: (scope: string) => Logger;
  private readonly log: Logger;

  /**
   * Created once and never detached (see the header). It is `root.firstChild`
   * for the life of the host, so every overlay insert is "after the base".
   */
  private readonly baseHost: HTMLDivElement;

  private panel: Geometry;
  private entries = new Map<LayerId, Entry>();
  /** Plan order, bottom first — the array the frame loop and the DOM both follow. */
  private order: Entry[] = [];
  private failures = new Map<LayerId, LayerFailure>();
  private notes: readonly StackNote[] = [];
  private look: Look | null = null;
  private cfgs: LayerConfigs | null = null;
  private stackTier: Tier = 'full';
  private disposed = false;
  private emitQueued = false;
  private readonly offClock: () => void;
  private readonly listeners = new Set<() => void>();

  constructor(root: HTMLElement, opts: LayerHostOptions) {
    this.root = root;
    this.registry = opts.registry;
    this.clock = opts.clock;
    this.renderOf = opts.render;
    this.monitoringSource = opts.monitoring;
    this.makeLog = opts.log ?? createLogger;
    this.log = this.makeLog('render/layers');
    this.panel = opts.panel;

    this.baseHost = document.createElement('div');
    this.baseHost.className = 'kh-layer kh-stage__module';
    this.baseHost.dataset['layer'] = 'base';
    this.baseHost.dataset['role'] = 'base';
    this.root.append(this.baseHost);

    this.offClock = this.clock.subscribe((f) => {
      this.tick(f);
    });
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  /**
   * Reconcile the DOM to `look`. Idempotent, and a no-op when both arguments are
   * reference-identical to the last call — which is the common case, because
   * `normalizeLook` hands back the ORIGINAL array when nothing is wrong and the
   * store hands back the original state when nothing changed.
   */
  setLook(look: Look, cfgs: LayerConfigs): void {
    if (this.disposed) return;
    if (look === this.look && cfgs === this.cfgs) return;
    this.look = look;
    this.cfgs = cfgs;

    const plan = normalizeLook(look, this.registry, (l) => cfgs[l.id]);
    this.notes = plan.notes;

    const wanted = plan.layers.filter((l) => l.on);
    const keep = new Set<LayerId>();
    const next: Entry[] = [];

    wanted.forEach((layer, index) => {
      keep.add(layer.id);
      let entry = this.entries.get(layer.id);
      if (entry !== undefined && entry.kind !== layer.kind) {
        // A kind change on the same id is a remove plus an add (§2.6): the old
        // renderer knows nothing about the new config's shape.
        this.dropEntry(entry);
        this.entries.delete(layer.id);
        entry = undefined;
      }
      if (entry === undefined) {
        entry = this.createEntry(layer, index, cfgs[layer.id]);
        this.entries.set(layer.id, entry);
        void this.mountEntry(entry);
      } else {
        this.updateEntry(entry, layer, index, cfgs[layer.id]);
      }
      next.push(entry);
    });

    for (const [id, entry] of [...this.entries]) {
      if (keep.has(id)) continue;
      this.dropEntry(entry);
      this.entries.delete(id);
    }

    this.order = next;
    this.reorderDom();
    this.emit();
  }

  /** The panel resized, or its safe area changed: republish every host's box. */
  setPanel(panel: Geometry): void {
    if (this.disposed || panel === this.panel) return;
    this.panel = panel;
    for (const entry of this.order) {
      this.applyStyle(entry);
      this.call(entry, 'geometry', (r) => {
        r.geometry?.(this.geometryOf(entry.layer));
      });
    }
  }

  /** The 1 Hz CAM feed, fanned out to every mounted renderer that wants it. */
  setMonitoring(n: NormalizedMonitoring, raw: NzxtV1.MonitoringData): void {
    for (const entry of this.order) {
      this.call(entry, 'monitoring', (r) => {
        r.monitoring?.(n, raw);
      });
    }
  }

  /**
   * Move the whole stack to a governor tier. Never hides a layer — it changes
   * how often `frame()` is called and tells each renderer to get coarser.
   *
   * The base is spared the bottom tier (§7.5 G2): whatever else the panel does,
   * the thing the user actually chose keeps its cadence.
   */
  setTier(tier: Tier): void {
    if (this.disposed || tier === this.stackTier) return;
    this.stackTier = tier;
    for (const entry of this.order) this.retier(entry);
  }

  /** Soft recovery, fanned out. Renderers must make this idempotent. */
  reinit(reason: ReinitReason): void {
    for (const entry of this.order) {
      this.call(entry, 'reinit', (r) => {
        r.reinit?.(reason);
      });
    }
  }

  /**
   * An imperative `cmd`. Routed to `layerId` when given, else to the base.
   *
   * The return value is a DELIVERY REPORT, and callers who care about arrival —
   * `display/sync.ts` and its retained position — depend on it: `false` means
   * the command reached no live renderer, because the layer is still loading its
   * chunk, is not in the look, or is a kind with no `command()` at all.
   *
   * Nothing is queued here, and that is deliberate rather than lazy. The
   * single-module host this replaced registered `runtime.onCommand` only *after*
   * `await renderer.mount(...)`, so "there is a handler" meant "there is a
   * renderer that can act", and a caller with something time-sensitive to say
   * waited and re-derived it. A queue flushed at mount would deliver a position
   * anchored to an older instant, at the one moment a media element is least
   * able to honour it — measured: a `seekTo` delivered in the same turn as the
   * video module's mount is undone by its own loop machine, whose first
   * predictive tick still carries the boot hitch's `dt`. So the compositor
   * reports, and `sync.ts` re-anchors and asks again.
   */
  command(op: string, arg?: unknown, layerId?: LayerId): boolean {
    const entry =
      layerId === undefined ? this.order.find((e) => e.role === 'base') : this.entries.get(layerId);
    if (entry === undefined || !entry.mounted || entry.dead) return false;
    if (entry.renderer?.command === undefined) return false;
    this.call(entry, 'command', (r) => {
      r.command?.(op, arg);
    });
    return true;
  }

  visibility(v: 'hidden' | 'visible'): void {
    for (const entry of this.order) {
      this.call(entry, 'visibility', (r) => {
        r.visibility?.(v);
      });
    }
  }

  status(): LayerHostStatus {
    return {
      ready: this.order.length > 0 && this.order.every((e) => e.mounted || e.dead),
      failures: [...this.failures.values()],
      notes: this.notes,
    };
  }

  stats(): LayerHostStats {
    return {
      tier: this.stackTier,
      surfaces: this.order.filter((e) => e.layer.t.a < 1).length,
      notes: this.notes,
      layers: this.order.map((e) => ({
        id: e.id,
        kind: e.kind,
        role: e.role,
        index: e.index,
        tier: e.tier,
        emaMs: e.ema,
        p95Ms: p95Of(e),
        maxMs: e.max,
        samples: e.samples,
        ticks: e.renderer?.frame !== undefined,
      })),
    };
  }

  /** Status changes only, for `useSyncExternalStore`. Never called per frame. */
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offClock();
    for (const entry of this.entries.values()) this.dropEntry(entry);
    this.entries.clear();
    this.order = [];
    this.baseHost.remove();
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------
  // The frame loop: ONE subscription, fanned out in array order (§2.5)
  // -------------------------------------------------------------------------

  /**
   * Public so a surface whose clock never fires on its own — the phone replica's
   * 1 Hz timer — can drive the same code path the LCD does.
   */
  tick(f: FrameInfo): void {
    for (const entry of this.order) {
      const renderer = entry.renderer;
      if (entry.dead || renderer?.frame === undefined) continue;
      if (!this.due(entry, f)) continue;
      const t0 = performance.now();
      try {
        renderer.frame(f);
        entry.throws = 0;
      } catch (err) {
        entry.throws += 1;
        if (entry.throws >= MAX_CONSECUTIVE_THROWS) {
          entry.dead = true;
          this.fail(entry, 'Module error', messageOf(err));
        }
      }
      this.sample(entry, performance.now() - t0);
    }
  }

  private due(entry: Entry, f: FrameInfo): boolean {
    if (entry.tier === 'full') return true;
    if (entry.tier === 'reduced') return (f.frame + entry.index) % REDUCED_EVERY === 0;
    if (entry.nextAt === 0) entry.nextAt = f.t + entry.index * HZ1_STAGGER_MS;
    if (f.t < entry.nextAt) return false;
    entry.nextAt = f.t + HZ1_INTERVAL_MS;
    return true;
  }

  private sample(entry: Entry, ms: number): void {
    entry.ema = entry.ema === 0 ? ms : entry.ema + EMA_ALPHA * (ms - entry.ema);
    entry.ring[entry.ringAt] = ms;
    entry.ringAt = (entry.ringAt + 1) % RING;
    entry.ringLen = Math.min(entry.ringLen + 1, RING);
    entry.samples += 1;
    if (ms > entry.max) entry.max = ms;
  }

  // -------------------------------------------------------------------------
  // Reconcile
  // -------------------------------------------------------------------------

  private createEntry(layer: Layer, index: number, cfg: unknown): Entry {
    const role: 'base' | 'overlay' = layer.frame === 'panel' ? 'base' : 'overlay';
    const host = role === 'base' ? this.baseHost : document.createElement('div');
    // The base keeps `.kh-stage__module` — its `inset: 0` is where the whole
    // single-module DOM shape comes from, and the e2e suite reads it.
    host.className = role === 'base' ? 'kh-layer kh-stage__module' : 'kh-layer';
    host.dataset['layer'] = layer.id;
    host.dataset['kind'] = layer.kind;
    host.dataset['role'] = role;
    if (role === 'base') {
      // `data-module` is the selector the display's e2e suite has always used
      // for "what is on the panel". Only the base carries it, so it stays
      // singular no matter how many overlays a look has.
      host.dataset['module'] = layer.kind;
    }

    const entry: Entry = {
      id: layer.id,
      kind: layer.kind,
      role,
      index,
      layer,
      host,
      renderer: null,
      abort: new AbortController(),
      offs: [],
      style: {},
      pending: cfg,
      applied: undefined,
      mounted: false,
      disposed: false,
      dead: false,
      throws: 0,
      tier: this.tierFor(role),
      nextAt: 0,
      ring: new Float64Array(RING),
      ringAt: 0,
      ringLen: 0,
      ema: 0,
      max: 0,
      samples: 0,
    };
    this.applyStyle(entry);
    if (role === 'overlay') this.root.append(host);
    return entry;
  }

  private updateEntry(entry: Entry, layer: Layer, index: number, cfg: unknown): void {
    const prev = entry.layer;
    entry.layer = layer;
    if (entry.index !== index) {
      entry.index = index;
      entry.nextAt = 0;
    }

    if (prev !== layer) {
      const framed = !sameFrame(prev.frame, layer.frame);
      this.applyStyle(entry);
      if (framed) {
        // Frame changes are gesture-END only, so one re-layout is the whole cost.
        this.call(entry, 'geometry', (r) => {
          r.geometry?.(this.geometryOf(layer));
        });
      }
    }

    entry.pending = cfg;
    if (!entry.mounted || entry.dead) return;
    const changed = diffPaths(entry.applied, cfg);
    if (changed.length === 0) return;
    entry.applied = cfg;
    this.call(entry, 'update', (r) => {
      r.update(cfg, { changed, origin: 'local' });
    });
  }

  private dropEntry(entry: Entry): void {
    entry.disposed = true;
    entry.abort.abort();
    for (const off of entry.offs) off();
    entry.offs = [];
    try {
      entry.renderer?.unmount();
    } catch (err) {
      this.log.error(`layer ${entry.id} (${entry.kind}) threw in unmount`, err);
    }
    entry.renderer = null;
    entry.mounted = false;
    entry.host.replaceChildren();
    this.failures.delete(entry.id);
    if (entry.role === 'base') {
      // The base host is never detached — only emptied and unlabelled.
      delete this.baseHost.dataset['kind'];
      delete this.baseHost.dataset['module'];
    } else {
      entry.host.remove();
    }
  }

  /**
   * Overlays follow the base, in array order. The base is `root.firstChild` and
   * is never passed to `insertBefore`, so no reorder can ever move it.
   */
  private reorderDom(): void {
    let prev: Node = this.baseHost;
    for (const entry of this.order) {
      if (entry.role === 'base') continue;
      if (prev.nextSibling !== entry.host) this.root.insertBefore(entry.host, prev.nextSibling);
      prev = entry.host;
    }
  }

  // -------------------------------------------------------------------------
  // Mounting
  // -------------------------------------------------------------------------

  private async mountEntry(entry: Entry): Promise<void> {
    const mod = this.registry(entry.kind);
    // `normalizeLook` already excluded unknown kinds and said so in a note.
    if (mod === null) return;
    // Read through a function: TypeScript narrows a boolean read before an
    // `await` to `false` and never widens it again, so a bare `if (disposed)`
    // after one is dead code the compiler is sure of.
    const gone = (): boolean => entry.disposed || this.disposed;
    try {
      const loaded = await mod.loadDisplay();
      if (gone()) return;
      const renderer = loaded.createRenderer();
      entry.renderer = renderer;
      entry.applied = entry.pending;
      await renderer.mount(entry.host, this.contextFor(entry), entry.pending);
      if (gone()) {
        renderer.unmount();
        return;
      }
      entry.mounted = true;
      if (entry.tier !== 'full') renderer.budget?.(entry.tier);
      // A config that arrived while the chunk was in flight.
      const changed = diffPaths(entry.applied, entry.pending);
      if (changed.length > 0) {
        entry.applied = entry.pending;
        this.call(entry, 'update', (r) => {
          r.update(entry.pending, { changed, origin: 'boot' });
        });
      }
      this.emit();
    } catch (err) {
      this.log.error(`layer ${entry.id} (${entry.kind}) failed to mount`, err);
      this.fail(entry, 'Module failed to start', messageOf(err));
    }
  }

  private contextFor(entry: Entry): ModuleContext {
    return {
      geometry: () => this.geometryOf(entry.layer),
      frameClock: this.clock,
      monitoring: this.monitoringSource ?? INERT_MONITORING,
      render: this.renderOf,
      log: this.makeLog(`module/${entry.kind}`),
      signal: entry.abort.signal,
      layer: {
        id: entry.id,
        index: entry.index,
        role: entry.role,
        frame: entry.layer.frame,
        panel: () => this.panel,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Geometry and style
  // -------------------------------------------------------------------------

  /**
   * The base returns the panel's own object BY IDENTITY — the module contract
   * and the one-layer fast path both depend on
   * `ctx.geometry() === runtime.geometry.get()`.
   */
  private geometryOf(layer: Layer): Geometry {
    return layerGeometry(layer, this.panel);
  }

  /**
   * Writes only the DELTA. A pure `t` change touches `transform` and nothing
   * else, which is the one style write §2.6 promises for a drag.
   *
   * `hostStyle` is deliberately the same function the editor and the replica
   * call, and `layerBox` derives the layer's `--kh-*` custom properties from the
   * default render settings so both surfaces produce byte-identical strings.
   */
  private applyStyle(entry: Entry): void {
    const layer = entry.layer;
    let next: Record<string, string> = {};
    if (layer.frame !== 'panel') {
      const placement = placementOfKind(this.registry, layer.kind);
      const round = layer.frame.shape === 'circle' && placement?.resize === 'scale';
      next = hostStyle(layer, this.panel, { round });
    }
    for (const key of Object.keys(entry.style)) {
      if (!(key in next)) entry.host.style.removeProperty(key);
    }
    for (const [key, value] of Object.entries(next)) {
      if (entry.style[key] === value) continue;
      entry.host.style.setProperty(key, value);
    }
    entry.style = next;
  }

  // -------------------------------------------------------------------------
  // Tiers, failures, notification
  // -------------------------------------------------------------------------

  private tierFor(role: 'base' | 'overlay'): Tier {
    return role === 'base' && this.stackTier === 'hz1' ? 'reduced' : this.stackTier;
  }

  private retier(entry: Entry): void {
    const tier = this.tierFor(entry.role);
    if (tier === entry.tier) return;
    entry.tier = tier;
    entry.nextAt = 0;
    this.call(entry, 'budget', (r) => {
      r.budget?.(tier);
    });
  }

  /** Every renderer callback is wrapped: a module that throws must not take the LCD down. */
  private call(entry: Entry, what: string, fn: (r: DisplayRenderer<unknown>) => void): void {
    const renderer = entry.renderer;
    if (renderer === null || entry.dead) return;
    try {
      fn(renderer);
    } catch (err) {
      this.log.error(`layer ${entry.id} (${entry.kind}) threw in ${what}`, err);
      this.fail(entry, 'Module error', messageOf(err));
    }
  }

  private fail(entry: Entry, title: string, detail: string): void {
    this.failures.set(entry.id, { id: entry.id, kind: entry.kind, title, detail });
    this.emit();
  }

  /**
   * Notify status subscribers on a microtask, coalesced.
   *
   * Deferred rather than immediate because one of the callers is the frame loop:
   * a renderer's third consecutive throw records a failure, and a subscriber is
   * `useSyncExternalStore` on the display shell. A React update that originates
   * *inside* a tick is exactly what invariant I4 forbids, and coalescing also
   * means a reconcile that mounts five layers re-renders the shell once.
   */
  private emit(): void {
    if (this.emitQueued) return;
    this.emitQueued = true;
    queueMicrotask(() => {
      this.emitQueued = false;
      if (this.disposed) return;
      for (const cb of this.listeners) cb();
    });
  }
}

function sameFrame(a: Layer['frame'], b: Layer['frame']): boolean {
  if (a === 'panel' || b === 'panel') return a === b;
  return a.w === b.w && a.h === b.h && a.shape === b.shape;
}

function placementOfKind(registry: GetModule, kind: ModuleId) {
  const mod = registry(kind);
  return mod === null ? null : placementOf(mod);
}

/**
 * What `ctx.monitoring` is when the surface has no CAM feed at all (a unit test,
 * a preview). A module that subscribes gets silence rather than a crash.
 */
const INERT_MONITORING: MonitoringSource = {
  latest: () => null,
  subscribe: () => () => {
    /* nothing ever arrives */
  },
  lastUpdateAt: () => 0,
  isStale: () => true,
  isSimulated: () => false,
  intervals: () => [],
  rearm: () => {
    /* nothing to re-arm */
  },
  dispose: () => {
    /* nothing to dispose */
  },
};
