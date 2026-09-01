import { Suspense, lazy, useCallback, useState } from 'react';

import { issueUrl } from '../../../buildInfo';
import { toJson, type DiagReport } from '../../../diag/report';
import { Button, Notice, Panel, Row } from '../../../ui';

import type { ConfigRuntime } from '../runtime';
import type { SyncHandle } from '../useSync';

/**
 * "Report" — one paragraph, one button, and a drawer.
 *
 * ## What this replaced
 *
 * The About page's lower half used to be the whole of `#/diag`, unfolded: four
 * panels headed *This browser*, *The display*, *Network reachability (H19)* and
 * *Hardware report*, carrying a codec matrix, a rAF percentile, a
 * `devicePixelRatio`, a storage-delivery counter, a `window.nzxt` row, a raw
 * JSON dump, three `?kraken=1&diag=1` links, a bullet list of network targets
 * and two more Copy buttons. Around 1,200 px of measurement, headed by internal
 * hardware-checklist ids, on a page a user reaches by clicking a version string.
 *
 * Every one of those numbers is real and worth having. None of them is worth
 * *reading*: they exist to be pasted into an issue. So the page says what a
 * report is and why you would send one, gives you the single button that puts it
 * on your clipboard, and puts every probe behind one door.
 *
 * ## Nothing probes until asked
 *
 * `sampleRafFps` measures for two seconds and `probeStorage` asks the quota API;
 * running both on arrival, for every visitor, to populate a drawer almost
 * nobody opens is the same mistake in a different currency. The probes are
 * dynamically imported and run on the FIRST of two events — pressing Copy
 * report, or opening the drawer — and the result is kept for the second.
 *
 * `Disclosure`'s `onToggle` is what makes the second half of that real:
 * `<details>` keeps its children mounted whether or not it is open, so the
 * drawer's contents are gated on React state rather than on the element.
 */

/** Probes touch a lot of APIs, and the tables are dead weight until asked for. */
const TechnicalDetail = lazy(async () => {
  const m = await import('../../../diag/DiagView');
  return { default: m.DiagView };
});

export function ReportSection({ runtime, sync }: { runtime: ConfigRuntime; sync: SyncHandle }) {
  const [report, setReport] = useState<DiagReport | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  /**
   * The report for THIS browser, built on demand.
   *
   * Memoised by identity rather than by result: two presses of Copy report a
   * second apart should not re-sample the frame rate, and the drawer opening
   * behind an in-flight copy should not start a second probe.
   */
  const build = useCallback(async (): Promise<DiagReport | null> => {
    try {
      const [{ newReport }, probes, { readGeometry }] = await Promise.all([
        import('../../../diag/report'),
        import('../../../diag/probes'),
        import('../../../platform/geometry'),
      ]);
      const state = runtime.store.getSnapshot();
      const rafFps = await probes.sampleRafFps(RAF_SAMPLE_MS);
      const storage = await probes.probeStorage();
      const built = newReport({
        mode: 'config',
        device: probes.probeDevice(
          readGeometry({ fallbackTargetFps: state.platform.fallbackTargetFps }, state.render),
        ),
        injection: probes.probeInjection(),
        capabilities: probes.probeApiSurface(),
        storage,
        timings: { rafFps, monitoringIntervalMs: null, achievedFps: null, longFrames: null },
      });
      setReport(built);
      return built;
    } catch {
      return null;
    }
  }, [runtime]);

  const copy = (): void => {
    setBusy(true);
    setFailed(false);
    void (async () => {
      const mine = report ?? (await build());
      /*
       * The best report available, not merely this browser's.
       *
       * Whichever half exists goes on the clipboard: the config browser's own
       * probes always, plus whatever your Kraken has published — over CAM's
       * shared storage on the same machine, or over the paired room from
       * anywhere. An issue with both halves is worth several rounds of
       * questions.
       */
      const pulled = sync.diagReport?.report ?? null;
      const payload = pulled === null ? mine : { config: mine, kraken: pulled };
      if (payload === null) {
        setBusy(false);
        setFailed(true);
        return;
      }
      try {
        await navigator.clipboard.writeText(toJson(payload));
        setCopied(true);
      } catch {
        setFailed(true);
      }
      setBusy(false);
    })();
  };

  const formUrl = issueUrl('hardware_report.yml');

  return (
    <Panel title="Report">
      <p className="kh-hint">
        What this PC and your Kraken can do — panel size, frame rate, codecs. No personal data; it
        makes a bug fixable.
      </p>
      <Row>
        <Button
          primary
          testId="copy-report"
          disabled={busy}
          title="Puts the report on your clipboard, ready to paste into an issue."
          onClick={copy}
        >
          {busy ? 'Measuring…' : copied ? 'Copied' : 'Copy report'}
        </Button>
        {formUrl !== null && (
          <a className="kh-btn" href={formUrl} target="_blank" rel="noreferrer">
            Send it in
          </a>
        )}
      </Row>
      {failed && <Notice tone="warn">The report could not be copied — try again.</Notice>}

      <details
        className="kh-details"
        data-testid="tech-detail"
        // Opening the drawer is the second of the two things that earn the
        // probes; pressing Copy report is the first.
        onToggle={(e) => {
          if (e.currentTarget.open && report === null) void build();
        }}
      >
        <summary className="kh-details__summary">Show the technical detail</summary>
        <div className="kh-details__body">
          {/*
            Rendered whether or not the drawer is open, and gated on nothing.

            The first version mounted this only while a `detailOpen` state flag
            was true, which is one state too clever: React owns `<details>`'s
            `open` attribute across re-renders, so a `toggle` event arriving
            during an unrelated render tore the drawer's contents out from under
            somebody who had opened it — reproducibly, about one run in three,
            in the middle of a hardware-report pull. Nothing here probes on
            mount anyway: the measurements are `ReportSection`'s and they run on
            demand, and this component is handed the result.
          */}
          <Suspense fallback={<p className="kh-hint">Measuring…</p>}>
            <TechnicalDetail runtime={runtime} sync={sync} report={report} />
          </Suspense>
        </div>
      </details>
    </Panel>
  );
}

/** Two seconds is enough for a stable p50 and short enough not to feel stuck. */
const RAF_SAMPLE_MS = 2000;
