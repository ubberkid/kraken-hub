import { getModule, resolveModule } from '../../modules/registry';
import { createLayerGovernor } from '../../render/layerGovernor';
import { LayerHost, type LayerConfigs, type LayerHostStatus } from '../../render/LayerHost';

import { el, slot } from './dom';
import { moduleErrorCard } from './ModuleErrorCard';

import type { DisplayRuntime } from './runtime';
import type { Look } from '../../state/look/types';

/**
 * The whole stage, as one compositor.
 *
 * There is exactly ONE `LayerHost` per display and it lives for the life of the
 * runtime: a look change is a reconcile, not a remount, so switching the base
 * module no longer tears the stage down and rebuilds it. Everything per-frame
 * happens inside the compositor's own clock subscription; this file reacts only
 * when the compositor's *status* changes — a layer finished mounting, or one
 * failed — which is at most a handful of times per session.
 *
 * For a base-only look (every document before W1b writes one) the DOM this
 * produces is the one the display has always produced: a single
 * `.kh-stage__module[data-module]` div with the renderer inside it.
 *
 * W9 removed the React wrapper and nothing else. The compositor was already
 * framework-free (I8/W-I8); what stood between it and the panel was a component
 * whose entire job was to own a `<div className="kh-stack">` ref, a `useEffect`
 * that constructed the host, and a `useState` that mirrored `host.status()`.
 * Those are a field, a constructor call and a subscription, and that is what
 * they are now.
 */
const EMPTY_STATUS: LayerHostStatus = { ready: false, failures: [], notes: [] };

/**
 * Once a second, off the frame path (invariant I4). The governor's thresholds
 * are ten and thirty seconds, so a faster sample buys nothing and an update
 * inside a tick is exactly what I4 forbids.
 */
const GOVERNOR_SAMPLE_MS = 1000;

export interface LayerStack {
  /** `look`/`cfgs` are memoised by the caller on state identity, as before. */
  update(look: Look, cfgs: LayerConfigs): void;
  destroy(): void;
}

export function mountLayerStack(parent: HTMLElement, runtime: DisplayRuntime): LayerStack {
  const root = el('div', { class: 'kh-stack' });
  parent.append(root);
  // Declared after the compositor root, so the splash and the error card sit on
  // top of it in DOM order exactly as the JSX fragment put them.
  const overlay = slot(parent);

  let status: LayerHostStatus = EMPTY_STATUS;
  let baseKind = '';
  /** What `overlay` currently holds, so an unchanged status is not rebuilt. */
  let painted = '';

  const host = new LayerHost(root, {
    registry: getModule,
    panel: runtime.geometry.get(),
    clock: runtime.frameClock,
    render: () => runtime.store.getSnapshot().render,
    monitoring: runtime.monitoring,
  });
  runtime.layers.current = host;
  runtime.onReinit.current = (reason) => {
    host.reinit(reason);
  };
  // The boolean is the point: `host.command` says whether a live renderer took
  // it, and `display/sync.ts` waits on that answer for the retained position
  // rather than on the handler merely existing (runtime.ts).
  runtime.onCommand.current = (op, arg) => host.command(op, arg);

  function paint(): void {
    const failure = status.failures[0];
    const want =
      failure !== undefined
        ? `error:${failure.id}:${failure.title}:${failure.detail}`
        : status.ready
          ? ''
          : `splash:${baseKind}`;
    if (want === painted) return;
    painted = want;
    if (failure !== undefined) {
      overlay.set(moduleErrorCard(failure.title, failure.detail));
      return;
    }
    overlay.set(
      status.ready ? null : el('div', { class: 'kh-splash' }, resolveModule(baseKind).name),
    );
  }

  const offStatus = host.subscribe(() => {
    status = host.status();
    paint();
  });
  const offGeometry = runtime.geometry.subscribe(() => {
    host.setPanel(runtime.geometry.get());
  });
  const offMonitoring = runtime.monitoring.subscribe((n, raw) => {
    host.setMonitoring(n, raw);
  });

  // The governor never removes a layer; it only makes the stack coarser, and it
  // says so through `budget()`. See render/layerGovernor.ts.
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

  paint();

  return {
    update(look, cfgs) {
      baseKind = look.layers[0]?.kind ?? '';
      host.setLook(look, cfgs);
      status = host.status();
      paint();
    },
    destroy() {
      clearInterval(timer);
      offMonitoring();
      offGeometry();
      offStatus();
      runtime.onReinit.current = null;
      runtime.onCommand.current = null;
      if (runtime.layers.current === host) runtime.layers.current = null;
      host.destroy();
      status = EMPTY_STATUS;
      overlay.dispose();
      root.remove();
    },
  };
}
