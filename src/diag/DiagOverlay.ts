import { el, setText } from '../app/display/dom';
import { buildInfo } from '../buildInfo';

import { probeApiSurface, probeDevice, probeInjection, probeStorage, sampleRafFps } from './probes';
import {
  DIAG_PUBLISH_INTERVAL_MS,
  newReport,
  publishDisplayReport,
  type DiagReport,
} from './report';

import type { DisplayRuntime } from '../app/display/runtime';
import './diag.css';

/**
 * `?kraken=1&diag=1` — the on-LCD diagnostics surface.
 *
 * Designed to be photographed: huge high-contrast type inside the safe inset,
 * no scrolling, nothing that depends on being able to click. The same data is
 * published to localStorage every 5 s so the configuration page can hand the
 * user a copyable JSON blob.
 *
 * `&pattern=rings` swaps in the ring target that measures the true visible
 * radius (H20), and `&pattern=flat` the H09 counter. Both, like `&pattern=stack`,
 * OWN the stage: `DisplayApp` mounts no module behind a measurement pattern
 * (F12-7), so the ring target is photographed against the background rather than
 * against a playing video, and H09's "near-static frame" really is one.
 *
 * W9 made this framework-free along with the rest of the display shell. It is
 * six labelled rows whose values are read straight out of the probes, so what
 * a component bought was a re-render of six `<dd>`s every five seconds; the
 * capture loop, the publish interval and the "sampling…" placeholder are
 * unchanged, and the DOM is the same `<dl class="kh-diag__list">` it was.
 */
const RAF_SAMPLE_MS = 3000;

/** Shown for the rAF-derived fields while the 3 s window is still open. */
const SAMPLING = 'sampling…';

export interface DiagOverlay {
  node: HTMLElement;
  destroy(): void;
}

export function mountDiagOverlay(runtime: DisplayRuntime): DiagOverlay {
  let cancelled = false;
  // Read through a function: a bare `if (cancelled)` after the first check is
  // narrowed to `false` by TS even though the disposer can flip it.
  const alive = (): boolean => !cancelled;

  let report: DiagReport | null = null;
  let onReport: (() => void) | null = null;

  /**
   * Everything except `rafFps` is available synchronously, and on a 1 FPS panel
   * a three-second gate costs one or two whole frames of "nzxt | absent" —
   * which reads as a failure to whoever is photographing the LCD. So capture
   * twice: once immediately with `rafFps: null` (rendered as "sampling…"), then
   * again when the window closes. Only the complete report is published, so the
   * configuration page never sees a half-report.
   */
  const capture = async (): Promise<void> => {
    let storage = await probeStorage();
    if (!alive()) return;

    const build = (rafFps: Awaited<ReturnType<typeof sampleRafFps>> | null): DiagReport => {
      const stats = runtime.frameClock.stats();
      return newReport({
        mode: 'display',
        device: probeDevice(runtime.geometry.get()),
        injection: probeInjection(),
        capabilities: probeApiSurface(),
        storage,
        timings: {
          rafFps,
          monitoringIntervalMs: null,
          achievedFps: stats.achievedFps,
          longFrames: stats.longFrames,
        },
      });
    };

    report = build(null);
    onReport?.();

    const rafFps = await sampleRafFps(RAF_SAMPLE_MS);
    storage = await probeStorage();
    if (!alive()) return;
    report = build(rafFps);
    onReport?.();
    publishDisplayReport(report);
  };

  void capture();
  const timer = setInterval(() => {
    void capture();
  }, DIAG_PUBLISH_INTERVAL_MS);

  const stop = (): void => {
    cancelled = true;
    clearInterval(timer);
  };

  const pattern = runtime.flags.pattern;

  if (pattern === 'rings') {
    return {
      node: el('div', { class: 'kh-diag kh-diag--pattern' }, [
        el('img', {
          class: 'kh-diag__rings',
          src: './diag/ring-target.svg',
          alt: 'Concentric rings labelled 100 to 80 percent of the panel width',
        }),
      ]),
      destroy: stop,
    };
  }

  if (pattern === 'stack') {
    // Five layer stacks of increasing cost, composited by the real LayerHost.
    return stackPattern(runtime, stop);
  }

  if (pattern === 'flat') {
    // A near-static frame: the counter is the only thing that changes, so this
    // measures capture FPS for low-entropy content (H09).
    return flatCounter(stop);
  }

  /*
   * Read live rather than waiting for the first report. Every one of these is a
   * synchronous, side-effect-free read of state the page already has, so the
   * panel is correct on its very first frame — which matters when the panel
   * only paints once a second and a photograph of it is the bug report.
   * `rafFps` is the sole field that genuinely needs a sampling window.
   */
  const values = {
    panel: el('dd'),
    fps: el('dd'),
    dpr: el('dd'),
    // Keyed `injection`, not `nzxt`: the platform lint forbids ANY `.nzxt`
    // property access outside the two files allowed to touch the injected API,
    // and it is right to — the exception is what would need arguing, not the
    // rename. The label the panel prints is still `nzxt`.
    injection: el('dd'),
    chromium: el('dd'),
    build: el('dd'),
  };

  const node = el('div', { class: 'kh-diag' }, [
    el('dl', { class: 'kh-diag__list' }, [
      el('dt', undefined, 'panel'),
      values.panel,
      el('dt', undefined, 'fps'),
      values.fps,
      el('dt', undefined, 'dpr'),
      values.dpr,
      el('dt', undefined, 'nzxt'),
      values.injection,
      el('dt', undefined, 'chromium'),
      values.chromium,
      el('dt', undefined, 'build'),
      values.build,
    ]),
    el('p', { class: 'kh-diag__hint' }, "Open #/diag in CAM's browser to copy this as JSON"),
  ]);

  const paint = (): void => {
    const device = probeDevice(runtime.geometry.get());
    const injected = probeInjection().present;
    const app = buildInfo();
    const rafFps = report?.timings.rafFps?.p50;
    setText(
      values.panel,
      `${String(device.width)}×${String(device.height)} ${device.shape} (${device.geometrySource})`,
    );
    setText(
      values.fps,
      `target ${String(device.targetFps)} · raf ${
        rafFps === undefined || rafFps === null ? SAMPLING : rafFps.toFixed(0)
      }`,
    );
    setText(values.dpr, String(device.dpr));
    setText(values.injection, injected ? 'injected' : 'absent');
    setText(values.chromium, probeApiSurface().chromiumVersion ?? '—');
    setText(values.build, `${app.version} ${app.gitSha}`);
  };

  onReport = paint;
  paint();

  return { node, destroy: stop };
}

