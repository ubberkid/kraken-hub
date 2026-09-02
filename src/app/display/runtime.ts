/**
 * Everything the display tree needs, assembled once at boot.
 *
 * Kept in a plain `.ts` file so the `.tsx` components each export exactly one
 * component (React Fast Refresh, and the ESLint rule that guards it).
 */

import type { ReinitReason } from '../../modules/types';
import type { FrameClock } from '../../platform/fpsGovernor';
import type { Geometry } from '../../platform/geometry';
import type { MonitoringSource } from '../../platform/monitoring';
import type { Watchdog } from '../../platform/watchdog';
import type { LayerHost } from '../../render/LayerHost';
import type { Store } from '../../state/store';
import type { RuntimeFlags } from '../../state/urlParams';

/** A `useSyncExternalStore`-compatible holder for a single value. */
export interface ExternalValue<T> {
  get: () => T;
  set: (next: T) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createExternalValue<T>(initial: T): ExternalValue<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return;
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

export interface DisplayRuntime {
  store: Store;
  geometry: ExternalValue<Geometry>;
  frameClock: FrameClock;
  monitoring: MonitoringSource;
  watchdog: Watchdog;
  flags: RuntimeFlags;
  /** Raw module-scoped URL params (`src`, `loop`, `mute`) for the active module. */
  moduleParams: Readonly<Record<string, string>>;
  /**
   * The live compositor, registered by whatever owns the stage.
   *
   * `LayerStack` sets it on the normal display path and the `&pattern=stack`
   * diagnostic sets it on its own, which is what lets `DebugOverlay` print one
   * line per layer without knowing or caring which of the two is running. Null
   * whenever nothing is composited (the boot frame, a torn-down tree).
   */
  layers: { current: LayerHost | null };
  /** Registered by the compositor so the watchdog can reach the live renderers. */
  onReinit: { current: ((reason: ReinitReason) => void) | null };
  /**
   * Registered by the compositor so the sync `cmd` channel can reach the live
   * renderers. Null whenever nothing is composited at all.
   *
   * It returns whether the command actually REACHED a renderer, which is the
   * part a caller with something time-sensitive to say needs: the single-module
   * host registered this only after `await renderer.mount(...)`, so a non-null
   * handler used to mean a renderer that could act. The compositor outlives
   * every renderer it mounts, so "is anyone home?" moved from the handler's
   * existence into its answer. A command nobody could take is DROPPED here —
   * commands are time-sensitive, and replaying a seek at mount would be wrong;
   * `sync.ts` re-derives the position and asks again instead.
   */
  onCommand: { current: ((op: string, arg?: unknown) => boolean) | null };
}
