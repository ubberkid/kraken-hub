/**
 * The compositor's contract, as a table.
 *
 * Every row here is a promise §2.6 makes about what a given kind of change
 * COSTS, and the assertions are about the cost, not the appearance: a reorder
 * must not unmount anything, a transform must not call a renderer at all, a
 * config change must not remount, and the base host must be the same DOM node
 * afterwards no matter what happened — because an `<iframe>` that is re-inserted
 * re-navigates and a WebGL canvas that is re-created loses its context.
 */

import { describe, expect, it, vi } from 'vitest';

import { hostStyle } from './layerBox';
import { LayerHost, type LayerConfigs } from './LayerHost';

import type { Tier } from './layerGovernor';
import type { GetModule } from '../modules/stack';
import type {
  AnyKrakenModule,
  DisplayRenderer,
  LayerPlacement,
  ModuleContext,
} from '../modules/types';
import type { FrameClock, FrameInfo } from '../platform/fpsGovernor';
import type { Geometry } from '../platform/geometry';
import type { NormalizedMonitoring } from '../platform/monitoring';
import type { Layer, Look, Transform } from '../state/look/types';
import type { RenderSettings } from '../state/schema';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RENDER: RenderSettings = {
  fit: 'cover',
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  rotate: 0,
  safeAreaPct: 0.08,
  safeRadiusPct: 0.88,
  maskCircle: 'auto',
  background: '#000',
};

function panelOf(width: number, height: number, shape: 'circle' | 'square'): Geometry {
  return {
    width,
    height,
    shape,
    targetFps: 40,
    dpr: 1,
    source: 'sim',
    safeInsetPx: Math.round(Math.min(width, height) * 0.19),
    inscribedSquarePx: Math.round(Math.min(width, height) * 0.7),
    radiusPx: Math.min(width, height) / 2,
  };
}

// device-size-ok: three PANEL SIZES from the preset table, reproduced so the
// geometry assertions below are the design doc's worked examples.
const PANELS = [
  panelOf(640, 640, 'circle'),
  panelOf(320, 320, 'circle'),
  panelOf(240, 240, 'square'),
];

const IDENT: Transform = { x: 0, y: 0, s: 1, r: 0, a: 1 };

function t(patch: Partial<Transform>): Transform {
  return { ...IDENT, ...patch };
}

interface FakeClock extends FrameClock {
  emit(frame: number, at?: number): void;
  subscribers(): number;
}

