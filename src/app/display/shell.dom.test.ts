/**
 * The display shell's state → DOM mapping, now that there is no framework to
 * take the blame for it.
 *
 * These are the transitions a component tree used to get for free and that a
 * hand-written shell has to be held to: the splash while the compositor is
 * still mounting, the module error card when a layer fails, the low-FPS
 * advisory on a 1 FPS panel, the debug overlay's one-line-per-layer, and the
 * stage's own four attributes. The registry is mocked so a failing module is a
 * one-line fixture rather than a real player asked to break.
 *
 * What is deliberately NOT re-tested here is the compositor: `LayerHost` has its
 * own table (`src/render/LayerHost.dom.test.ts`) and W9 did not touch it.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CAM_PATH_CONFIGURE, fpsAdvisoryBody } from '../../config/camPaths';
import { renderFpsBadge } from '../../modules/video/ui/FpsAdvisory';
import { DEFAULT_PLATFORM } from '../../state/defaults';
import { IDENTITY } from '../../state/look/types';

import { mountDisplayApp } from './DisplayApp';

import type { DisplayRuntime, ExternalValue } from './runtime';
import type {
  AnyKrakenModule,
  DisplayRenderer,
  LayerPlacement,
  ReinitReason,
} from '../../modules/types';
import type { FrameClock } from '../../platform/fpsGovernor';
import type { Geometry } from '../../platform/geometry';
import type { MonitoringSource } from '../../platform/monitoring';
import type { AppState } from '../../state/schema';
import type { Store } from '../../state/store';
import type { RuntimeFlags } from '../../state/urlParams';

// ---------------------------------------------------------------------------
// A registry of exactly three kinds: one that works, one that never starts, and
// one that never moves.
// ---------------------------------------------------------------------------

const registry = vi.hoisted(() => ({ mods: new Map<string, unknown>() }));

vi.mock('../../modules/registry', () => ({
  getModule: (id: string) => registry.mods.get(id) ?? null,
  resolveModule: (id: string) => registry.mods.get(id) ?? registry.mods.get('good'),
}));

const PLACEMENT: LayerPlacement = {
  roles: ['base', 'overlay'],
  maxInstances: 8,
  resize: 'frame',
  minFrame: 0.2,
  overlayDefault: { frame: { w: 1, h: 1, shape: 'square' }, t: IDENTITY },
  cost: () => ({ cadence: 'frame', coverage: 1, entropy: 'low', decoders: 0, gl: 0 }),
};

const STATIC_PLACEMENT: LayerPlacement = {
  ...PLACEMENT,
  cost: () => ({ cadence: 'static', coverage: 1, entropy: 'low', decoders: 0, gl: 0 }),
};

function fakeModule(
  id: string,
  name: string,
  opts: { placement?: LayerPlacement; fails?: boolean; ownsFpsAdvisory?: boolean } = {},
): AnyKrakenModule {
  const renderer: DisplayRenderer<unknown> = {
    mount: () => undefined,
    update: () => undefined,
    unmount: () => undefined,
  };
  return {
    id,
    name,
    summary: '',
    icon: '',
    configVersion: 1,
    capabilities: {
      needsMonitoring: false,
      needsFrameLoop: false,
      usesMedia: false,
      hasTimeline: false,
      motionLevel: 'low',
      substrate: 'dom',
      audio: 'none',
      remoteCommands: [],
      ...(opts.ownsFpsAdvisory === true ? { ownsFpsAdvisory: true } : {}),
    },
    layer: opts.placement ?? PLACEMENT,
    defaults: {},
    validate: (raw) => raw,
    loadDisplay: () =>
      opts.fails === true
        ? Promise.reject(new Error('no display build'))
        : Promise.resolve({ createRenderer: () => renderer }),
    loadConfigPanel: () => Promise.reject(new Error('no panel')),
  };
}

// ---------------------------------------------------------------------------
// A runtime with no platform underneath it
// ---------------------------------------------------------------------------

function geometryOf(patch: Partial<Geometry> = {}): Geometry {
  return {
    width: 640,
    height: 640,
    shape: 'circle',
    targetFps: 40,
    dpr: 1,
    source: 'sim',
    safeInsetPx: 121,
    inscribedSquarePx: 398,
    radiusPx: 320,
    ...patch,
  };
}

function externalValue<T>(initial: T): ExternalValue<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      value = next;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const FRAME_CLOCK: FrameClock = {
  subscribe: () => () => undefined,
  pause: () => undefined,
  resume: () => undefined,
  stats: () => ({ achievedFps: 39.4, longFrames: 2, lastTickAt: 0, paused: false, frame: 0 }),
  stop: () => undefined,
};

const MONITORING = {
  latest: () => null,
  subscribe: () => () => undefined,
  lastUpdateAt: () => 0,
  isStale: () => true,
  isSimulated: () => true,
  intervals: () => [],
  rearm: () => undefined,
  dispose: () => undefined,
} as unknown as MonitoringSource;

function stateOf(kind: string, patch: Partial<AppState> = {}): AppState {
  return {
    schema: 7,
    rev: 0,
    updatedAt: 0,
    writerId: '',
    writerRole: 'display',
    activeModuleId: kind,
    look: { layers: [{ id: 'base', kind, on: true, frame: 'panel', t: IDENTITY }] },
    modules: { [kind]: { v: 1, cfg: {} } },
    render: {
      fit: 'cover',
      zoom: 1,
      offsetX: 0,
      offsetY: 0,
      rotate: 0,
      safeAreaPct: 0.08,
      safeRadiusPct: 0.88,
      maskCircle: 'auto',
      background: '#000000',
    },
    platform: { ...DEFAULT_PLATFORM },
    diagnostics: { showDebugOverlay: false, lowFpsBannerDismissedForFps: null, logLevel: 'info' },
    sync: {
      enabled: false,
      roomCode: null,
      transport: 'auto',
      mqttUrl: '',
      ntfyBase: '',
      persistRemote: true,
      publishTelemetry: true,
    },
    ...patch,
  } as AppState;
}

interface Harness {
  container: HTMLElement;
  runtime: DisplayRuntime;
  setState(next: AppState): void;
  setGeometry(next: Geometry): void;
  unmount(): void;
}

function mount(initial: AppState, flags: Partial<RuntimeFlags> = {}): Harness {
  const container = document.createElement('div');
  document.body.append(container);

  let state = initial;
  const listeners = new Set<() => void>();
  const store = {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as Store;

  const geometry = externalValue(geometryOf());
  const runtime: DisplayRuntime = {
    store,
    geometry,
    frameClock: FRAME_CLOCK,
    monitoring: MONITORING,
    watchdog: { start: () => undefined, stop: () => undefined } as DisplayRuntime['watchdog'],
    flags: { diag: false, demo: false, pattern: null, stack: null, ...flags } as RuntimeFlags,
    moduleParams: {},
    layers: { current: null },
    onReinit: { current: null as ((reason: ReinitReason) => void) | null },
    onCommand: { current: null },
  };

  const dispose = mountDisplayApp(container, runtime);
  return {
    container,
    runtime,
    setState(next) {
      state = next;
      for (const l of [...listeners]) l();
    },
    setGeometry(next) {
      geometry.set(next);
    },
    unmount() {
      dispose();
      container.remove();
    },
  };
}

/** Long enough for `LayerHost`'s `await mod.loadDisplay()` to settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  registry.mods.clear();
  registry.mods.set('good', fakeModule('good', 'Clock'));
  registry.mods.set('broken', fakeModule('broken', 'Broken', { fails: true }));
  registry.mods.set('still', fakeModule('still', 'Shape', { placement: STATIC_PLACEMENT }));
  registry.mods.set('owns', fakeModule('owns', 'Video', { ownsFpsAdvisory: true }));
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('the stage', () => {
  it('carries the panel geometry and the background', () => {
    const h = mount(stateOf('good'));
    const stage = h.container.querySelector('.kh-stage');
    expect(stage).not.toBeNull();
    expect(stage?.getAttribute('data-shape')).toBe('circle');
    expect(stage?.getAttribute('data-target-fps')).toBe('40');
    // `maskCircle: 'auto'` on a round panel means masked.
    expect(stage?.classList.contains('kh-stage--circle')).toBe(true);
    h.unmount();
  });

  it('follows a geometry change and a background change', () => {
    const h = mount(stateOf('good'));
    h.setGeometry(geometryOf({ shape: 'square', targetFps: 25 }));
    const stage = h.container.querySelector<HTMLElement>('.kh-stage');
    expect(stage?.getAttribute('data-shape')).toBe('square');
    expect(stage?.getAttribute('data-target-fps')).toBe('25');
    expect(stage?.classList.contains('kh-stage--circle')).toBe(false);

    const next = stateOf('good');
    next.render = { ...next.render, background: '#123456' };
    h.setState(next);
    expect(stage?.style.background).toBe('rgb(18, 52, 86)');
    h.unmount();
  });

  it('never contains a link — invariant I1, from the shell side', () => {
    const h = mount(stateOf('good'));
    expect(h.container.querySelectorAll('.kh-stage a')).toHaveLength(0);
    h.unmount();
  });
});

describe('splash → stage → error card', () => {
  it('shows the base module name while the compositor is still mounting', () => {
    const h = mount(stateOf('good'));
    const splash = h.container.querySelector('.kh-splash');
    expect(splash?.textContent).toBe('Clock');
    expect(h.container.querySelector('.kh-stack')).not.toBeNull();
    h.unmount();
  });

  it('clears the splash once every layer is live', async () => {
    const h = mount(stateOf('good'));
    await settle();
    expect(h.container.querySelector('.kh-splash')).toBeNull();
    expect(h.container.querySelector('.kh-error')).toBeNull();
    h.unmount();
  });

  it('replaces the splash with the error card when a layer cannot start', async () => {
    const h = mount(stateOf('broken'));
    await settle();
    const card = h.container.querySelector('.kh-overlay.kh-error');
    expect(card).not.toBeNull();
    expect(card?.querySelector('.kh-card__title')?.textContent).toBe('Module failed to start');
    expect(card?.querySelector('.kh-card__body')?.textContent).toBe('no display build');
    // The one actionable instruction on a screen you cannot click.
    expect(card?.querySelector('.kh-card__footer')?.textContent).toBe(
      `Fix in ${CAM_PATH_CONFIGURE}`,
    );
    expect(h.container.querySelector('.kh-splash')).toBeNull();
    h.unmount();
  });

  it('gives the stage to the layer diagnostic under &pattern=stack', () => {
    const h = mount(stateOf('good'), { pattern: 'stack' });
    expect(h.container.querySelector('.kh-stack')).toBeNull();
    expect(h.container.querySelector('.kh-splash')).toBeNull();
    expect(h.container.querySelector('.kh-stage')).not.toBeNull();
    h.unmount();
  });
});

describe('the low-FPS advisory', () => {
  it('is silent above the threshold', () => {
    const h = mount(stateOf('good'));
    expect(h.container.querySelector('.kh-lowfps')).toBeNull();
    h.unmount();
  });

  it('names the slider at 1 FPS, then shrinks to a badge after 20 s', () => {
    vi.useFakeTimers();
    const h = mount(stateOf('good'));
    h.setGeometry(geometryOf({ targetFps: 1 }));

    const card = h.container.querySelector('.kh-overlay.kh-lowfps');
    expect(card?.querySelector('.kh-card__title')?.textContent).toBe('1 FPS');
    expect(card?.querySelector('.kh-card__body')?.textContent).toContain('Frame Rate');

    vi.advanceTimersByTime(20_000);
    expect(h.container.querySelector('.kh-overlay.kh-lowfps')).toBeNull();
    // ONE badge, app-wide: the same string the video module's own advisory
    // shrinks to (F12-3). It used to be a second, longer sentence here.
    expect(h.container.querySelector('.kh-lowfps__badge')?.textContent).toBe('1 FPS ⚠');
    expect(h.container.querySelector('.kh-lowfps__badge')?.textContent).toBe(
      renderFpsBadge(1).textContent,
    );

    // A NEW frame rate is a new advisory, from the top — what `key={targetFps}`
    // bought when this was a component.
    h.setGeometry(geometryOf({ targetFps: 5 }));
    expect(h.container.querySelector('.kh-overlay.kh-lowfps')).not.toBeNull();
    expect(h.container.querySelector('.kh-lowfps__badge')).toBeNull();

    // And it clears itself the moment the slider is raised.
    h.setGeometry(geometryOf({ targetFps: 40 }));
    expect(h.container.querySelector('.kh-lowfps')).toBeNull();
    h.unmount();
  });

  it('never nags for a look that does not move', () => {
    const h = mount(stateOf('still'));
    h.setGeometry(geometryOf({ targetFps: 1 }));
    expect(h.container.querySelector('.kh-lowfps')).toBeNull();
    h.unmount();
  });

  it('stands down for a module that draws its own advisory', () => {
    const h = mount(stateOf('owns'));
    h.setGeometry(geometryOf({ targetFps: 1 }));
    expect(h.container.querySelector('.kh-lowfps')).toBeNull();
    h.unmount();
  });

  /*
   * F12-1. CAM's slider tops out AT 1 FPS on a Kraken Z (320 round), and 1 is
   * also the low-FPS threshold — so a stock Z was permanently told to drag a
   * slider that is already at maximum to maximum, and then wore a permanent
   * badge for it. A panel at its ceiling has nothing to raise.
   */
  it('says nothing on a panel that is already at its maximum (Kraken Z at 1 FPS)', () => {
    const h = mount(stateOf('good'));
    h.setGeometry(geometryOf({ width: 320, height: 320, shape: 'circle', targetFps: 1 }));
    expect(h.container.querySelector('.kh-lowfps')).toBeNull();
    h.unmount();
  });

  it('still advises on an Elite at 1 FPS, whose slider goes to 40', () => {
    const h = mount(stateOf('good'));
    h.setGeometry(geometryOf({ targetFps: 1 }));
    expect(h.container.querySelector('.kh-lowfps')).not.toBeNull();
    h.unmount();
  });

  it('still advises on a panel nobody recognises: an unnamed ceiling is not a reached one', () => {
    const h = mount(stateOf('good'));
    h.setGeometry(geometryOf({ width: 300, height: 300, shape: 'circle', targetFps: 1 }));
    const body = h.container.querySelector('.kh-card__body')?.textContent;
    expect(body).toBe(fpsAdvisoryBody(null, { leadIn: true }));
    expect(body).not.toContain('on this panel');
    h.unmount();
  });

  /*
   * Round 13, M2. The card's body is a whole paragraph, and it shipped starting
   * on a lowercase verb — *"drag CAM → …"* — because the only variant camPaths
   * offered was the mid-sentence one About and CamSetupCard need. One function
   * owns both forms now; this pins the display card to the sentence-start one.
   */
  it('starts its instruction on a capital, because it is a whole sentence', () => {
    const h = mount(stateOf('good'));
    h.setGeometry(geometryOf({ targetFps: 1 }));
    const body = h.container.querySelector('.kh-card__body')?.textContent ?? '';
    expect(body.charAt(0)).toBe(body.charAt(0).toUpperCase());
    expect(body.charAt(0)).not.toBe(body.charAt(0).toLowerCase());
    expect(body.startsWith('Drag ')).toBe(true);
    h.unmount();
  });

  /*
   * Round 13, F1. On a 240 Kraken the safe box is 202 px square, and title +
   * body + footer do not fit in it at readable type. The footer is the line
   * that says the notice will go away on its own — which it does whether or
   * not the user was told — so it is dropped, not shrunk, exactly as the video
   * module drops its route footer under the same 300 px threshold.
   */
  it('drops the footer, rather than shrinking it, on a panel too small for three lines', () => {
    const small = mount(stateOf('good'));
    small.setGeometry(
      geometryOf({
        width: 240,
        height: 240,
        shape: 'square',
        targetFps: 1,
        safeInsetPx: 19,
        inscribedSquarePx: 240,
      }),
    );
    expect(small.container.querySelector('.kh-card__body')).not.toBeNull();
    expect(small.container.querySelector('.kh-card__footer')).toBeNull();
    small.unmount();

    const big = mount(stateOf('good'));
    big.setGeometry(geometryOf({ targetFps: 1, inscribedSquarePx: 453 }));
    expect(big.container.querySelector('.kh-card__footer')?.textContent).toBe(
      'This notice disappears once a higher frame rate is set.',
    );
    big.unmount();
  });

  /*
   * F12-3. The shell used to re-concatenate `lead + path + tail` by hand, which
   * silently dropped the per-panel ceiling `fpsAdvisoryBody()` adds — so the
   * video module said *"…to maximum (40 FPS on this panel)."* and every other
   * base said *"…to maximum."* on the same hardware.
   */
  it('speaks camPaths’ sentence verbatim, ceiling included', () => {
    const panels = [
      { geom: { width: 640, height: 640, shape: 'circle' as const }, max: 40 },
      { geom: { width: 240, height: 240, shape: 'square' as const }, max: 25 },
    ];
    for (const panel of panels) {
      const h = mount(stateOf('good'));
      h.setGeometry(geometryOf({ ...panel.geom, targetFps: 1 }));
      expect(h.container.querySelector('.kh-card__body')?.textContent).toBe(
        fpsAdvisoryBody(panel.max, { leadIn: true }),
      );
      h.unmount();
    }
  });
});

