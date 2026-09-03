import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRenderer, GL_ATTR, GL_LOST_ATTR } from './display';
import { loadFragment } from './effects';
import { EFFECT_DEFAULTS } from './schema';

import type { ModuleContext } from '../types';

/**
 * H29, as a fact on the element.
 *
 * `display.ts` picks WebGL2, then WebGL1, then a CSS still frame, and until this
 * attribute existed nothing on the page said which of the three a given panel
 * had taken — the diagnostics report could say what the webview *offers*, never
 * what this instance got. jsdom grants no GL at all, which makes it the exact
 * rig for the bottom rung, and one stubbed `getContext` covers the other two.
 */

/**
 * A fake context that compiles, links and draws.
 *
 * A Proxy rather than twenty stub methods: the runner only ever calls, and the
 * two questions it asks — `COMPILE_STATUS`, `LINK_STATUS` — are the two that
 * have to answer `true`. `getExtension` returns `null` so `WEBGL_lose_context`
 * is honestly absent.
 */
function fakeGl(): unknown {
  const noop = (): void => undefined;
  return new Proxy(
    {},
    {
      get(_t, prop: string | symbol) {
        if (prop === 'getShaderParameter' || prop === 'getProgramParameter') return () => true;
        if (prop === 'getExtension') return () => null;
        if (prop === 'isContextLost') return () => false;
        if (prop === 'createShader' || prop === 'createProgram' || prop === 'createBuffer') {
          return () => ({});
        }
        if (prop === 'getUniformLocation') return () => ({});
        if (prop === 'getAttribLocation') return () => 0;
        // Every enum the runner reads is only ever handed straight back to this
        // same object, so any number will do.
        if (typeof prop === 'string' && /^[A-Z_]+$/.test(prop)) return 1;
        return noop;
      },
    },
  );
}

let host: HTMLDivElement;

function context(): ModuleContext {
  return {
    geometry: () => ({ width: 64, height: 64 }) as unknown as ReturnType<ModuleContext['geometry']>,
    frameClock: {} as ModuleContext['frameClock'],
    monitoring: {} as ModuleContext['monitoring'],
    render: () => ({}) as ReturnType<ModuleContext['render']>,
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    signal: new AbortController().signal,
  };
}

/** One macrotask. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Generous enough to absorb a cold chunk, short enough to fail fast. */
const POLLS = 200;

/**
 * Mount, and wait for the fragment source's dynamic `import()` to land.
 *
 * `mount()` writes `data-gl="none"` synchronously — that is the honest answer
 * before a program exists — and only upgrades it inside the `.then` of
 * `loadFragment()`. Waiting a fixed `setTimeout(0)` for that was a race: the
 * first run of the plasma chunk in a worker pays Vite's transform, which is
 * comfortably more than one macrotask, so in a combined `vitest run src/modules`
 * the `webgl2` case read the pre-load `none` and failed while passing alone.
 *
 * So the wait is on the actual event instead of on a duration. `beforeAll`
 * pre-warms the chunk; awaiting the same (now cached) loader here guarantees
 * the renderer's own `.then` — registered first, on the same promise — has
 * already run. The bounded poll afterwards costs nothing when the attribute is
 * already settled and keeps the test from being a stopwatch.
 */
async function mounted(want: 'none' | 'webgl1' | 'webgl2'): Promise<HTMLElement> {
  const renderer = createRenderer();
  // `mount` is synchronous here; the contract's `void | Promise<void>` is what
  // the `void` is for.
  void renderer.mount(host, context(), EFFECT_DEFAULTS);
  await loadFragment(EFFECT_DEFAULTS.effect);
  const root = host.querySelector<HTMLElement>('.kh-effect');
  expect(root).not.toBeNull();
  for (let i = 0; i < POLLS && root!.getAttribute(GL_ATTR) !== want; i += 1) {
    await tick();
  }
  return root!;
}