function fakeClock(): FakeClock {
  const subs = new Set<(f: FrameInfo) => void>();
  return {
    subscribe(cb) {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    pause: () => undefined,
    resume: () => undefined,
    stats: () => ({ achievedFps: 40, longFrames: 0, lastTickAt: 0, paused: false, frame: 0 }),
    stop: () => undefined,
    emit(frame, at = frame * 25) {
      const f: FrameInfo = {
        t: at,
        dt: 25,
        frame,
        targetFps: 40,
        budgetMs: 25,
        achievedFps: 40,
      };
      for (const cb of [...subs]) cb(f);
    },
    subscribers: () => subs.size,
  };
}

interface Spy {
  mounted: number;
  unmounted: number;
  updates: { config: unknown; changed: string[] }[];
  geometries: Geometry[];
  budgets: Tier[];
  monitoring: number;
  frames: number[];
  ctx: ModuleContext | null;
}

const OVERLAY_PLACEMENT: LayerPlacement = {
  roles: ['base', 'overlay'],
  maxInstances: 8,
  resize: 'frame',
  minFrame: 0.2,
  overlayDefault: { frame: { w: 1, h: 1, shape: 'square' }, t: IDENT },
  cost: () => ({ cadence: 'tick', coverage: 0.3, entropy: 'low', decoders: 0, gl: 0 }),
};

/** A pixel kind: `resize: 'scale'`, which is what earns a circle frame its clip. */
const PIXEL_PLACEMENT: LayerPlacement = { ...OVERLAY_PLACEMENT, resize: 'scale' };

function fakeModule(id: string, placement = OVERLAY_PLACEMENT): [AnyKrakenModule, Spy] {
  const spy: Spy = {
    mounted: 0,
    unmounted: 0,
    updates: [],
    geometries: [],
    budgets: [],
    monitoring: 0,
    frames: [],
    ctx: null,
  };
  const renderer: DisplayRenderer<unknown> = {
    mount(_host, ctx) {
      spy.mounted += 1;
      spy.ctx = ctx;
    },
    update(config, reason) {
      spy.updates.push({ config, changed: reason.changed });
    },
    geometry(g) {
      spy.geometries.push(g);
    },
    budget(tier) {
      spy.budgets.push(tier);
    },
    monitoring() {
      spy.monitoring += 1;
    },
    frame(f) {
      spy.frames.push(f.frame);
    },
    unmount() {
      spy.unmounted += 1;
    },
  };
  const mod: AnyKrakenModule = {
    id,
    name: id,
    summary: '',
    icon: '',
    configVersion: 1,
    capabilities: {
      needsMonitoring: true,
      needsFrameLoop: true,
      usesMedia: false,
      hasTimeline: false,
      motionLevel: 'low',
      substrate: 'dom',
      audio: 'none',
      remoteCommands: [],
    },
    layer: placement,
    defaults: {},
    validate: (raw) => raw,
    loadDisplay: () => Promise.resolve({ createRenderer: () => renderer }),
    loadConfigPanel: () => Promise.reject(new Error('no panel')),
  };
  return [mod, spy];
}

function registryOf(...mods: AnyKrakenModule[]): GetModule {
  const byId = new Map(mods.map((m) => [m.id, m]));
  return (id) => byId.get(id) ?? null;
}

function base(kind: string): Layer {
  return { id: 'base', kind, on: true, frame: 'panel', t: IDENT };
}

function box(
  id: string,
  kind: string,
  transform = IDENT,
  frame: Layer['frame'] = { w: 1, h: 0.5, shape: 'square' },
  cfg: unknown = {},
): Layer {
  return { id, kind, on: true, frame, t: transform, cfg };
}

function look(...layers: Layer[]): Look {
  return { layers };
}

function cfgsOf(l: Look): LayerConfigs {
  const out: Record<string, unknown> = {};
  for (const layer of l.layers) out[layer.id] = layer.cfg ?? { kind: layer.kind };
  return out;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Harness {
  root: HTMLElement;
  host: LayerHost;
  clock: FakeClock;
}

function mount(registry: GetModule, panel = PANELS[0]!): Harness {
  const root = document.createElement('div');
  document.body.append(root);
  const clock = fakeClock();
  const host = new LayerHost(root, {
    registry,
    panel,
    clock,
    render: () => RENDER,
  });
  return { root, host, clock };
}

const hostsOf = (root: HTMLElement): HTMLElement[] =>
  [...root.children].filter((el): el is HTMLElement => el.classList.contains('kh-layer'));

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

describe('reconcile by id', () => {
  it('gives a base-only look the DOM the single-module display always produced', async () => {
    const [clock] = fakeModule('clock');
    const h = mount(registryOf(clock));
    const l = look(base('clock'));
    h.host.setLook(l, cfgsOf(l));
    await flush();

    const nodes = hostsOf(h.root);
    expect(nodes).toHaveLength(1);
    const el = nodes[0]!;
    expect(el.className).toBe('kh-layer kh-stage__module');
    expect(el.dataset['module']).toBe('clock');
    expect(el.dataset['role']).toBe('base');
    // No inline geometry at all: the base inherits `:root`, which is what keeps
    // every module's CSS resolving exactly as it did before looks existed.
    expect(el.getAttribute('style')).toBeNull();
    expect(el.style.getPropertyValue('--kh-w')).toBe('');
    h.host.destroy();
  });

  it('hands the base the panel geometry BY IDENTITY', async () => {
    const [clock, spy] = fakeModule('clock');
    const panel = PANELS[0]!;
    const h = mount(registryOf(clock), panel);
    const l = look(base('clock'));
    h.host.setLook(l, cfgsOf(l));
    await flush();
    expect(spy.ctx?.geometry()).toBe(panel);
    expect(spy.ctx?.layer).toEqual({
      id: 'base',
      index: 0,
      role: 'base',
      frame: 'panel',
      panel: expect.any(Function) as unknown,
    });
    h.host.destroy();
  });

  it('is a reference-stable no-op when nothing changed', async () => {
    const [clock, spy] = fakeModule('clock');
    const h = mount(registryOf(clock));
    const l = look(base('clock'));
    const cfgs = cfgsOf(l);
    h.host.setLook(l, cfgs);
    await flush();
    h.host.setLook(l, cfgs);
    h.host.setLook(l, cfgs);
    expect(spy.mounted).toBe(1);
    expect(spy.updates).toHaveLength(0);
    h.host.destroy();
  });

  it('keeps the base node identical across add, reorder, toggle and remove', async () => {
    const [clock] = fakeModule('clock');
    const [stats] = fakeModule('stats');
    const [text] = fakeModule('text');
    const h = mount(registryOf(clock, stats, text));

    const only = look(base('clock'));
    h.host.setLook(only, cfgsOf(only));
    await flush();
    const baseNode = hostsOf(h.root)[0]!;

    const added = look(base('clock'), box('ovra', 'stats'), box('ovrb', 'text'));
    h.host.setLook(added, cfgsOf(added));
    await flush();
    expect(hostsOf(h.root)[0]).toBe(baseNode);
    expect(hostsOf(h.root).map((n) => n.dataset['layer'])).toEqual(['base', 'ovra', 'ovrb']);

    const swapped = look(base('clock'), box('ovrb', 'text'), box('ovra', 'stats'));
    h.host.setLook(swapped, cfgsOf(swapped));
    await flush();
    expect(hostsOf(h.root)[0]).toBe(baseNode);
    expect(hostsOf(h.root).map((n) => n.dataset['layer'])).toEqual(['base', 'ovrb', 'ovra']);

    const off = look(base('clock'), { ...box('ovrb', 'text'), on: false }, box('ovra', 'stats'));
    h.host.setLook(off, cfgsOf(off));
    await flush();
    expect(hostsOf(h.root)[0]).toBe(baseNode);
    expect(hostsOf(h.root).map((n) => n.dataset['layer'])).toEqual(['base', 'ovra']);

    h.host.setLook(only, cfgsOf(only));
    await flush();
    expect(hostsOf(h.root)[0]).toBe(baseNode);
    expect(hostsOf(h.root)).toHaveLength(1);
    h.host.destroy();
  });

  it('reorders overlays without unmounting anything', async () => {
    const [clock] = fakeModule('clock');
    const [stats, statsSpy] = fakeModule('stats');
    const [text, textSpy] = fakeModule('text');
    const h = mount(registryOf(clock, stats, text));

    const a = look(base('clock'), box('ovra', 'stats'), box('ovrb', 'text'));
    h.host.setLook(a, cfgsOf(a));
    await flush();
    const statsNode = hostsOf(h.root)[1]!;

    const b = look(base('clock'), box('ovrb', 'text'), box('ovra', 'stats'));
    h.host.setLook(b, cfgsOf(b));
    await flush();

    expect(statsSpy.unmounted).toBe(0);
    expect(textSpy.unmounted).toBe(0);
    expect(statsSpy.mounted).toBe(1);
    // The very same element, moved — not a fresh one.
    expect(hostsOf(h.root)[2]).toBe(statsNode);
    h.host.destroy();
  });

  it('unmounts a removed layer exactly once', async () => {
    const [clock] = fakeModule('clock');
    const [stats, spy] = fakeModule('stats');
    const h = mount(registryOf(clock, stats));

    const two = look(base('clock'), box('ovra', 'stats'));
    h.host.setLook(two, cfgsOf(two));
    await flush();

    const one = look(base('clock'));
    h.host.setLook(one, cfgsOf(one));
    await flush();
    // Idempotence: setting it again must not unmount a second time.
    const oneAgain = look(base('clock'));
    h.host.setLook(oneAgain, cfgsOf(oneAgain));
    await flush();

    expect(spy.unmounted).toBe(1);
    expect(hostsOf(h.root)).toHaveLength(1);
    h.host.destroy();
  });

  it('a transform change writes ONE style property and calls no renderer at all', async () => {
    const [clock] = fakeModule('clock');
    const [stats, spy] = fakeModule('stats');
    const h = mount(registryOf(clock, stats));

    const a = look(base('clock'), box('ovra', 'stats'));
    h.host.setLook(a, cfgsOf(a));
    await flush();
    const node = hostsOf(h.root)[1]!;
    const before = node.style.getPropertyValue('width');
    spy.geometries.length = 0;
    spy.updates.length = 0;

    const b = look(base('clock'), box('ovra', 'stats', t({ y: 0.6 })));
    h.host.setLook(b, cfgsOf(b));
    await flush();

    expect(spy.geometries).toHaveLength(0);
    expect(spy.updates).toHaveLength(0);
    expect(spy.unmounted).toBe(0);
    expect(node.style.getPropertyValue('width')).toBe(before);
    expect(node.style.getPropertyValue('transform')).toContain('translate(0px, 192px)');
    h.host.destroy();
  });

  it('a frame change republishes the box and calls geometry() once', async () => {
    const [clock] = fakeModule('clock');
    const [stats, spy] = fakeModule('stats');
    const h = mount(registryOf(clock, stats));

    const a = look(base('clock'), box('ovra', 'stats'));
    h.host.setLook(a, cfgsOf(a));
    await flush();
    spy.geometries.length = 0;

    const b = look(base('clock'), box('ovra', 'stats', IDENT, { w: 1.6, h: 0.5, shape: 'square' }));
    h.host.setLook(b, cfgsOf(b));
    await flush();

    expect(spy.geometries).toHaveLength(1);
    expect(spy.geometries[0]?.width).toBe(512);
    expect(hostsOf(h.root)[1]?.style.getPropertyValue('width')).toBe('512px');
    h.host.destroy();
  });

  it('a config change updates rather than remounts', async () => {
    const [clock] = fakeModule('clock');
    const [stats, spy] = fakeModule('stats');
    const h = mount(registryOf(clock, stats));

    const a = look(base('clock'), box('ovra', 'stats', IDENT, undefined, { face: 'digital' }));
    h.host.setLook(a, cfgsOf(a));
    await flush();

    const b = look(base('clock'), box('ovra', 'stats', IDENT, undefined, { face: 'analog' }));
    h.host.setLook(b, cfgsOf(b));
    await flush();

    expect(spy.mounted).toBe(1);
    expect(spy.unmounted).toBe(0);
    expect(spy.updates).toHaveLength(1);
    expect(spy.updates[0]?.changed).toEqual(['face']);
    h.host.destroy();
  });

  it('a KIND change on the same id remounts', async () => {
    const [clock] = fakeModule('clock');
    const [stats, statsSpy] = fakeModule('stats');
    const [text, textSpy] = fakeModule('text');
    const h = mount(registryOf(clock, stats, text));

    const a = look(base('clock'), box('ovra', 'stats'));
    h.host.setLook(a, cfgsOf(a));
    await flush();

    const b = look(base('clock'), box('ovra', 'text'));
    h.host.setLook(b, cfgsOf(b));
    await flush();

    expect(statsSpy.unmounted).toBe(1);
    expect(textSpy.mounted).toBe(1);
    expect(hostsOf(h.root)[1]?.dataset['kind']).toBe('text');
    h.host.destroy();
  });

  it('renders nothing for a kind this build has never heard of, and says why', async () => {
    const [clock] = fakeModule('clock');
    const h = mount(registryOf(clock));

    const l = look(base('clock'), box('ovra', 'lava'));
    h.host.setLook(l, cfgsOf(l));
    await flush();

    expect(hostsOf(h.root)).toHaveLength(1);
    expect(h.host.status().notes.map((n) => n.reason)).toEqual(['unknown-kind']);
    h.host.destroy();
  });

  it('subscribes to the frame clock exactly once, for the whole stack', async () => {
    const [clock] = fakeModule('clock');
    const [stats] = fakeModule('stats');
    const h = mount(registryOf(clock, stats));
    const l = look(base('clock'), box('ovra', 'stats'));
    h.host.setLook(l, cfgsOf(l));
    await flush();
    expect(h.clock.subscribers()).toBe(1);
    h.host.destroy();
    expect(h.clock.subscribers()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

describe('host geometry', () => {
  it('writes exactly what layerBox.hostStyle says, at every panel size', async () => {
    const [clock] = fakeModule('clock');
    const [stats] = fakeModule('stats');
    for (const panel of PANELS) {
      const h = mount(registryOf(clock, stats), panel);
      const layer = box('ovra', 'stats', t({ x: 0.5, y: -0.25, r: 12, a: 0.8 }));
      const l = look(base('clock'), layer);
      h.host.setLook(l, cfgsOf(l));
      await flush();

      const node = hostsOf(h.root)[1]!;
      const expected = hostStyle(layer, panel, { round: false });
      for (const [key, value] of Object.entries(expected)) {
        expect(node.style.getPropertyValue(key)).toBe(value);
      }
      expect(node.style.getPropertyValue('border-radius')).toBe('');
      h.host.destroy();
    }
  });

  it('clips a circle frame only for a pixel kind, exactly as hostStyle decides', async () => {
    const [clock] = fakeModule('clock');
    const [pixel] = fakeModule('image', PIXEL_PLACEMENT);
    const [layout] = fakeModule('stats', OVERLAY_PLACEMENT);
    const panel = PANELS[0]!;
    const h = mount(registryOf(clock, pixel, layout), panel);

    const circle = { w: 0.8, h: 0.8, shape: 'circle' } as const;
    const l = look(
      base('clock'),
      box('ovra', 'image', IDENT, circle),
      box('ovrb', 'stats', IDENT, circle),
    );
    h.host.setLook(l, cfgsOf(l));
    await flush();

    const [, pixelNode, layoutNode] = hostsOf(h.root);
    expect(pixelNode?.style.getPropertyValue('border-radius')).toBe('50%');
    expect(pixelNode?.style.getPropertyValue('overflow')).toBe('hidden');
    expect(layoutNode?.style.getPropertyValue('border-radius')).toBe('');
    h.host.destroy();
  });

  it('republishes every host when the panel changes', async () => {
    const [clock] = fakeModule('clock');
    const [stats, spy] = fakeModule('stats');
    const h = mount(registryOf(clock, stats), PANELS[0]);
    const l = look(base('clock'), box('ovra', 'stats'));
    h.host.setLook(l, cfgsOf(l));
    await flush();
    spy.geometries.length = 0;

    h.host.setPanel(PANELS[1]!);
    expect(spy.geometries).toHaveLength(1);
    expect(hostsOf(h.root)[1]?.style.getPropertyValue('width')).toBe(
      hostStyle(box('ovra', 'stats'), PANELS[1]!)['width'],
    );
    h.host.destroy();
  });
});

// ---------------------------------------------------------------------------
// Governor tiers
// ---------------------------------------------------------------------------

describe('governor tiers', () => {
  it('ticks every layer every frame at full', async () => {
    const [clock, baseSpy] = fakeModule('clock');
    const [stats, overSpy] = fakeModule('stats');
    const h = mount(registryOf(clock, stats));
    const l = look(base('clock'), box('ovra', 'stats'));
    h.host.setLook(l, cfgsOf(l));
    await flush();

    for (let f = 1; f <= 4; f += 1) h.clock.emit(f);
    expect(baseSpy.frames).toEqual([1, 2, 3, 4]);
    expect(overSpy.frames).toEqual([1, 2, 3, 4]);
    h.host.destroy();
  });

  it('reduced ticks every 4th frame, phase-staggered so two layers never coincide', async () => {
    const [clock, baseSpy] = fakeModule('clock');
    const [stats, overSpy] = fakeModule('stats');
    const h = mount(registryOf(clock, stats));
    const l = look(base('clock'), box('ovra', 'stats'));
    h.host.setLook(l, cfgsOf(l));
    await flush();

    h.host.setTier('reduced');
    expect(baseSpy.budgets).toEqual(['reduced']);
    expect(overSpy.budgets).toEqual(['reduced']);

    for (let f = 1; f <= 8; f += 1) h.clock.emit(f);
    expect(baseSpy.frames).toEqual([4, 8]);
    expect(overSpy.frames).toEqual([3, 7]);
    expect(baseSpy.frames.some((f) => overSpy.frames.includes(f))).toBe(false);
    h.host.destroy();
  });

  it('hz1 spares the base and never unmounts a layer', async () => {
    const [clock, baseSpy] = fakeModule('clock');
    const [stats, overSpy] = fakeModule('stats');
    const h = mount(registryOf(clock, stats));
    const l = look(base('clock'), box('ovra', 'stats'));
    h.host.setLook(l, cfgsOf(l));
    await flush();

    h.host.setTier('hz1');
    expect(baseSpy.budgets).toEqual(['reduced']);
    expect(overSpy.budgets).toEqual(['hz1']);
    expect(h.host.stats().layers.map((s) => s.tier)).toEqual(['reduced', 'hz1']);

    // Two seconds of ticks: the overlay draws twice, not eighty times.
    for (let f = 1; f <= 80; f += 1) h.clock.emit(f, f * 25);
    expect(overSpy.frames.length).toBeLessThanOrEqual(3);
    expect(baseSpy.frames.length).toBeGreaterThan(overSpy.frames.length);
    expect(baseSpy.unmounted).toBe(0);
    expect(overSpy.unmounted).toBe(0);
    expect(hostsOf(h.root)).toHaveLength(2);
    h.host.destroy();
  });

  it('is a no-op when the tier does not change', async () => {
    const [clock, spy] = fakeModule('clock');
    const h = mount(registryOf(clock));
    const l = look(base('clock'));
    h.host.setLook(l, cfgsOf(l));
    await flush();
    h.host.setTier('full');
    h.host.setTier('reduced');
    h.host.setTier('reduced');
    expect(spy.budgets).toEqual(['reduced']);
    h.host.destroy();
  });
});

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

describe('fan-out', () => {
  const SAMPLE: NormalizedMonitoring = {
    cpu: {},
    gpu: {},
    ram: {},
    kraken: {},
    at: 0,
    simulated: true,
  };
  const EMPTY_RAW = {} as NzxtV1.MonitoringData;

  it('reaches every mounted renderer', async () => {
    const [clock, a] = fakeModule('clock');
    const [stats, b] = fakeModule('stats');
    const [text, c] = fakeModule('text');
    const h = mount(registryOf(clock, stats, text));
    const l = look(base('clock'), box('ovra', 'stats'), box('ovrb', 'text'));
    h.host.setLook(l, cfgsOf(l));
    await flush();

    h.host.setMonitoring(SAMPLE, EMPTY_RAW);
    h.host.setMonitoring(SAMPLE, EMPTY_RAW);
    expect([a.monitoring, b.monitoring, c.monitoring]).toEqual([2, 2, 2]);
    h.host.destroy();
  });

  it('stops at a layer that has gone', async () => {
    const [clock, a] = fakeModule('clock');
    const [stats, b] = fakeModule('stats');
    const h = mount(registryOf(clock, stats));
    const two = look(base('clock'), box('ovra', 'stats'));
    h.host.setLook(two, cfgsOf(two));
    await flush();
    const one = look(base('clock'));
    h.host.setLook(one, cfgsOf(one));
    await flush();

    h.host.setMonitoring(SAMPLE, EMPTY_RAW);
    expect(a.monitoring).toBe(1);
    expect(b.monitoring).toBe(0);
    h.host.destroy();
  });

  it('routes a command to the base by default and to a named layer on request', async () => {
    const [clockMod] = fakeModule('clock');
    const [stats] = fakeModule('stats');
    const ops: string[] = [];
    const withCommand = (mod: AnyKrakenModule, tag: string): AnyKrakenModule => ({
      ...mod,
      loadDisplay: async () => {
        const inner = (await mod.loadDisplay()).createRenderer();
        return {
          createRenderer: () => ({
            ...inner,
            command: (op: string) => ops.push(`${tag}:${op}`),
          }),
        };
      },
    });
    const h = mount(registryOf(withCommand(clockMod, 'base'), withCommand(stats, 'over')));
    const l = look(base('clock'), box('ovra', 'stats'));
    h.host.setLook(l, cfgsOf(l));
    await flush();

    expect(h.host.command('play')).toBe(true);
    expect(h.host.command('seekBy', 10, 'ovra')).toBe(true);
    expect(h.host.command('play', undefined, 'nope')).toBe(false);
    expect(ops).toEqual(['base:play', 'over:seekBy']);
    h.host.destroy();
  });

  /**
   * The cold-boot seek, as a unit.
   *
   * A retained playback snapshot is delivered the instant the transport
   * connects, which on a fresh display is routinely before the base module's
   * dynamic import has resolved. The single-module host answered that with the
   * REGISTRATION of its command handler — it registered only after `mount()`
   * resolved, so `display/sync.ts` waited on a non-null handler and re-anchored
   * the position on a 250 ms ladder until one appeared. The compositor's handler
   * is installed with the stage and outlives every renderer, so the same
   * question is answered by `command()`'s return value instead, and these rows
   * are that contract: no queue, no replay, and an honest `false` while the
   * layer is still loading.
   */
  function recording(mod: AnyKrakenModule, ops: [string, unknown][]): AnyKrakenModule {
    return {
      ...mod,
      loadDisplay: async () => {
        const inner = (await mod.loadDisplay()).createRenderer();
        return {
          createRenderer: () => ({
            ...inner,
            command: (op: string, arg?: unknown) => ops.push([op, arg]),
          }),
        };
      },
    };
  }

  it('reports a command that arrives before the base mounts as undelivered, and drops it', async () => {
    const [clockMod] = fakeModule('clock');
    const ops: [string, unknown][] = [];
    const h = mount(registryOf(recording(clockMod, ops)));
    const l = look(base('clock'));
    h.host.setLook(l, cfgsOf(l));

    // No `flush()`: the import is still in flight, which is the whole window.
    expect(h.host.command('seekTo', 4.5)).toBe(false);
    expect(ops).toEqual([]);

    // Mounting REPLAYS NOTHING — the caller re-derives and asks again, which is
    // what keeps a restored position one seek at a position that is still true.
    await flush();
    h.clock.emit(1);
    expect(ops).toEqual([]);

    expect(h.host.command('seekTo', 4.5)).toBe(true);
    expect(ops).toEqual([['seekTo', 4.5]]);
    h.host.destroy();
  });

  it('reports undelivered for a layer that is not in the look, or cannot take commands', async () => {
    const [clockMod] = fakeModule('clock');
    const [statsMod] = fakeModule('stats');
    const ops: [string, unknown][] = [];
    // `stats` here is the plain fixture: a renderer with no `command()` at all.
    const h = mount(registryOf(recording(clockMod, ops), statsMod));
    const l = look(base('clock'), box('ovra', 'stats'));
    h.host.setLook(l, cfgsOf(l));
    await flush();

    expect(h.host.command('play', undefined, 'nope')).toBe(false);
    expect(h.host.command('play', undefined, 'ovra')).toBe(false);
    expect(h.host.command('play')).toBe(true);
    expect(ops).toEqual([['play', undefined]]);
    h.host.destroy();
  });

  it('stops reporting delivery once the base has gone', async () => {
    const [clockMod] = fakeModule('clock');
    const ops: [string, unknown][] = [];
    const h = mount(registryOf(recording(clockMod, ops)));
    const l = look(base('clock'));
    h.host.setLook(l, cfgsOf(l));
    await flush();
    expect(h.host.command('seekTo', 1)).toBe(true);

    const off = look({ ...base('clock'), on: false });
    h.host.setLook(off, cfgsOf(off));
    expect(h.host.command('seekTo', 2)).toBe(false);
    expect(ops).toEqual([['seekTo', 1]]);
    h.host.destroy();
  });

  it('survives a renderer that throws, and reports it after three strikes', async () => {
    const [clockMod] = fakeModule('clock');
    const boom: AnyKrakenModule = {
      ...clockMod,
      id: 'boom',
      loadDisplay: () =>
        Promise.resolve({
          createRenderer: () => ({
            mount: () => undefined,
            update: () => undefined,
            frame: () => {
              throw new Error('nope');
            },
            unmount: () => undefined,
          }),
        }),
    };
    const errors = vi.fn();
    const root = document.createElement('div');
    document.body.append(root);
    const clock = fakeClock();
    const host = new LayerHost(root, {
      registry: registryOf(boom),
      panel: PANELS[0]!,
      clock,
      render: () => RENDER,
      log: () => ({ error: errors, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    });
    const l = look(base('boom'));
    host.setLook(l, cfgsOf(l));
    await flush();

    for (let f = 1; f <= 5; f += 1) clock.emit(f);
    expect(host.status().failures).toHaveLength(1);
    expect(host.status().failures[0]?.detail).toBe('nope');
    host.destroy();
  });
});
