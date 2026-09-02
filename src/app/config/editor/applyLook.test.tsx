import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultAppState } from '../../../state/defaults';
import { applyLookFile, resolveMedia } from '../../../state/look/file';
import { templateById } from '../../../state/look/templates';
import { createStore, type Store } from '../../../state/store';

import { useEditor, type EditorApi } from './useEditor';

import type { LookFile } from '../../../state/look/file';
import type { ConfigRuntime } from '../runtime';

/**
 * §4's promise, measured: **applying a Look is ONE operation and ONE undo step.**
 *
 * Both halves matter and they fail differently. Two operations is two synced
 * snapshots, and a peer that saw only the first renders the new arrangement
 * wearing the old settings. Two undo entries is a user pressing undo, watching
 * the panel not change, and pressing it again — which is what "undo crosses the
 * switch" is written to prevent.
 *
 * The test drives the REAL hook against a REAL store rather than re-implementing
 * `applyLook`'s body, because the thing being asserted is precisely how many
 * times that body writes.
 */

const NEBULA = templateById('tpl-nebula-clock')!.file;
const MINIMAL = templateById('tpl-minimal-clock')!.file;

let host: HTMLDivElement;
let root: Root;
let store: Store;
let api: EditorApi;
let commits: number;

/**
 * A component whose only job is to run the hook and publish its handle.
 *
 * The publish happens in an effect rather than in the render body: reassigning
 * a module variable during render is a side effect, and React's own lint rule
 * says so — the handle is only used from inside `act`, which flushes effects
 * before it returns, so an effect is both correct and sufficient.
 */
function Probe({ runtime }: { runtime: ConfigRuntime }) {
  const next = useEditor({
    runtime,
    panel: { shape: 'circle' },
    render: { safeRadiusPct: 0.88 },
  });
  useEffect(() => {
    api = next;
  });
  return null;
}

function apply(file: LookFile): void {
  act(() => {
    api.applyLook(applyLookFile(store.getSnapshot(), resolveMedia(file, [])));
  });
}

beforeEach(() => {
  // React 19 wants this said out loud before `act` will drive a root.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  store = createStore(defaultAppState(), 'config', { commitBase: 'snapshot' });
  commits = 0;
  store.onCommit(() => {
    commits += 1;
  });
  act(() => {
    root.render(<Probe runtime={{ store } as unknown as ConfigRuntime} />);
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  store.dispose();
});

describe('applying a Look', () => {
  it('writes the arrangement and the base’s settings in one operation', () => {
    apply(NEBULA);
    expect(commits).toBe(1);
    const state = store.getSnapshot();
    // The arrangement…
    expect(state.look.layers.map((l) => l.kind)).toEqual(['effect', 'clock']);
    // …and the settings the base wears, which do not live in `look`.
    expect((state.modules['effect']?.cfg as { effect?: string } | undefined)?.effect).toBe(
      'twisted-nebula',
    );
  });

  it('keeps the two homes for the base kind in step', () => {
    apply(NEBULA);
    const state = store.getSnapshot();
    expect(state.activeModuleId).toBe('effect');
    expect(state.look.layers[0]?.kind).toBe('effect');
  });

  it('does not throw away a name the file gave its base layer', () => {
    const sunset = templateById('tpl-sunset-clock')!.file;
    apply(sunset);
    // `withBaseKind` rebuilds the base from `baseLook()`; writing the file's own
    // look after it is what keeps this true.
    expect(store.getSnapshot().look.layers[0]?.name).toBe('Your clip');
  });

  it('is one undo step, and undo crosses the switch', () => {
    apply(NEBULA);
    apply(MINIMAL);
    expect(store.getSnapshot().look.layers.map((l) => l.kind)).toEqual(['clock']);

    act(() => {
      api.undo();
    });
    expect(store.getSnapshot().look.layers.map((l) => l.kind)).toEqual(['effect', 'clock']);

    act(() => {
      api.undo();
    });
    expect(store.getSnapshot().look.layers.map((l) => l.kind)).toEqual([
      defaultAppState().look.layers[0]?.kind,
    ]);
  });

  it('leaves every other kind’s settings exactly where they were', () => {
    act(() => {
      store.commit((s) => ({
        ...s,
        modules: { ...s.modules, text: { v: 1, cfg: { text: 'hi' } } },
      }));
    });
    apply(NEBULA);
    expect(store.getSnapshot().modules['text']?.cfg).toEqual({ text: 'hi' });
  });
});
