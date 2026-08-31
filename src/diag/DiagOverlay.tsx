import { useEffect, useState, type ReactNode } from 'react';

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
 * radius (H20) — the number the safe-area constant is calibrated from.
 */
const RAF_SAMPLE_MS = 3000;

/** Shown for the rAF-derived fields while the 3 s window is still open. */
const SAMPLING = 'sampling…';

export function DiagOverlay({ runtime }: { runtime: DisplayRuntime }) {
  const [report, setReport] = useState<DiagReport | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Read through a function: a bare `if (cancelled)` after the first check is
    // narrowed to `false` by TS even though the cleanup closure can flip it.
    const alive = (): boolean => !cancelled;

    /**
     * Everything except `rafFps` is available synchronously, and on a 1 FPS
     * panel a three-second gate costs one or two whole frames of "nzxt |
     * absent" — which reads as a failure to whoever is photographing the LCD.
     * So capture twice: once immediately with `rafFps: null` (rendered as
     * "sampling…"), then again when the window closes. Only the complete
     * report is published, so the configuration page never sees a half-report.
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

      setReport(build(null));

      const rafFps = await sampleRafFps(RAF_SAMPLE_MS);
      storage = await probeStorage();
      if (!alive()) return;
      const next = build(rafFps);
      setReport(next);
      publishDisplayReport(next);
    };

    void capture();
    const timer = setInterval(() => {
      void capture();
    }, DIAG_PUBLISH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runtime]);

  const pattern = runtime.flags.pattern;

  if (pattern === 'rings') {
    return (
      <div className="kh-diag kh-diag--pattern">
        <img
          className="kh-diag__rings"
          src="./diag/ring-target.svg"
          alt="Concentric rings labelled 100 to 80 percent of the panel width"
        />
      </div>
    );
  }

  if (pattern === 'flat') {
    // A near-static frame: the counter is the only thing that changes, so this
    // measures capture FPS for low-entropy content (H09).
    return (
      <div className="kh-diag kh-diag--pattern kh-diag--flat">
        <FlatCounter />
      </div>
    );
  }

  /*
   * Read live rather than waiting for the first report. Every one of these is a
   * synchronous, side-effect-free read of state the page already has, so the
   * panel is correct on its very first frame — which matters when the panel
   * only paints once a second and a photograph of it is the bug report.
   * `rafFps` is the sole field that genuinely needs a sampling window.
   */
  const device = probeDevice(runtime.geometry.get());
  const injected = probeInjection().present;
  const app = buildInfo();
  const rafFps = report?.timings.rafFps?.p50;

  return (
    <div className="kh-diag">
      <dl className="kh-diag__list">
        <Row label="panel">
          {`${String(device.width)}×${String(device.height)} ${device.shape} (${device.geometrySource})`}
        </Row>
        <Row label="fps">
          {`target ${String(device.targetFps)} · raf ${
            rafFps === undefined || rafFps === null ? SAMPLING : rafFps.toFixed(0)
          }`}
        </Row>
        <Row label="dpr">{String(device.dpr)}</Row>
        <Row label="nzxt">{injected ? 'injected' : 'absent'}</Row>
        <Row label="chromium">{probeApiSurface().chromiumVersion ?? '—'}</Row>
        <Row label="build">{`${app.version} ${app.gitSha}`}</Row>
      </dl>
      <p className="kh-diag__hint">Open #/diag in CAM&apos;s browser to copy this as JSON</p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function FlatCounter() {
  const [n, setN] = useState(0);
  useEffect(() => {
    let raf = 0;
    const step = (): void => {
      setN((v) => v + 1);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, []);
  return <span className="kh-diag__counter">{n}</span>;
}
