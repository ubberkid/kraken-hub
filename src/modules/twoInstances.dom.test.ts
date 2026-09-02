/**
 * Two of the same module, on the same panel, at the same time (§3.3, §10 W2).
 *
 * The whole layer model rests on one property nobody had ever tested, because
 * until now it could not be exercised: a module is a FACTORY, and two renderers
 * made by it share nothing. Every place a module quietly assumed it was "the"
 * instance — a module-scope `let`, a keyed-by-nothing notice board, a global
 * timer — is a bug that only appears when somebody adds a second clock.
 *
 * So this suite mounts every overlay-capable kind twice, into two hosts, with
 * two different `ctx.layer.id`s, drives one of them, and asserts the other did
 * not move. It runs over the registry, so a new module gets the guarantee — and
 * the failure — for free.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { normalizeMonitoring } from '../platform/monitoring';
import { DEFAULT_RENDER } from '../state/defaults';

import { MODULES } from './registry';
import {
  currentReplicaThumbs,
  resetReplicaThumb,
  setReplicaThumb,
  subscribeReplicaThumbs,
} from './replicaThumb';
import { placementOf } from './stack';

import type { DisplayRenderer, ModuleContext } from './types';
import type { FrameClock, FrameInfo } from '../platform/fpsGovernor';
import type { Geometry } from '../platform/geometry';
import type { MonitoringSource, NormalizedMonitoring } from '../platform/monitoring';

const PANEL = 640;

const GEOMETRY: Geometry = {
  width: PANEL,
  height: PANEL,
  shape: 'circle',
  targetFps: 40,
  dpr: 1,
  source: 'sim',
  safeInsetPx: Math.round(PANEL * DEFAULT_RENDER.safeAreaPct),
  inscribedSquarePx: Math.round(PANEL * Math.SQRT1_2),
  radiusPx: PANEL / 2,
};

/** A box a `1.6 × 0.5` overlay would get, so the two instances differ in size too. */
const OVERLAY_GEOMETRY: Geometry = {
  ...GEOMETRY,
  width: PANEL * 0.8,
  height: PANEL * 0.25,
  shape: 'square',
  radiusPx: (PANEL * 0.25) / 2,
  inscribedSquarePx: Math.round(PANEL * 0.25),
};

const RAW: NzxtV1.MonitoringData = {
  cpus: [{ name: 'CPU', temperature: 61, load: 0.42, frequency: 4200 }],
  gpus: [{ name: 'GPU', temperature: 48, load: 0.31 }],
  ram: { used: 8192, total: 16384 },
  kraken: { liquidTemperature: 33 },
} as unknown as NzxtV1.MonitoringData;

const NORM: NormalizedMonitoring = normalizeMonitoring(RAW, { simulated: true, at: 1_000 });

function fakeClock(): FrameClock {
  return {
    subscribe: () => () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    stats: () => ({ achievedFps: 40, longFrames: 0, lastTickAt: 0, paused: false, frame: 0 }),
    stop: () => undefined,
  };
}

function fakeMonitoring(): MonitoringSource {
  return {
    latest: () => ({ norm: NORM, raw: RAW }),
    subscribe: () => () => undefined,
    lastUpdateAt: () => Date.now(),
    isStale: () => false,
    isSimulated: () => true,
    intervals: () => [],
    rearm: () => undefined,
    dispose: () => undefined,
  };
}

interface Mounted {
  host: HTMLElement;
  renderer: DisplayRenderer<unknown>;
  ctx: ModuleContext;
  abort: AbortController;
}

