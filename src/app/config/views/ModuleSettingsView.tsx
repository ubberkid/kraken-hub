import { useEffect, useState, type ComponentType } from 'react';

import { getModule } from '../../../modules/registry';
import { withModuleConfig } from '../../../state/selectors';
import { Panel } from '../../../ui';

import { loadConfigPanel, readConfigPanel } from './configPanels';

import type { ModuleConfigProps } from '../../../modules/types';
import type { ConfigRuntime } from '../runtime';

/**
 * The active module's own panel, fetched on the decision rather than the press.
 *
 * ## Why this is not `React.lazy` any more (round 3, F3)
 *
 * It was, and the result was measured: the options panel's opening spring
 * animated against Suspense's `Loading settings…` placeholder — a different
 * height from the real content — for **380 ms**, and then hard-cut to the panel
 * when the chunk landed. One frame of snap on the app's most-used gesture,
 * every cold load.
 *
 * Prefetching the chunk is necessary but not sufficient: `lazy()` does not start
 * its import until its first render, and it suspends on that render even when
 * the module is already in the browser's cache, so the placeholder still gets a
 * paint. The component has to be *resolved before the element exists*, which
 * means owning the cache rather than asking `lazy` to.
 *
 * So: a module-scope cache, filled by `prefetchConfigPanel()` when a module
 * becomes the active one — choosing a module is a decision to look at it — and
 * read **synchronously as the initial state** here. In the ordinary path the
 * panel's first render is the real panel, so the spring has the true height from
 * its first frame and there is nothing to cut to.
 *
 * The cold path (a fork's slow chunk, a cold cache, a module switched and opened
 * inside one frame) renders nothing for a beat rather than something false. A
 * placeholder that is the wrong size is not more informative than a pause; it is
 * the same pause with a lie drawn over it.
 */

export function ModuleSettingsView({ runtime, id }: { runtime: ConfigRuntime; id: string }) {
  const mod = getModule(id);

  /*
   * Read synchronously, and re-read when the id changes.
   *
   * The `useState` initialiser only runs on mount, and this component is
   * remounted per module — but a `key` is not something this file controls, so
   * the derived-state pattern below re-syncs on an id change without an effect
   * and without a wasted render.
   */
  const [loaded, setLoaded] = useState<ComponentType<ModuleConfigProps> | null>(() =>
    readConfigPanel(id),
  );
  const [loadedFor, setLoadedFor] = useState(id);
  if (loadedFor !== id) {
    setLoadedFor(id);
    // Through a thunk, always: `setState(fn)` treats a function as an UPDATER
    // and calls it, and the value here is a React component — so passing it
    // directly invokes the panel with the previous state as its props.
    setLoaded(() => readConfigPanel(id));
  }

  useEffect(() => {
    if (readConfigPanel(id) !== null) return undefined;
    // A function through a closure rather than a boolean: TypeScript narrows a
    // plain flag to `true` across the await and the guard becomes dead code —
    // the same trick `useSync` and `ModuleHost` use for their teardown flags.
    let gone = false;
    const isGone = (): boolean => gone;
    void loadConfigPanel(id).then((found) => {
      // `setState` with a function argument would CALL the component; wrap it.
      if (!isGone() && found !== null) setLoaded(() => found);
    });
    return () => {
      gone = true;
    };
  }, [id]);

  if (mod === null) {
    return (
      <Panel title="Unknown module" hint={`No module is registered with the id "${id}".`}>
        <p className="kh-hint">
          If this configuration came from a fork, its settings are preserved untouched and will work
          again on that build.
        </p>
      </Panel>
    );
  }

  // Nothing, briefly, rather than a placeholder at the wrong height (F3).
  if (loaded === null) return null;

  const state = runtime.store.getSnapshot();
  const stored = Object.hasOwn(state.modules, mod.id) ? state.modules[mod.id]?.cfg : undefined;
  const ConfigPanel = loaded;

  return (
    <ConfigPanel
      config={mod.validate(stored)}
      onChange={(next) => {
        runtime.store.commit((s) => withModuleConfig(s, mod.id, mod.configVersion, next));
      }}
    />
  );
}