/**
 * F12-3, as a rule rather than a fix.
 *
 * `camPaths.ts` exports the instruction in three pieces ONLY because JSX needs
 * to bold the middle one. Every plain-text surface must build it from
 * `CAM_FRAME_RATE_INSTRUCTION` or `fpsAdvisoryBody()`; a `.ts` file that names
 * the pieces is re-assembling the sentence by hand, which is how the display's
 * banner came to differ from the video module's card in the first place.
 */
describe('nobody re-assembles the frame-rate instruction', () => {
  // From the project root: the dom environment's `import.meta.url` is not an
  // absolute file URL, and a walk that resolves to nothing is a vacuous rule.
  const SRC = join(process.cwd(), 'src');
  const ALLOWED = new Set(['config/camPaths.ts', 'config/camPaths.test.ts']);

  function walk(dir: string, rel = ''): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const here = rel === '' ? name : `${rel}/${name}`;
      if (statSync(abs).isDirectory()) out.push(...walk(abs, here));
      // `.tsx` is exempt: a component bolds the path, which needs the pieces.
      else if (name.endsWith('.ts') && !ALLOWED.has(here)) out.push(here);
    }
    return out;
  }

  const FILES = walk(SRC);

  it('finds source files to check at all', () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  it('leaves the pieces to JSX and gives everything else the whole sentence', () => {
    const offenders = FILES.filter((rel) =>
      /CAM_FRAME_RATE_(?:LEAD|TAIL)/.test(readFileSync(join(SRC, rel), 'utf8')),
    );
    expect(offenders, 'use fpsAdvisoryBody() or CAM_FRAME_RATE_INSTRUCTION').toEqual([]);
  });
});

