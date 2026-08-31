import { Suspense, lazy, useSyncExternalStore } from 'react';

import { resolveModule } from '../../modules/registry';
import { selectMaskCircle } from '../../state/selectors';

import { DebugOverlay } from './DebugOverlay';
import { ErrorBoundary } from './ErrorBoundary';
import { LowFpsBanner } from './LowFpsBanner';
import { ModuleErrorCard } from './ModuleErrorCard';
import { ModuleHost } from './ModuleHost';
import { Stage } from './Stage';

import type { DisplayRuntime } from './runtime';

/** Diagnostics are lazy: the normal display path never downloads the probes. */
const DiagOverlay = lazy(async () => {
  const m = await import('../../diag/DiagOverlay');
  return { default: m.DiagOverlay };
});

/**
 * The whole LCD tree: about a dozen nodes, on purpose. React re-renders only on
 * human-driven state changes; per-frame work happens inside the module's
 * imperative renderer (invariant I4).
 */
export function DisplayApp({ runtime }: { runtime: DisplayRuntime }) {
  const state = useSyncExternalStore(runtime.store.subscribe, runtime.store.getSnapshot);
  const geometry = useSyncExternalStore(runtime.geometry.subscribe, runtime.geometry.get);

  return (
    <ErrorBoundary
      fallback={(error) => (
        <Stage
          geometry={geometry}
          masked={selectMaskCircle(state, geometry.shape)}
          background="#000"
        >
          <ModuleErrorCard title="Display error" detail={error.message} />
        </Stage>
      )}
    >
      <Stage
        geometry={geometry}
        masked={selectMaskCircle(state, geometry.shape)}
        background={state.render.background}
      >
        <ModuleHost runtime={runtime} state={state} moduleId={state.activeModuleId} />
        {/* Keyed by targetFps: a new frame rate re-shows the full advisory.
            `motionLevel` is the FpsAdvisory hook-in: a 1 FPS slider ruins the
            video module and merely dulls a clock, so a static module never
            nags. */}
        {resolveModule(state.activeModuleId).capabilities.ownsFpsAdvisory !== true && (
          <LowFpsBanner
            key={geometry.targetFps}
            targetFps={geometry.targetFps}
            threshold={state.platform.lowFpsThreshold}
            motionLevel={resolveModule(state.activeModuleId).capabilities.motionLevel}
          />
        )}
        {state.diagnostics.showDebugOverlay && <DebugOverlay runtime={runtime} />}
        {runtime.flags.diag && (
          <Suspense fallback={null}>
            <DiagOverlay runtime={runtime} />
          </Suspense>
        )}
      </Stage>
    </ErrorBoundary>
  );
}
