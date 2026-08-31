import { useEffect, useState } from 'react';

import { docUrl } from '../buildInfo';
import { readGeometry } from '../platform/geometry';
import { Button, Chip, Code, Panel, Row } from '../ui';

import {
  NETWORK_TARGETS,
  probeApiSurface,
  probeDevice,
  probeInjection,
  probeStorage,
  sampleRafFps,
} from './probes';
import { newReport, readDisplayReport, toJson, type DiagReport } from './report';

import type { ConfigRuntime } from '../app/config/runtime';

/**
 * `#/diag` — runs its own probes AND shows whatever the display page last
 * published to localStorage.
 *
 * That second half is the whole point: an LCD has no keyboard, no scrollbar and
 * no clipboard, so the only way to get its measurements into a GitHub issue is
 * for the display to write them somewhere this page can read.
 */
const RAF_SAMPLE_MS = 2000;
const DISPLAY_POLL_MS = 2000;

export function DiagView({ runtime }: { runtime: ConfigRuntime }) {
  const [local, setLocal] = useState<DiagReport | null>(null);
  const [display, setDisplay] = useState<DiagReport | null>(() => readDisplayReport());
  const [copied, setCopied] = useState(false);

  // Bumped by the "Re-run probes" button; the effect below owns the probing.
  const [runNonce, setRunNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const probe = async (): Promise<void> => {
      const state = runtime.store.getSnapshot();
      const rafFps = await sampleRafFps(RAF_SAMPLE_MS);
      const storage = await probeStorage();
      if (cancelled) return;
      setLocal(
        newReport({
          mode: 'config',
          device: probeDevice(
            readGeometry({ fallbackTargetFps: state.platform.fallbackTargetFps }, state.render),
          ),
          injection: probeInjection(),
          capabilities: probeApiSurface(),
          storage,
          timings: { rafFps, monitoringIntervalMs: null, achievedFps: null, longFrames: null },
        }),
      );
    };

    void probe();
    // The display republishes every 5 s while ?diag=1 is open; poll for it.
    const timer = setInterval(() => {
      setDisplay(readDisplayReport());
    }, DISPLAY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runtime, runNonce]);

  /**
   * Every field in these reports maps to an H-id, and the H-ids only mean
   * something if the reader can reach the page that defines them. `docs/` is
   * not deployed with the app, so this has to be an absolute link — built from
   * the repository named in this build's own `package.json`, so a fork links to
   * the fork.
   */
  const checklist = docUrl('docs/hardware-checklist.md');

  const copy = (report: DiagReport): void => {
    void navigator.clipboard.writeText(toJson(report)).then(
      () => {
        setCopied(true);
      },
      () => {
        setCopied(false);
      },
    );
  };

  return (
    <>
      <Panel
        title="This browser"
        hint="Probes run here, in the CAM Configuration Browser or an ordinary tab."
      >
        {local === null ? (
          <p className="kh-hint">Running probes…</p>
        ) : (
          <>
            <table className="kh-table">
              <tbody>
                <tr>
                  <th scope="row">Chromium</th>
                  <td>{local.capabilities.chromiumVersion ?? 'not Chromium'}</td>
                </tr>
                <tr>
                  <th scope="row">Electron</th>
                  <td>{local.capabilities.electronVersion ?? 'no'}</td>
                </tr>
                <tr>
                  <th scope="row">devicePixelRatio</th>
                  <td>{local.device.dpr}</td>
                </tr>
                <tr>
                  <th scope="row">window.nzxt</th>
                  <td>{local.injection.present ? 'injected' : 'absent'}</td>
                </tr>
                <tr>
                  <th scope="row">rAF fps (p50)</th>
                  <td>{local.timings.rafFps?.p50?.toFixed(1) ?? '—'}</td>
                </tr>
                <tr>
                  <th scope="row">Storage persisted</th>
                  <td>{String(local.storage.persisted)}</td>
                </tr>
                <tr>
                  <th scope="row">State delivery</th>
                  <td>
                    event {local.storage.delivery.viaEvent} · poll {local.storage.delivery.viaPoll}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Codecs</th>
                  <td>
                    {Object.entries(local.capabilities.codecs)
                      .map(([id, c]) => `${id}:${c.element === '' ? 'no' : c.element}`)
                      .join(' · ')}
                  </td>
                </tr>
              </tbody>
            </table>
            <Row>
              <Button
                onClick={() => {
                  copy(local);
                }}
              >
                {copied ? 'Copied' : 'Copy JSON'}
              </Button>
              <Button
                onClick={() => {
                  setRunNonce((n) => n + 1);
                }}
              >
                Re-run probes
              </Button>
            </Row>
          </>
        )}
      </Panel>

      <Panel
        title="The display"
        hint="Open the display with ?kraken=1&diag=1 — it publishes its report here every 5 seconds. Every field maps to an H-id in docs/hardware-checklist.md."
      >
        <Row>
          <Chip tone={display === null ? 'warn' : 'ok'}>
            {display === null
              ? 'no report yet'
              : `captured ${new Date(display.capturedAt).toLocaleTimeString()}`}
          </Chip>
          <a className="kh-btn" href="./?kraken=1&diag=1" target="_blank" rel="noreferrer">
            Open display diagnostics
          </a>
          <a
            className="kh-btn"
            href="./?kraken=1&diag=1&pattern=rings"
            target="_blank"
            rel="noreferrer"
          >
            Ring target (H20)
          </a>
          {checklist !== null && (
            <a className="kh-btn" href={checklist} target="_blank" rel="noreferrer">
              Hardware checklist (H01–H23)
            </a>
          )}
        </Row>
        <p className="kh-hint">
          This hand-off is <strong>same-machine only</strong>: it works because CAM&rsquo;s two
          browsers share one storage partition. If you run CAM on one computer and work on another,
          pair a room on the Remote page instead — a paired browser anywhere can press{' '}
          <strong>Request hardware report</strong> and pull the same JSON across the network, with
          no URL to edit on the machine running CAM.
        </p>
        {display !== null && (
          <>
            <Code>{toJson(display)}</Code>
            <Row>
              <Button
                primary
                onClick={() => {
                  copy(display);
                }}
              >
                Copy display JSON
              </Button>
            </Row>
          </>
        )}
      </Panel>

      <Panel
        title="Network reachability (H19)"
        hint="Opt-in: nothing here contacts the network until you ask."
      >
        <ul>
          {NETWORK_TARGETS.map((t) => (
            <li key={t.id} className="kh-hint">
              {t.label}
            </li>
          ))}
        </ul>
        <p className="kh-hint">
          Nothing on this page probes them. Live status for a paired room is on the Remote page;
          whether CAM&rsquo;s webview can reach either host at all is <strong>H19</strong>, still
          unmeasured — see the hardware checklist above.
        </p>
      </Panel>
    </>
  );
}