beforeAll(async () => {
  // Load the chunk once, outside any test, so no test measures its transform.
  await loadFragment(EFFECT_DEFAULTS.effect);
});

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  vi.restoreAllMocks();
  host.remove();
});

/**
 * Grant exactly one context kind, for exactly one test.
 *
 * A spy rather than an assignment to `HTMLCanvasElement.prototype`: an
 * assignment outlives the test that made it (and, with a shared jsdom, the file
 * that made it), which is how `webgl2` once ended up answering in suites that
 * had asked for nothing. `vi.restoreAllMocks()` in `afterEach` puts the real
 * method — jsdom's, which grants nothing — back.
 */
function grantGl(kind: 'webgl' | 'webgl2'): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((asked: string) =>
    asked === kind ? fakeGl() : null) as never);
}

/**
 * A rig that mirrors the ONE Chromium behaviour the white-panel bug turned on:
 * once `WEBGL_lose_context.loseContext()` has been called, `getContext` on that
 * SAME canvas returns the SAME context object, still lost, forever. The old
 * `fakeGl()` above cannot express it — it returns `null` from `getExtension` and
 * a fresh object per call — which is exactly why a jsdom suite and a headless
 * SwiftShader e2e both passed while a real Kraken went white.
 */
interface FakeCtx {
  lost: boolean;
  /** Every program this context has linked, newest last. */
  programs: object[];
  /** `{ prog, name }` per `getUniformLocation`, so a test can prove re-fetches. */
  uniforms: { prog: object; name: string }[];
  loseCalls: number;
  deletedPrograms: object[];
  gl: unknown;
}

interface GlRig {
  /** One entry per canvas element that was ever asked for a context. */
  readonly perCanvas: Map<HTMLCanvasElement, { calls: number; ctx: FakeCtx | null }>;
  readonly contexts: FakeCtx[];
  loseCalls(): number;
}

function makeCtx(): FakeCtx {
  const state: FakeCtx = {
    lost: false,
    programs: [],
    uniforms: [],
    loseCalls: 0,
    deletedPrograms: [],
    gl: null,
  };
  let current: object | null = null;
  const noop = (): void => undefined;
  state.gl = new Proxy(
    {},
    {
      get(_t, prop: string | symbol) {
        switch (prop) {
          case 'getShaderParameter':
          case 'getProgramParameter':
            return () => !state.lost;
          case 'isContextLost':
            return () => state.lost;
          case 'getExtension':
            return (name: string) =>
              name === 'WEBGL_lose_context'
                ? {
                    loseContext: () => {
                      state.lost = true;
                      state.loseCalls += 1;
                    },
                    restoreContext: () => {
                      state.lost = false;
                    },
                  }
                : null;
          case 'createShader':
            return () => ({});
          case 'createProgram':
            return () => {
              const prog = { id: state.programs.length };
              state.programs.push(prog);
              current = prog;
              return prog;
            };
          case 'deleteProgram':
            return (prog: object) => {
              state.deletedPrograms.push(prog);
            };
          case 'createBuffer':
            return () => ({});
          case 'getUniformLocation':
            return (prog: object, name: string) => {
              state.uniforms.push({ prog, name });
              return { prog, name };
            };
          case 'getAttribLocation':
            return () => 0;
          default:
            if (typeof prop === 'string' && /^[A-Z_]+$/.test(prop)) return 1;
            return noop;
        }
      },
    },
  );
  void current;
  return state;
}

/**
 * Grant `kind` on every canvas, per ELEMENT — a canvas that has lost its context
 * keeps handing the same dead one back, which is the spec behaviour.
 */
