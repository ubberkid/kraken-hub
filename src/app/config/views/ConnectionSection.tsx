import { useEffect, useState } from 'react';

import { issueUrl } from '../../../buildInfo';
import { toJson } from '../../../diag/report';
import { diagPhase, diagReportFreshness, DIAG_REQUEST_TIMEOUT_MS } from '../../../diag/wire';
import { DEFAULT_MQTT_URL, DEFAULT_NTFY_BASE } from '../../../sync/endpoints';
import {
  Button,
  Chip,
  Code,
  Disclosure,
  Field,
  Notice,
  Panel,
  Row,
  Select,
  TextInput,
  Toggle,
} from '../../../ui';
import { useSync } from '../useSync';

import type { AppState } from '../../../state/schema';
import type { ConfigRuntime } from '../runtime';

/**
 * Connection — the ONE place a room is configured, and the hardware report.
 *
 * All of this used to live on the Remote page, two and three disclosures deep,
 * inside a "More controls" section that was a second complete copy of the app
 * (design audit, F6). None of it is a media control: a person driving a cooler
 * from the sofa never changes an MQTT endpoint, and a person who does is not
 * doing it on a phone.
 *
 * So it moved here, onto the merged About/Diagnostics page the footer's version
 * line opens, and the remote keeps exactly one quiet link to it. Three things
 * live in this section, in the order somebody actually needs them:
 *
 *  1. **Connection** — transport preference, and the endpoints behind a toggle.
 *  2. **Hardware report** — the cross-network pull, which is the only way to get
 *     measurements off a machine you are not sitting at. It has to be here
 *     rather than on the remote because it is a diagnostic, and this is the
 *     diagnostics page.
 *  3. **Connection detail** plus the honest privacy note about what a broker
 *     can and cannot observe.
 *
 * The `useSync` call is what makes the pull work: this page joins the same room
 * the remote does, so "Request hardware report" reaches a display anywhere.
 */

/** The diag card's own 20 s timeout ticks off this clock; 1 Hz is plenty. */
const CLOCK_MS = 1000;