/**
 * `?diag=1&pattern=stack&stack=a|b|c|d|e` — the layer-cost measurement path.
 *
 * It composites through the real `LayerHost`, so its numbers are the shipping
 * compositor's numbers. The stacks are built from the REAL registered modules —
 * `effect` for the frame-cadence base, `text` for the DOM overlays — and the
 * whole pattern is behind a DYNAMIC import, so neither the display's critical
 * path nor the diagnostics chunk carries a byte of them.
 */
function stackPattern(runtime: DisplayRuntime, stop: () => void): DiagOverlay {
  const node = el('div', { class: 'kh-diag kh-diag--pattern kh-diag--stack' });
  const stack = runtime.flags.stack ?? 'a';
  let stopPattern: (() => void) | null = null;
  let cancelled = false;

  void import('./patterns/stack')
    .then((m) => {
      if (cancelled) return;
      stopPattern = m.startStackPattern(node, runtime, stack);
    })
    .catch(() => {
      // The measurement pattern failing to load leaves an empty diagnostic,
      // which is what an empty diagnostic looks like. Nothing else is affected.
    });

  return {
    node,
    destroy() {
      cancelled = true;
      stopPattern?.();
      stop();
    },
  };
}

/** The H09 counter: one increment per rAF, and nothing else on the frame. */
function flatCounter(stop: () => void): DiagOverlay {
  const counter = el('span', { class: 'kh-diag__counter' });
  const node = el('div', { class: 'kh-diag kh-diag--pattern kh-diag--flat' }, [counter]);
  let n = 0;
  let raf = requestAnimationFrame(function step() {
    n += 1;
    counter.textContent = String(n);
    raf = requestAnimationFrame(step);
  });
  return {
    node,
    destroy() {
      cancelAnimationFrame(raf);
      stop();
    },
  };
}
