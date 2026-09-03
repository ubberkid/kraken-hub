/**
 * The compositor's LIFETIME is not a prop's identity.
 *
 * `EditorCanvas` builds a `LayerHost` in a layout effect and destroys it in the
 * cleanup, and that effect used to be keyed on the `panel` OBJECT. `panel` is
 * derived from `state.render`, `state.render` is rebuilt by `resolveState` on
 * every state delivery, so every inbound frame — every routine document write,
 * every peer's snapshot, changed or not — tore the whole compositor down and
 * built a new one: every layer unmounted, the effect canvas replaced, a fresh
 * WebGL context, `uTime` back to zero.
 *
 * That is what the user saw as a display "starting over from the beginning
 * constantly". A geometry change is `setPanel`, which the component already
 * calls; a geometry that did not change is not an event at all.
 *
 * So the rule, pinned on instance identity because a torn-down and rebuilt host
 * looks perfectly present every time you check: equal panel FIELDS, same
 * `LayerHost`. A field that genuinely changes still gets a new one.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultAppState } from '../../../../state/defaults';
import { baseLook } from '../../../../state/look/types';
import { replicaGeometry } from '../../replica';

import { EditorCanvas } from './EditorCanvas';

import type { Geometry } from '../../../../platform/geometry';
import type { EditorApi } from '../../editor/useEditor';

/** Every `LayerHost` this render tree ever built, in order. */
const built = vi.hoisted(() => ({ hosts: [] as object[], destroyed: 0 }));

vi.mock('../../../../render/LayerHost', () => ({
  LayerHost: class FakeLayerHost {
    constructor() {
      built.hosts.push(this);
    }
    setPanel(): void {
      /* geometry updates are not what this file measures */
    }
    setLook(): void {
      /* look updates are not what this file measures */
    }
    setMonitoring(): void {
      /* the CAM feed is not what this file measures */
    }
    setTier(): void {
      /* the governor is not what this file measures */
    }
    command(): boolean {
      return false;
    }
    destroy(): void {
      built.destroyed += 1;
    }
  },
}));

const state = defaultAppState();

/** Nothing this file asserts on happens through the editor's write path. */
function noop(): void {
  return undefined;
}

function editorStub(): EditorApi {
  const look = baseLook(state.activeModuleId);
  return {
    look,
    layers: look.layers,
    overlays: [],
    selection: [],
    selected: null,
    registry: { defaultConfigOf: () => ({}) },
    modules: [],
    select: noop,
    selectMany: noop,
    isSelected: () => false,
    isLocked: () => false,
    transform: noop,
    transformMany: noop,
    commitLook: noop,
    writeConfig: noop,
    canUndo: false,
    canRedo: false,
    refusal: null,
  } as unknown as EditorApi;
}

/** A panel with a brand-new identity and byte-identical fields. */
function panelOf(): Geometry {
  return replicaGeometry(
    { w: 640, h: 640, shape: 'circle', targetFps: 30 },
    { safeRadiusPct: state.render.safeRadiusPct, safeAreaPct: state.render.safeAreaPct },
  );
}

let host: HTMLDivElement;
let root: Root;
const editor = editorStub();

function draw(panel: Geometry): void {
  act(() => {
    root.render(
      <EditorCanvas
        editor={editor}
        state={state}
        panel={panel}
        monitor={null}
        monitorAt={0}
        progress={null}
        coarsePointer={false}
      />,
    );
  });
}

beforeEach(() => {
  // jsdom has neither, and the component is entitled to both.
  globalThis.ResizeObserver = class {
    observe(): void {
      return undefined;
    }
    unobserve(): void {
      return undefined;
    }
    disconnect(): void {
      return undefined;
    }
  };
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  built.hosts.length = 0;
  built.destroyed = 0;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

describe('the editor mirror', () => {
  it('keeps ONE LayerHost across a panel object with equal fields', () => {
    draw(panelOf());
    expect(built.hosts).toHaveLength(1);
    const first = built.hosts[0];

    // Ten deliveries of a state that changed nothing — what a room at rest used
    // to hand this component several times a second.
    for (let i = 0; i < 10; i += 1) draw(panelOf());

    expect(built.hosts).toHaveLength(1);
    expect(built.hosts[0]).toBe(first);
    expect(built.destroyed).toBe(0);
  });

  it('still rebuilds when the panel genuinely changes shape', () => {
    draw(panelOf());
    expect(built.hosts).toHaveLength(1);

    draw(
      replicaGeometry(
        { w: 800, h: 800, shape: 'square', targetFps: 30 },
        { safeRadiusPct: state.render.safeRadiusPct, safeAreaPct: state.render.safeAreaPct },
      ),
    );

    expect(built.hosts).toHaveLength(2);
    expect(built.destroyed).toBe(1);
  });
});
