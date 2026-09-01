import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { issueUrl } from '../../../buildInfo';
import { camInstallUrl, ytPosterUrls } from '../../../config/knownHosts';
import { toJson } from '../../../diag/report';
import { diagPhase, diagReportFreshness, DIAG_REQUEST_TIMEOUT_MS } from '../../../diag/wire';
import { clamp } from '../../../lib/clamp';
import { listModules } from '../../../modules/registry';
import {
  YT_BIAS_HELPER,
  describeQuality,
  qualityControlFor,
  qualityFromOption,
  qualityOptionValue,
  qualityOptions,
  type QualityConfig,
} from '../../../modules/video/quality';
import { detect } from '../../../modules/video/routing/detect';
import { LOCAL_CLIP_SCHEME } from '../../../modules/video/routing/patterns';
import { validateUrl, primaryIssue } from '../../../modules/video/routing/validate';
import {
  validateVideoConfig,
  type ProviderId,
  type VideoModuleConfig,
} from '../../../modules/video/types';
import { withModuleConfig } from '../../../state/selectors';
import { DEFAULT_MQTT_URL, DEFAULT_NTFY_BASE } from '../../../sync/endpoints';
import { anchorPosition, type WirePosition } from '../../../sync/position';
import { formatRoomCode, generateRoomCode, normalizeRoomCode } from '../../../sync/roomCode';
import {
  Button,
  Chip,
  Code,
  Disclosure,
  Field,
  Notice,
  Panel,
  RangeInput,
  Row,
  Select,
  TextInput,
  Toggle,
} from '../../../ui';
import { formatSeconds, sourceName } from '../homeState';
import { qrMatrix, qrSvgPath, remoteLinkUrl } from '../qr';
import { forgetRoom, readRememberedRoom, rememberRoom } from '../rememberedRoom';
import { currentHash, hashQuery, subscribeRoute } from '../router';
import { useSync } from '../useSync';

import { RemoteRing } from './RemoteRing';

import type { AppState } from '../../../state/schema';
import type { ConfigRuntime } from '../runtime';
import type { SyncHandle } from '../useSync';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

/**
 * The phone remote (docs/design/halo-prototype.html, screen 3).
 *
 * "The remote is a media remote — not a settings mirror." The old page was a
 * stack of nine panels that reproduced every configuration control on a 390 px
 * screen; this one is a mini-halo, a scrubber with two real loop handles, three
 * transport buttons sized for a thumb, and one pairing card. Everything else —
 * the source field, the module picker, framing, the transport internals, the
 * hardware-report pull — is still here, one level down, exactly where the
 * curious look.
 *
 * Two things are worth knowing before editing:
 *
 *  - **The mini-halo is a state REPLICA, never an iframe.** The home screen can
 *    run the real display page in its halo because it shares CAM's origin and
 *    storage; a phone is a different browser on a different machine, so an
 *    iframe here would boot a SECOND display — a second decoder and a second
 *    download, on a battery. Instead `RemoteRing` mounts the display's own
 *    module renderer and feeds it synced state, so the clock ring IS the clock
 *    module and the stats ring IS the stats module. Pixels are the one thing
 *    that never crosses the wire; see `../replica.ts`.
 *  - **The A-B handles write config, not commands.** A loop is a setting, so it
 *    travels as `state` through the ordinary store → `SyncService` path and its
 *    5 Hz coalescing. A seek is imperative and travels as `cmd`, with the same
 *    seek mirrored into the retained snapshot so a cold display resumes near it.
 */

const VIDEO_ID = 'video';
const SEEK_STEP_SEC = 10;
const LOOP_MAX_SEC = 3600;
const REANCHOR_MS = 250;
/** The A-B handles are hard-throttled here as well as in SyncService. */
const LOOP_WRITE_THROTTLE_MS = 200;
/** Matches `SyncService`'s `PUBLISH_THROTTLE_MS`, so `cmd` and `state` agree. */
const SEEK_WRITE_THROTTLE_MS = 200;
/** The seek bar's granularity. Half of it is the echo guard's tolerance. */
const SEEK_SLIDER_STEP_SEC = 0.5;
/** One arrow-key press on a loop handle. Page Up/Down moves ten of them. */
const LOOP_KEY_STEP_SEC = 0.5;
const LOOP_PAGE_STEPS = 10;
/**
 * Older than this and "linked" would be a lie, so the transport greys out.
 * Telemetry is 0.5 Hz (0.2 Hz in performance mode), so this is six missed
 * packets at the slow rate — long enough never to flicker on a busy display.
 */
const DISPLAY_ONLINE_MS = 12_000;
const PCT = 100;

/**
 * "1080p local" — the sub-line's badge, and only the badge.
 *
 * Deliberately terser than `describeQuality` in `modules/video/quality.ts`,
 * which is the full sentence the Quality control shows. This one sits inside a
 * line that already says "Playing on your Kraken ·", so a second "Auto —" in it
 * would be noise.
 *
 * Both halves are claims about the DISPLAY, not about this phone: the height is
 * whatever quality the display negotiated and reported, and "local" means it is
 * playing a stored clip rather than a stream. Nothing here is inferred from the
 * URL except the local-clip scheme, which is unambiguous.
 */
