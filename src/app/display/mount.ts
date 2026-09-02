import { createLogger } from '../../lib/log';
import { createFrameClock } from '../../platform/fpsGovernor';
import { applyGeometryToDom, readGeometry, watchGeometry } from '../../platform/geometry';
import { createMonitoringSource } from '../../platform/monitoring';
import { installNzxtTripwire, whenNzxt } from '../../platform/nzxt';
import { installSimulator } from '../../platform/simulator';
import { createWatchdog } from '../../platform/watchdog';
import { resolveState } from '../../state/precedence';
import { readState } from '../../state/storage';
import { createStore } from '../../state/store';
import { parseUrlParams } from '../../state/urlParams';

import { mountDisplayApp } from './DisplayApp';
import { createExternalValue, type DisplayRuntime } from './runtime';

const log = createLogger('boot/display');

/**
 * Display boot (design-architecture.md §7.1).
 *
 * Target: black pixels immediately, a module on screen within ~300 ms, and no
 * blocking network beyond the module's own media. Nothing here awaits CAM —
 * `whenNzxt()` is kicked off and reacted to, never waited on, because injection
 * can legitimately land after `load`.
 */
export function mountDisplay(container: HTMLElement): void {
  installNzxtTripwire();

  const params = parseUrlParams(window.location.search);

  // The simulator refuses to run when a real window.nzxt exists, so this is
  // inert inside CAM even if someone leaves ?sim= in the configured URL.
  const sim =
    params.flags.sim !== null
      ? installSimulator({
          preset: params.flags.sim,
          ...(params.flags.fps !== null ? { targetFps: params.flags.fps } : {}),
          ...(params.flags.monitor !== null ? { monitor: params.flags.monitor } : {}),
          ...(params.flags.inject === 'late' ? { late: true } : {}),
        })
      : null;

  const persisted = readState();
  const resolved = resolveState({ persisted: persisted.state, url: params.patch });
  // `overlay` keeps `?room=`, `?fit=` and friends winning over anything the
  // configuration browser writes later, without ever persisting them here.
  const store = createStore(resolved.state, 'display', { overlay: params.patch });

  const prefs = { fallbackTargetFps: resolved.state.platform.fallbackTargetFps };
  const geometryValue = createExternalValue(readGeometry(prefs, resolved.state.render));
  applyGeometryToDom(geometryValue.get(), resolved.state.render.background);

  const frameClock = createFrameClock(() => geometryValue.get().targetFps);
  const monitoring = createMonitoringSource({ simulated: sim !== null });

  const runtime: DisplayRuntime = {
    store,
    geometry: geometryValue,
    frameClock,
    monitoring,
    watchdog: createWatchdog({
      frameClock,
      monitoring,
      isKraken: params.flags.kraken,
      onSoftReinit: (reason) => {
        if (reason === 'resume' || reason === 'raf-stall' || reason === 'monitoring-stall') {
          runtime.onReinit.current?.(reason);
        }
        applyGeometry();
      },
    }),
    flags: params.flags,
    moduleParams: params.moduleParams,
    layers: { current: null },
    onReinit: { current: null },
    onCommand: { current: null },
  };

  /*
   * Sync starts in the background and NEVER blocks rendering (§7.1 step i).
   *
   * The whole layer — the service, mqtt.js, the crypto, the telemetry bridge —
   * is behind this one dynamic import, so a display with no room configured
   * downloads not a byte of it. A failure here is logged and ignored: the LCD
   * must keep playing from its persisted state whatever the network is doing.
   */
  if (resolved.state.sync.enabled && resolved.state.sync.roomCode !== null) {
    void import('./sync')
      .then((m) =>
        m.startDisplaySync({
          runtime,
          state: resolved.state,
          // A getter, not the boot-time document: the display persists remote
          // state to localStorage and the CAM window writes the same document,
          // so a frozen layer would let a stale echo roll back either of them.
          persisted: () => readState().state,
          url: params.patch,
        }),
      )
      .catch((err: unknown) => {
        log.warn('sync did not start; the display continues on persisted state', err);
      });
  }

  function applyGeometry(): void {
    const next = readGeometry(prefs, store.getSnapshot().render);
    geometryValue.set(next);
    applyGeometryToDom(next, store.getSnapshot().render.background);
  }

  // CAM may inject late, or re-inject after a sleep/wake cycle. Never awaited.
  void whenNzxt().then((api) => {
    if (api !== null) log.info('CAM geometry bound');
    applyGeometry();
  });
  // If ?inject=late is set the simulator injects after 1.5 s — same path.
  void sim?.injected.then(applyGeometry);

  watchGeometry(applyGeometry, prefs, resolved.state.render);
  runtime.watchdog.start();

  for (const note of [...resolved.notes.map((n) => n.path), ...params.notes.map((n) => n.key)]) {
    log.warn(`ignored or coerced: ${note}`);
  }

  /*
   * The shell, mounted directly (W9). There is no framework on this page: the
   * display's whole tree is a stage, the compositor's root and four advisory
   * cards, written by `DisplayApp.ts` from the same two subscriptions the
   * component tree used. `vendor-react` is not reachable from this entry any
   * more, and `scripts/check-bundle-size.mjs` fails the build if it becomes so.
   */
  mountDisplayApp(container, runtime);
}
