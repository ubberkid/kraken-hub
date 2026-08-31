import { useMemo, useState } from 'react';

import { camInstallUrl } from '../../../config/knownHosts';
import { listModules } from '../../../modules/registry';
import { formatRoomCode, generateRoomCode } from '../../../sync/roomCode';
import { Button, Chip, Code, Field, Panel, Row, Select } from '../../../ui';
import { qrMatrix, qrSvgPath } from '../qr';

import type { ConfigRuntime } from '../runtime';

/**
 * The first thing a new user sees.
 *
 * Two jobs, in order of how much support pain they prevent:
 *  1. Tell them where the CAM frame-rate slider is. It defaults to 1 FPS and
 *     nothing else we do matters until it is raised.
 *  2. Hand them the exact URL to paste into CAM — derived from `location`, so a
 *     fork on any origin gets the right one with no configuration.
 */
export function SetupView({ runtime }: { runtime: ConfigRuntime }) {
  const [copied, setCopied] = useState(false);
  const [copiedRemote, setCopiedRemote] = useState(false);
  const state = runtime.store.getSnapshot();
  const modules = listModules();

  const remoteUrl =
    state.sync.roomCode === null ? null : `${runtime.appUrl}#/remote?room=${state.sync.roomCode}`;

  // Generated locally, never fetched: the URL contains the room code.
  const qr = useMemo(() => {
    if (remoteUrl === null) return null;
    try {
      return qrSvgPath(qrMatrix(remoteUrl));
    } catch {
      return null;
    }
  }, [remoteUrl]);

  const copyRemote = (): void => {
    if (remoteUrl === null) return;
    void navigator.clipboard.writeText(remoteUrl).then(
      () => {
        setCopiedRemote(true);
      },
      () => {
        setCopiedRemote(false);
      },
    );
  };

  const copy = (): void => {
    void navigator.clipboard.writeText(runtime.appUrl).then(
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
        title="Step 1 — raise the frame rate"
        hint="CAM ships this slider at 1 FPS. Everything looks like a slideshow until you move it."
      >
        <p className="kh-hint">
          CAM → Lighting → Kraken → Web Integration → <strong>Frame Rate</strong> → drag to maximum.
        </p>
      </Panel>

      <Panel
        title="Step 2 — point CAM at kraken-hub"
        hint="Paste this URL as the Web Integration address."
      >
        <Code>{runtime.appUrl}</Code>
        <Row>
          <Button onClick={copy} primary>
            {copied ? 'Copied' : 'Copy URL'}
          </Button>
          <a className="kh-btn" href={camInstallUrl(runtime.appUrl)}>
            Open in CAM
          </a>
          <a className="kh-btn" href={camInstallUrl(runtime.appUrl, true)}>
            Open in CAM Beta
          </a>
          <Chip tone={runtime.camDetected ? 'ok' : 'neutral'}>
            {runtime.camDetected ? 'CAM detected' : 'Ordinary browser'}
          </Chip>
        </Row>
      </Panel>

      <Panel
        title="Step 3 — choose a module"
        hint="The display shows exactly one module at a time."
      >
        <Field label="Active module" htmlFor="setup-module">
          <Select
            id="setup-module"
            value={state.activeModuleId}
            options={modules.map((m) => ({ value: m.id, label: m.name }))}
            onChange={(id) => {
              runtime.store.commit((s) => ({ ...s, activeModuleId: id }));
            }}
          />
        </Field>
        <Row>
          {modules.map((m) => (
            <a key={m.id} className="kh-btn" href={`#/module/${m.id}`}>
              {m.name} settings
            </a>
          ))}
        </Row>
      </Panel>

      <Panel
        title="Step 4 — pair your phone (optional)"
        hint="One eight-character code. No account, no server of ours, and payloads the broker cannot read."
      >
        <Field
          label="Room code"
          htmlFor="setup-room"
          description="Scan the code or open the link on your phone. Full controls, transports and the privacy model live under Remote."
        >
          <Code>
            {state.sync.roomCode === null ? '— none —' : formatRoomCode(state.sync.roomCode)}
          </Code>
        </Field>
        <Row>
          {qr !== null && (
            <svg
              className="kh-qr"
              viewBox={`0 0 ${String(qr.side)} ${String(qr.side)}`}
              width={150}
              height={150}
              role="img"
              aria-label="Pairing QR code for the remote URL"
              shapeRendering="crispEdges"
            >
              <rect width={qr.side} height={qr.side} fill="#ffffff" />
              <path d={qr.d} fill="#000000" />
            </svg>
          )}
          <div>
            {remoteUrl !== null && <Code>{remoteUrl}</Code>}
            <Row>
              <Button
                onClick={() => {
                  const fresh = generateRoomCode();
                  runtime.store.commit((s) => ({
                    ...s,
                    sync: { ...s.sync, roomCode: fresh, enabled: true },
                  }));
                }}
              >
                {state.sync.roomCode === null ? 'Generate room code' : 'Rotate room code'}
              </Button>
              {remoteUrl !== null && (
                <Button onClick={copyRemote}>{copiedRemote ? 'Copied' : 'Copy remote link'}</Button>
              )}
              <a className="kh-btn" href="#/remote">
                Open the remote
              </a>
            </Row>
          </div>
        </Row>
      </Panel>
    </>
  );
}
