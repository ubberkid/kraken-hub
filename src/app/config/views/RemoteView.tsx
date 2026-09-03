import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { ytPosterUrls } from '../../../config/knownHosts';
import { UNPAIR_NOTE } from '../../../config/vocabulary';
import { localImageId, validateImageConfig } from '../../../modules/image/schema';
import { listModules } from '../../../modules/registry';
import { detect } from '../../../modules/video/routing/detect';
import { LOCAL_CLIP_SCHEME } from '../../../modules/video/routing/patterns';
import { validateVideoConfig, type VideoModuleConfig } from '../../../modules/video/types';
import { withModuleConfig } from '../../../state/selectors';
import { anchorPosition, type WirePosition } from '../../../sync/position';
import {
  ROOM_CODE_HINT,
  filterRoomCodeInput,
  formatRoomCode,
  generateRoomCode,
  normalizeRoomCode,
} from '../../../sync/roomCode';
import {
  Button,
  Code,
  Disclosure,
  Field,
  GroupField,
  Notice,
  Row,
  Segmented,
  TextInput,
} from '../../../ui';
import { FIT_SEGMENTS } from '../../../ui/fitOptions';
import { withBaseKind } from '../../state/switchBase';
import {
  baseOptions,
  SOLID_BASE_CFG,
  SOLID_BASE_KIND,
  SOLID_OPTION_VALUE,
} from '../editor/basePicker';
import { RECEIPT_LINGER_MS, sourceName } from '../homeState';
import { linkReceipt, panelVerb, playingLine } from '../panelClaims';
import {
  PRESENCE_FRESH_MS,
  panelIsKnown,
  panelPresence,
  type PanelPresence,
} from '../panelPresence';
import { pasteAction, type PasteIssue } from '../pasteLink';
import { qrMatrix, qrSvgPath, remoteLinkUrl } from '../qr';
import { forgetRoom, readRememberedRoom, rememberRoom } from '../rememberedRoom';
import { currentHash, hashQuery, subscribeRoute } from '../router';
import { ownsBytes } from '../surface';
import { PHONE_QUERY, useNarrow, usePhoneOnly } from '../useNarrow';
import { useSync } from '../useSync';

import { CamSetupCard } from './CamSetupCard';
import { LoopScrubber, LOOP_MAX_SEC, SEEK_SLIDER_STEP_SEC } from './LoopScrubber';
import { RemoteEditor } from './remote/RemoteEditor';
import { RemoteAdd } from './RemoteAdd';
import { RemoteLibrary } from './RemoteLibrary';
import { RemoteQuality } from './RemoteQuality';
import { RemoteRing } from './RemoteRing';

import type { StripEscape } from './remote/RemoteEditor';
import type { RemoteRingProps } from './RemoteRing';
import type { AppState } from '../../../state/schema';
import type { ConfigRuntime } from '../runtime';
import type { SyncHandle } from '../useSync';

/**
 * The phone remote (docs/design/halo-prototype.html, screen 3).
 *
 * "The remote is a media remote — not a settings mirror." The first pass at
 * that put the mini-halo, the scrubber and the transport on top and then kept
 * everything else one level down, under a disclosure called **More controls** —
 * and the design audit's F6 is the bill for that compromise: what sat behind
 * that summary was a second complete copy of the app. Fourteen controls, in
 * different words from the ones the home screen uses for the same settings, plus
 * a nested privacy disclosure, plus a hardware-report puller, on a 390 px
 * screen.
 *
 * It is gone. What is left is a remote: the ring, the line that says what is
 * playing, the scrubber, three transport buttons, four compact essentials
 * (what to play, which module, how it is framed, what quality) and one pairing
 * card. Room settings, the transport internals and the hardware-report pull
 * moved to a single **Connection** section on the merged About/Diagnostics page,
 * which this page reaches by one quiet link at the bottom — the only navigation
 * on it.
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
const REANCHOR_MS = 250;
/** The A-B handles are hard-throttled here as well as in SyncService. */
const LOOP_WRITE_THROTTLE_MS = 200;
/** Matches `SyncService`'s `PUBLISH_THROTTLE_MS`, so `cmd` and `state` agree. */
const SEEK_WRITE_THROTTLE_MS = 200;
/**
 * Older than this and "linked" would be a lie, so the transport greys out.
 *
 * It is `panelPresence.PRESENCE_FRESH_MS` now, not a second twelve seconds.
 * This file had its own copy of the freshness rule while `HomeView` had another
 * and the download ladder had none, which is precisely how four surfaces came
 * to disagree about one panel (round 6). One number, one derivation.
 */
