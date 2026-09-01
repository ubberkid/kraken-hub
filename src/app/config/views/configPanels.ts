/**
 * The options-panel chunk cache, and the prefetch that fills it (round 3, F3).
 *
 * A file of its own because it exports functions rather than components, and
 * because a cache that lives beside the component reading it is a cache that
 * gets a second copy the next time somebody needs one.
 *
 * ## Why this exists at all
 *
 * `ModuleSettingsView` used `React.lazy`, and the result was measured: the
 * options panel's opening spring animated against Suspense's *"Loading
 * settings…"* placeholder — a different height from the real content — and then
 * hard-cut to the panel when the chunk landed. 380 ms at the wrong height and a
 * one-frame snap, on the app's most-used gesture, every cold load.
 *
 * Prefetching the chunk is necessary but not sufficient: `lazy()` does not start
 * its import until its first render and suspends on that render even when the
 * module is already in the browser's cache, so the placeholder still gets a
 * paint. The component has to be **resolved before the element exists**, which
 * means owning the cache rather than asking `lazy` to. `readConfigPanel` is that
 * synchronous read; `prefetchConfigPanel` is what makes it hit.
 */

import { getModule } from '../../../modules/registry';

import type { ModuleConfigProps } from '../../../modules/types';
import type { ComponentType } from 'react';

/** Resolved panels, by module id. Module scope, so it survives remounts. */
const PANELS = new Map<string, ComponentType<ModuleConfigProps>>();

/** Fetches in flight, so a double press does not start a second one. */
const INFLIGHT = new Map<string, Promise<ComponentType<ModuleConfigProps> | null>>();

/** The panel for `id` if it is already resolved, without suspending anything. */
export function readConfigPanel(id: string): ComponentType<ModuleConfigProps> | null {
  return PANELS.get(id) ?? null;
}

/**
 * Fetch a module's options panel, and remember it.
 *
 * Idempotent and safe to call every render-ish: a resolved panel returns
 * immediately, an in-flight one shares its promise. A failure resolves to `null`
 * rather than rejecting — the caller's job is to render, not to report, and the
 * next call simply tries again, which is exactly what happened before any of
 * this existed.
 */
export function loadConfigPanel(id: string): Promise<ComponentType<ModuleConfigProps> | null> {
  const cached = PANELS.get(id);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = INFLIGHT.get(id);
  if (pending !== undefined) return pending;

  const mod = getModule(id);
  if (mod === null) return Promise.resolve(null);

  const fetching = mod
    .loadConfigPanel()
    .then((m) => {
      PANELS.set(id, m.ConfigPanel);
      return m.ConfigPanel;
    })
    .catch(() => null)
    .finally(() => {
      INFLIGHT.delete(id);
    });
  INFLIGHT.set(id, fetching);
  return fetching;
}

/**
 * Warm the cache for a module that has just become the active one.
 *
 * Choosing a module is a decision to look at that module, and its panel is a few
 * kB — so by the time the chip is pressed a second time (which is the gesture
 * that opens the options) the component is already resolved and the panel's
 * FIRST render is the real one.
 */
export function prefetchConfigPanel(id: string): void {
  void loadConfigPanel(id);
}