describe('the debug overlay', () => {
  it('appears on the diagnostics flag and prints one line per layer', async () => {
    const h = mount(stateOf('good'));
    await settle();
    expect(h.container.querySelector('.kh-debug')).toBeNull();

    const on = stateOf('good');
    on.diagnostics = { ...on.diagnostics, showDebugOverlay: true };
    h.setState(on);

    const text = h.container.querySelector('.kh-debug')?.textContent ?? '';
    expect(text).toContain('640×640 circle (sim)');
    expect(text).toContain('target 40 fps · achieved 39.4');
    expect(text).toContain('long frames 2 · dpr 1');
    expect(text).toContain('safe inset 121px · inscribed 398px');
    // The compositor is registered, so the stack lines are there too.
    expect(text).toContain('1 layers');
    expect(text).toContain('base good');

    h.setState(stateOf('good'));
    expect(h.container.querySelector('.kh-debug')).toBeNull();
    h.unmount();
  });
});

describe('unmounting', () => {
  it('takes the stage with it and releases the compositor', async () => {
    const h = mount(stateOf('good'));
    await settle();
    expect(h.runtime.layers.current).not.toBeNull();
    h.unmount();
    expect(document.querySelector('.kh-stage')).toBeNull();
    expect(h.runtime.layers.current).toBeNull();
    expect(h.runtime.onCommand.current).toBeNull();
  });
});