const DISPLAY_ONLINE_MS = PRESENCE_FRESH_MS;

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
  // "Auto" is what is true when the display has not named a height — the same
  // resting word `modules/video/quality.ts` settled on (round 4, minors).
  return parts.length === 0 ? 'Auto' : parts.join(' ');
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
  /**
   * The line under the row, from whichever validator ran.
   *
   * On submit, not on every keystroke. The field is contextual now (S1), so
   * "which validator" is a question with two answers, and `pasteLink` is the one
   * place that knows — the row used to run `validateUrl` inline against whatever
   * was in the box, which is the same hard-wiring that lost the picture link.
   */
  const [urlIssue, setUrlIssue] = useState<PasteIssue | null>(null);
  /** The link field, so "Play something" can hand it the caret — as home does. */
  const pasteRef = useRef<HTMLInputElement | null>(null);
  const wantsPaste = useRef(false);
  /** A CSS selector for the control the strip's escape was reaching for. */
  const wantsScroll = useRef<string | null>(null);
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
   * The latch matters: without it, Unpair would be undone on the
   * component's next render by the same hash it was pressed under. Forgetting
   * therefore also clears the room out of the hash (a hash rewrite, not a
   * navigation — invariant I1/I2), and the latch keeps the effect from
   * re-joining in the frame between the two.
   */
  /**
   * A code that arrived in the link and could not be one — round 10's M4.
   *
   * `#/remote?room=UUUUUUUU` produced exactly nothing: `normalizeRoomCode`
   * returned `null`, the effect below returned, and the page rendered the
   * ordinary pairing card as though no code had been offered. The person is
   * looking at a link somebody sent them and a screen that does not mention it.
   *
   * Round 5 built the words for this on the field beside it — `badCode` and the
   * `pair-code-error` Notice — and the URL is the same refusal by a different
   * door, so it goes through the same one rather than growing a second. What is
   * added is the DIAGNOSIS: a code with an `I`, `L`, `O` or `U` in it is the one
   * failure a person can act on without counting characters, and it is the
   * commonest, because those are the four glyphs Crockford removed precisely
   * because people confuse them.
   */
  const linkCodeIssue = useMemo((): string | null => {
    /*
     * Both places a link can carry a code — round 11's F-6.
     *
     * The pairing QR encodes the code in the FRAGMENT (`#/remote?room=…`, and
     * `router.ts` says why), so the fragment is the first place to look. It was
     * also the only place: a link with the code in the ordinary query string —
     * `?phone=1&room=UUUUUUUU`, which is exactly the shape a person gets when
     * they retype a link they half remember, or when a chat app rewrites one —
     * reached this screen and was refused in complete silence, because
     * `hashQuery` returns nothing for it and the effect below simply returned.
     *
     * The fragment WINS when both carry one: it is the form the app itself
     * mints, so a copied-around query string cannot override a freshly scanned
     * square.
     */
    const raw =
      new URLSearchParams(hashQuery(hash)).get('room') ??
      new URLSearchParams(window.location.search).get('room');
    if (raw === null || raw === '') return null;
    if (normalizeRoomCode(raw) !== null) return null;
    return /[ILOU]/i.test(raw)
      ? 'That code has a letter Crockford codes never use — check for I, L, O or U.'
      : ROOM_CODE_HINT;
  }, [hash]);

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
   * Unpair — genuinely unpaired, not re-paired on the next load.
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

  /*
   * The VIDEO packet, not "whatever landed last".
   *
   * `sync.lastTele` is the most recent packet of any kind, and the channel is
   * shared with the replica feed's `monitor`, the clip `library` and the
   * chunked diagnostics report. Reading `provider` / `quality` / `levels` off
   * it meant every non-video packet answered "nothing known", which is how the
   * quality picker came and went roughly once a second and took the panel's
   * whole DOM subtree with it. `lastVideo` is sticky across the other kinds.
   */
  const tele = sync.lastVideo?.body ?? null;
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
   *
   * This used to be its own inline freshness test, which made it the third
   * private answer to "is a Kraken there" on one screen. It is `presence` now.
   *
   * A phone shares nothing with the Kraken but a room, so "ever seen" is simply
   * whether a packet has ever arrived on this connection: there is no latch to
   * read and a `localStorage` key on the phone would be a fact about a
   * different machine. `lastTele.at` is stamped on THIS device's clock, which
   * is the clock `now` samples.
   */
  const presence = panelPresence(
    { everSeen: sync.lastTele !== null, lastSeenAt: sync.lastTele?.at ?? null },
    now,
    DISPLAY_ONLINE_MS,
  );
  const displayOnline = presence === 'live';
  /**
   * The sub-line, or `null` when the app must not make one.
   *
   * `held` is decided a few lines above, off the same telemetry — so the two
   * halves of "is it playing, and is it paused" come from one packet.
   */
  const playing = playingLine(presence, held);

  /*
   * The library packet, used for the whole shelf rather than one string.
   *
   * This is the gap A3 closes: the display has published `{kind:'library', …}`
   * for two milestones and this page latched it, built a name→title lookup out
   * of it, and threw the rest away. A full shelf arrived on the phone, every
   * packet, and one filename was rendered from it.
   */
  const wireLibrary = sync.library?.body ?? null;
  const clips = useMemo(() => {
    const raw = wireLibrary?.['clips'];
    if (!Array.isArray(raw)) return [];
    return raw as { id: string; name: string }[];
  }, [wireLibrary]);

  const clipNames = useMemo(() => new Map(clips.map((c) => [c.id, c.name])), [clips]);

  /**
   * Is the panel actually showing video? — round 6's C3.
   *
   * `state.activeModuleId` is the SYNCED document, which is the same value the
   * display resolves its module from, so this is the panel's own answer rather
   * than this page's assumption. It was assumed: the remote mounted a video
   * title, a scrubber, A-B loop handles, ±10 and a quality picker whatever was
   * on the LCD, so a paired phone in front of a running clock offered to seek
   * it and reported its "1080p" quality.
   */
  const isVideo = state.activeModuleId === VIDEO_ID;

  /**
   * What the instrument is ABOUT — the source's name, or the module's.
   *
   * `sourceName` answers a question about a video URL, and it was asked
   * unconditionally: with Clock on the panel the heading read `demo.mp4`, which
   * is the name of something the Kraken is demonstrably not showing. The module
   * registry is the one place a module's name lives (R11), so a module added
   * later is named here for free.
   */
  const moduleName = useMemo(() => {
    const found = listModules().find((m) => m.id === state.activeModuleId);
    return found === undefined ? 'this module' : (found.chipName ?? found.name);
  }, [state.activeModuleId]);
  const title = isVideo ? sourceName(videoCfg.url, clipNames) : moduleName;

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

  /**
   * Stable across renders, which is what makes `memo(RemoteQuality)` real.
   *
   * A fresh arrow in the JSX would change the prop's identity on every
   * telemetry packet and re-render the panel anyway — memoising the component
   * and then handing it a new function is the classic way to memoise nothing.
   */
  const setQuality = useCallback(
    (quality: VideoModuleConfig['quality']): void => {
      commit((s) => withModuleConfig(s, VIDEO_ID, 1, { ...videoCfg, quality }));
    },
    // `commit` closes over `runtime.store`, created once by the mount; the
    // identity only has to be stable within one snapshot. Same reasoning as
    // `publishLoop` above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [videoCfg],
  );

  const seek = (delta: number): void => {
    sync.sendCmd('seekBy', delta);
    publishSeek(positionSec + delta);
  };

  /**
   * The receipt for a link handed over from here — A5.
   *
   * Adding from the phone has WORKED the whole time: this field commits the
   * source and the display fetches it. The surface that needed the explanation
   * least (CAM) carried the full receipt, and the one that needed it most said
   * "Play" and nothing else, so nobody ever found out. Same sentence as the
   * Library's, from `vocabulary.ts`, because it is the same act.
   *
   * Round 5's S4: it also has to STOP being true. A receipt with no end is a
   * claim the screen keeps making about a moment that has passed, so it lingers
   * for `RECEIPT_LINGER_MS` — the home screen's rule, the home screen's number —
   * and it is dropped the instant the field is touched or the module changes
   * under it.
   */
  const [receipt, setReceipt] = useState(false);
  useEffect(() => {
    if (!receipt) return undefined;
    const timer = setTimeout(() => {
      setReceipt(false);
    }, RECEIPT_LINGER_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [receipt]);

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

  /**
   * Nothing but pairing, until there is something to drive (R4).
   *
   * The unpaired remote used to mount the whole instrument: a scrubber reading
   * `0:00 / 60:00` — a duration nobody had reported, invented by the fallback
   * track length — three greyed-out transport buttons, a video field, a module
   * picker, a Fit picker, a quality readout and TWO status lines both saying it
   * was waiting. A page whose entire job at that moment is *press this button*
   * was 90 % controls that could not do anything.
   *
   * So the transport, the scrubber and the essentials are gated on a live room.
   * What is left before one exists is the ring, one sentence and one button.
   *
   * ## Round 6's C3: a room is not the only question
   *
   * `const live = paired` was the whole rule, and the name was the tell — it
   * called one thing "live" and used it for three different questions:
   *
   *  - **is there a room?** — which is what it actually tested, and what the
   *    essentials, the shelf and the pairing card genuinely turn on;
   *  - **is the video module on the panel?** — never asked, so the video
   *    instrument mounted over a clock;
   *  - **is the Kraken saying anything?** — never asked either, so the sub-line
   *    claimed playback into silence.
   *
   * The three are separate now: `paired` below, `isVideo` further down, and
   * `presence` from the one derivation every surface reads.
   */
  const live = paired;

  /**
   * A6 — a desktop browser is the same remote, at a desk.
   *
   * Paired, it is identical to the phone: the same ring, the same transport, the
   * same shelf, plus the pairing QR at a size a camera can read (already
   * width-conditioned in `ui.css`). Unpaired, it is pairing **and install** —
   * because the person sitting at a desktop browser with nothing paired is very
   * often the person who has not pointed CAM at this page yet, and the only door
   * to that instruction was on a screen they cannot reach from here.
   *
   * Not on a phone. "Point CAM at this address" is advice about a PC, and the
   * phone is not the PC; mounting it there would be the machine-centric
   * vocabulary problem in card form. The one thing a desktop browser never gets,
   * at any width, is file ingest — that is a data-integrity lie rather than a UI
   * preference, and `ownsBytes()` refuses it everywhere.
   */
  const narrow = useNarrow(PHONE_QUERY);
  const offerInstall = !live && !narrow && !runtime.camDetected;

  /**
   * …and whether this screen is the ONLY screen (the phone rule, `ConfigApp`).
   *
   * The About link below is the one door off this page. On a phone every route
   * resolves back here, so the door opens onto the room it is in — and a link
   * that lands you where you already are is worse than no link at all. What it
   * leads to is broker fields and telemetry switches, which are settings for the
   * machine that talks to the broker; pairing itself — join, rotate, unpair —
   * has always lived on this screen, and stays.
   */
  const phoneOnly = usePhoneOnly(runtime);

  /**
   * …and round 7's F5: WHICH WINDOW is asking for the remote?
   *
   * `#/remote` served one page to every surface, and in CAM's Configuration
   * Browser that page was a remote control for the machine it was running on.
   * The audit's screenshots are the argument: a replica ring above CAM's own
   * live mirror, a scrubber and a ±10 for a panel whose real transport is one
   * click away on the home screen, a **Library** that is the very database this
   * window owns, and a card announcing **Paired with your PC** — to the PC. The
   * unpaired state was worse, because it was advice: *"scan it from the CAM
   * window on your PC"*, printed inside the CAM window on that PC.
   *
   * `docs/remote-control.md` has always described the right flow — press
   * **Create a code** in CAM, then point your phone's camera at the QR — and the
   * UI hid the QR behind a disclosure under a self-pairing headline. So the two
   * surfaces are two pages: CAM gets PAIRING, with the square it exists to show
   * at the size a camera needs, and everything that drives the Kraken from
   * somewhere else keeps the instrument.
   *
   * `ownsBytes` rather than a fifth signal: the window whose IndexedDB the LCD
   * reads is exactly the window that is not remote from it (`surface.ts`).
   */
  const pairingSurface = ownsBytes(runtime);

  /**
   * The link row, in the active module's own noun — round 5's S1.
   *
   * The SAME object CAM's home row is built from (`pasteAction`), so the two
   * fields cannot drift again. What was here instead was `setVideo({ url })`
   * unconditionally under the words "Paste a video link" and a button that said
   * Play: with **Image** on the panel, a pasted `.jpg` went into
   * `modules.video.cfg.url`, the picture module stayed empty, and the receipt
   * below the field said it had been sent. Three lies in one gesture.
   */
  const action = pasteAction(runtime, state.activeModuleId, { narrow });
  const urlValue = urlDraft ?? action?.value ?? '';

  /**
   * The field belongs to the module it is the field FOR.
   *
   * Same rule as the home screen's `draftOwner`: switching modules must not
   * carry a picture URL into the video field, and arriving on a module shows
   * what that module is holding.
   */
  /**
   * Is the **Add** panel open? — round 7's minors, "one field per screen".
   *
   * The state is lifted out of `RemoteAdd` because the thing it has to hide is
   * not inside `RemoteAdd`: pressing **+ Add** opened a panel with a link field
   * in it while the essentials section below kept its own link field for the
   * same module, so a 390 px screen carried two boxes asking for one picture
   * link, 200 px apart, with two different placeholders. Whichever one you type
   * into does exactly the same thing, which is the tell that there should be
   * one.
   *
   * The Add panel wins while it is open because it is the one the user just
   * asked for, and it is the one that also offers **Send a file**.
   */
  const [addOpen, setAddOpen] = useState(false);

  const [draftOwner, setDraftOwner] = useState(state.activeModuleId);
  if (draftOwner !== state.activeModuleId) {
    setDraftOwner(state.activeModuleId);
    setUrlDraft(null);
    setUrlIssue(null);
    setReceipt(false);
  }

  useEffect(() => {
    if (!wantsPaste.current) return;
    wantsPaste.current = false;
    pasteRef.current?.focus();
  }, [state.activeModuleId]);

  /**
   * Editing — one tap, and the ring is still the ring underneath (§8).
   *
   * Two conditions, and the second is the same one the replica itself lives by
   * (round 6's C4): a canvas needs the panel's REPORTED geometry, because every
   * gesture converts screen pixels through `panel.radiusPx` and every module
   * lays itself out against the same numbers. Offering Edit over a panel nobody
   * has described would place layers by arithmetic on a guess, which is the
   * fallback `RemoteRing` deleted for exactly this reason.
   */
  const canEdit = (sync.monitor?.display ?? null) !== null;
  const [editing, setEditing] = useState(false);
  if (editing && (!live || !canEdit)) setEditing(false);

  /** Everything the ring needs, in one object, so both surfaces mount ONE ring. */
  const ringProps: Omit<RemoteRingProps, 'sizePx'> = {
    moduleId: state.activeModuleId,
    config: state.modules[state.activeModuleId]?.cfg ?? null,
    render: state.render,
    display: sync.monitor?.display ?? null,
    monitor: sync.monitor?.snapshot ?? null,
    monitorAt: sync.monitor?.at ?? 0,
    posterUrl: isVideo ? posterUrl : null,
    /*
      The name the ring's fallback card carries, or `''` for "nothing to
      name". Video with no source is the one case that must stay blank: the
      status line already says "Ready to play the demo clip", and the card
      printing the same four words six pixels away is round 2's R11.
    */
    name: isVideo && videoCfg.url.trim() === '' ? '' : title,
    progress: ringProgress,
    held,
  };

  /**
   * Done — and, when the strip sent them, what they were reaching for.
   *
   * The editor deliberately does not grow its own copy of the source field, the
   * A-B scrubber or the quality ladder: all three are real controls on this
   * page, a thumb's width below the canvas. Leaving lands the person on them
   * rather than on a second version of them.
   */
  const leaveEditor = (wanted?: StripEscape): void => {
    setEditing(false);
    if (wanted === 'source') wantsPaste.current = true;
    /*
      …and the other two land somewhere real now.

      `loop` and `quality` used to be accepted here and then dropped: the
      editor closed, the intent evaporated, and the A/B scrubber and the
      quality ladder were somewhere below the fold with nothing to say they
      were what the button had meant. They are on this page — so the page
      brings them to the person rather than the person hunting for them.
    */
    if (wanted === 'loop') wantsScroll.current = '[data-testid="scrubber"]';
    if (wanted === 'quality') wantsScroll.current = '#remote-quality-label,#remote-quality-readout';
  };
  useEffect(() => {
    if (editing) return;
    if (wantsPaste.current) {
      wantsPaste.current = false;
      pasteRef.current?.focus();
    }
    const target = wantsScroll.current;
    if (target === null) return;
    wantsScroll.current = null;
    /*
      One frame later: the editor has just unmounted and the transport, the
      scrubber and the quality ladder mount in its place, so a scroll issued in
      the same tick measures a page that is still the editor's height.
    */
    requestAnimationFrame(() => {
      document.querySelector(target)?.scrollIntoView({ block: 'center', behavior: 'auto' });
    });
  }, [editing]);

  const submitLink = (): void => {
    if (action === null) return;
    const outcome = action.submit(urlValue);
    setUrlIssue(outcome.issue);
    setReceipt(outcome.accepted && outcome.issue === null);
    if (outcome.accepted && action.clearOnAccept) setUrlDraft(null);
  };

  return (
    <div
      className="kh-remote"
      data-testid="remote"
      data-live={live ? 'true' : 'false'}
      /* Which of the two pages this is — F5. The e2e suite asserts the state. */
      data-surface={pairingSurface ? 'pairing' : 'instrument'}
    >
      {/*
        No instrument for the machine it runs on (F5).

        Everything from here to the pairing card is a way to drive a Kraken from
        somewhere else: a replica of the panel, a transport for it, and a shelf
        drawn from the wire. In CAM every one of those has a truer version on the
        home screen — a live iframe of the real display page, the real ops strip,
        and the actual database. A second, worse copy of all three is not a
        remote control, it is a second app.
      */}
      {!pairingSurface && !editing && <RemoteRing {...ringProps} />}

      {/*
        The phone edits the same Look — §8, principle 10.

        The ring goes on being the ring: `RemoteEditor` mounts the same
        component, live replica and all, at a size a thumb can work with, and
        puts the editor's overlay above it. Everything else on this page steps
        aside while it is up, because the remote's other job is a transport for
        a video and this one is an arrangement — two instruments, one at a time,
        on 390 px.
      */}
      {!pairingSurface && live && editing && (
        <RemoteEditor
          runtime={runtime}
          /*
            Does an edit made in there reach the panel? — W1c.

            The wire carries `look` now, so the answer is "the room is joined and
            the transport is up" rather than "this window shares the display's
            IndexedDB". Both facts live on this page already; `lookReach.ts`
            turns them into the tense the claim is allowed to use.

            Only the transport is asked about here: this branch is already inside
            `live`, which is `paired` and then some, so an `&& paired` would be a
            condition the type system can see is always true.
          */
          delivers={sync.status?.network === 'online'}
          state={state}
          presence={presence}
          ring={ringProps}
          onDone={leaveEditor}
        />
      )}

      {!pairingSurface && live && !editing && (
        <>
          <h2 className="kh-remote__title" data-testid="remote-title">
            {title}
          </h2>

          {/*
            One tap to the canvas, and nothing above it moves.

            The remote's first job is play / hold / skip, so editing is an
            affordance beside the ring rather than a mode the page boots in. It
            is disabled — with the reason on it — until the display has reported
            its geometry, which is the same condition the replica inside the
            ring already lives by: no report, no canvas.
          */}
          <p className="kh-remote__editrow">
            <button
              type="button"
              className="kh-btn"
              data-testid="remote-edit"
              disabled={!canEdit}
              title={canEdit ? '' : 'Your Kraken has not reported its panel yet.'}
              onClick={() => {
                setEditing(true);
              }}
            >
              Edit this look
            </button>
          </p>
          {/*
        One line, one truth.

        This sub-line and the link status underneath it BOTH said the remote was
        waiting — "Waiting for your Kraken · quality not reported yet" directly
        above "Looking for your Kraken…" — which is the same sentence twice in
        two vocabularies. The sub-line is about what is PLAYING, so it only
        appears when something is; the link status owns the other case alone.
      */}
          {/*
            The sentence, from the one place that decides whether it may be said
            (round 6, C3). `playingLine` returns `null` for anything but fresh
            telemetry, so this cannot be rendered greyed-out or hopeful — and
            the words themselves are `vocabulary.ts`'s, shared with the home
            screen's ladder, which used to carry its own copy of them.
          */}
          {isVideo && playing !== null && (
            <p className="kh-remote__sub" data-testid="remote-sub">
              {`${playing} · `}
              <span className="kh-tnum">{badge}</span>
            </p>
          )}

          {/*
            The instrument is the VIDEO module's, so it mounts for the video
            module — C3.

            All of this addresses one module: a position, an A-B loop, ±10
            seconds and a stream quality are video's vocabulary and nothing
            else's. It mounted regardless, so a phone paired to a Kraken showing
            a clock offered a scrubber for it, greyed transport buttons under a
            heading naming an `.mp4`, and a quality picker whose readout was the
            last video packet the room had ever carried. Clock, Stats and Image
            have their own compact controls on this page already — the Showing
            row, Fit, and the module-aware link field above — and what they do
            NOT get is somebody else's transport.
          */}
          {isVideo && (
            <>
              <LoopScrubber
                max={scrubMax}
                durationKnown={durationSec !== null && durationSec > 0}
                positionSec={seekBarValue}
                loop={videoCfg.loop}
                onLoopChange={publishLoop}
                /*
                  One group, one answer — round 7's F3.

                  The three transport buttons greyed out on `displayOnline` and
                  the rail beside them did not: a tap on a dead link moved the
                  thumb, sent a `seekTo` into a room with nobody in it, and left
                  the bar showing a position no display had ever reported. It is
                  the same question about the same panel, so it is the same
                  answer — and `LoopScrubber` already turns an absent `onSeek`
                  into a read-only rail with the honest tooltip.
                */
                onSeek={
                  !displayOnline
                    ? undefined
                    : (next) => {
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
                      }
                }
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
            </>
          )}

          <LinkStatus sync={sync} now={now} online={displayOnline} />

          {/*
            The Library, as a PEER of the transport (A3).

            Ring → what's playing → transport → Library → pairing. It sits in the
            page's flow, at the same level as the buttons above it, because it is
            the same kind of thing: a way to drive the one Kraken. A drawer or a
            modal here would be the deleted "clip picker" all over again — a
            second app, behind a door, that reads as a different library.
          */}
          <RemoteLibrary
            store={runtime.store}
            wire={wireLibrary}
            /*
              When the packet ARRIVED, on this device's clock — the clock that
              also stamped the moment a curation command went out. The `ts` the
              display wrote is a different machine's and cannot be compared with
              either.
            */
            packetAt={sync.library?.at ?? null}
            sendCmd={sync.sendCmd}
            activeModuleId={state.activeModuleId}
            videoUrl={videoCfg.url}
            imageId={localImageId(validateImageConfig(state.modules['image']?.cfg).url)}
            presence={presence}
            /*
              Adding, from the window that cannot hold the bytes.

              The line that used to sit here — "Files are added at your PC." —
              was true for exactly as long as that was the case. A phone hands
              the Kraken a file directly now, over the LAN, into the same ingest
              pipeline CAM's own drop target uses, so the sentence is retired and
              the control that makes it untrue stands where it stood.
            */
            add={
              <RemoteAdd
                runtime={runtime}
                sync={sync}
                presence={presence}
                /*
                  The phone's own Add panel had the DESKTOP placeholder — "Paste
                  a picture link — JPG, PNG, WebP, GIF…" — because it was the one
                  `pasteAction` call site in the product that never passed the
                  width. `useNarrow` lives up here, so the answer travels down
                  rather than being sampled a second time.
                */
                narrow={narrow}
                open={addOpen}
                onOpenChange={setAddOpen}
              />
            }
          />

          {/*
        The compact essentials — four controls, not fourteen.

        These are the ones a person on a sofa genuinely reaches for, and they
        are the four the census's REMOTE 22→8 verdict kept: what to play, which
        module is on screen, how the picture sits in the panel, and what quality
        to ask for. Everything they used to be wrapped in — a Panel each, a hint
        each, and a "More controls" door in front of the lot — is gone, and so
        are the sentences that lived inside the `<option>` elements: Fit uses the
        SAME one-word vocabulary as the home screen and the video panel, from
        `ui/Framing`, so the same setting is never learned twice.
      */}
          <section className="kh-remote__ess" data-testid="remote-essentials" aria-label="Controls">
            {/*
              One field per screen (round 7, minors).

              This row and the Add panel's row are the same control for the same
              module; the Add panel is the one the user opened, so this one steps
              out of the way while it is up rather than shouting the same request
              twice with two different placeholders.
            */}
            {!addOpen &&
              (action === null ? (
                /*
                Clock and Stats have nothing to be handed — the home screen's
                answer, on the screen that never got it (S1). A field asking a
                sofa for a video link while the panel shows a clock is the most
                prominent control on the page addressing a module that cannot
                use it.
              */
                <p className="kh-remote__src kh-remote__src--quiet">
                  <button
                    type="button"
                    className="kh-quiet"
                    data-testid="remote-paste-switch"
                    onClick={() => {
                      commit((s) => withBaseKind(s, VIDEO_ID));
                      wantsPaste.current = true;
                    }}
                  >
                    Play something
                  </button>
                </p>
              ) : (
                <form
                  className="kh-remote__src"
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitLink();
                  }}
                >
                  <label className="kh-sr" htmlFor="remote-src">
                    {action.label}
                  </label>
                  <TextInput
                    id="remote-src"
                    inputRef={pasteRef}
                    value={urlValue}
                    /* The spine's fingerprint — see `pasteLink.ts` and C1. */
                    pasteField={action.moduleId}
                    placeholder={action.placeholder}
                    onChange={(next) => {
                      setUrlDraft(next);
                      setUrlIssue(null);
                      setReceipt(false);
                    }}
                  />
                  <button
                    type="submit"
                    className="kh-btn kh-btn--primary"
                    data-testid="remote-play"
                  >
                    {action.submitLabel}
                  </button>
                </form>
              ))}
            {!addOpen && urlIssue !== null && (
              <Notice tone={urlIssue.severity === 'error' ? 'error' : 'warn'}>
                {urlIssue.message}
              </Notice>
            )}
            {/*
              …and the receipt only promises what presence supports — C5.

              It said "Sent to your Kraken. It fetches the file and keeps a
              copy, so a tile appears here shortly." into a room with nobody
              listening in it: a phone paired to a Kraken that is switched off
              got a green tick and a promise about a tile that was not coming.
              `linkReceipt` is the same chooser CAM's Library and the phone's
              Add panel print through.
            */}
            {!addOpen && receipt && urlIssue === null && (
              <p className="kh-hint" data-testid="remote-receipt">
                {linkReceipt(presence)}
              </p>
            )}

            {/*
          Segmented, not `<select>` (R8). These were the last two native pickers
          in the product, and both are three or four one-word choices — the
          exact shape a segment row is for, and the shape the home screen draws
          the same two settings in.
        */}
            <div className="kh-remote__pair2">
              {/*
                The same word the status line uses, from the same place.

                "Showing" was typed here and again in `HomeView.describeStatus`
                — one vocabulary, two files, free to drift. `panelVerb` owns it,
                and asking for it means naming what this window knows.
              */}
              <GroupField label={panelVerb(presence, 'showing')} id="remote-module">
                <Segmented
                  id="remote-module"
                  wrap
                  labelledBy="remote-module-label"
                  value={state.activeModuleId}
                  /*
                    The BASE picker, from the one derivation — round 13.

                    This row was `listModules()`: nine options including Text,
                    Icon and Date, whose manifests declare `roles: ['overlay']`
                    and therefore cannot be a background at all, and missing the
                    Solid colour the add sheet one screen away offers. That is
                    exactly the bug round 11's M-a fixed for CAM's chip row, and
                    the fix never reached the phone — so the phone's two base
                    pickers disagreed with each other AND with the desktop's.
                    `basePicker.ts` answers it for all four now.

                    `chipName ?? name`, the same source the home chips read, so
                    no two rows can call one module two different things.
                  */
                  options={baseOptions(listModules())}
                  onChange={(id) => {
                    /*
                      Solid is the shape kind wearing `SOLID_BASE_CFG` (§10)
                      rather than a tenth module, so choosing it is a base
                      switch AND a config write — the same pair the add sheet's
                      Solid tile commits.
                    */
                    if (id === SOLID_OPTION_VALUE) {
                      const shape = listModules().find((m) => m.id === SOLID_BASE_KIND);
                      commit((s) => {
                        const based = withBaseKind(s, SOLID_BASE_KIND);
                        return shape === undefined
                          ? based
                          : withModuleConfig(based, SOLID_BASE_KIND, shape.configVersion, {
                              ...SOLID_BASE_CFG,
                            });
                      });
                      return;
                    }
                    commit((s) => withBaseKind(s, id));
                  }}
                />
              </GroupField>
              <GroupField label="Fit" id="remote-fit">
                <Segmented
                  id="remote-fit"
                  wrap
                  labelledBy="remote-fit-label"
                  value={state.render.fit}
                  options={FIT_SEGMENTS.map((f) => ({ value: f.value, label: f.label }))}
                  onChange={(fit) => {
                    commit((s) => ({
                      ...s,
                      render: { ...s.render, fit: fit as AppState['render']['fit'] },
                    }));
                  }}
                />
              </GroupField>
            </div>

            {isVideo && (
              <RemoteQuality
                cfg={videoCfg}
                tele={tele}
                fallbackProvider={ytMatch.provider}
                onChange={setQuality}
              />
            )}
          </section>
        </>
      )}

      <PairingCard
        paired={paired}
        surface={pairingSurface ? 'pairing' : 'instrument'}
        // Round 8's B. "Paired with your PC" is a claim about the OTHER end, and
        // the card was making it out of `paired && roomCode !== null` — two
        // facts this device produces on its own. The same derivation the
        // sub-line 200 px up already reads decides it now.
        presence={presence}
        roomCode={roomCode}
        remoteUrl={remoteUrl}
        // The gap between "this device knows the room" and "the transport is
        // actually up" is a second or two on a phone radio, and a card that
        // claims "Paired" through it is claiming something it cannot see yet.
        connecting={paired && sync.status?.network !== 'online'}
        // M4 — a code in the link that could not be one is said, not swallowed.
        linkCodeIssue={linkCodeIssue}
        onJoin={join}
        onRotate={rotate}
        onForget={forget}
      />

      {/*
        The only navigation on the page, and the only door left to everything
        this screen used to duplicate: brokers, endpoints, telemetry switches
        and the hardware-report pull all live on the merged About page.

        Gated with everything else: before a room exists there is no connection
        to inspect, and the unpaired screen is one sentence and one button.
      */}
      {offerInstall && <CamSetupCard runtime={runtime} variant="quiet" />}

      {live && !phoneOnly && (
        <p className="kh-remote__foot">
          {/*
            The label is the destination (round 4, minors).

            "Connection & diagnostics" named two things, one of which — a
            Diagnostics page — has not existed since round 1; what the link opens
            is About, which carries the connection settings and the report. A
            link whose words do not match the page it lands on teaches the reader
            not to trust the next one.
          */}
          <a href="#/about" data-testid="remote-connection-link">
            About
          </a>
        </p>
      )}
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
 * the line answers, in words. The plumbing moved to the About page's Connection
 * section, behind its "Connection detail" disclosure, where it is still one tap
 * away — the Diagnostics page it used to name has not existed since round 1.
 *
 * The `data-*` attributes are the machine-readable copy of the same answer, so
 * the e2e suite can assert on state rather than on user-facing prose.
 */
function LinkStatus({ sync, now, online }: { sync: SyncHandle; now: number; online: boolean }) {
  const network = sync.status?.network ?? 'idle';
  const failedOver = sync.status?.failedOver === true;
  const seenSec =
    sync.lastTele === null ? null : Math.max(0, Math.round((now - sync.lastTele.at) / 1000));

  /*
   * Three states, and the unpaired one is not among them.
   *
   * This line only mounts inside a live room now, so "Not paired yet — scan the
   * code below" is gone along with the screen that could show it: the unpaired
   * remote IS the pairing card, and a status line above it saying so was the
   * second of the two duplicate waiting lines (R4).
   */
  let text: string;
  if (online) text = `Linked to your Kraken · seen ${String(seenSec ?? 0)}s ago`;
  else if (network === 'online') text = 'Linked — waiting for your Kraken.';
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
 * a feature."
 *
 * ## The unpaired card is ONE state, not three
 *
 * The design audit (F5.4) opened this card and read *"Point a camera at this
 * code. The phone opens the remote and connects automatically…"* — above no
 * code at all, and two paragraphs above an orange warning saying *"No code yet.
 * Press Generate code."* Three equal-weight controls sat under that (a field, a
 * Join button and a Generate button) where exactly one of them was the answer.
 *
 * So the card never describes something that is not on screen. Before a room
 * exists it is a sentence and **one** primary button; the instant one does, it
 * is the QR, the code, and Copy the link. The field for reading a code off a
 * monitor is real and stays — it is the fallback for a camera that will not
 * focus — but it is a fallback, so it sits behind a quiet disclosure instead of
 * competing with the thing that works.
 *
 * Paired, the card collapses to a single line: who you are paired with, and the
 * code, with everything that changes a room one tap down.
 */
function PairingCard({
  paired,
  surface,
  presence,
  roomCode,
  remoteUrl,
  connecting,
  linkCodeIssue,
  onJoin,
  onRotate,
  onForget,
}: {
  paired: boolean;
  /**
   * Which window is reading this card — round 7's F5.
   *
   * `'pairing'` is CAM's Configuration Browser, where this card is the entire
   * page and the QR is the thing it exists to show: the square goes up front, at
   * the size a phone camera resolves, under a heading that names the gesture.
   * `'instrument'` is every window that is remote from the Kraken, where the
   * card is a credential at the bottom of a remote control and collapses to one
   * line.
   *
   * The self-pairing wording lives entirely on the other side of this flag.
   * *"Paired with your PC"*, shown to the PC, was a true sentence addressed to
   * the wrong reader; the phone's half of it — *"scan it from the CAM window on
   * your PC"* — turned out not to be true for any reader at all, and round 8's
   * C is what replaced it.
   */
  surface: 'pairing' | 'instrument';
  /**
   * What this device has actually heard from the other end — round 8's B.
   *
   * The card's paired state said **Paired with your PC** on `paired &&
   * roomCode !== null`, and neither of those is evidence of a PC: `rotate()`
   * mints a code and joins the room in one commit, so a phone that pressed
   * **Create a code** by itself satisfied both facts and announced a pairing
   * with a machine that had never been asked. It is the same shape as every
   * finding round 6 collected — a surface inventing a private answer to "is a
   * Kraken there" — and the answer is the same one `playingLine` is already
   * given 200 px further up this page.
   *
   * Pre-evidence the card does not collapse: it is the code, and how to get the
   * code where it needs to be.
   */
  presence: PanelPresence;
  roomCode: string | null;
  remoteUrl: string | null;
  connecting: boolean;
  /**
   * Why the code in this page's own link was refused — `null` when there was
   * none or it was fine (M4).
   *
   * Rendered through the same `pair-code-error` Notice a refused **Join** uses:
   * one refusal, one place, whichever door the code came through.
   */
  linkCodeIssue: string | null;
  onJoin: (code: string) => void;
  onRotate: () => void;
  onForget: () => void;
}) {
  const [draft, setDraft] = useState(roomCode ?? '');
  const [copied, setCopied] = useState(false);
  /**
   * Whether the last **Join** was refused — round 5's S5.
   *
   * `normalizeRoomCode` returns `null` for anything that is not eight
   * alphabet characters, and `join()` simply returned on that: the button
   * moved, the field kept the text, and nothing on the screen or in the
   * accessibility tree said why. A control that refuses in silence is
   * indistinguishable from one that is broken.
   */
  const [badCode, setBadCode] = useState(false);

  /**
   * The refusal on the screen, from either door (M4).
   *
   * A typed code the user has since started correcting clears `badCode` and so
   * clears this; a code that came in the LINK cannot be corrected in place, so
   * it stands until the field is used, which is exactly the remedy the sentence
   * points at.
   */
  const codeIssue = badCode ? ROOM_CODE_HINT : linkCodeIssue;
  const showIssue = codeIssue !== null;
  /**
   * Where the refusal is SHOWN, which is not always where it is about — F-6.
   *
   * A code somebody typed belongs beside the field they typed it into, and that
   * field lives behind "Type a code instead". A code that arrived in the LINK
   * belongs nowhere near it: the person did not open the disclosure, has no
   * intention of opening it, and the whole content of the message is that the
   * link they followed cannot work. Rendered inside the collapsed `<details>`
   * it was in the DOM, described the field, and was invisible — measured on
   * `#/remote?room=UUUUUUUU`, `pair-code-error` sat at y = 642 inside a closed
   * disclosure with no rendered text.
   *
   * One Notice, one id (the field's `aria-describedby` still resolves to it
   * either way), placed by where the code came from.
   */
  const issueFromLink = showIssue && !badCode;
  const issueNotice = showIssue ? (
    <div id="remote-room-bad" data-testid="pair-code-error">
      {/*
        The hint and the error are the same sentence, from `roomCode.ts` —
        unless the code carried one of the four glyphs Crockford removed, in
        which case the caller has diagnosed it and the sentence names them
        (M4). A rule stated one way when it is advice and another way when it
        is a complaint is two rules to the person reading them; a rule and a
        diagnosis are not the same thing.
      */}
      <Notice tone="error">{codeIssue}</Notice>
    </div>
  ) : null;

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

  /**
   * Join, from the field as well as from the button.
   *
   * Round 6's minors: the box was a `<Row>` rather than a form, so pressing
   * Enter on an eight-character code did nothing at all — on the one screen
   * whose entire job at that moment is to accept eight characters, typed by
   * somebody reading them off a monitor across the room.
   */
  const submitCode = (): void => {
    if (normalizeRoomCode(draft) === null) {
      setBadCode(true);
      return;
    }
    setBadCode(false);
    onJoin(draft);
  };

  /** The by-hand path: type a code somebody read off a monitor. */
  const codeField = (
    /*
      The rule is stated ONCE — round 6's minors.

      `ROOM_CODE_HINT` was the field's permanent description AND the text of the
      error, so a refused code printed the same sentence twice, 20 px apart, one
      of them in red. Saying a rule louder is not saying a second thing. The
      description carries it while it is advice; the Notice takes it over while
      it is a complaint, and the description reverts the moment the field is
      touched.
    */
    <Field
      label="Room code"
      htmlFor="remote-room"
      {...(showIssue ? {} : { description: ROOM_CODE_HINT })}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submitCode();
        }}
      >
        <Row>
          {/*
          The box filters as you type (S5).

          `normalizeRoomCode` has always folded `I`/`L` → `1` and `O` → `0` at
          the end, which meant the field happily accepted characters the code
          format does not contain and then quietly rewrote them on submit. Doing
          the fold on the keystroke shows the user the code they are actually
          typing — and `U`, which Crockford excludes and which has no lookalike
          to fold into, simply cannot be entered rather than failing eight
          characters later.
        */}
          <TextInput
            id="remote-room"
            value={draft}
            placeholder="ABCD1234"
            invalid={showIssue}
            describedBy={showIssue ? 'remote-room-bad' : undefined}
            onChange={(next) => {
              setDraft(filterRoomCodeInput(next));
              setBadCode(false);
            }}
          />
          <button type="submit" className="kh-btn kh-btn--primary" data-testid="pair-join">
            Join
          </button>
        </Row>
      </form>
      {/* A typed refusal stays with the field; a link's is hoisted (F-6). */}
      {!issueFromLink && issueNotice}
    </Field>
  );

  const qrBlock =
    qr !== null && remoteUrl !== null ? (
      <div className="kh-roomcard__qr" data-testid="pair-qr">
        <QrCode qr={qr} payload={remoteUrl} />
        <small className="kh-roomcard__caption">
          Point your phone’s camera at this to pair it.
        </small>
      </div>
    ) : null;

  const roomActions =
    remoteUrl === null ? null : (
      <>
        <Code>{remoteUrl}</Code>
        <Row>
          <Button testId="pair-copy" onClick={copyLink}>
            {copied ? 'Copied' : 'Copy the link'}
          </Button>
          <Button testId="pair-rotate" onClick={onRotate}>
            Rotate code
          </Button>
        </Row>
      </>
    );

  /*
   * CAM, paired — the pairing surface (F5).
   *
   * This card IS the page here, so the square is not behind a disclosure and the
   * heading names the gesture rather than the state. What it does not say is
   * "Paired with your PC": the reader is the PC, and a machine reporting that it
   * has paired with itself is the clearest possible sign that a screen was built
   * without asking who is reading it. What is true and useful is that a code
   * exists and here is how to get it onto a phone.
   */
  if (paired && roomCode !== null && surface === 'pairing') {
    return (
      <section
        className="kh-roomcard kh-roomcard--open"
        data-testid="pairing-card"
        data-paired="true"
      >
        <h2 className="kh-roomcard__title" data-testid="pairing-title">
          Scan with your phone
        </h2>
        {qrBlock}
        <div className="kh-roomcard__head" data-testid="paired-summary">
          <small className="kh-roomcard__code">ROOM {formatRoomCode(roomCode)}</small>
          <Button testId="pair-forget" onClick={onForget}>
            Unpair
          </Button>
        </div>
        {roomActions}
        {issueFromLink && issueNotice}
        <Disclosure summary="Pairing options" testId="pairing-options">
          {codeField}
          <p className="kh-hint">{UNPAIR_NOTE}</p>
        </Disclosure>
      </section>
    );
  }

  if (paired && roomCode !== null) {
    /*
     * Round 8's B, as the two states this card actually has.
     *
     * `seen` — something the display published has reached this device, so
     * there demonstrably is a machine on the other end and the card may name
     * it. `waiting` — this device has a room and nothing else, which is exactly
     * what pressing **Create a code** here produces, and what a link scanned
     * from a Kraken that is switched off produces too. The room is real either
     * way, so the code, Unpair and the pairing options stay where they are; the
     * headline stops naming a PC nobody has heard from, and the card spends the
     * space on the thing a code with no Kraken behind it needs, which is a route
     * into CAM.
     */
    const known = panelIsKnown(presence);
    return (
      <section
        className="kh-roomcard"
        data-testid="pairing-card"
        data-paired="true"
        data-evidence={known ? 'seen' : 'waiting'}
      >
        <div className="kh-roomcard__head" data-testid="paired-summary">
          <div className="kh-roomcard__who">
            <b data-testid="paired-title">
              {connecting ? (
                <span className="kh-shimmer">Connecting…</span>
              ) : known ? (
                'Paired with your PC'
              ) : (
                'Your pairing code'
              )}
            </b>
            <small className="kh-roomcard__code">ROOM {formatRoomCode(roomCode)}</small>
          </div>
          {/*
            Unpaired, not "Forget this Kraken" — the one thing this card is for
            besides showing the code, promoted out of a drawer and named after
            the state it produces.
          */}
          <Button testId="pair-forget" onClick={onForget}>
            Unpair
          </Button>
        </div>
        {!known && (
          /*
            The one route that exists, named by its real controls — round 8's C.
            A code minted on this phone is a room CAM has never been told about,
            and the only way to tell it is the field on CAM's own pairing card.
            The line is conditional because the other way to arrive here is a
            scanned link, where CAM already knows the room and there is nothing
            to do but wait — which the status line above says, so this does not.
          */
          <p className="kh-hint" data-testid="pair-waiting">
            Created this code here? Enter it in the CAM window on your PC: open <b>Remote</b> there,
            then <b>Type a code instead</b>.
          </p>
        )}
        {issueFromLink && issueNotice}
        <Disclosure summary="Pairing options" testId="pairing-options">
          {/*
            The square is for the OTHER device — and it is not the first thing
            about a room that is already paired (round 4, minors).

            A phone showing itself a code to scan is furniture, so `ui.css`
            already hid it below 700 px. Round 4 measured the desktop case: at
            176 px plus its caption it is by some distance the loudest object on
            a card whose whole message, once you are paired, is one line — and
            it pushed the thing you came back for below the fold. Pairing a
            SECOND device is a pairing option, so it lives with the other pairing
            options, one tap down, at the size a camera actually needs.

            CAM is the exception and it is a whole surface rather than a flag:
            there the card is the page and the square is the point, so it is not
            in here at all (F5).
          */}
          {qrBlock}
          {codeField}
          {roomActions}
          <p className="kh-hint">{UNPAIR_NOTE}</p>
        </Disclosure>
      </section>
    );
  }

  /*
   * Unpaired is ONE state: a sentence, a button, and a way in by hand.
   *
   * There is no second branch for "a code exists but we are not paired",
   * because there is no such moment — `onRotate` mints a code and joins the
   * room in the same commit, so the card is either asking for a pairing or
   * reporting one. The branch that used to sit here drew a large QR under the
   * heading "Open on your phone", on the phone.
   */
  return (
    <section
      className="kh-roomcard kh-roomcard--open"
      data-testid="pairing-card"
      data-paired="false"
    >
      {/*
        Two readers, two sentences — F5, and round 8's C.

        F5 split the copy by reader, and the phone's half was still an
        instruction nobody can carry out: *"Create a code here, then scan it
        from the CAM window on your PC — nothing to type."* Codes are created on
        CAM and scanned BY a phone camera (docs/remote-control.md) — CAM has no
        camera, this app ships no decoder on any surface, the phone draws no
        square of its own below 700 px, and a code minted here can only reach
        CAM by being typed. So the sentence told a reader holding the one device
        that CAN scan to go and scan with the one that cannot, and closed by
        ruling out the only route that works.

        What each reader is told now is the route their own hardware has. CAM
        hands a code out; the phone takes one, with its camera if it has the
        square in front of it and by typing into CAM if it does not — and
        **Create a code**, **Remote** and **Type a code instead** are all
        controls that exist, on the surface named.
      */}
      <h2 className="kh-roomcard__title" data-testid="pairing-title">
        {surface === 'pairing' ? 'Pair your phone' : 'Pair with your Kraken'}
      </h2>
      <p className="kh-hint">
        {surface === 'pairing'
          ? 'Create a code here, then scan it with your phone — nothing to type, no account, and no server of ours in between.'
          : 'The code comes from CAM: open Remote on your PC, press Create a code, and point this phone’s camera at the square. No square in front of you? Create a code here and type it into CAM instead. No account, and no server of ours in between.'}
      </p>
      <Row>
        <Button primary testId="pair-rotate" onClick={onRotate}>
          Create a code
        </Button>
      </Row>
      {/*
        The refusal, ABOVE the door rather than behind it — F-6.

        `#/remote?room=UUUUUUUU` is a link somebody followed: the only useful
        thing this screen can do is say why it did not work, and it said it
        inside a collapsed disclosure the reader had no reason to open.
      */}
      {issueFromLink && issueNotice}
      <Disclosure summary="Type a code instead" testId="pair-by-hand">
        {codeField}
      </Disclosure>
    </section>
  );
}

