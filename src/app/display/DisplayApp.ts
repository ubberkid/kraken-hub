import { createLogger } from '../../lib/log';
import { getModule, resolveModule } from '../../modules/registry';
import { stackMotionLevel } from '../../modules/stack';
import { maxTargetFpsForPanel } from '../../platform/devicePresets';
import { configsOf, lookOf } from '../../render/lookOf';
import { selectMaskCircle } from '../../state/selectors';

import { createDebugOverlay, type DebugOverlay } from './DebugOverlay';
import { slot } from './dom';
import { mountLayerStack, type LayerStack } from './LayerStack';
import { createLowFpsBanner } from './LowFpsBanner';
import { moduleErrorCard } from './ModuleErrorCard';
import { createStage } from './Stage';

import type { DisplayRuntime } from './runtime';
import type { LayerConfigs } from '../../render/LayerHost';
import type { Look } from '../../state/look/types';
import type { AppState } from '../../state/schema';

const log = createLogger('display/boundary');

/**
 * The whole LCD tree: about a dozen nodes, on purpose — and, since W9, not one
 * of them a component.
 *
 * The display page used to download and boot React to render a shell that is
 * static DOM: a stage div, the compositor's root, and four advisory cards that
 * are either on screen or not. That cost the hidden Kraken Browser 57.5 kB gzip
 * of framework before the panel could show a frame, in order to re-render "at
 * most a handful of times per session" — which is the definition of a bad
 * trade. The render graph was already framework-free (invariant I8); this
 * finishes the job for the shell.
 *
 * What replaces the component tree is this function: subscribe to the two
 * external sources the tree read (`store` and `geometry`) and, on a change,
 * write the handful of nodes that can differ. Per-frame work still happens
 * exclusively inside the compositor's imperative renderers (invariant I4) —
 * nothing here runs on a frame, and nothing here allocates on one.
 *
 * The CONFIGURATION page is untouched. It is a real application with forms,
 * routing and a component library, it is never downloaded by the panel, and
 * `vendor-react` still exists for it.
 */
