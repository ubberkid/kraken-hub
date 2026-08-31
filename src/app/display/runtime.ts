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
  /** Registered by ModuleHost so the watchdog can reach the live renderer. */
  onReinit: { current: ((reason: ReinitReason) => void) | null };
  /**
   * Registered by ModuleHost so the sync `cmd` channel can reach the live
   * renderer. Null whenever no module is mounted, which is exactly when an
   * inbound command must be dropped rather than queued: commands are
   * time-sensitive, and replaying a seek at mount would be wrong.
   */
  onCommand: { current: ((op: string, arg?: unknown) => void) | null };
}