function installGl(kind: 'webgl' | 'webgl2'): GlRig {
  const perCanvas = new Map<HTMLCanvasElement, { calls: number; ctx: FakeCtx | null }>();
  const contexts: FakeCtx[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
    asked: string,
  ) {
    let entry = perCanvas.get(this);
    if (entry === undefined) {
      entry = { calls: 0, ctx: null };
      perCanvas.set(this, entry);
    }
    if (asked !== kind) return null;
    entry.calls += 1;
    if (entry.ctx === null) {
      const made = makeCtx();
      contexts.push(made);
      entry.ctx = made;
    }
    // The lost context is returned AS IS. No new context is ever handed to a
    // canvas that has had one.
    return entry.ctx.gl;
  } as never);
  return {
    perCanvas,
    contexts,
    loseCalls: () => contexts.reduce((n, c) => n + c.loseCalls, 0),
  };
}

/** The live context of the canvas currently inside `root`. */
function liveCtx(rig: GlRig, root: HTMLElement): FakeCtx {
  const canvas = root.querySelector<HTMLCanvasElement>('canvas');
  const entry = canvas === null ? undefined : rig.perCanvas.get(canvas);
  expect(entry?.ctx).toBeTruthy();
  return entry!.ctx!;
}

/** Mount and wait for the first program, keeping the renderer for `update()`. */
async function mountRenderer(): Promise<{
  renderer: ReturnType<typeof createRenderer>;
  root: HTMLElement;
}> {
  const renderer = createRenderer();
  void renderer.mount(host, context(), EFFECT_DEFAULTS);
  await loadFragment(EFFECT_DEFAULTS.effect);
  const root = host.querySelector<HTMLElement>('.kh-effect')!;
  for (let i = 0; i < POLLS && root.getAttribute(GL_ATTR) === 'none'; i += 1) await tick();
  return { renderer, root };
}

/** Change `cfg.effect` and wait for the new program to be linked. */
async function switchEffect(
  renderer: ReturnType<typeof createRenderer>,
  root: HTMLElement,
  rig: GlRig,
  id: 'voronoi' | 'twisted-nebula' | 'prism',
): Promise<void> {
  const was = liveCtx(rig, root);
  const before = was.programs.length;
  renderer.update({ ...EFFECT_DEFAULTS, effect: id }, { changed: ['effect'], origin: 'local' });
  await loadFragment(id);
  for (let i = 0; i < POLLS; i += 1) {
    const now = liveCtx(rig, root);
    if (now !== was || now.programs.length > before) return;
    await tick();
  }
}

