/**
 * The measurement path, checked for the one thing that would silently invalidate
 * it: the five stacks must actually be composited, in order, by the real
 * `LayerHost`.
 *
 * W0 drove them through a throwaway compositor and two throwaway KINDS. Both are
 * gone — the stacks now name `effect` and `text`, which are registered modules —
 * and that swap is precisely the change that could silently invalidate the
 * measurement. If a stack quietly lost a layer — an overlay-incapable kind, an
 * instance cap, a kind this build does not have — every number filmed off the LCD
 * would be a number for a different stack, and nothing would say so. So: DOM
 * order equals look order, at every stack, and every kind is a real one.
 */

import { describe, expect, it } from 'vitest';

import { getModule } from '../../modules/registry';
import { normalizeLook } from '../../modules/stack';
import { configsOf } from '../../render/lookOf';
import { IDENTITY } from '../../state/look/types';

import { STACK_IDS, stackLook, stackRegistry, startStackPattern } from './stack';

import type { DisplayRuntime } from '../../app/display/runtime';
import type { FrameInfo } from '../../platform/fpsGovernor';
import type { Geometry } from '../../platform/geometry';

const PANEL: Geometry = {
  // device-size-ok: a simulated panel; the number is the fixture, not a constant.
  width: 400,
  height: 400,
  shape: 'circle',
  targetFps: 40,
  dpr: 1,
  source: 'sim',
  safeInsetPx: 76,
  inscribedSquarePx: 283,
  radiusPx: 200,
};

function fakeRuntime(): DisplayRuntime {
  const subs = new Set<(f: FrameInfo) => void>();
  return {
    store: { getSnapshot: () => ({ render: { safeRadiusPct: 0.88, safeAreaPct: 0.08 } }) },
    geometry: { get: () => PANEL, set: () => undefined, subscribe: () => () => undefined },
    frameClock: {
      subscribe: (cb: (f: FrameInfo) => void) => {
        subs.add(cb);
        return () => subs.delete(cb);
      },
      pause: () => undefined,
      resume: () => undefined,
      stats: () => ({ achievedFps: 40, longFrames: 0, lastTickAt: 0, paused: false, frame: 0 }),
      stop: () => undefined,
    },
    monitoring: { subscribe: () => () => undefined },
    layers: { current: null },
    onReinit: { current: null },
    onCommand: { current: null },
  } as unknown as DisplayRuntime;
}

describe('the stack diagnostic', () => {
  it.each([...STACK_IDS])('composites stack %s in look order, base first', (id) => {
    const look = stackLook(id);
    // Nothing may be silently dropped: a note here means the stack being filmed
    // is not the stack the checklist row describes.
    expect(normalizeLook(look, stackRegistry).notes).toEqual([]);

    const runtime = fakeRuntime();
    const root = document.createElement('div');
    document.body.append(root);
    const stop = startStackPattern(root, runtime, id);

    const hosts = [...root.children].filter((el) => el.classList.contains('kh-layer'));
    expect(hosts.map((el) => (el as HTMLElement).dataset['layer'])).toEqual(
      look.layers.map((l) => l.id),
    );
    expect((hosts[0] as HTMLElement).dataset['role']).toBe('base');
    expect((hosts[0] as HTMLElement).dataset['module']).toBe(look.layers[0]?.kind);
    expect(hosts.slice(1).every((el) => (el as HTMLElement).dataset['role'] === 'overlay')).toBe(
      true,
    );
    expect(runtime.layers.current).not.toBeNull();

    stop();
    expect(runtime.layers.current).toBeNull();
    root.remove();
  });

  it('names only REAL registered kinds — the two W0 stand-ins are gone', () => {
    const kinds = new Set(STACK_IDS.flatMap((id) => stackLook(id).layers.map((l) => l.kind)));
    for (const kind of kinds) expect(getModule(kind)).not.toBeNull();
    // The stand-ins were called `plasma` and `label`; `plasma` survives only as
    // an EFFECT id inside the effect layer's config, never as a layer kind.
    expect(kinds).toEqual(new Set(['video', 'stats', 'clock', 'effect', 'text']));
    // ...and the file's registry is now the real one, with nothing wrapped
    // around it: a stand-in could not be reached even if one were reintroduced.
    expect(stackRegistry('plasma')).toBeNull();
    expect(stackRegistry('label')).toBeNull();
    expect(stackRegistry('effect')).toBe(getModule('effect'));
  });

  it('keeps the W0 cost slots: effect is the frame-cadence base, text is static', () => {
    // The measurement semantics, not the implementation. `plasma` stood in for a
    // full-frame GPU layer and `label` for a free DOM node; if the real kinds did
    // not occupy those slots the recorded W0 tables would no longer be comparable.
    expect(getModule('effect')?.layer?.cost(null, { frame: 'panel', t: IDENTITY })).toMatchObject({
      cadence: 'frame',
      coverage: 1,
      gl: 1,
    });
    expect(getModule('text')?.capabilities.needsFrameLoop).toBe(false);
    expect(getModule('text')?.layer?.cost(null, { frame: 'panel', t: IDENTITY }).cadence).toBe(
      'static',
    );
  });

  it('reaches MAX_LAYERS on stack e — the worst legal stack is actually eight', () => {
    expect(stackLook('e').layers).toHaveLength(8);
  });

  it('resolves a config for every layer, base from the bank and overlays from the look', () => {
    for (const id of STACK_IDS) {
      const look = stackLook(id);
      const cfgs = configsOf(look, { modules: {} }, stackRegistry);
      for (const layer of look.layers) expect(layer.id in cfgs).toBe(true);
    }
  });
});