/** Two ticks of the microtask/macrotask queue: enough for a renderer to settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const FRAME: FrameInfo = { t: 1000, dt: 25, frame: 1, targetFps: 40 } as FrameInfo;

const OVERLAY_KINDS = MODULES.filter((m) => placementOf(m).roles.includes('overlay'));

describe('two instances of one module never touch each other', () => {
  let mounted: Mounted[] = [];

  beforeEach(() => {
    resetReplicaThumb();
  });

  afterEach(() => {
    for (const m of mounted) {
      m.abort.abort();
      try {
        m.renderer.unmount();
      } catch {
        // A renderer that cannot unmount is a different test's problem.
      }
      m.host.remove();
    }
    mounted = [];
    resetReplicaThumb();
  });

  async function mount(
    mod: (typeof MODULES)[number],
    id: string,
    index: number,
    geometry: Geometry,
  ): Promise<Mounted> {
    const host = document.createElement('div');
    host.dataset['layer'] = id;
    document.body.append(host);
    const abort = new AbortController();
    const ctx: ModuleContext = {
      geometry: () => geometry,
      frameClock: fakeClock(),
      monitoring: fakeMonitoring(),
      render: () => DEFAULT_RENDER,
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      signal: abort.signal,
      layer: {
        id,
        index,
        role: index === 0 ? 'base' : 'overlay',
        frame: index === 0 ? 'panel' : { w: 1.6, h: 0.5, shape: 'square' },
        panel: () => GEOMETRY,
      },
    };
    const loaded = await mod.loadDisplay();
    const renderer: DisplayRenderer<unknown> = loaded.createRenderer();
    await renderer.mount(host, ctx, mod.defaults);
    const entry = { host, renderer, ctx, abort };
    mounted.push(entry);
    return entry;
  }

  it.each(OVERLAY_KINDS.map((m) => [m.id, m] as const))(
    '%s: driving the base leaves the overlay alone',
    async (_id, mod) => {
      const first = await mount(mod, 'base', 0, GEOMETRY);
      const second = await mount(mod, 'lsecond', 1, OVERLAY_GEOMETRY);
      await settle();

      const before = second.host.innerHTML;
      expect(before.length).toBeGreaterThan(0);

      // Everything the shell can do to one layer, done to one layer only.
      first.renderer.update(mod.defaults, { changed: [], origin: 'local' });
      first.renderer.frame?.(FRAME);
      first.renderer.monitoring?.(NORM, RAW);
      first.renderer.geometry?.(GEOMETRY);
      first.renderer.visibility?.('visible');
      first.renderer.reinit?.('manual');
      await settle();

      expect(second.host.innerHTML).toBe(before);
    },
  );

  it.each(OVERLAY_KINDS.map((m) => [m.id, m] as const))(
    '%s: unmounting one does not unmount the other',
    async (_id, mod) => {
      const first = await mount(mod, 'base', 0, GEOMETRY);
      const second = await mount(mod, 'lsecond', 1, OVERLAY_GEOMETRY);
      await settle();

      const before = second.host.innerHTML;
      first.renderer.unmount();
      first.abort.abort();
      await settle();

      expect(second.host.innerHTML).toBe(before);
      expect(first.host.innerHTML).toBe('');
    },
  );

  it.each(OVERLAY_KINDS.map((m) => [m.id, m] as const))(
    '%s: keeps at most one replica thumbnail per layer',
    async (_id, mod) => {
      await mount(mod, 'base', 0, GEOMETRY);
      await mount(mod, 'lsecond', 1, OVERLAY_GEOMETRY);
      await settle();

      const thumbs = currentReplicaThumbs();
      for (const key of thumbs.keys()) expect(['base', 'lsecond']).toContain(key);
      // A Map cannot hold two entries for one id; what it CAN do — and what the
      // single slot used to do — is let the second mount overwrite the first.
      expect(thumbs.size).toBeLessThanOrEqual(2);
    },
  );

  it('keys the replica seam by layer, so one unmount cannot blank the other', () => {
    const seen: [string, Blob | null][] = [];
    const off = subscribeReplicaThumbs((id, blob) => seen.push([id, blob]));

    const a = new Blob(['a']);
    const b = new Blob(['b']);
    setReplicaThumb('base', a);
    setReplicaThumb('lbadge', b);
    expect(currentReplicaThumbs().get('base')).toBe(a);
    expect(currentReplicaThumbs().get('lbadge')).toBe(b);

    // What an unmount does: says "nothing on MY layer", not "nothing anywhere".
    setReplicaThumb('lbadge', null);
    expect(currentReplicaThumbs().get('base')).toBe(a);
    expect(seen).toEqual([
      ['base', a],
      ['lbadge', b],
      ['lbadge', null],
    ]);
    off();
  });
});
