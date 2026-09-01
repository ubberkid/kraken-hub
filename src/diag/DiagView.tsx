import { useEffect, useState } from 'react';

import { docUrl } from '../buildInfo';
import { Button, Chip, Code, Row } from '../ui';

import { NETWORK_TARGETS } from './probes';
import { toJson, readDisplayReport, type DiagReport } from './report';
import { diagPhase, diagReportFreshness, DIAG_REQUEST_TIMEOUT_MS } from './wire';

import type { ConfigRuntime } from '../app/config/runtime';
import type { SyncHandle } from '../app/config/useSync';

/**
 * Everything behind "Show the technical detail" — and nothing outside it.
 *
 * This file used to BE the `#/diag` page: four panels, permanently expanded,
 * headed *This browser*, *The display*, *Network reachability (H19)*. Round 2's
 * R3 measured what that cost the merged About page and moved the whole thing
 * one door down. What is here now is the drawer's contents, mounted only once
 * somebody opens it (`ReportSection` gates it on state, because `<details>`
 * does not).
 *
 * TWO sections are in it, in the order somebody debugging needs them:
 *
 *  1. **This browser** — the probes, already run by `ReportSection` and handed
 *     in as `report`, so the drawer never re-measures what the Copy button
 *     measured.
 *  2. **Your Kraken** — the two ways its report reaches this page. The
 *     same-machine hand-off through CAM's shared storage, and the cross-network
 *     pull over the paired room, which is the only way to get measurements off
 *     a machine you are not sitting at.
 *
 * The third — *Network reachability* — is not a section any more. It was a
 * bulleted inventory of transports under a heading, describing measurements
 * nothing on this page takes; what survives it is the one sentence at the foot
 * that says nothing here contacts the network, which is the only part of it a
 * reader has to know before they open an issue.
 *
 * The visible copy names no H-ids. They are still in the JSON and still in
 * `docs/hardware-checklist.md`, which is one link away; a heading that reads
 * "Network reachability (H19)" is this project's internal issue tracker leaking
 * onto a user's screen.
 */

/** The display republishes every 5 s while it is open with diagnostics on. */
const DISPLAY_POLL_MS = 2000;
/** The pull's own timeout ticks off this clock; 1 Hz is plenty. */
const CLOCK_MS = 1000;