/**
 * The pairing QR, drawn inline — never fetched, because the URL is the secret.
 *
 * Three properties here are what a camera actually needs, and all three are
 * pinned by tests because all three look like styling:
 *
 *  - DARK ON LIGHT, always. The white `rect` and the black `path` are literal
 *    hex, not theme tokens: the app is dark, and a light-on-dark QR is an
 *    inverted code that the QR spec does not describe and that iOS will not
 *    even offer to open.
 *  - THE QUIET ZONE, from `qrSvgPath`'s 4-module margin, which is inside the
 *    `viewBox` — so the white `rect` spans it and it survives any scaling.
 *  - SIZE. 176 px, not the 56 px thumbnail this used to be. A version-4 code is
 *    33 modules plus 8 of quiet zone; 176 px puts a module at ~4.3 px, which a
 *    phone camera resolves at arm's length.
 */
const QR_PX = 176;

function QrCode({ qr, payload }: { qr: { d: string; side: number }; payload: string }) {
  return (
    <svg
      className="kh-qr"
      viewBox={`0 0 ${String(qr.side)} ${String(qr.side)}`}
      width={QR_PX}
      height={QR_PX}
      role="img"
      aria-label="Pairing QR code for the remote URL"
      shapeRendering="crispEdges"
      // Not for the browser: the e2e assertion that what is drawn is the
      // absolute https link, since the modules themselves are unreadable to a
      // test. A camera that decodes anything else has decoded a bug.
      data-qr-payload={payload}
      data-qr-quiet="4"
    >
      <rect width={qr.side} height={qr.side} fill="#ffffff" />
      <path d={qr.d} fill="#000000" />
    </svg>
  );
}