describe('switching effect keeps the context and rebuilds only the program', () => {
  it('asks the canvas for a context ONCE across two runtime switches', async () => {
    const rig = installGl('webgl2');
    const { renderer, root } = await mountRenderer();
    const canvas = root.querySelector('canvas')!;
    expect(root.getAttribute(GL_ATTR)).toBe('webgl2');
    expect(rig.perCanvas.get(canvas)?.calls).toBe(1);

    await switchEffect(renderer, root, rig, 'voronoi');
    await switchEffect(renderer, root, rig, 'twisted-nebula');

    // Same element, same context object, one grant.
    expect(root.querySelector('canvas')).toBe(canvas);
    expect(rig.contexts).toHaveLength(1);
    expect(rig.perCanvas.get(canvas)?.calls).toBe(1);
    // Three programs — one per effect — on that one context.
    expect(liveCtx(rig, root).programs).toHaveLength(3);
    // …and the switch NEVER drops the context. This is the bug, in one line.
    expect(rig.loseCalls()).toBe(0);
    expect(liveCtx(rig, root).lost).toBe(false);
    expect(root.getAttribute(GL_ATTR)).toBe('webgl2');
    expect(root.getAttribute(GL_LOST_ATTR)).toBeNull();
  });

  it('re-fetches every uniform location from the NEW program', async () => {
    const rig = installGl('webgl2');
    const { renderer, root } = await mountRenderer();
    const ctx = liveCtx(rig, root);

    await switchEffect(renderer, root, rig, 'voronoi');

    const newest = ctx.programs[ctx.programs.length - 1];
    const fetched = ctx.uniforms.filter((u) => u.prog === newest).map((u) => u.name);
    // A location belongs to a program; carrying one across a switch is
    // meaningless even when the uniform has the same name.
    for (const name of ['uTime', 'uResolution', 'uTemp', 'uScale', 'uBright', 'uColor0']) {
      expect(fetched).toContain(name);
    }
    // The outgoing program is deleted; the context is not.
    expect(ctx.deletedPrograms).toContain(ctx.programs[0]);
  });

  it('gets a drawable context back after hidden → visible', async () => {
    const rig = installGl('webgl2');
    const { renderer, root } = await mountRenderer();
    const first = root.querySelector('canvas')!;

    renderer.visibility?.('hidden');
    // Hiding DOES give the context back — that part was always right.
    expect(rig.loseCalls()).toBe(1);
    expect(root.getAttribute(GL_ATTR)).toBe('none');

    renderer.visibility?.('visible');
    // …so coming back needs a FRESH element: the old canvas would hand over the
    // same dead context, which is what painted the panel white.
    const second = root.querySelector('canvas')!;
    expect(second).not.toBe(first);
    expect(root.getAttribute(GL_ATTR)).toBe('webgl2');
    expect(liveCtx(rig, root).lost).toBe(false);
    expect(liveCtx(rig, root).programs.length).toBeGreaterThan(0);
  });

  it('rebuilds on a fresh canvas when a switch is asked of a lost context', async () => {
    const rig = installGl('webgl2');
    const { renderer, root } = await mountRenderer();
    const first = root.querySelector('canvas')!;
    // The driver takes it away underneath us, without the event arriving.
    liveCtx(rig, root).lost = true;

    await switchEffect(renderer, root, rig, 'prism');

    const second = root.querySelector('canvas')!;
    expect(second).not.toBe(first);
    expect(liveCtx(rig, root).lost).toBe(false);
    expect(root.getAttribute(GL_ATTR)).toBe('webgl2');
  });

  it('recovers from a webglcontextlost event onto a new canvas', async () => {
    const rig = installGl('webgl2');
    const { renderer, root } = await mountRenderer();
    const first = root.querySelector('canvas')!;

    first.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(root.getAttribute(GL_LOST_ATTR)).toBe('true');
    expect(root.getAttribute(GL_ATTR)).toBe('none');
    // A real loss means the old context object is gone for good, so mark it.
    liveCtx(rig, root).lost = true;

    // The watchdog path — no restore event ever comes.
    renderer.reinit?.('manual');
    const second = root.querySelector('canvas')!;
    expect(second).not.toBe(first);
    expect(root.getAttribute(GL_ATTR)).toBe('webgl2');
    expect(liveCtx(rig, root).lost).toBe(false);
  });
});

describe('the effect host says which renderer it got', () => {
  it('says "none" where there is no GL at all — the CSS still frame', async () => {
    const root = await mounted('none');
    expect(root.getAttribute(GL_ATTR)).toBe('none');
    // …and the still frame it is claiming is genuinely painted.
    expect(root.style.getPropertyValue('--kh-effect-a')).not.toBe('');
  });

  it('says "webgl2" when the webview grants one', async () => {
    grantGl('webgl2');
    expect((await mounted('webgl2')).getAttribute(GL_ATTR)).toBe('webgl2');
  });

  it('says "webgl1" when only the older context is offered', async () => {
    grantGl('webgl');
    expect((await mounted('webgl1')).getAttribute(GL_ATTR)).toBe('webgl1');
  });

  it('marks a lost context, and stops marking it once it is back', async () => {
    grantGl('webgl2');
    const root = await mounted('webgl2');
    const canvas = root.querySelector('canvas')!;

    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(root.getAttribute(GL_LOST_ATTR)).toBe('true');
    // Lost means the still frame is what is on screen, and it says so.
    expect(root.getAttribute(GL_ATTR)).toBe('none');

    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(root.getAttribute(GL_LOST_ATTR)).toBeNull();
    expect(root.getAttribute(GL_ATTR)).toBe('webgl2');
  });
});