/** Telemetry values arrive as `unknown`; render them without stringifying an object. */
function asText(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

export function ConnectionSection({ runtime }: { runtime: ConfigRuntime }) {
  const state = runtime.store.getSnapshot();
  const sync = useSync(runtime);
  const [showEndpoints, setShowEndpoints] = useState(false);
  const [diagRequestedAt, setDiagRequestedAt] = useState<number | null>(null);
  const [diagCopied, setDiagCopied] = useState(false);

  /**
   * The clock, sampled OUTSIDE render — `Date.now()` during render would make
   * this component non-idempotent, and the 20 s timeout below needs something
   * to tick against anyway.
   */
  const [now, setNow] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, CLOCK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const commit = (mutate: (s: AppState) => AppState): void => {
    runtime.store.commit(mutate);
  };

  const paired = state.sync.roomCode !== null && state.sync.enabled;
  const diag = sync.diagReport;
  const diagState = diagPhase({
    requestedAt: diagRequestedAt,
    receivedAt: diag?.at ?? null,
    now,
  });
  const diagStale = diag !== null && diagReportFreshness(diagState) === 'stale';
  const hardwareReportUrl = issueUrl('hardware_report.yml');
  const errorPacket = sync.lastError?.body ?? null;
  const tele = sync.lastVideo?.body ?? null;
  const achievedFps = typeof tele?.['achievedFps'] === 'number' ? tele['achievedFps'] : null;

  return (
    <>
      <Panel
        title="Connection"
        hint="How this PC and your phone reach each other, and what that tells anyone else."
      >
        <Field
          label="Route"
          htmlFor="room-transport"
          description="Automatic tries the fast route first and falls back to a slower one if it cannot connect within five seconds."
        >
          <Select
            id="room-transport"
            value={state.sync.transport === 'fake' ? 'auto' : state.sync.transport}
            options={[
              { value: 'auto', label: 'Automatic — recommended' },
              { value: 'mqtt', label: 'MQTT only' },
              { value: 'ntfy', label: 'ntfy only' },
              { value: 'off', label: 'Off — same PC only' },
            ]}
            onChange={(raw) => {
              commit((s) => ({
                ...s,
                sync: { ...s.sync, transport: raw as AppState['sync']['transport'] },
              }));
            }}
          />
        </Field>

        <Row>
          <Toggle id="room-endpoints" checked={showEndpoints} onChange={setShowEndpoints} />
          <label htmlFor="room-endpoints">Use my own broker</label>
        </Row>
        {showEndpoints && (
          <>
            <Field
              label="MQTT URL"
              htmlFor="room-mqtt"
              description="wss:// or ws://. Empty means this build's default."
            >
              <TextInput
                id="room-mqtt"
                value={state.sync.mqttUrl}
                placeholder={DEFAULT_MQTT_URL}
                onChange={(mqttUrl) => {
                  commit((s) => ({ ...s, sync: { ...s.sync, mqttUrl } }));
                }}
              />
            </Field>
            <Field
              label="ntfy base URL"
              htmlFor="room-ntfy"
              description="https:// only. Empty means this build's default."
            >
              <TextInput
                id="room-ntfy"
                value={state.sync.ntfyBase}
                placeholder={DEFAULT_NTFY_BASE}
                onChange={(ntfyBase) => {
                  commit((s) => ({ ...s, sync: { ...s.sync, ntfyBase } }));
                }}
              />
            </Field>
          </>
        )}

        <Row>
          <Toggle
            id="room-persist"
            checked={state.sync.persistRemote}
            onChange={(persistRemote) => {
              commit((s) => ({ ...s, sync: { ...s.sync, persistRemote } }));
            }}
          />
          <label htmlFor="room-persist">Your Kraken remembers remote changes across reboots</label>
        </Row>
        <Row>
          <Toggle
            id="room-tele"
            checked={state.sync.publishTelemetry}
            onChange={(publishTelemetry) => {
              commit((s) => ({ ...s, sync: { ...s.sync, publishTelemetry } }));
            }}
          />
          <label htmlFor="room-tele">Your Kraken reports back to this page</label>
        </Row>
      </Panel>

      <Panel
        title="Hardware report"
        hint="Pull a report off the machine running CAM — from this browser, on any machine."
      >
        <p className="kh-hint">
          Your Kraken checks itself for about five seconds and sends the answer back over the paired
          room, encrypted like everything else. It does <strong>not</strong> need to have been
          opened with <Code inline>?diag=1</Code>, and that is the point: nobody can edit a URL on a
          hidden window from another computer.
        </p>
        <Row>
          <Button
            primary
            disabled={!paired || diagState === 'waiting'}
            testId="request-report"
            title={
              paired
                ? 'Asks the display for a report; it answers on the telemetry channel.'
                : 'Pair a room on the Remote page first — there is nothing to ask.'
            }
            onClick={() => {
              setDiagCopied(false);
              setDiagRequestedAt(Date.now());
              sync.sendCmd('requestDiag');
            }}
          >
            {diagState === 'waiting' ? 'Waiting for the display…' : 'Request hardware report'}
          </Button>
          {diag !== null && (
            <Chip tone={diagStale ? 'warn' : 'ok'}>
              {diagStale ? 'stale — from an earlier request, captured ' : 'captured '}
              {new Date(diag.report.capturedAt).toLocaleTimeString()}
            </Chip>
          )}
        </Row>

        {diagState === 'waiting' && (
          <p className="kh-hint">
            Asked. The display measures its frame rate for three seconds before it answers, so this
            normally takes five or six — and gives up after{' '}
            {Math.round(DIAG_REQUEST_TIMEOUT_MS / 1000)}.
          </p>
        )}
        {diagState === 'timeout' && (
          <Notice tone="error">
            The display did not answer — is it on and paired? Your Kraken is only reachable while
            CAM has kraken-hub open on the same room code.
            {diagStale && ' The report below is the earlier one, not an answer to this request.'}
          </Notice>
        )}

        {diag !== null && (
          <>
            <table className="kh-table" data-testid="pulled-summary">
              <tbody>
                <tr>
                  <th scope="row">Panel</th>
                  <td>
                    {diag.report.device.width}×{diag.report.device.height}{' '}
                    {diag.report.device.shape} ({diag.report.device.geometrySource})
                  </td>
                </tr>
                <tr>
                  <th scope="row">devicePixelRatio</th>
                  <td>{diag.report.device.dpr}</td>
                </tr>
                <tr>
                  <th scope="row">Target FPS</th>
                  <td>{diag.report.device.targetFps}</td>
                </tr>
                <tr>
                  <th scope="row">Chromium</th>
                  <td>{diag.report.capabilities.chromiumVersion ?? 'not Chromium'}</td>
                </tr>
                <tr>
                  <th scope="row">window.nzxt</th>
                  <td>{diag.report.injection.present ? 'injected' : 'absent'}</td>
                </tr>
                <tr>
                  <th scope="row">rAF fps (p50)</th>
                  <td>{diag.report.timings.rafFps?.p50?.toFixed(1) ?? '—'}</td>
                </tr>
                <tr>
                  <th scope="row">Build</th>
                  <td>
                    {diag.report.app.version} · {diag.report.app.gitSha}
                  </td>
                </tr>
              </tbody>
            </table>
            <details data-testid="pulled-report">
              <summary>Raw JSON</summary>
              <Code>{toJson(diag.report)}</Code>
            </details>
            <Row>
              <Button
                primary
                testId="copy-report"
                onClick={() => {
                  void navigator.clipboard.writeText(toJson(diag.report)).then(
                    () => {
                      setDiagCopied(true);
                    },
                    () => {
                      setDiagCopied(false);
                    },
                  );
                }}
              >
                {diagCopied ? 'Copied' : 'Copy JSON'}
              </Button>
              {hardwareReportUrl !== null && (
                <a className="kh-btn" href={hardwareReportUrl} target="_blank" rel="noreferrer">
                  File a hardware report
                </a>
              )}
            </Row>
          </>
        )}
      </Panel>

      <Panel title="Connection detail" hint="What the link is doing, in its own words.">
        <Row>
          <Chip tone={sync.status?.network === 'online' ? 'ok' : 'warn'} testId="connection-net">
            {sync.status === null
              ? 'not started'
              : `${sync.status.networkTransport ?? 'no transport'} — ${sync.status.network}`}
          </Chip>
          <Chip tone={sync.status?.local === 'online' ? 'ok' : 'neutral'}>
            local bus — {sync.status?.local ?? 'idle'}
          </Chip>
          {sync.status?.failedOver === true && (
            <Chip tone="warn">fallback transport — higher latency</Chip>
          )}
          <Chip tone={sync.lastTele === null ? 'neutral' : 'ok'}>
            {sync.lastTele === null
              ? 'no telemetry yet'
              : `display seen ${String(Math.max(0, Math.round((now - sync.lastTele.at) / 1000)))}s ago`}
          </Chip>
          {achievedFps !== null && (
            <Chip tone="neutral">{achievedFps.toFixed(1)} fps achieved</Chip>
          )}
          {sync.topicId !== null && <Chip tone="neutral">topic {sync.topicId}</Chip>}
        </Row>
        {sync.status?.lastError != null && <Notice tone="warn">{sync.status.lastError}</Notice>}
        {errorPacket !== null && (
          <Notice tone="error">
            {asText(errorPacket['code'], 'error')}: {asText(errorPacket['message'], '')}
          </Notice>
        )}
        {sync.status !== null && sync.status.decryptFailures >= 10 && (
          <Notice tone="error">
            No messages could be decrypted. The other side is almost certainly on a different room
            code.
          </Notice>
        )}

        <Disclosure summary="What leaves your machine" testId="privacy-note">
          <p className="kh-hint">
            Only the room code stays private, and only because you never send it: the broker sees a
            topic derived from <Code inline>SHA-256(code)</Code>, and every payload is AES-GCM
            encrypted under a key derived from the same code, with a separate key per channel. What
            the broker can observe is that <em>some</em> topic exists, how big the messages are and
            how often they arrive. What it cannot read is the video URL, the seek position, the clip
            names or any error text.
          </p>
          <p className="kh-hint">
            Telemetry contains playback position, achieved frame rate, panel geometry, error codes,
            the names and durations of stored clips, and a <em>hash</em> of the source URL — never
            the URL itself. Full detail, including the honest limits of a 40-bit room code, is in
            docs/remote-control.md.
          </p>
        </Disclosure>
      </Panel>
    </>
  );
}
