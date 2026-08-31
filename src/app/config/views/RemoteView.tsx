import { useEffect, useMemo, useRef, useState } from 'react';

import { issueUrl } from '../../../buildInfo';
import { camInstallUrl } from '../../../config/knownHosts';
import { toJson } from '../../../diag/report';
import { diagPhase, diagReportFreshness, DIAG_REQUEST_TIMEOUT_MS } from '../../../diag/wire';
import { listModules } from '../../../modules/registry';
import { validateUrl, primaryIssue } from '../../../modules/video/routing/validate';
import { validateVideoConfig, type VideoModuleConfig } from '../../../modules/video/types';
import { withModuleConfig } from '../../../state/selectors';
import { DEFAULT_MQTT_URL, DEFAULT_NTFY_BASE } from '../../../sync/endpoints';
import { anchorPosition, type WirePosition } from '../../../sync/position';
import { formatRoomCode, generateRoomCode, normalizeRoomCode } from '../../../sync/roomCode';
import {
  Button,
  Chip,
  Code,
  Field,
  Notice,
  Panel,
  RangeInput,
  Row,
  Select,
  TextInput,
  Toggle,
} from '../../../ui';
import { qrMatrix, qrSvgPath } from '../qr';
import { useSync } from '../useSync';

import type { AppState } from '../../../state/schema';
import type { ConfigRuntime } from '../runtime';

const VIDEO_ID = 'video';
const SEEK_STEP_SEC = 10;
const LOOP_MAX_SEC = 3600;
const REANCHOR_MS = 250;
/** The A-B sliders are hard-throttled here as well as in SyncService. */
const LOOP_WRITE_THROTTLE_MS = 200;
/** Matches `SyncService`'s `PUBLISH_THROTTLE_MS`, so `cmd` and `state` agree. */
const SEEK_WRITE_THROTTLE_MS = 200;
/** The seek bar's granularity. Half of it is the echo guard's tolerance. */
const SEEK_SLIDER_STEP_SEC = 0.5;

