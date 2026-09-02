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