function describeBadge(
  quality: { height?: number | null; label?: string | null } | undefined,
  url: string,
): string {
  const parts: string[] = [];
  if (typeof quality?.height === 'number' && quality.height > 0) {
    parts.push(`${String(quality.height)}p`);
  } else if (typeof quality?.label === 'string' && quality.label.length > 0) {
    parts.push(quality.label);
  }
  if (url.startsWith(LOCAL_CLIP_SCHEME)) parts.push('local');
  return parts.length === 0 ? 'quality not reported yet' : parts.join(' ');
}

/** Telemetry values arrive as `unknown`; render them without stringifying an object. */
function asText(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

/** The remote's whole surface: watch, drive, pair — in that order. */
export function RemoteView({ runtime }: { runtime: ConfigRuntime }) {
  const state = runtime.store.getSnapshot();
  const sync = useSync(runtime);
  // The pairing link's room lives in the fragment, so the auto-join effect below
  // has to re-run when the fragment changes — a scanned link opened in an
  // already-running tab is a `hashchange`, not a load.
  const hash = useSyncExternalStore(subscribeRoute, currentHash, () => '#/');

  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  /** When the last `requestDiag` went out. `null` before anyone has asked. */
  const [diagRequestedAt, setDiagRequestedAt] = useState<number | null>(null);
  const [diagCopied, setDiagCopied] = useState(false);
  const lastLoopWrite = useRef(0);
  const pendingLoop = useRef<VideoModuleConfig['loop'] | null>(null);
  const loopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSeekWrite = useRef(0);
  const pendingSeek = useRef<number | null>(null);
  const seekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (seekTimer.current !== null) clearTimeout(seekTimer.current);
      if (loopTimer.current !== null) clearTimeout(loopTimer.current);
    },
    [],
  );

  /**
   * The clock, sampled OUTSIDE render.
   *
   * The scrubber is driven by telemetry, which arrives at 2 Hz at best, so the
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

  const paired = state.sync.roomCode !== null && state.sync.enabled;
  const roomCode = state.sync.roomCode;

  const remoteUrl = useMemo(
    () => (roomCode === null ? null : remoteLinkUrl(runtime.appUrl, roomCode)),
    [runtime.appUrl, roomCode],
  );

  const join = useCallback(
    (raw: string): void => {
      const normalized = normalizeRoomCode(raw);
      if (normalized === null) return;
      // Remember first: if the state write is what fails (quota, a private
      // window), the next visit should still know which Kraken this is.
      rememberRoom(normalized);
      commit((s) => ({ ...s, sync: { ...s.sync, roomCode: normalized, enabled: true } }));
    },
    // `commit` closes over `runtime.store`, which is created once by the mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runtime],
  );

  /**
   * Zero taps from a scanned code, and zero taps ever again after that.
   *
   * Three sources, in order of how deliberate they are:
   *
   *  1. **The link's own fragment** — `#/remote?room=ABCD1234`, which is what
   *     the QR encodes. Somebody just pointed a camera at a screen; asking them
   *     to also press Join is asking them to confirm the thing they did.
   *  2. **The state document**, if this device is already paired. Nothing to do.
   *  3. **The remembered room** — a home-screen bookmark or a plain reload
   *     arriving at `#/remote` with no code in the link at all.
   *
   * The latch matters: without it, "Forget this Kraken" would be undone on the
   * component's next render by the same hash it was pressed under. Forgetting
   * therefore also clears the room out of the hash (a hash rewrite, not a
   * navigation — invariant I1/I2), and the latch keeps the effect from
   * re-joining in the frame between the two.
   */
  const joinedFrom = useRef<string | null>(null);
  useEffect(() => {
    const fromLink = new URLSearchParams(hashQuery(hash)).get('room');
    const wanted = normalizeRoomCode(fromLink ?? '') ?? readRememberedRoom();
    if (wanted === null) return;
    if (joinedFrom.current === wanted) return;
    joinedFrom.current = wanted;
    if (roomCode === wanted && state.sync.enabled) {
      // Already on it — but a code that arrived by link on a fresh device has
      // not been written down yet.
      rememberRoom(wanted);
      return;
    }
    join(wanted);
  }, [hash, roomCode, state.sync.enabled, join]);

  const rotate = (): void => {
    const fresh = generateRoomCode();
    joinedFrom.current = fresh;
    rememberRoom(fresh);
    commit((s) => ({ ...s, sync: { ...s.sync, roomCode: fresh, enabled: true } }));
  };

  /**
   * "Forget this Kraken" — genuinely unpaired, not re-paired on the next load.
   *
   * Three things have to go, and missing any one of them leaves the remote
   * reconnecting to a room the user just said they were done with: the
   * remembered key, the room in the state document, and the room still sitting
   * in this page's own address bar from the link that opened it.
   */
  const forget = (): void => {
    forgetRoom();
    joinedFrom.current = null;
    commit((s) => ({ ...s, sync: { ...s.sync, roomCode: null, enabled: false } }));
    if (hashQuery(window.location.hash).length > 0) window.location.hash = '#/remote';
  };

  // -------------------------------------------------------------------------
  // Telemetry readout
  // -------------------------------------------------------------------------

  const tele = sync.lastTele?.body ?? null;
  const playback = state.playback;

  /**
   * The scrubber's position — re-anchored, not frozen.
   *
   * Every stats packet is a `posSec + posAtTs` pair in disguise —
   * `stats.currentTime` sampled on the display at the packet's own `ts` — so it
   * feeds `anchorPosition()` exactly like any other wire position, and the
   * 250 ms clock above moves the bar smoothly between packets.
   *
   * `state.playback` is the fallback rather than the primary source: it changes
   * only when somebody seeks, whereas telemetry is the display's continuous
   * ground truth. An anchored sample that has gone `stale` is discarded in
   * favour of the raw one — that is the case where the two machines' clocks
   * disagree badly enough that extrapolating would invent a position that never
   * existed.
   */
  const statsBody = sync.lastStats?.body ?? null;
  const stats = statsBody?.['stats'] as
    { currentTime?: number; held?: boolean; durationSec?: number | null } | undefined;
  const statsTs =
    typeof statsBody?.['ts'] === 'number' ? statsBody['ts'] : (sync.lastStats?.at ?? null);

  /*
   * The duration, from the display rather than from `playback`.
   *
   * The display never publishes `state`, so `playback.durationSec` exists only
   * once somebody has explicitly seeked — which means a freshly opened remote
   * had no timeline at all and the scrubber fell back to a one-hour track. The
   * continuous stats packet carries it now; `playback` stays the fallback for
   * the moments before the first packet lands.
   */
  const durationSec =
    typeof stats?.durationSec === 'number' && stats.durationSec > 0
      ? stats.durationSec
      : (playback?.durationSec ?? null);

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
  const scrubMax = durationSec ?? LOOP_MAX_SEC;
  /** What the seek bar is showing right now — also the echo guard's reference. */
  const seekBarValue = Math.min(positionSec, scrubMax);
  const held = stats?.held ?? playback?.paused ?? false;

  /**
   * Is there a Kraken on the other end at all?
   *
   * Transport controls that do nothing are worse than absent ones: a user
   * pressing Play three times on a dead link concludes the app is broken, not
   * that CAM is closed. Freshness rather than the socket's own `online`, because
   * a connected broker with nobody listening is exactly as useless.
   */
  const displayOnline =
    sync.lastTele !== null && (now === 0 || now - sync.lastTele.at < DISPLAY_ONLINE_MS);

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

  const clipNames = useMemo(() => new Map(clips.map((c) => [c.id, c.name])), [clips]);
  const title = sourceName(videoCfg.url, clipNames);

  const quality = tele?.['quality'] as
    { height?: number | null; label?: string | null } | undefined;
  // Not memoized: two property reads and a string join, off values this
  // component already re-renders on. A manual memo here is exactly the kind the
  // React compiler cannot preserve.
  const badge = describeBadge(quality, videoCfg.url);

  // -------------------------------------------------------------------------
  // Writers
  // -------------------------------------------------------------------------

  /**
   * An explicit seek is the ONE position that travels as *state*.
   *
   * The `cmd` channel does the seek — imperative, one-shot, never replayed,
   * exactly right for "go there now". But a command is also never retained, so a
   * display that boots ten seconds later would know nothing about it. Writing
   * `playback` here puts the same seek in the retained snapshot as
   * `posSec + posAtTs`, which is what lets a cold display resume near where the
   * user left it. The display applies it once, keyed on `posAtTs`.
   */
  const writeSeek = (posSec: number, at: number): void => {
    commit((s) => ({
      ...s,
      playback: {
        ownerModuleId: s.activeModuleId,
        paused: held,
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
   * Throttled with a TRAILING edge.
   *
   * Dragging fires on every pixel and each one would otherwise be a localStorage
   * write and a retained snapshot. Leading-edge alone is wrong here: it drops
   * the LAST event of a drag, which is the only one that matters — the position
   * the user let go at — and the retained snapshot would then permanently
   * disagree with the `seekTo` command that did land.
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

  /**
   * The A-B handles' writer: 5 Hz, leading edge plus a trailing flush.
   *
   * Same reasoning as the seek above, for the same reason — the value a user
   * released the handle on is the one that must survive — but this one writes
   * module config rather than `playback`, so it reaches the display through the
   * ordinary state channel and is retained for a cold boot for free.
   */
  const publishLoop = useCallback(
    (next: VideoModuleConfig['loop']): void => {
      const at = Date.now();
      const elapsed = at - lastLoopWrite.current;
      if (elapsed >= LOOP_WRITE_THROTTLE_MS) {
        lastLoopWrite.current = at;
        commit((s) => withModuleConfig(s, VIDEO_ID, 1, { ...videoCfg, loop: next }));
        return;
      }
      pendingLoop.current = next;
      if (loopTimer.current !== null) return;
      loopTimer.current = setTimeout(() => {
        loopTimer.current = null;
        const value = pendingLoop.current;
        pendingLoop.current = null;
        if (value === null) return;
        lastLoopWrite.current = Date.now();
        commit((s) => withModuleConfig(s, VIDEO_ID, 1, { ...videoCfg, loop: value }));
      }, LOOP_WRITE_THROTTLE_MS - elapsed);
    },
    // `commit` and `videoCfg` are both derived from the store snapshot this
    // component already re-renders on; the ref-held timers are what carry state
    // across renders, so the identity of this callback only has to be stable
    // within one snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [videoCfg],
  );

  const seek = (delta: number): void => {
    sync.sendCmd('seekBy', delta);
    publishSeek(positionSec + delta);
  };

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

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
  const errorPacket = sync.lastError?.body ?? null;
  const achievedFps = typeof tele?.['achievedFps'] === 'number' ? tele['achievedFps'] : null;

  /*
   * What the ring shows for a picture module.
   *
   * Two sources, in order of how directly the phone can reach them:
   *
   *  1. A **public poster**, for YouTube. `i.ytimg.com` is on the open web and
   *     this phone has internet, so it fetches the still itself — asking the
   *     display to grab a frame, re-encode it and chunk it over a radio for an
   *     image that already has a URL would be silly.
   *  2. The **shipped thumbnail** — a ≤6 KB WebP the display sent once over the
   *     chunked telemetry channel, for exactly the cases the phone cannot
   *     reach: a stored clip and a library image, both of which live in CAM's
   *     browser profile.
   */
  const ytMatch = useMemo(() => detect(videoCfg.url), [videoCfg.url]);
  const ytPoster =
    ytMatch.provider === 'youtube-embed' && ytMatch.id !== null && ytMatch.id !== ''
      ? (ytPosterUrls(ytMatch.id)[0] ?? null)
      : null;
  const posterUrl = ytPoster ?? sync.ringThumb?.dataUrl ?? null;

  /**
   * The ring's position arc: the same re-anchored position the scrubber uses.
   *
   * Driven by `now`, so it advances smoothly between the 0.5 Hz telemetry
   * packets rather than stepping twice a second. `null` for a source with no
   * known duration — a live stream has no "how far through" to draw.
   */
  const ringProgress =
    durationSec === null || durationSec <= 0
      ? null
      : Math.max(0, Math.min(1, positionSec / durationSec));

  // -------------------------------------------------------------------------

  return (
    <div className="kh-remote" data-testid="remote">
      <RemoteRing
        moduleId={state.activeModuleId}
        config={state.modules[state.activeModuleId]?.cfg ?? null}
        render={state.render}
        display={sync.monitor?.display ?? null}
        monitor={sync.monitor?.snapshot ?? null}
        monitorAt={sync.monitor?.at ?? 0}
        posterUrl={posterUrl}
        sourceUrl={videoCfg.url}
        progress={ringProgress}
        held={held}
      />

      <h2 className="kh-remote__title" data-testid="remote-title">
        {title}
      </h2>
      <p className="kh-remote__sub" data-testid="remote-sub">
        {displayOnline
          ? held
            ? 'Holding on your Kraken · '
            : 'Playing on your Kraken · '
          : 'Waiting for your Kraken · '}
        <span className="kh-tnum">{badge}</span>
      </p>

      <LoopScrubber
        max={scrubMax}
        positionSec={seekBarValue}
        loop={videoCfg.loop}
        onLoopChange={publishLoop}
        onSeek={(next) => {
          /*
           * The echo guard.
           *
           * React delivers BOTH `input` and `change` for a controlled range, and
           * by the time the second one runs the component has already re-rendered
           * with the telemetry-anchored position — so the echo arrives carrying
           * the value the bar snapped back to, not the one the user chose. Acting
           * on it seeks the display back to where it already was.
           *
           * The tolerance is half a step, not exact equality, because the two
           * numbers are not the same number: the bar renders a continuous
           * `3.503996` and the input reports the grid value `3.5`. Half a step is
           * also exactly the widest a real gesture can never be.
           */
          if (Math.abs(next - seekBarValue) < SEEK_SLIDER_STEP_SEC / 2) return;
          sync.sendCmd('seekTo', next);
          publishSeek(next);
        }}
      />

      <div className="kh-transport" role="group" aria-label="Playback">
        <button
          type="button"
          className="kh-tbtn"
          data-testid="transport-back"
          aria-label="Back 10 seconds"
          disabled={!displayOnline}
          onClick={() => {
            seek(-SEEK_STEP_SEC);
          }}
        >
          −10
        </button>
        <button
          type="button"
          className="kh-tbtn kh-tbtn--big"
          data-testid="transport-hold"
          /*
           * "Hold", never "Pause". YouTube's real pause raises a
           * suggested-video grid inside the picture, where cropping cannot
           * reach it, so the display micro-loops instead (§2.6).
           */
          aria-label={held ? 'Play' : 'Hold'}
          disabled={!displayOnline}
          onClick={() => {
            sync.sendCmd(held ? 'play' : 'pause');
          }}
        >
          <span aria-hidden="true">{held ? '▶' : '❙❙'}</span>
        </button>
        <button
          type="button"
          className="kh-tbtn"
          data-testid="transport-forward"
          aria-label="Forward 10 seconds"
          disabled={!displayOnline}
          onClick={() => {
            seek(SEEK_STEP_SEC);
          }}
        >
          +10
        </button>
      </div>

      <LinkStatus sync={sync} now={now} online={displayOnline} paired={paired} />

      <PairingCard
        paired={paired}
        roomCode={roomCode}
        remoteUrl={remoteUrl}
        // The gap between "this device knows the room" and "the transport is
        // actually up" is a second or two on a phone radio, and a card that
        // claims "Paired" through it is claiming something it cannot see yet.
        connecting={paired && sync.status?.network !== 'online'}
        onJoin={join}
        onRotate={rotate}
        onForget={forget}
      />

      <Disclosure summary="Diagnostics" testId="diag-disclosure">
        <Panel
          title="Hardware report"
          hint="Pull a report off the machine running CAM — from this browser, on any machine."
        >
          <p className="kh-hint">
            Your Kraken checks itself for about five seconds and sends the answer back over this
            room, encrypted like everything else. It does <strong>not</strong> need to have been
            opened with <Code inline>?diag=1</Code>, and that is the point: nobody can edit a URL on
            a hidden window from another computer.
          </p>
          <Row>
            <Button
              primary
              disabled={!paired || diagState === 'waiting'}
              testId="request-report"
              title={
                paired
                  ? 'Asks the display for a report; it answers on the telemetry channel.'
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
              Asked. The display measures its frame rate for three seconds before it answers, so
              this normally takes five or six — and gives up after{' '}
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

        {/*
          The transport internals, which used to be a row of chips above the
          controls. They belong here: nobody drives a cooler by watching a
          transport name, and the one thing that DID matter — is anything on the
          other end — is the quiet line above.
        */}
        <Panel title="Connection detail" hint="What the link is doing, in its own words.">
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
        </Panel>
      </Disclosure>

      <Disclosure summary="More controls" testId="more-controls">
        <Panel
          title="Play something else"
          hint="The display checks the link again before it plays."
        >
          <Field label="Video link" htmlFor="remote-src">
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
          title="Quality"
          hint="What your Kraken is getting, and — where the source allows it — what to ask for."
        >
          <RemoteQuality
            cfg={videoCfg}
            tele={tele}
            fallbackProvider={ytMatch.provider}
            onChange={(quality) => {
              setVideo({ quality });
            }}
          />
        </Panel>

        <Panel title="What's on the screen" hint="Your Kraken shows exactly one thing at a time.">
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

        <Panel title="Framing" hint="How the picture sits in the panel, whatever is showing.">
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

        <Panel
          title="Clips on your PC"
          hint="The library lives on the machine running CAM. This page can pick from it, but cannot add to it."
        >
          <p className="kh-hint">
            CAM opens two browser windows that share one storage area — and your phone is a third,
            separate one. So a file picker here would put the file in the wrong place. Add clips in
            the CAM window; this list is what the display has told us it has.
          </p>
          <Row>
            <a className="kh-btn" href={camInstallUrl(runtime.appUrl)}>
              Open kraken-hub in CAM
            </a>
          </Row>
          {clips.length === 0 ? (
            <Notice tone="warn">No list yet — your Kraken sends one once it has connected.</Notice>
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
                  if (id.length > 0) setVideo({ url: `${LOCAL_CLIP_SCHEME}${id}` });
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

        <RoomSettings runtime={runtime} />
      </Disclosure>
    </div>
  );
}

/**
 * The same quality control as the CAM panel, in a thumb-sized form.
 *
 * Identical rules and identical words — `src/modules/video/quality.ts` owns
 * both, so the two surfaces can never disagree about who controls the picture.
 * The difference is only where the truth comes from: the panel reads the
 * telemetry mirror over CAM's shared origin, and this reads the same packet off
 * the encrypted `tele` channel.
 *
 * A pin travels as ordinary module *config* — it is a setting, not a command —
 * so it reaches the display through the retained state snapshot and survives a
 * cold boot, exactly like the A-B loop.
 */
function RemoteQuality({
  cfg,
  tele,
  fallbackProvider,
  onChange,
}: {
  cfg: VideoModuleConfig;
  tele: Record<string, unknown> | null;
  fallbackProvider: ProviderId | null;
  onChange: (next: QualityConfig) => void;
}) {
  const reportedProvider = typeof tele?.['provider'] === 'string' ? tele['provider'] : null;
  // The mounted adapter beats the URL's guess: a link that looks like a bare
  // `.m3u8` may have ended up on the resolver, and the adapter that is actually
  // running is the one whose control is real.
  const control = qualityControlFor((reportedProvider as ProviderId | null) ?? fallbackProvider);
  const rawLevels = tele?.['levels'];
  const levels = Array.isArray(rawLevels)
    ? (rawLevels as { h: number; l: string }[]).map((l) => ({ height: l.h, label: l.l }))
    : [];
  const rawQuality = tele?.['quality'];
  const reported =
    typeof rawQuality === 'object' && rawQuality !== null
      ? (rawQuality as { height?: number | null; label?: string | null })
      : null;
  const reading = describeQuality(cfg.quality, {
    reported,
    local: cfg.url.startsWith(LOCAL_CLIP_SCHEME),
  });

  if (control === 'readonly' || control === 'none') {
    return (
      <p className="kh-hint" data-testid="remote-quality-readout">
        {reading}
        {control === 'readonly'
          ? ' — a stored file has one resolution, so there is nothing to choose.'
          : ' — nothing is playing yet.'}
      </p>
    );
  }

  return (
    <>
      <Field
        label={control === 'bias' ? 'Bias' : 'Quality'}
        htmlFor="remote-quality"
        description={reading}
      >
        <Select
          id="remote-quality"
          value={qualityOptionValue(cfg.quality)}
          options={qualityOptions(control, levels)}
          onChange={(value) => {
            onChange(qualityFromOption(value, cfg.quality));
          }}
        />
      </Field>
      {control === 'bias' && <p className="kh-hint">{YT_BIAS_HELPER}</p>}
    </>
  );
}

// ---------------------------------------------------------------------------
// The scrubber
// ---------------------------------------------------------------------------

/**
 * One track, three truths: where playback is, and where the loop starts and
 * ends.
 *
 * The prototype's note — "the loop is two draggable handles on the scrubber,
 * not number fields" — is the whole design here, and it is why the handles are
 * `role="slider"` buttons rather than styled `<input type="range">`s: two
 * ranges cannot share one track without one of them eating the other's pointer
 * events, and neither can express "A may not pass B".
 *
 * The seek control underneath IS a real `<input type="range">`, laid over the
 * track and under the handles. Tapping anywhere on the bar seeks; grabbing a
 * handle moves the loop. Keeping the native input is deliberate: it brings
 * touch behaviour, keyboard support and the platform's own accessibility for
 * the one control most people use, for free.
 */
function LoopScrubber({
  max,
  positionSec,
  loop,
  onLoopChange,
  onSeek,
}: {
  max: number;
  positionSec: number;
  loop: VideoModuleConfig['loop'];
  onLoopChange: (next: VideoModuleConfig['loop']) => void;
  onSeek: (next: number) => void;
}) {
  const start = clamp(loop.start, 0, max);
  const end = clamp(loop.end ?? max, 0, max);

  /**
   * Moving a handle turns the loop on.
   *
   * A user dragging A and B and seeing nothing happen because a separate toggle
   * is off is the kind of correct-but-useless behaviour disclosure is supposed
   * to prevent. The toggle below still exists to turn it back off.
   */
  const move = (which: 'a' | 'b', seconds: number): void => {
    if (which === 'a') {
      onLoopChange({ ...loop, enabled: true, start: clamp(seconds, 0, end) });
    } else {
      onLoopChange({ ...loop, enabled: true, end: clamp(seconds, start, max) });
    }
  };

  /**
   * The drag.
   *
   * The track's geometry comes from the handle's own `parentElement` rather
   * than from a `useRef`: the handle IS a child of the track, so the DOM
   * already knows the answer, and reading it inside the event avoids holding a
   * ref that the React compiler would (rightly) refuse to see read during
   * render.
   *
   * `setPointerCapture` on the handle is what makes the whole gesture work on a
   * phone: every subsequent `pointermove` is retargeted to the handle even when
   * the thumb has travelled well outside its 18 px, so a drag never "falls off"
   * the control and never needs document-level listeners.
   */
  const drag = (which: 'a' | 'b', e: ReactPointerEvent<HTMLButtonElement>): void => {
    e.preventDefault();
    const handle = e.currentTarget;
    const track = handle.parentElement;
    if (track === null) return;
    handle.setPointerCapture(e.pointerId);

    const at = (clientX: number): number => {
      const rect = track.getBoundingClientRect();
      if (rect.width <= 0) return 0;
      return clamp((clientX - rect.left) / rect.width, 0, 1) * max;
    };

    move(which, at(e.clientX));
    const onMove = (ev: PointerEvent): void => {
      move(which, at(ev.clientX));
    };
    const onUp = (): void => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };

  /** Arrow keys nudge, Page Up/Down jump, Home/End go to the ends. */
  const key = (which: 'a' | 'b', e: ReactKeyboardEvent<HTMLButtonElement>): void => {
    const from = which === 'a' ? start : end;
    const page = LOOP_KEY_STEP_SEC * LOOP_PAGE_STEPS;
    let next: number | null = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = from - LOOP_KEY_STEP_SEC;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = from + LOOP_KEY_STEP_SEC;
    else if (e.key === 'PageDown') next = from - page;
    else if (e.key === 'PageUp') next = from + page;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = max;
    if (next === null) return;
    e.preventDefault();
    move(which, next);
  };

  const pct = (seconds: number): string => `${String((seconds / Math.max(max, 1)) * PCT)}%`;

  return (
    <div className="kh-scrub" data-testid="scrubber">
      <div className="kh-scrub__track">
        <div className="kh-scrub__rail" />
        <div
          className="kh-scrub__loop"
          data-testid="scrub-loop"
          data-enabled={loop.enabled}
          style={{ left: pct(start), width: pct(Math.max(0, end - start)) }}
        />
        <div className="kh-scrub__fill" style={{ width: pct(positionSec) }} />
        {/*
          The seek control. Visually it is only its thumb — the rail, the loop
          band and the progress fill above are ours — but it is a real range
          input, so a tap anywhere on the bar seeks and every platform's touch
          and keyboard behaviour comes along with it.
        */}
        <input
          id="remote-seek"
          className="kh-scrub__seek"
          type="range"
          aria-label="Position"
          value={String(positionSec)}
          min={0}
          max={max}
          step={SEEK_SLIDER_STEP_SEC}
          onChange={(e) => {
            onSeek(Number(e.target.value));
          }}
        />
        <button
          type="button"
          className="kh-scrub__handle kh-scrub__handle--a"
          data-testid="loop-handle-a"
          role="slider"
          aria-label="Loop start"
          aria-valuemin={0}
          aria-valuemax={end}
          aria-valuenow={start}
          aria-valuetext={formatSeconds(start)}
          style={{ left: pct(start) }}
          onPointerDown={(e) => {
            drag('a', e);
          }}
          onKeyDown={(e) => {
            key('a', e);
          }}
        >
          <span className="kh-scrub__lab" aria-hidden="true">
            A
          </span>
        </button>
        <button
          type="button"
          className="kh-scrub__handle kh-scrub__handle--b"
          data-testid="loop-handle-b"
          role="slider"
          aria-label="Loop end"
          aria-valuemin={start}
          aria-valuemax={max}
          aria-valuenow={end}
          aria-valuetext={formatSeconds(end)}
          style={{ left: pct(end) }}
          onPointerDown={(e) => {
            drag('b', e);
          }}
          onKeyDown={(e) => {
            key('b', e);
          }}
        >
          <span className="kh-scrub__lab" aria-hidden="true">
            B
          </span>
        </button>
      </div>

      <div className="kh-scrub__times kh-tnum">
        <span data-testid="scrub-position">{formatSeconds(positionSec)}</span>
        <button
          type="button"
          className="kh-scrub__looptoggle"
          data-testid="loop-toggle"
          aria-pressed={loop.enabled}
          onClick={() => {
            onLoopChange({ ...loop, enabled: !loop.enabled });
          }}
        >
          Loop {formatSeconds(start)} – {loop.end === null ? 'end' : formatSeconds(end)}
        </button>
        <span data-testid="scrub-duration">{formatSeconds(max)}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status and pairing
// ---------------------------------------------------------------------------

/**
 * One quiet line where five chips used to be.
 *
 * The chips said `mqtt — online`, `local bus — idle`, `display seen 2s ago`.
 * Every one of them is a fact about the plumbing, and exactly one question is
 * actually being asked here — is my Kraken on the other end? — so that is what
 * the line answers, in words. The plumbing moved into the Diagnostics
 * disclosure, where it is still one tap away.
 *
 * The `data-*` attributes are the machine-readable copy of the same answer, so
 * the e2e suite can assert on state rather than on user-facing prose.
 */
function LinkStatus({
  sync,
  now,
  online,
  paired,
}: {
  sync: SyncHandle;
  now: number;
  online: boolean;
  paired: boolean;
}) {
  const network = sync.status?.network ?? 'idle';
  const failedOver = sync.status?.failedOver === true;
  const seenSec =
    sync.lastTele === null ? null : Math.max(0, Math.round((now - sync.lastTele.at) / 1000));

  let text: string;
  if (!paired) text = 'Not paired yet — scan the code below.';
  else if (online) text = `Linked to your Kraken · seen ${String(seenSec ?? 0)}s ago`;
  else if (network === 'online') text = 'Linked, but your Kraken has not said anything yet.';
  else text = 'Looking for your Kraken…';

  return (
    <p
      className="kh-linkstatus"
      data-testid="link-status"
      data-network={network}
      data-transport={sync.status?.networkTransport ?? 'none'}
      data-failover={failedOver}
      data-display={online ? 'online' : 'offline'}
    >
      <span className={online ? 'kh-status__live' : 'kh-status__dead'} aria-hidden="true" />
      {text}
      {failedOver && ' · on the backup link, so it is a little slower'}
    </p>
  );
}

/**
 * Pairing, as one card (prototype screen 3).
 *
 * "Scan the QR shown in CAM once; the room code becomes a quiet credential, not
 * a feature." So the card has exactly two states. Unpaired, it is the biggest
 * thing below the transport: a code to generate, a field to type one into, and
 * the QR once a room exists. Paired, it collapses to a single line — who you are
 * paired with, and the code — with everything that changes a room one tap down.
 *
 * The Join button is a fallback, not the path. A phone that arrives from the QR
 * has already joined before this renders (see the auto-join effect above); the
 * field exists for the case where somebody is reading a code off a monitor
 * because the camera would not focus.
 */
function PairingCard({
  paired,
  roomCode,
  remoteUrl,
  connecting,
  onJoin,
  onRotate,
  onForget,
}: {
  paired: boolean;
  roomCode: string | null;
  remoteUrl: string | null;
  connecting: boolean;
  onJoin: (code: string) => void;
  onRotate: () => void;
  onForget: () => void;
}) {
  const [draft, setDraft] = useState(roomCode ?? '');
  const [copied, setCopied] = useState(false);

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

  const controls = (
    <>
      <Field
        label="Room code"
        htmlFor="remote-room"
        description="Eight characters, with no I, L, O or U — so nothing is ambiguous when you read it off a screen."
      >
        <Row>
          <TextInput
            id="remote-room"
            value={draft}
            placeholder="ABCD1234"
            onChange={(next) => {
              setDraft(next.toUpperCase());
            }}
          />
          <Button
            primary
            testId="pair-join"
            onClick={() => {
              onJoin(draft);
            }}
          >
            Join
          </Button>
          <Button testId="pair-rotate" onClick={onRotate}>
            {paired ? 'Rotate code' : 'Generate code'}
          </Button>
        </Row>
      </Field>
      {remoteUrl !== null && (
        <>
          <Code>{remoteUrl}</Code>
          <Row>
            <Button testId="pair-copy" onClick={copyLink}>
              {copied ? 'Copied' : 'Copy the link'}
            </Button>
          </Row>
        </>
      )}
      {paired && (
        <>
          <Button testId="pair-forget" onClick={onForget}>
            Forget this Kraken
          </Button>
          <p className="kh-hint">
            Clears the pairing from this device only. Your Kraken keeps playing, and the same code
            still works if you scan it again.
          </p>
        </>
      )}
    </>
  );

  if (paired && roomCode !== null) {
    return (
      <section className="kh-roomcard" data-testid="pairing-card" data-paired="true">
        <div className="kh-roomcard__head" data-testid="paired-summary">
          {qr !== null && <QrCode qr={qr} size="small" />}
          <div>
            <b data-testid="paired-title">
              {connecting ? <span className="kh-shimmer">Connecting…</span> : 'Paired with your PC'}
            </b>
            <small className="kh-roomcard__code">ROOM {formatRoomCode(roomCode)}</small>
          </div>
        </div>
        <Disclosure summary="Pairing options" testId="pairing-options">
          {controls}
        </Disclosure>
      </section>
    );
  }

  return (
    <section
      className="kh-roomcard kh-roomcard--open"
      data-testid="pairing-card"
      data-paired="false"
    >
      <h2 className="kh-roomcard__title">Open on your phone</h2>
      <p className="kh-hint">
        Point a camera at this code. The phone opens the remote and{' '}
        <strong>connects automatically</strong> — there is nothing to type, no account, and no
        server of ours in between. It stays paired afterwards, so a bookmark works too.
      </p>
      {qr === null ? (
        <Notice tone="warn">
          No code yet. Press <strong>Generate code</strong> and one appears here.
        </Notice>
      ) : (
        <>
          <QrCode qr={qr} size="large" />
          <p className="kh-roomcard__caption" data-testid="pair-caption">
            Open on your phone — connects automatically.
          </p>
        </>
      )}
      {controls}
    </section>
  );
}

/** The pairing QR, drawn inline — never fetched, because the URL is the secret. */
function QrCode({ qr, size }: { qr: { d: string; side: number }; size: 'small' | 'large' }) {
  const px = size === 'small' ? 56 : 168;
  return (
    <svg
      className="kh-qr"
      viewBox={`0 0 ${String(qr.side)} ${String(qr.side)}`}
      width={px}
      height={px}
      role="img"
      aria-label="Pairing QR code for the remote URL"
      shapeRendering="crispEdges"
    >
      <rect width={qr.side} height={qr.side} fill="#ffffff" />
      <path d={qr.d} fill="#000000" />
    </svg>
  );
}

/** Transport preference, endpoints, and what actually leaves this machine. */
function RoomSettings({ runtime }: { runtime: ConfigRuntime }) {
  const state = runtime.store.getSnapshot();
  const [showEndpoints, setShowEndpoints] = useState(false);
  const commit = (mutate: (s: AppState) => AppState): void => {
    runtime.store.commit(mutate);
  };

  return (
    <Panel
      title="Room settings"
      hint="How this page reaches your PC, and what it tells anyone else."
    >
      <Field
        label="Connection"
        htmlFor="remote-transport"
        description="Automatic tries the fast route first and falls back to a slower one if it cannot connect within five seconds."
      >
        <Select
          id="remote-transport"
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
        <label htmlFor="remote-persist">Your Kraken remembers remote changes across reboots</label>
      </Row>
      <Row>
        <Toggle
          id="remote-tele"
          checked={state.sync.publishTelemetry}
          onChange={(publishTelemetry) => {
            commit((s) => ({ ...s, sync: { ...s.sync, publishTelemetry } }));
          }}
        />
        <label htmlFor="remote-tele">Your Kraken reports back to this page</label>
      </Row>

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
          the names and durations of stored clips, and a <em>hash</em> of the source URL — never the
          URL itself. Full detail, including the honest limits of a 40-bit room code, is in
          docs/remote-control.md.
        </p>
      </Disclosure>
    </Panel>
  );
}