export function mountDisplayApp(container: HTMLElement, runtime: DisplayRuntime): () => void {
  const stage = createStage();
  container.append(stage.root);

  /*
   * A measurement pattern OWNS the stage: leaving the configured look running
   * underneath would put a second video decoder on the frame path and make
   * every measurement a lie. `stack` composites through the same `LayerHost`
   * this branch would have mounted; `rings` (H20, the true visible radius) and
   * `flat` (H09, capture FPS for near-static content) draw their own target and
   * must have nothing else on the panel or on the frame path.
   *
   * F12-7: `rings` and `flat` used to render OVER the configured look, so the
   * ring target sat on top of a playing video and H09's "near-static frame"
   * measured a video decoder. They are drawn by the diagnostics overlay, which
   * only mounts under `?diag=1`, so they claim the stage only when it does —
   * otherwise the pattern would blank the panel and draw nothing in its place.
   */
  const pattern = runtime.flags.pattern;
  const patternOwnsStage =
    pattern === 'stack' || ((pattern === 'rings' || pattern === 'flat') && runtime.flags.diag);

  let stack: LayerStack | null = null;
  let bootError: unknown = null;
  if (!patternOwnsStage) {
    // First, so the compositor root is the bottom of the stage: every slot
    // below is appended after it and therefore composites on top of it, which
    // is the z-order the JSX declared by writing them in this order.
    try {
      stack = mountLayerStack(stage.root, runtime);
    } catch (err: unknown) {
      bootError = err;
    }
  }

  const banner = createLowFpsBanner(slot(stage.root));
  const debugSlot = slot(stage.root);
  const diagSlot = slot(stage.root);

  let debug: DebugOverlay | null = null;
  let diag: { destroy(): void } | null = null;
  let disposed = false;
  let failed = false;

  /*
   * `useMemo` on state identity, kept. `lookOf` and `configsOf` allocate, and
   * `LayerHost.setLook` reconciles against the look it is given, so
   * recomputing them on a geometry tick would hand the compositor an
   * equal-but-new look and make a reconcile out of a resize.
   */
  let derivedFrom: AppState | null = null;
  let look: Look = { layers: [] };
  let cfgs: LayerConfigs = {};

  function derive(state: AppState): void {
    if (state === derivedFrom) return;
    derivedFrom = state;
    look = lookOf(state);
    cfgs = configsOf(look, state, getModule, runtime.moduleParams);
  }

  function render(): void {
    const state = runtime.store.getSnapshot();
    const geometry = runtime.geometry.get();
    derive(state);

    stage.update(geometry, selectMaskCircle(state, geometry.shape), state.render.background);

    stack?.update(look, cfgs);

    /*
     * The advisory is a property of the STACK, not of one module: one layer that
     * moves every frame is enough to be ruined by a 1 FPS capture, and a look
     * made entirely of static overlays should never nag. `ownsFpsAdvisory` stays
     * a base question — it is the video module's own card, drawn inside the
     * video's own safe area, and an overlay has no business suppressing the
     * shell's banner.
     */
    const baseKind = look.layers[0]?.kind ?? '';
    if (resolveModule(baseKind).capabilities.ownsFpsAdvisory === true) {
      banner.clear();
    } else {
      banner.update(
        geometry.targetFps,
        state.platform.lowFpsThreshold,
        stackMotionLevel(look, getModule, (layer) => cfgs[layer.id]),
        // The ceiling belongs to the panel that is actually attached, and it is
        // what decides whether there is anything to advise at all (F12-1).
        maxTargetFpsForPanel(geometry.width, geometry.height, geometry.shape),
        // How much room the card actually has (round 13, F1): below 300 px the
        // footer line is dropped rather than set at type nobody can read.
        geometry.inscribedSquarePx,
      );
    }

    if (state.diagnostics.showDebugOverlay) {
      if (debug === null) {
        debug = createDebugOverlay(runtime);
        debugSlot.set(debug.node);
      }
    } else if (debug !== null) {
      debug.destroy();
      debug = null;
      debugSlot.set(null);
    }
  }

  /**
   * The display page runs unattended for weeks on a screen nobody watches. An
   * uncaught error while writing the shell must degrade to a readable card,
   * never to a black panel that looks like dead hardware — the job React's
   * `ErrorBoundary` did, done at the one place that can throw now that the
   * shell is a function rather than a tree.
   */
  function fatal(error: unknown): void {
    if (failed) return;
    failed = true;
    const err = error instanceof Error ? error : new Error(String(error));
    log.error(err.message, err.stack ?? '');
    try {
      const state = runtime.store.getSnapshot();
      const geometry = runtime.geometry.get();
      stack?.destroy();
      stack = null;
      banner.destroy();
      debug?.destroy();
      debug = null;
      diag?.destroy();
      diag = null;
      stage.root.replaceChildren();
      stage.update(geometry, selectMaskCircle(state, geometry.shape), '#000');
      stage.root.append(moduleErrorCard('Display error', err.message));
    } catch {
      // A fallback that throws is worse than no fallback: the panel keeps
      // whatever it last painted rather than losing the stage as well.
    }
  }

  function safeRender(): void {
    if (disposed || failed) return;
    try {
      render();
    } catch (err: unknown) {
      fatal(err);
    }
  }

  if (bootError !== null) fatal(bootError);
  else safeRender();

  /*
   * Diagnostics are lazy: the normal display path never downloads the probes.
   * `flags.diag` comes from the URL and cannot change for the life of the page,
   * so this is decided once rather than re-tested on every state change.
   */
  if (runtime.flags.diag) {
    void import('../../diag/DiagOverlay')
      .then((m) => {
        if (disposed || failed) return;
        const mounted = m.mountDiagOverlay(runtime);
        diag = mounted;
        diagSlot.set(mounted.node);
      })
      .catch((err: unknown) => {
        log.warn('the diagnostics overlay did not load', err);
      });
  }

  const offStore = runtime.store.subscribe(safeRender);
  const offGeometry = runtime.geometry.subscribe(safeRender);

  return () => {
    if (disposed) return;
    disposed = true;
    offGeometry();
    offStore();
    diag?.destroy();
    debug?.destroy();
    banner.destroy();
    stack?.destroy();
    stage.root.remove();
  };
}