export function DiagView({
  runtime,
  sync,
  report,
}: {
  runtime: ConfigRuntime;
  sync: SyncHandle;
  /** This browser's probes, already run by the Report section. */
  report: DiagReport | null;
}) {
  const [display, setDisplay] = useState<DiagReport | null>(() => readDisplayReport());
  const [requestedAt, setRequestedAt] = useState<number | null>(null);

  /** The clock, sampled OUTSIDE render — `Date.now()` there is not idempotent. */
  const [now, setNow] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, CLOCK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setDisplay(readDisplayReport());
    }, DISPLAY_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const state = runtime.store.getSnapshot();
  const paired = state.sync.roomCode !== null && state.sync.enabled;
  const pulled = sync.diagReport;
  const phase = diagPhase({
    requestedAt,
    receivedAt: pulled?.at ?? null,
    now,
  });
  const stale = pulled !== null && diagReportFreshness(phase) === 'stale';

  /** `docs/` is not deployed with the app, so this has to be an absolute link. */
  const checklist = docUrl('docs/hardware-checklist.md');
  /** Whichever of the two paths actually produced one. */
  const kraken = pulled?.report ?? display;

  return (
    <>
      <h3 className="kh-diaghead">This browser</h3>
      {report === null ? (
        <p className="kh-hint">Measuring…</p>
      ) : (
        <table className="kh-table">
          <tbody>
            <tr>
              <th scope="row">Chromium</th>
              <td>{report.capabilities.chromiumVersion ?? 'not Chromium'}</td>
            </tr>
            <tr>
              <th scope="row">Electron</th>
              <td>{report.capabilities.electronVersion ?? 'no'}</td>
            </tr>
            <tr>
              <th scope="row">devicePixelRatio</th>
              <td>{report.device.dpr}</td>
            </tr>
            <tr>
              <th scope="row">window.nzxt</th>
              <td>{report.injection.present ? 'injected' : 'absent'}</td>
            </tr>
            <tr>
              <th scope="row">rAF fps (p50)</th>
              <td>{report.timings.rafFps?.p50?.toFixed(1) ?? '—'}</td>
            </tr>
            <tr>
              <th scope="row">Storage persisted</th>
              <td>{String(report.storage.persisted)}</td>
            </tr>
            <tr>
              <th scope="row">State delivery</th>
              <td>
                event {report.storage.delivery.viaEvent} · poll {report.storage.delivery.viaPoll}
              </td>
            </tr>
            <tr>
              <th scope="row">Codecs</th>
              <td>
                {Object.entries(report.capabilities.codecs)
                  .map(([id, c]) => `${id}:${c.element === '' ? 'no' : c.element}`)
                  .join(' · ')}
              </td>
            </tr>
          </tbody>
        </table>
      )}

      <h3 className="kh-diaghead">Your Kraken</h3>
      <Row>
        <Chip tone={kraken === null ? 'warn' : stale ? 'warn' : 'ok'} testId="diag-display-chip">
          {kraken === null
            ? 'no report'
            : `${stale ? 'stale — ' : ''}captured ${new Date(kraken.capturedAt).toLocaleTimeString()}`}
        </Chip>
        <Button
          testId="request-report"
          disabled={!paired || phase === 'waiting'}
          title={
            paired
              ? 'Asks your Kraken for a report; it answers over the paired room.'
              : 'Pair a room on the Remote page first — there is nothing to ask.'
          }
          onClick={() => {
            setRequestedAt(Date.now());
            sync.sendCmd('requestDiag');
          }}
        >
          {phase === 'waiting' ? 'Waiting…' : 'Ask your Kraken'}
        </Button>
        <a className="kh-btn" href="./?kraken=1&diag=1" target="_blank" rel="noreferrer">
          Open display diagnostics
        </a>
        <a
          className="kh-btn"
          href="./?kraken=1&diag=1&pattern=rings"
          target="_blank"
          rel="noreferrer"
        >
          Ring target
        </a>
        {checklist !== null && (
          <a className="kh-btn" href={checklist} target="_blank" rel="noreferrer">
            Hardware checklist
          </a>
        )}
      </Row>
      <p className="kh-hint">
        Your Kraken measures itself for about five seconds and answers over the paired room,
        encrypted like everything else — which is the only way to reach a machine you are not
        sitting at. On the same PC it also publishes here on its own, through the storage
        CAM&rsquo;s two browsers share.
        {phase === 'timeout' &&
          ' It did not answer this time — is CAM running with kraken-hub open on the same room code?'}
        {phase === 'waiting' &&
          ` Asked; it gives up after ${String(Math.round(DIAG_REQUEST_TIMEOUT_MS / 1000))} seconds.`}
      </p>
      {kraken !== null && (
        <>
          <table className="kh-table" data-testid="pulled-summary">
            <tbody>
              <tr>
                <th scope="row">Panel</th>
                <td>
                  {kraken.device.width}×{kraken.device.height} {kraken.device.shape} (
                  {kraken.device.geometrySource})
                </td>
              </tr>
              <tr>
                <th scope="row">Target FPS</th>
                <td>{kraken.device.targetFps}</td>
              </tr>
              <tr>
                <th scope="row">rAF fps (p50)</th>
                <td>{kraken.timings.rafFps?.p50?.toFixed(1) ?? '—'}</td>
              </tr>
              <tr>
                <th scope="row">Build</th>
                <td>
                  {kraken.app.version} · {kraken.app.gitSha}
                </td>
              </tr>
            </tbody>
          </table>
          <details className="kh-details" data-testid="pulled-report">
            <summary className="kh-details__summary">Raw JSON</summary>
            <div className="kh-details__body">
              <Code>{toJson(kraken)}</Code>
            </div>
          </details>
        </>
      )}

      {/*
        The network story, as a sentence rather than a bulleted inventory of
        transports — and only the half that is about the reader (round 4,
        minors).

        The second clause used to report that whether CAM's webview can reach
        those hosts "is still unmeasured", which is a note about this project's
        own progress, printed inside a drawer somebody opened to debug their
        cooler. Where the project has got to belongs in the hardware checklist
        that clause was pointing at, and the reader's question — does opening
        this drawer phone home? — is answered by the first clause alone.
      */}
      {/*
        "not even", never "including" — round 6's minors.

        The sentence had been inverted for a wave: *"Nothing here contacts the
        network, including X and Y"* parses as a list of things it DOES contact,
        which is the exact opposite of the promise, printed inside the drawer
        somebody opened to check whether the app phones home. A privacy claim
        that reads backwards is worse than no claim at all.
      */}
      <p className="kh-hint">
        Nothing here contacts the network, not even{' '}
        {NETWORK_TARGETS.map((t) => t.label).join(' or ')}.
      </p>
    </>
  );
}