/** Telemetry values arrive as `unknown`; render them without stringifying an object. */
function asText(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

/** The remote's whole surface: pair, drive, watch. */
export function RemoteView({ runtime }: { runtime: ConfigRuntime }) {
  const state = runtime.store.getSnapshot();
  const sync = useSync(runtime);

  const [codeDraft, setCodeDraft] = useState(state.sync.roomCode ?? '');
  /** `null` means "show whatever the stored config says" — no effect needed. */
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showEndpoints, setShowEndpoints] = useState(false);
  /** When the last `requestDiag` went out. `null` before anyone has asked. */
  const [diagRequestedAt, setDiagRequestedAt] = useState<number | null>(null);
  const [diagCopied, setDiagCopied] = useState(false);
  const lastLoopWrite = useRef(0);
  const lastSeekWrite = useRef(0);
  const pendingSeek = useRef<number | null>(null);
  const seekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (seekTimer.current !== null) clearTimeout(seekTimer.current);
    },
    [],
  );

  /**
   * The clock, sampled OUTSIDE render.
   *
   * The seek bar is driven by telemetry, which arrives at 2 Hz at best, so the
   * position has to be re-anchored from `posSec + posAtTs` between packets.
   * Calling `Date.now()` during render would make this component non-idempotent
   * (React may render it twice and get two answers), so the clock is state and
   * the interval is the only thing that moves it. `0` means "not sampled yet",
   * which renders the raw sample rather than a wrong extrapolation.
   */
  const [now, setNow] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, REANCHOR_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const videoCfg: VideoModuleConfig = useMemo(
    () => validateVideoConfig(state.modules[VIDEO_ID]?.cfg),
    [state],
  );

  const commit = (mutate: (s: AppState) => AppState): void => {
    runtime.store.commit(mutate);
  };

  const setVideo = (patch: Partial<VideoModuleConfig>): void => {
    commit((s) => withModuleConfig(s, VIDEO_ID, 1, { ...videoCfg, ...patch }));
  };

  // -------------------------------------------------------------------------
  // Pairing
  // -------------------------------------------------------------------------

  const remoteUrl = useMemo(() => {
    const code = state.sync.roomCode;
    if (code === null) return null;
    return `${runtime.appUrl}#/remote?room=${code}`;
  }, [runtime.appUrl, state.sync.roomCode]);

  const qr = useMemo(() => {
    if (remoteUrl === null) return null;
    try {
      return qrSvgPath(qrMatrix(remoteUrl));
    } catch {
      // A fork URL long enough to overflow a version-10 code still gets the
      // copyable link below; a missing QR is not a broken page.
      return null;
    }
  }, [remoteUrl]);

  const applyCode = (raw: string): void => {
    const normalized = normalizeRoomCode(raw);
    if (normalized === null) return;
    commit((s) => ({ ...s, sync: { ...s.sync, roomCode: normalized, enabled: true } }));
    setCodeDraft(normalized);
  };

  const rotate = (): void => {
    const fresh = generateRoomCode();
    setCodeDraft(fresh);
    commit((s) => ({ ...s, sync: { ...s.sync, roomCode: fresh, enabled: true } }));
  };

  const copyLink = (): void => {
    if (remoteUrl === null) return;
    void navigator.clipboard.writeText(remoteUrl).then(
      () => {
        setCopied(true);
      },
      () => {
        setCopied(false);
      },
    );
  };

  // -------------------------------------------------------------------------
  // Telemetry readout
  // -------------------------------------------------------------------------

  const tele = sync.lastTele?.body ?? null;
  const playback = state.playback;
  const durationSec = playback?.durationSec ?? null;

  /**
   * The scrubber's position — re-anchored, not frozen.
   *
   * Telemetry lands at 0.5 Hz (0.2 Hz in performance mode), so a scrubber that
   * simply rendered `stats.currentTime` would sit still for two seconds and
   * then jump. Every stats packet is a `posSec + posAtTs` pair in disguise —
   * `stats.currentTime` sampled on the display at the packet's own `ts` — so it
   * feeds `anchorPosition()` exactly like any other wire position, and the
   * 250 ms clock above moves the bar smoothly between packets.
   *
   * `state.playback` is the fallback rather than the primary source: it changes
   * only when somebody seeks (see `publishSeek` below), whereas telemetry is
   * the display's continuous ground truth. And an anchored sample that has gone
   * `stale` is discarded in favour of the raw one — that is the case where the
   * two machines' clocks disagree badly enough that extrapolating would invent
   * a position that never existed.
   */
  const statsBody = sync.lastStats?.body ?? null;
  const stats = statsBody?.['stats'] as { currentTime?: number; held?: boolean } | undefined;
  const statsTs =
    typeof statsBody?.['ts'] === 'number' ? statsBody['ts'] : (sync.lastStats?.at ?? null);

  let wire: WirePosition | null = null;
  if (stats?.currentTime !== undefined && statsTs !== null) {
    wire = {
      posSec: stats.currentTime,
      posAtTs: statsTs,
      paused: stats.held === true,
      rate: playback?.rate ?? 1,
    };
  } else if (playback !== null) {
    wire = {
      posSec: playback.posSec,
      posAtTs: playback.posAtTs,
      paused: playback.paused,
      rate: playback.rate,
    };
  }

  const anchored = wire === null || now === 0 ? null : anchorPosition(wire, now, durationSec);
  const positionSec = anchored !== null && !anchored.stale ? anchored.posSec : (wire?.posSec ?? 0);
  /** What the seek bar is showing right now — also the echo guard's reference. */
  const seekBarValue = Math.min(positionSec, durationSec ?? LOOP_MAX_SEC);

  /**
   * An explicit seek is the ONE position that travels as *state*.
   *
   * The `cmd` channel does the seek — it is imperative, one-shot and never
   * replayed, which is exactly right for "go there now". But a command is also
   * never retained, so a display that boots ten seconds later would know
   * nothing about it. Writing `playback` here puts the same seek in the
   * retained snapshot as `posSec + posAtTs`, which is what lets a cold display
   * resume near where the user left it. The display applies it once, keyed on
   * `posAtTs`, so the retained copy is not re-seeked on every keepalive.
   *
   * Publishing state from here is allowed and the display still never does it:
   * the roles are config/remote publish `state`, display publishes `tele`.
   */
  const writeSeek = (posSec: number, at: number): void => {
    const paused = stats?.held ?? playback?.paused ?? false;
    commit((s) => ({
      ...s,
      playback: {
        ownerModuleId: s.activeModuleId,
        paused,
        posSec: Math.max(0, posSec),
        posAtTs: at,
        durationSec: s.playback?.durationSec ?? durationSec,
        rate: s.playback?.rate ?? 1,
        // Muted-only is a platform invariant, not a preference: the panel has
        // no speakers anybody has measured (hardware checklist H08).
        muted: true,
        volume: s.playback?.volume ?? 1,
        loop: s.playback?.loop ?? { enabled: false, startSec: 0, endSec: null },
      },
    }));
  };

  /**
   * Throttled with a TRAILING edge, unlike the A-B sliders above.
   *
   * Dragging fires `onChange` on every pixel and each one would otherwise be a
   * localStorage write and a retained snapshot. Leading-edge alone was tried and
   * is wrong here: it drops the LAST event of a drag, which is the only one that
   * matters — the position the user let go at — and the retained snapshot would
   * then permanently disagree with the `seekTo` command that did land. So the
   * first event goes out immediately and the last suppressed one is flushed at
   * the end of the window.
   */
  const publishSeek = (posSec: number): void => {
    const at = Date.now();
    const elapsed = at - lastSeekWrite.current;
    if (elapsed >= SEEK_WRITE_THROTTLE_MS) {
      lastSeekWrite.current = at;
      writeSeek(posSec, at);
      return;
    }
    pendingSeek.current = posSec;
    if (seekTimer.current !== null) return;
    seekTimer.current = setTimeout(() => {
      seekTimer.current = null;
      const value = pendingSeek.current;
      pendingSeek.current = null;
      if (value === null) return;
      lastSeekWrite.current = Date.now();
      writeSeek(value, lastSeekWrite.current);
    }, SEEK_WRITE_THROTTLE_MS - elapsed);
  };
  const achievedFps = typeof tele?.['achievedFps'] === 'number' ? tele['achievedFps'] : null;
  const errorPacket = sync.lastError?.body ?? null;

  const clips = useMemo(() => {
    const raw = sync.library?.body['clips'];
    if (!Array.isArray(raw)) return [];
    return raw as { id: string; name: string; durationSec: number }[];
  }, [sync.library]);

  const downloads = useMemo(() => {
    const raw = sync.library?.body['downloads'];
    if (!Array.isArray(raw)) return [];
    return raw as { id: string; name: string; state: string; receivedBytes: number }[];
  }, [sync.library]);

  /**
   * The Diagnostics card's whole state machine, in one pure call.
   *
   * `now` rather than `Date.now()` because this runs during render: the 250 ms
   * clock above is the only thing allowed to move time here, which is also what
   * makes the 20-second timeout tick without a timer of its own.
   */
  const diag = sync.diagReport;
  const diagState = diagPhase({
    requestedAt: diagRequestedAt,
    receivedAt: diag?.at ?? null,
    now,
  });
  // A report survives a timed-out re-request (see `diagReportFreshness`), so the
  // chip has to distinguish "this is the answer" from "this is what it said last
  // time" — an unqualified "captured 14:02" next to a timeout Notice reads as a
  // healthy display.
  const diagStale = diag !== null && diagReportFreshness(diagState) === 'stale';
  const hardwareReportUrl = issueUrl('hardware_report.yml');

  const urlValue = urlDraft ?? videoCfg.url;
  const urlCheck = urlValue.trim().length === 0 ? null : validateUrl(urlValue.trim());
  const urlIssue = urlCheck === null ? null : primaryIssue(urlCheck);
  const paired = state.sync.roomCode !== null && state.sync.enabled;

  // -------------------------------------------------------------------------

  return (
    <>
      <Panel
        title="Pairing"
        hint="One code pairs everything. There is no account, no server of ours, and nothing to sign up for."
      >
        <Field
          label="Room code"
          htmlFor="remote-room"
          description="Eight characters, Crockford base32 — no I, L, O or U, so nothing is ambiguous when you read it off a screen."
        >
          <Row>
            <TextInput
              id="remote-room"
              value={codeDraft}
              placeholder="ABCD1234"
              onChange={(next) => {
                setCodeDraft(next.toUpperCase());
              }}
            />
            <Button
              primary
              onClick={() => {
                applyCode(codeDraft);
              }}
            >
              Join
            </Button>
            <Button onClick={rotate}>{paired ? 'Rotate code' : 'Generate code'}</Button>
          </Row>
        </Field>

        {paired && state.sync.roomCode !== null && (
          <>
            <p className="kh-hint">
              Current room <Code>{formatRoomCode(state.sync.roomCode)}</Code>
              {sync.topicId !== null && (
                <>
                  {' '}
                  → topic <Code>{sync.topicId}</Code>
                </>
              )}
            </p>
            <Row>
              {qr !== null && (
                <svg
                  className="kh-qr"
                  viewBox={`0 0 ${String(qr.side)} ${String(qr.side)}`}
                  width={180}
                  height={180}
                  role="img"
                  aria-label="Pairing QR code for the remote URL"
                  shapeRendering="crispEdges"
                >
                  <rect width={qr.side} height={qr.side} fill="#ffffff" />
                  <path d={qr.d} fill="#000000" />
                </svg>
              )}
              <div>
                <Code>{remoteUrl}</Code>
                <Row>
                  <Button onClick={copyLink}>{copied ? 'Copied' : 'Copy remote link'}</Button>
                </Row>
              </div>
            </Row>
          </>
        )}

        {!paired && (
          <Notice tone="warn">
            No room yet. Generate a code here, then open the same code on your phone — or scan the
            QR that appears once a room exists.
          </Notice>
        )}
      </Panel>

      <Panel title="Status" hint="What the link is doing right now.">
        <Row>
          <Chip tone={sync.status?.network === 'online' ? 'ok' : 'warn'}>
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
      </Panel>

      <Panel title="Source" hint="Paste a URL. The display validates it again before it plays.">
        <Field label="Video URL" htmlFor="remote-src">
          <Row>
            <TextInput
              id="remote-src"
              value={urlValue}
              placeholder="Paste a video link"
              onChange={setUrlDraft}
            />
            <Button
              primary
              onClick={() => {
                setVideo({ url: urlValue.trim() });
                setUrlDraft(null);
              }}
            >
              Play
            </Button>
          </Row>
        </Field>
        {urlIssue !== null && (
          <Notice tone={urlIssue.severity === 'error' ? 'error' : 'warn'}>
            {urlIssue.message}
          </Notice>
        )}
        {urlCheck?.ok === true && urlIssue === null && (
          <Notice tone="ok">Recognised as {urlCheck.match.provider ?? 'a direct file'}.</Notice>
        )}
      </Panel>

      <Panel
        title="Transport"
        hint="Play, hold and seek. Commands are one-shot and never replayed."
      >
        <Row>
          <Button
            onClick={() => {
              sync.sendCmd('play');
            }}
          >
            Play
          </Button>
          <Button
            onClick={() => {
              sync.sendCmd('pause');
            }}
            title="Hold, not a true pause: a real pause raises YouTube's suggested-video grid over the frame."
          >
            Hold
          </Button>
          <Button
            onClick={() => {
              sync.sendCmd('seekBy', -SEEK_STEP_SEC);
              publishSeek(positionSec - SEEK_STEP_SEC);
            }}
          >
            −10 s
          </Button>
          <Button
            onClick={() => {
              sync.sendCmd('seekBy', SEEK_STEP_SEC);
              publishSeek(positionSec + SEEK_STEP_SEC);
            }}
          >
            +10 s
          </Button>
          <Button
            onClick={() => {
              sync.sendCmd('reload');
            }}
          >
            Re-initialise
          </Button>
        </Row>

        <Field
          label={`Position — ${positionSec.toFixed(1)} s${durationSec === null ? '' : ` / ${durationSec.toFixed(0)} s`}`}
          htmlFor="remote-seek"
          description="Driven by telemetry and re-anchored here from posSec + posAtTs, so it keeps moving between packets without ever drifting."
        >
          <RangeInput
            id="remote-seek"
            value={seekBarValue}
            min={0}
            max={durationSec ?? LOOP_MAX_SEC}
            step={SEEK_SLIDER_STEP_SEC}
            onChange={(next) => {
              /*
               * The echo guard.
               *
               * React delivers BOTH `input` and `change` for a controlled range,
               * and by the time the second one runs the component has already
               * re-rendered with the telemetry-anchored position — so the echo
               * arrives carrying the value the bar snapped back to, not the one
               * the user chose. Acting on it seeks the display back to where it
               * already was, undoing the seek that just happened.
               *
               * The tolerance is half a step, not exact equality, because the
               * two numbers are not the same number: the bar renders a
               * continuous `3.503996` and the input reports the grid value
               * `3.5`. Half a step is also exactly the widest a real gesture can
               * never be — the nearest position a user can actually choose is a
               * full step away.
               */
              if (Math.abs(next - seekBarValue) < SEEK_SLIDER_STEP_SEC / 2) return;
              sync.sendCmd('seekTo', next);
              publishSeek(next);
            }}
          />
        </Field>

        <Row>
          <Button
            disabled
            onClick={() => undefined}
            title="Audio is unverified on hardware (checklist H08): it is not known whether the CAM webview reaches the speakers at all. The display forces mute until somebody measures it."
          >
            Volume — unavailable
          </Button>
          <Button disabled onClick={() => undefined} title="Same reason: hardware checklist H08.">
            Unmute — unavailable
          </Button>
        </Row>
      </Panel>

      <Panel title="A–B loop" hint="Slider changes are throttled to 5 Hz on the wire.">
        <Row>
          <Toggle
            id="remote-loop"
            checked={videoCfg.loop.enabled}
            onChange={(enabled) => {
              setVideo({ loop: { ...videoCfg.loop, enabled } });
            }}
          />
          <label htmlFor="remote-loop">Loop between A and B</label>
        </Row>
        <Field label={`A — ${videoCfg.loop.start.toFixed(1)} s`} htmlFor="remote-loop-a">
          <RangeInput
            id="remote-loop-a"
            value={videoCfg.loop.start}
            min={0}
            max={durationSec ?? LOOP_MAX_SEC}
            step={0.5}
            onChange={(start) => {
              const at = Date.now();
              if (at - lastLoopWrite.current < LOOP_WRITE_THROTTLE_MS) return;
              lastLoopWrite.current = at;
              setVideo({ loop: { ...videoCfg.loop, start } });
            }}
          />
        </Field>
        <Field
          label={`B — ${videoCfg.loop.end === null ? 'end of clip' : `${videoCfg.loop.end.toFixed(1)} s`}`}
          htmlFor="remote-loop-b"
        >
          <RangeInput
            id="remote-loop-b"
            value={videoCfg.loop.end ?? durationSec ?? LOOP_MAX_SEC}
            min={0}
            max={durationSec ?? LOOP_MAX_SEC}
            step={0.5}
            onChange={(end) => {
              const at = Date.now();
              if (at - lastLoopWrite.current < LOOP_WRITE_THROTTLE_MS) return;
              lastLoopWrite.current = at;
              setVideo({ loop: { ...videoCfg.loop, end } });
            }}
          />
        </Field>
      </Panel>

      <Panel title="Framing" hint="Fit, zoom and rotation apply to whatever module is on screen.">
        <Field label="Fit" htmlFor="remote-fit">
          <Select
            id="remote-fit"
            value={state.render.fit}
            options={[
              { value: 'cover', label: 'Cover — fill the panel, crop the edges' },
              { value: 'contain', label: 'Contain — show everything, letterbox' },
              { value: 'contain-circle', label: 'Contain (circle) — inscribe in the bezel' },
              { value: 'fill', label: 'Fill — stretch' },
            ]}
            onChange={(fit) => {
              commit((s) => ({
                ...s,
                render: { ...s.render, fit: fit as AppState['render']['fit'] },
              }));
            }}
          />
        </Field>
        <Field label={`Zoom — ${state.render.zoom.toFixed(2)}×`} htmlFor="remote-zoom">
          <RangeInput
            id="remote-zoom"
            value={state.render.zoom}
            min={1}
            max={4}
            step={0.05}
            onChange={(zoom) => {
              commit((s) => ({ ...s, render: { ...s.render, zoom } }));
            }}
          />
        </Field>
        <Field label="Rotation" htmlFor="remote-rotate">
          <Select
            id="remote-rotate"
            value={String(state.render.rotate)}
            options={[
              { value: '0', label: '0°' },
              { value: '90', label: '90°' },
              { value: '180', label: '180°' },
              { value: '270', label: '270°' },
            ]}
            onChange={(raw) => {
              const rotate = Number(raw) as AppState['render']['rotate'];
              commit((s) => ({ ...s, render: { ...s.render, rotate } }));
            }}
          />
        </Field>
      </Panel>

      <Panel title="Module" hint="The display shows exactly one module at a time.">
        <Field label="Active module" htmlFor="remote-module">
          <Select
            id="remote-module"
            value={state.activeModuleId}
            options={listModules().map((m) => ({ value: m.id, label: m.name }))}
            onChange={(id) => {
              commit((s) => ({ ...s, activeModuleId: id }));
            }}
          />
        </Field>
      </Panel>

      <Panel
        title="Local clips"
        hint="The library lives on the machine running CAM. This page can pick from it, but cannot add to it."
      >
        <p className="kh-hint">
          CAM opens the configuration window and the LCD window in two Chromium browsers that share
          one storage profile — and your phone is a third, separate profile. So a file picker here
          would upload into the wrong place. Downloads and uploads happen in the CAM window; this
          list is what the display has announced over telemetry.
        </p>
        <Row>
          <a className="kh-btn" href={camInstallUrl(runtime.appUrl)}>
            Open kraken-hub in CAM
          </a>
        </Row>
        {clips.length === 0 ? (
          <Notice tone="warn">
            No clip index yet — the display publishes one once it has connected.
          </Notice>
        ) : (
          <Field label="Play a stored clip" htmlFor="remote-clip">
            <Select
              id="remote-clip"
              value=""
              options={[
                { value: '', label: `— ${String(clips.length)} clips —` },
                ...clips.map((c) => ({
                  value: c.id,
                  label: `${c.name} (${c.durationSec.toFixed(0)} s)`,
                })),
              ]}
              onChange={(id) => {
                if (id.length > 0) setVideo({ url: `kraken-hub-clip:${id}` });
              }}
            />
          </Field>
        )}
        {downloads.length > 0 && (
          <ul className="kh-cliplist">
            {downloads.map((d) => (
              <li key={d.id} className="kh-clip">
                <span className="kh-clip__name">{d.name}</span>
                <span className="kh-clip__detail">{d.state}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Diagnostics"
        hint="Pull a hardware report off the machine running CAM — from this browser, on any machine."
      >
        <p className="kh-hint">
          The display probes itself for about five seconds and sends the report back over this room,
          encrypted like everything else on the wire. It does <strong>not</strong> need to have been
          opened with <Code>?diag=1</Code>, and that is the point: nobody can edit a URL on a hidden
          Kraken Browser window from another computer. The same-machine route — <Code>#/diag</Code>{' '}
          in CAM&rsquo;s own Configuration Browser — still exists and is unchanged.
        </p>
        <Row>
          <Button
            primary
            disabled={!paired || diagState === 'waiting'}
            title={
              paired
                ? 'Sends a requestDiag command; the display answers on the telemetry channel.'
                : 'Pair a room first — there is nothing to ask.'
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
            Asked. The display samples its frame rate for three seconds before it answers, so this
            normally takes five or six — and gives up after{' '}
            {Math.round(DIAG_REQUEST_TIMEOUT_MS / 1000)}.
          </p>
        )}
        {diagState === 'timeout' && (
          <Notice tone="error">
            The display did not answer — is it online and paired? Check the Status card above: the
            display is only reachable while CAM has the Web Integration open on the same room code.
            {diagStale && ' The report below is the earlier one, not an answer to this request.'}
          </Notice>
        )}

        {diag !== null && (
          <>
            <table className="kh-table">
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
            <details>
              <summary>Raw JSON</summary>
              <Code>{toJson(diag.report)}</Code>
            </details>
            <Row>
              <Button
                primary
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

      <Panel
        title="Room settings"
        hint="Transport preference, endpoints, and what actually leaves this machine."
      >
        <Field
          label="Transport"
          htmlFor="remote-transport"
          description="Auto tries MQTT first and falls back to ntfy on a connect error or a five-second timeout."
        >
          <Select
            id="remote-transport"
            value={state.sync.transport === 'fake' ? 'auto' : state.sync.transport}
            options={[
              { value: 'auto', label: 'Auto — MQTT, falling back to ntfy' },
              { value: 'mqtt', label: 'MQTT only' },
              { value: 'ntfy', label: 'ntfy only' },
              { value: 'off', label: 'Off — local (CAM) sync only' },
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
          <Toggle id="remote-endpoints" checked={showEndpoints} onChange={setShowEndpoints} />
          <label htmlFor="remote-endpoints">Use my own broker</label>
        </Row>
        {showEndpoints && (
          <>
            <Field
              label="MQTT URL"
              htmlFor="remote-mqtt"
              description="wss:// or ws://. Empty means this build's default."
            >
              <TextInput
                id="remote-mqtt"
                value={state.sync.mqttUrl}
                placeholder={DEFAULT_MQTT_URL}
                onChange={(mqttUrl) => {
                  commit((s) => ({ ...s, sync: { ...s.sync, mqttUrl } }));
                }}
              />
            </Field>
            <Field
              label="ntfy base URL"
              htmlFor="remote-ntfy"
              description="https:// only. Empty means this build's default."
            >
              <TextInput
                id="remote-ntfy"
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
            id="remote-persist"
            checked={state.sync.persistRemote}
            onChange={(persistRemote) => {
              commit((s) => ({ ...s, sync: { ...s.sync, persistRemote } }));
            }}
          />
          <label htmlFor="remote-persist">Display remembers remote changes across reboots</label>
        </Row>
        <Row>
          <Toggle
            id="remote-tele"
            checked={state.sync.publishTelemetry}
            onChange={(publishTelemetry) => {
              commit((s) => ({ ...s, sync: { ...s.sync, publishTelemetry } }));
            }}
          />
          <label htmlFor="remote-tele">Display publishes telemetry to this page</label>
        </Row>

        <h3>What leaves your machine</h3>
        <p className="kh-hint">
          Only the room code stays private, and only because you never send it: the broker sees a
          topic derived from <Code>SHA-256(code)</Code>, and every payload is AES-GCM encrypted
          under a key derived from the same code, with a separate key per channel. What the broker
          can observe is that <em>some</em> topic exists, how big the messages are and how often
          they arrive. What it cannot read is the video URL, the seek position, the clip names or
          any error text.
        </p>
        <p className="kh-hint">
          Telemetry contains playback position, achieved frame rate, panel geometry, error codes,
          the names and durations of stored clips, and a <em>hash</em> of the source URL — never the
          URL itself. Full detail, including the honest limits of a 40-bit room code, is in
          docs/remote-control.md.
        </p>
      </Panel>
    </>
  );
}
