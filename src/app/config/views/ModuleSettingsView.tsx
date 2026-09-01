import { Suspense, lazy, type ComponentType } from 'react';

import { getModule, listModules } from '../../../modules/registry';
import { withModuleConfig } from '../../../state/selectors';
import { Panel } from '../../../ui';

import type { ModuleConfigProps } from '../../../modules/types';
import type { ConfigRuntime } from '../runtime';

/**
 * One lazy wrapper per registered module, built once at module scope.
 *
 * Creating a component during render would reset its state and its Suspense
 * boundary on every keystroke in the panel, so the wrappers are made eagerly
 * (they are just thunks — no panel code is fetched until one is rendered).
 */
const PANELS: ReadonlyMap<string, ComponentType<ModuleConfigProps>> = new Map(
  listModules().map((mod) => [
    mod.id,
    lazy(async () => {
      const m = await mod.loadConfigPanel();
      return { default: m.ConfigPanel };
    }),
  ]),
);

/**
 * Renders the active module's own panel, so a config page only downloads the
 * panel for the route actually visited.
 */
export function ModuleSettingsView({ runtime, id }: { runtime: ConfigRuntime; id: string }) {
  const mod = getModule(id);
  // Looked up, never created: PANELS is built once at module scope above, so
  // the identity is stable across renders. The rule cannot see through the Map.
  const LazyConfigPanel = mod === null ? undefined : PANELS.get(mod.id);

  if (mod === null || LazyConfigPanel === undefined) {
    return (
      <Panel title="Unknown module" hint={`No module is registered with the id "${id}".`}>
        <p className="kh-hint">
          If this configuration came from a fork, its settings are preserved untouched and will work
          again on that build.
        </p>
      </Panel>
    );
  }

  const state = runtime.store.getSnapshot();
  const stored = Object.hasOwn(state.modules, mod.id) ? state.modules[mod.id]?.cfg : undefined;

  return (
    /*
      The fallback carries no title.

      It used to be `<Panel title={mod.name}>`, and the contextual panel's own
      head now carries that name — so for the length of one lazy chunk fetch the
      screen printed "Clock" twice, six pixels apart, and then printed it once.
    */
    <Suspense fallback={<Panel>Loading settings…</Panel>}>
      {/*
        `react-hooks/static-components` fires because it cannot prove that a
        capitalised local binding is stable. This one is: `PANELS` is built once
        at module scope, and `LazyConfigPanel` is a lookup out of it, never a
        `lazy()` call made during render. The rule cannot see through the `Map`,
        so the suppression is the only way to say so — and it is scoped to this
        single element rather than the file, so a genuinely-created component
        added below would still be caught.
      */}
      {/* eslint-disable-next-line react-hooks/static-components */}
      <LazyConfigPanel
        config={mod.validate(stored)}
        onChange={(next) => {
          runtime.store.commit((s) => withModuleConfig(s, mod.id, mod.configVersion, next));
        }}
      />
    </Suspense>
  );
}
