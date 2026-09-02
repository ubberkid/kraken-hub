import { Suspense, lazy, useMemo, useSyncExternalStore } from 'react';

import { getModule, resolveModule } from '../../modules/registry';
import { stackMotionLevel } from '../../modules/stack';
import { configsOf, lookOf } from '../../render/lookOf';
import { selectMaskCircle } from '../../state/selectors';

import { DebugOverlay } from './DebugOverlay';
import { ErrorBoundary } from './ErrorBoundary';
import { LayerStack } from './LayerStack';
import { LowFpsBanner } from './LowFpsBanner';
import { ModuleErrorCard } from './ModuleErrorCard';
import { Stage } from './Stage';

import type { DisplayRuntime } from './runtime';

/** Diagnostics are lazy: the normal display path never downloads the probes. */
const DiagOverlay = lazy(async () => {
  const m = await import('../../diag/DiagOverlay');
  return { default: m.DiagOverlay };
});

/**
 * The whole LCD tree: about a dozen nodes, on purpose. React re-renders only on
 * human-driven state changes; per-frame work happens inside the compositor's
 * imperative renderers (invariant I4).
 */
export function DisplayApp({ runtime }: { runtime: DisplayRuntime }) {
  const state = useSyncExternalStore(runtime.store.subscribe, runtime.store.getSnapshot);
  const geometry = useSyncExternalStore(runtime.geometry.subscribe, runtime.geometry.get);

  const look = useMemo(() => lookOf(state), [state]);
  /*
   * The advisory is a property of the STACK, not of one module: one layer that
   * moves every frame is enough to be ruined by a 1 FPS capture, and a look made
   * entirely of static overlays should never nag. `ownsFpsAdvisory` stays a base
   * question — it is the video module's own card, drawn inside the video's own
   * safe area, and an overlay has no business suppressing the shell's banner.
   */
  const baseKind = look.layers[0]?.kind ?? '';
  const motionLevel = useMemo(() => {
    const cfgs = configsOf(look, state, getModule, runtime.moduleParams);
    return stackMotionLevel(look, getModule, (layer) => cfgs[layer.id]);
  }, [look, state, runtime.moduleParams]);

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
        {/* The layer diagnostic (`&pattern=stack`) OWNS the stage: leaving the
            configured look running underneath would put a second video decoder
            on the frame path and make every measurement a lie. It composites
            through the same `LayerHost` this branch would have mounted. */}
        {runtime.flags.pattern !== 'stack' && <LayerStack runtime={runtime} state={state} />}
        {/* Keyed by targetFps: a new frame rate re-shows the full advisory.
            `motionLevel` is the FpsAdvisory hook-in: a 1 FPS slider ruins the
            video module and merely dulls a clock, so a static look never nags. */}
        {resolveModule(baseKind).capabilities.ownsFpsAdvisory !== true && (
          <LowFpsBanner
            key={geometry.targetFps}
            targetFps={geometry.targetFps}
            threshold={state.platform.lowFpsThreshold}
            motionLevel={motionLevel}
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
