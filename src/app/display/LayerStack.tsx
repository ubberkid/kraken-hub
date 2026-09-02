/*
 * The React Compiler's immutability rule cannot model this file, for the same
 * reason it could not model the single-module host it replaces: by design the
 * display is a React *shell* around an imperative compositor that owns the DOM
 * (design-architecture.md §2.1), so it hands the runtime's accessor functions to
 * non-React code. Nothing here mutates props; the rule flags any call through a
 * prop-held function property.
 */
/* eslint-disable react-hooks/immutability */
import { useEffect, useMemo, useRef, useState } from 'react';

import { getModule, resolveModule } from '../../modules/registry';
import { createLayerGovernor } from '../../render/layerGovernor';
import { LayerHost, type LayerHostStatus } from '../../render/LayerHost';
import { configsOf, lookOf } from '../../render/lookOf';

import { ModuleErrorCard } from './ModuleErrorCard';

import type { DisplayRuntime } from './runtime';
import type { AppState } from '../../state/schema';

/**
 * The whole stage, as one compositor.
 *
 * There is exactly ONE `LayerHost` per display and it lives for the life of the
 * runtime: a look change is a reconcile, not a remount, so switching the base
 * module no longer tears the stage down and rebuilds it. Everything per-frame
 * happens inside the compositor's own clock subscription; this component
 * re-renders only when the compositor's *status* changes — a layer finished
 * mounting, or one failed — which is at most a handful of times per session.
 *
 * For a base-only look (every document before W1b writes one) the DOM this
 * produces is the one the display has always produced: a single
 * `.kh-stage__module[data-module]` div with the renderer inside it.
 */
const EMPTY_STATUS: LayerHostStatus = { ready: false, failures: [], notes: [] };

/**
 * Once a second, off the frame path (invariant I4). The governor's thresholds
 * are ten and thirty seconds, so a faster sample buys nothing and a React
 * update inside a tick is exactly what I4 forbids.
 */
const GOVERNOR_SAMPLE_MS = 1000;

export function LayerStack({ runtime, state }: { runtime: DisplayRuntime; state: AppState }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<LayerHost | null>(null);
  const [status, setStatus] = useState<LayerHostStatus>(EMPTY_STATUS);

  const look = useMemo(() => lookOf(state), [state]);
  const cfgs = useMemo(
    () => configsOf(look, state, getModule, runtime.moduleParams),
    [look, state, runtime.moduleParams],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return undefined;

    const host = new LayerHost(root, {
      registry: getModule,
      panel: runtime.geometry.get(),
      clock: runtime.frameClock,
      render: () => runtime.store.getSnapshot().render,
      monitoring: runtime.monitoring,
    });
    hostRef.current = host;
    runtime.layers.current = host;
    runtime.onReinit.current = (reason) => {
      host.reinit(reason);
    };
    // The boolean is the point: `host.command` says whether a live renderer
    // took it, and `display/sync.ts` waits on that answer for the retained
    // position rather than on the handler merely existing (runtime.ts).
    runtime.onCommand.current = (op, arg) => host.command(op, arg);

    const offStatus = host.subscribe(() => {
      setStatus(host.status());
    });
    const offGeometry = runtime.geometry.subscribe(() => {
      host.setPanel(runtime.geometry.get());
    });
    const offMonitoring = runtime.monitoring.subscribe((n, raw) => {
      host.setMonitoring(n, raw);
    });

    // The governor never removes a layer; it only makes the stack coarser, and
    // it says so through `budget()`. See render/layerGovernor.ts.
    const governor = createLayerGovernor();
    const timer = setInterval(() => {
      const clock = runtime.frameClock.stats();
      host.setTier(
        governor.sample({
          t: performance.now(),
          achievedFps: clock.achievedFps,
          targetFps: runtime.geometry.get().targetFps,
        }),
      );
    }, GOVERNOR_SAMPLE_MS);

    return () => {
      clearInterval(timer);
      offMonitoring();
      offGeometry();
      offStatus();
      runtime.onReinit.current = null;
      runtime.onCommand.current = null;
      if (runtime.layers.current === host) runtime.layers.current = null;
      hostRef.current = null;
      host.destroy();
      setStatus(EMPTY_STATUS);
    };
  }, [runtime]);

  useEffect(() => {
    hostRef.current?.setLook(look, cfgs);
  }, [look, cfgs]);

  const baseKind = look.layers[0]?.kind ?? '';
  const failure = status.failures[0];

  return (
    <>
      <div className="kh-stack" ref={rootRef} />
      {!status.ready && failure === undefined && (
        <div className="kh-splash">{resolveModule(baseKind).name}</div>
      )}
      {failure !== undefined && <ModuleErrorCard title={failure.title} detail={failure.detail} />}
    </>
  );
}
