import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import {
  CAM_FRAME_RATE_LEAD_SENTENCE,
  CAM_FRAME_RATE_TAIL,
  CAM_PATH_FRAME_RATE,
} from '../../../config/camPaths';
import {
  KEEPING_A_COPY,
  KEPT_A_COPY,
  LIBRARY_NOUN,
  LOCAL_COPY_PITCH,
} from '../../../config/vocabulary';
import { formatBytes } from '../../../lib/bytes';
import { getModule, listModules } from '../../../modules/registry';
import { videoModule } from '../../../modules/video';
import { readClipIndex } from '../../../modules/video/local/clipStore';
import {
  progressPct,
  readMirroredDownloads,
  type DownloadEntry,
} from '../../../modules/video/local/downloadManager';
import { readTeleMirror, type TelePacket } from '../../../modules/video/telemetry/videoTelemetry';
import { validateVideoConfig, type VideoModuleConfig } from '../../../modules/video/types';
import { DEVICE_PRESETS } from '../../../platform/devicePresets';
import { BASE_LAYER_ID, MAX_LAYERS } from '../../../state/look/types';
import { selectLayerConfig, withModuleConfig } from '../../../state/selectors';
import { decodeMonitorSnapshot } from '../../../sync/monitorSnapshot';
import { Meter, Notice } from '../../../ui';
import { withBaseKind } from '../../state/switchBase';
import { hasDisplayBeenSeen } from '../displaySeen';
import { alignPatches, distributePatches, type AlignEdge, type AlignRef } from '../editor/arrange';
import {
  SOLID_BASE_CFG,
  SOLID_BASE_KIND,
  baseCapableKinds,
  hasSolidBase,
} from '../editor/basePicker';
import { budgetReading } from '../editor/budget';
import { readLookName, writeLookName } from '../editor/looksStore';
import { nudgeStep } from '../editor/nudge';
import { resize as resizeLayer } from '../editor/ops';
import { monitoringIsSimulated } from '../editor/previewMonitoring';
import { useScrollEdges } from '../editor/scrollEdges';
import { useEditor } from '../editor/useEditor';
import {
  TELE_FRESH_MS,
  describeFlow,
  eventTime,
  describeVideoStatus,
  failureLine,
  fpsIsAtPanelMax,
  isLowFps,
  pickMirrorPreset,
  readDisplayFacts,
  receiptIsCurrent,
  receiptSubLine,
  resolverHealthyFromTele,
  sourceName,
  type FlowState,
  type Status,
} from '../homeState';
import { PanelClaim } from '../PanelClaim';
import {
  CLAIM_FRAME_RATE,
  CLAIM_FRAME_RATE_AT_MAX,
  CLAIM_HANDOFF_PICKUP,
  CLAIM_SAMPLE_READINGS,
  CLAIM_STREAMING_HEADLINE,
  CLAIM_STREAMING_NO_COPY,
  CLAIM_YOUTUBE_EMBED,
  handoffHeadline,
  panelClaimText,
  panelVerb,
  settledReceipt,
} from '../panelClaims';
import { panelIsLive, panelPresence, type PanelPresence } from '../panelPresence';
import { pasteAction, type PasteAction, type PasteIssue } from '../pasteLink';
import { replicaGeometry } from '../replica';
import { ownsBytes } from '../surface';
import { PHONE_QUERY, useNarrow } from '../useNarrow';

import { CamSetupCard } from './CamSetupCard';
import { prefetchConfigPanel } from './configPanels';
import { AddSheet } from './editor/AddSheet';
import { ArrangeStrip } from './editor/ArrangeStrip';
import { EditorCanvas } from './editor/EditorCanvas';
import { EditorHeader } from './editor/EditorHeader';
import { InspectorSheet } from './editor/InspectorSheet';
import { LayerRail } from './editor/LayerRail';
import { crossFadeLookSwitch } from './editor/looks/crossFade';
import { FirstRunTemplates } from './editor/looks/FirstRunTemplates';
import { LooksSheet } from './editor/looks/LooksSheet';
import { useCarousel } from './editor/looks/useCarousel';
import { SelectionStrip } from './editor/SelectionStrip';
import { LoopScrubber, LOOP_MAX_SEC } from './LoopScrubber';
import { ModuleSettingsView } from './ModuleSettingsView';
import { VideoHalo } from './VideoHalo';

import type { ConfigRuntime } from '../runtime';

/**
 * "Your Kraken" — the home screen (docs/design/halo-prototype.html, screen 1).
 *
 * The old home was Setup: four numbered steps organised like the codebase. This
 * one is organised around the object. The screen itself is the interface — a
 * live mirror of the LCD sits at the top, one primary action sits under it, and
 * everything technical is one level down behind a quiet disclosure.
 *
 * Three things here are more than styling:
 *
 *  - **The mirror is the real display page.** `./?kraken=1&sim=<preset>` in an
 *    iframe on the same origin, sharing this page's localStorage, so an edit
 *    made below is reflected above through the production storage-event path.
 *    It is the Preview tab, promoted to the thing you always see.
 *  - **Except for video**, which cannot run a second decoder on this origin and
 *    shows a poster plus a live position arc instead — see `VideoHalo`.
 *  - **The advisory never guesses.** See `homeState.readDisplayFacts`: the
 *    low-frame-rate banner is drawn only on a number the DISPLAY published, not
 *    on this window's own geometry fallback.
 *
 * ## Options are contextual, and they resolve in place
 *
 * The design audit's two worst findings were both here. There was no way to
 * click to a settings page (F1) — `#/module/<id>` had zero inbound links in the
 * whole product — and the ops line pretended to be three quick toggles while
 * every one of them opened the same 1,600 px wall and scroll-jumped 1,363 px
 * into it (F2). So:
 *
 *  - **the active chip is the door.** Tap a chip to switch modules; tap the one
 *    that is already active and its options appear directly underneath, in an
 *    animated panel, without the halo leaving the screen.
 *  - **the ops strip is real controls.** Fit is a segmented control and Loop
 *    opens the A/B scrubber in place. Nothing on it is a status readout wearing
 *    a button's clothes — the "Saved locally ✓" chip the audit named is gone
 *    entirely, because keeping a copy is a stage the status line reports, not a
 *    property the strip asserts. Nothing here navigates and nothing here
 *    scrolls you anywhere.
 *
 * ## …and Advanced gets the floor, the way options got the halo's
 *
 * Round 3 found the second door INERT at CAM's window: a `max-height` on the
 * panel silently swallowed 929 px, so pressing Advanced rotated a chevron and
 * changed nothing else on the screen. A deliberate second gesture that produces
 * no visible result is worse than one that produces a scrollbar. So opening
 * Advanced promotes the panel to an honest full-height flow — the page scrolls,
 * visibly and expectedly, with the nav and the footer below it — and the panel
 * scrolls the thing you opened into view so the press has an answer.
 */

/** The telemetry and download mirrors are polled at 1 Hz, as §7.5 mandates. */
const MIRROR_POLL_MS = 1000;

/**
 * How long the options panel lingers while it collapses.
 *
 * Must be >= `--kh-dur-slow` in `ui.css`, which is what `kh-close` runs for.
 */
const OPS_CLOSE_MS = 500;

/**
 * A localStorage mirror, rendered as React state.
 *
 * `storage` event for the fast path plus an unconditional 1 s poll, because the
 * event's cross-window reliability inside CAM's Electron webview is only
 * measured on one build (hardware checklist H16) — the same belt-and-braces
 * `subscribeTelemetry()` uses.
 */
function useMirror<T>(read: () => T): T {
  const [value, setValue] = useState<T>(read);
  useEffect(() => {
    const refresh = (): void => {
      setValue(read());
    };
    refresh();
    window.addEventListener('storage', refresh);
    const timer = setInterval(refresh, MIRROR_POLL_MS);
    return () => {
      window.removeEventListener('storage', refresh);
      clearInterval(timer);
    };
  }, [read]);
  return value;
}

/** A 1 Hz clock, so "live" can go stale on its own without a storage write. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, MIRROR_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return now;
}

export function HomeView({
  runtime,
  openModule,
}: {
  runtime: ConfigRuntime;
  /**
   * `#/module/<id>`, resolved here rather than on a page of its own.
   *
   * The route survives as a redirect for bookmarks, docs and forks (see
   * `ConfigApp`), and it lands where the options actually live now: home, with
   * that module active and its panel open.
   */
  openModule?: string | undefined;
}) {
  const state = runtime.store.getSnapshot();
  const modules = listModules();
  const activeId = state.activeModuleId;

  const [draft, setDraft] = useState('');
  const [issue, setIssue] = useState<PasteIssue | null>(null);
  /**
   * The primary action's input, so "Play something" can hand it the caret.
   *
   * With Clock or Stats on the panel there is nothing to paste, so the row
   * collapses to one quiet affordance that switches context (R9). Switching
   * without landing the caret would leave the user looking at a field they have
   * to go and click, which is the gesture the affordance existed to save.
   */
  const pasteRef = useRef<HTMLInputElement>(null);
  /**
   * A ref rather than state: nothing renders differently because a focus is
   * pending, and the switch itself already re-renders this screen — so the
   * effect below has a trigger without a second state update chasing the first.
   */
  const wantsPaste = useRef(false);
  /**
   * The contextual panel, open on arrival when a `#/module/<id>` link brought
   * us here.
   *
   * A lazy initialiser rather than an effect: the panel's open-ness is React's
   * own state, nothing outside React reads it, and setting it from an effect
   * would be a cascading render on every mount. `ConfigApp` keeps this screen
   * mounted across the redirect's hash rewrite (they share a `<main>` key), so
   * the value survives `openModule` going back to `undefined` one tick later.
   */
  const [openOps, setOpenOps] = useState(
    () => openModule !== undefined && openModule !== '' && getModule(openModule) !== null,
  );
  /**
   * The panel's exit, which React cannot do on its own.
   *
   * Wave A gave the options panel a real opening spring (`@keyframes kh-open`)
   * and then unmounted it instantly on close, so half the gesture was animated
   * and half was a hard cut (F12). An unmount cannot be animated, so the panel
   * stays mounted for one beat with a `--closing` modifier and the mirrored
   * keyframes, and a timer — not `animationend` — takes it down: a timer fires
   * whether or not the animation ran at all, which matters under
   * `prefers-reduced-motion` and in any environment that disables animations.
   */
  const [closingOps, setClosingOps] = useState(false);
  /**
   * Whether the panel's own Advanced door is open (F1).
   *
   * The `<details>` lives several levels down inside a lazily-loaded module
   * panel, so this window learns about it the only way it can: a `toggle`
   * listener on the panel container, in the CAPTURE phase — `toggle` does not
   * bubble, but capture always traverses the ancestors, so one listener covers
   * every door any module chooses to put in there.
   *
   * It is state rather than a CSS-only affair because the page's contract
   * changes: with Advanced closed the whole composition is promised to fit
   * CAM's 537 px window, and with it open the page is promised to scroll
   * honestly instead. `data-advanced` is what says which promise is in force,
   * to the stylesheet and to the suite.
   */
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!closingOps) return undefined;
    const timer = setTimeout(() => {
      setClosingOps(false);
    }, OPS_CLOSE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [closingOps]);
  const showOps = (next: boolean): void => {
    setOpenOps(next);
    setClosingOps(!next && openOps);
    // A closed panel has no open doors. Without this the page would still be
    // claiming its scrolling contract after the thing that justified it left.
    if (!next) setAdvancedOpen(false);
  };

  /**
   * The Advanced door, watched from outside the chunk that renders it.
   *
   * Capture phase because `toggle` does not bubble. The open one is scrolled
   * into view for the same reason the flag exists at all: the audit's finding
   * was that pressing this control changed nothing a user could see, and a door
   * that opens below the fold with no motion is the same failure with a
   * scrollbar attached. `block: 'nearest'` moves the page by the minimum that
   * makes the answer visible, and not at all when it already is.
   */
  useEffect(() => {
    const host = panelRef.current;
    if (host === null) return undefined;
    const sync = (): void => {
      setAdvancedOpen(host.querySelector('details[open]') !== null);
    };
    const onToggle = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof HTMLDetailsElement)) return;
      sync();
      if (target.open) target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    host.addEventListener('toggle', onToggle, true);
    /*
     * A door can arrive ALREADY OPEN (round 4, F2).
     *
     * `ModuleOptions` opens Advanced on arrival when there is nothing above it,
     * and rendering `<details open>` fires no `toggle` event — so a listener
     * alone would leave `data-advanced` saying `false` while the page was in
     * fact the taller, scrolling composition. That is the exact class of bug
     * round 3 fixed on the other side of this attribute: the page's promise
     * has to match the page.
     *
     * The observer rather than a one-shot read because the panel's chunk can
     * land a tick after this effect runs (`ModuleSettingsView`'s cold path),
     * and the door arrives with it.
     */
    sync();
    const watcher = new MutationObserver(sync);
    watcher.observe(host, { childList: true, subtree: true, attributes: true });
    return () => {
      host.removeEventListener('toggle', onToggle, true);
      watcher.disconnect();
    };
  }, [openOps, activeId]);
  /** The A/B scrubber, revealed under the ops strip by the Loop control. */
  const [loopOpen, setLoopOpen] = useState(false);
  const setupDone = hasDisplayBeenSeen();

  /**
   * Escape closes what is open — round 4's F3.
   *
   * The two things that take the floor on this screen both had exactly one exit:
   * a 22 px × in the panel's head. With Advanced open the page is 1,343 px in a
   * 537 px window, and a user who has scrolled to the bottom of it is 557 px
   * below the only way out — no key, no gesture, and nothing on screen that
   * closes anything. The keyboard's universal dismissal costs two lines and
   * works from anywhere on the page, at any scroll position.
   *
   * `keydown` on `window` rather than on the panel: the whole point is that it
   * works when focus is nowhere near the thing being dismissed.
   */
  useEffect(() => {
    if (!openOps && !loopOpen) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (openOps) {
        setOpenOps(false);
        setClosingOps(true);
        setAdvancedOpen(false);
      }
      setLoopOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [openOps, loopOpen]);

  /**
   * Make the deep-linked module the active one — the store is the external
   * system here, which is exactly what an effect is for.
   *
   * Deliberately not a dependency on `activeId`: after this has run the user is
   * free to switch modules, and re-applying the deep link on every render would
   * make that impossible.
   */
  useEffect(() => {
    if (openModule === undefined || openModule === '') return;
    if (getModule(openModule) === null) return;
    runtime.store.commit((s) => withBaseKind(s, openModule));
  }, [openModule, runtime]);

  /**
   * The active module's options chunk, fetched before anybody asks for it (F3).
   *
   * The panel is `lazy()`, so the FIRST time a chip is pressed the opening
   * spring animates against Suspense's "Loading settings…" placeholder — a
   * different height from the real content — and then hard-cuts to the panel
   * when the chunk lands. Measured: 380 ms of animation at the wrong height and
   * a one-frame snap, on the app's most-used gesture, every cold load.
   *
   * The fix is to stop racing. Choosing a module is a decision to look at that
   * module, and its panel is a few kB; fetching it on that decision means the
   * chunk is already in the module cache by the time the chip is pressed again,
   * so the spring animates against the real thing. A failure here is not an
   * error — the `Suspense` boundary is still the one that renders, exactly as
   * before — so this deliberately does not surface anything.
   */
  useEffect(() => {
    prefetchConfigPanel(activeId);
  }, [activeId]);

  /**
   * Whether this window's storage is the one the LCD reads back (A1).
   *
   * The home screen's one bytes-owning object is the live mirror: an iframe of
   * the real display page, which is only the real display page on the surface
   * that shares CAM's origin and storage partition.
   */
  const owns = ownsBytes(runtime);

  const facts = useMirror(readDisplayFacts);
  const tele = useMirror(readTeleMirror);
  const downloads = useMirror(readMirroredDownloads);
  const clips = useMirror(readClipIndex);
  const now = useNow();
  const narrow = useNarrow(PHONE_QUERY);

  const preset = DEVICE_PRESETS[pickMirrorPreset(facts)];

  /**
   * The editor is a DESKTOP/CAM surface this wave (§5, and W6 brings the phone).
   *
   * A coarse pointer under 700 px keeps the composition it has always had —
   * mirror, one action, chips, strip — because the remote is what a phone gets,
   * and shipping half an editor onto a 390 px screen would be worse than
   * shipping none.
   */
  const editorMode = !narrow;

  /**
   * The panel the halo is standing in for, at its own pixel size.
   *
   * `replicaGeometry` rather than a second derivation: the phone's ring already
   * had to answer "what geometry is the panel", and two answers to that question
   * is how a layer ends up 4 px out on one surface and nobody can say which one
   * is lying.
   */
  const haloPanel = useMemo(
    () =>
      replicaGeometry(
        {
          w: preset.width,
          h: preset.height,
          shape: preset.shape,
          targetFps: facts?.targetFps ?? preset.targetFps,
        },
        state.render,
      ),
    [preset, facts?.targetFps, state.render],
  );

  const editor = useEditor({
    runtime,
    panel: { shape: preset.shape },
    render: { safeRadiusPct: state.render.safeRadiusPct },
  });

  /*
    The carousel's timer (§4), on the home screen rather than in the sheet: a
    rotation that stopped when you closed the menu would be no rotation at all.
    It is a no-op on any window that does not own the saved-Looks store.
  */
  useCarousel({ store: runtime.store, owns });

  const [addOpen, setAddOpen] = useState(false);
  /**
   * Which row of the add sheet the press was ASKING for — round 12's F12-2.
   *
   * `+ Add a layer` opens the sheet at the top, which is Content. The rail's
   * `BASE` label opens the same sheet asking a different question — *what is
   * the background* — and the answer to that is the Background row, which is
   * four groups down. A counter for the same reason `reveal` is one: pressing
   * BASE twice must scroll twice.
   */
  const [baseReveal, setBaseReveal] = useState(0);
  const [looksOpen, setLooksOpen] = useState(false);
  /**
   * The inspector (§2.4, M6) — `More`'s destination at editor widths.
   *
   * It is a sheet in the RAIL's column, like the add sheet, rather than the
   * options panel taking the floor: the panel is the right answer on the phone's
   * single-column home, where there is no rail to put anything in, and the wrong
   * one here, where it cost the halo 180 px to show a wall of controls that the
   * strip's five buttons had all been aliases for.
   */
  const [inspectOpen, setInspectOpen] = useState(false);
  /**
   * Which part of the inspector the press was ASKING for — round 11's F-7.
   *
   * The strip's Effect, Preset and Colours are all doors into the kind's own
   * panel (`runStripAction` below), and the inspector opens at the top, which
   * is Layout: five number fields and a sentence about panel pixels. Measured
   * on the effect layer at 866x537, the sheet's body is 365 px tall over
   * 1,651 px of content, so pressing **Effect** showed 0 of the 12 effect tiles
   * and left a person looking at an X/Y readout, with no sign that the thing
   * they asked for was 400 px below the fold.
   *
   * A counter rather than a boolean: pressing **Effect** twice in a row must
   * scroll twice, and a flag that is already `'options'` is a state change React
   * has no reason to act on. `More` — the door with no particular destination —
   * leaves it `null` and the inspector opens where it always did, at the top.
   */
  const [reveal, setReveal] = useState<{ section: 'options'; nonce: number } | null>(null);
  /** Align to the panel, or to the selection's own box (§2.1). */
  const [alignRef, setAlignRef] = useState<AlignRef>('canvas');

  /**
   * The chip row's own edges — the same machinery the selection strip has.
   *
   * See `editor/scrollEdges.ts`: it is measured rather than assumed, so on a
   * row that fits (which is every window this ships with, since F12-2 stopped
   * the short-viewport branch from collapsing the chips into one line) it is
   * `none` and nothing is faded.
   */
  const {
    attach: attachChips,
    clipped: chipsClipped,
    remeasure: remeasureChips,
    onWheel: chipsWheel,
  } = useScrollEdges();

  /** Opening one sheet closes the other two — they share the rail's column. */
  const openSheet = (which: 'add' | 'looks' | 'inspect' | null): void => {
    setAddOpen(which === 'add');
    setLooksOpen(which === 'looks');
    setInspectOpen(which === 'inspect');
  };
  const [lookName, setLookNameState] = useState(readLookName);
  const renameLook = (next: string): void => {
    const trimmed = next.trim();
    writeLookName(trimmed === '' ? null : trimmed);
    setLookNameState(trimmed === '' ? null : trimmed);
  };

  // Not memoized on purpose: both are pure, cheap and derived from state the
  // component already re-renders on, and a manual memo here is exactly the kind
  // the React compiler cannot preserve.
  const videoCfg = validateVideoConfig(state.modules[videoModule.id]?.cfg);
  const clipNames = new Map(clips.map((c) => [c.id, c.name]));

  /**
   * The primary action, in the active module's own noun (R9).
   *
   * `null` means the module has nothing to be given — Clock and Stats — and the
   * row becomes the quiet switch instead of a loud, irrelevant video field.
   *
   * The mapping itself moved to `pasteLink.ts` in round 5 (S1). It was written
   * here, so it existed here and nowhere else, and the phone's identical row
   * spent three waves hard-wired to video — see `pasteAction`'s note.
   */
  const action: PasteAction | null = pasteAction(runtime, activeId, { narrow });

  /**
   * Keep the row holding what the Image module is actually showing.
   *
   * The picture link merged INTO this row, so the row has to behave like the
   * field it replaced: arriving on Image shows the current link, and leaving
   * empties the box rather than carrying a picture URL into the video field.
   */
  const [draftOwner, setDraftOwner] = useState(activeId);
  if (draftOwner !== activeId) {
    setDraftOwner(activeId);
    setDraft(action === null || action.clearOnAccept ? '' : action.value);
    setIssue(null);
  }

  useEffect(() => {
    if (!wantsPaste.current) return;
    wantsPaste.current = false;
    pasteRef.current?.focus();
  }, [activeId]);

  const submit = (): void => {
    if (action === null) return;
    const outcome = action.submit(draft);
    setIssue(outcome.issue);
    /*
      The one place a link's story gets a timestamp on this window (F6).

      A pasted link that starts no download job has no moment recorded anywhere
      — `state.updatedAt` moves for every unrelated commit, so it is not one —
      and a ladder that narrates an event it cannot date is what replayed a
      day-old story on a cold open. This is the event, so this is where it is
      stamped: the committed URL — read back from the store, because the typed
      string is not necessarily the stored one (an `http://` link has already
      been upgraded by `validateUrl`, §7.1) — and when.
    */
    if (outcome.accepted) {
      const committed = validateVideoConfig(
        runtime.store.getSnapshot().modules[videoModule.id]?.cfg,
      ).url;
      setPasted({ url: committed, at: eventTime() });
    }
    if (outcome.accepted && action.clearOnAccept) setDraft('');
  };

  const setVideo = (patch: Partial<VideoModuleConfig>): void => {
    runtime.store.commit((s) =>
      withModuleConfig(s, videoModule.id, videoModule.configVersion, { ...videoCfg, ...patch }),
    );
  };

  const flow =
    activeId === videoModule.id
      ? describeFlow({
          url: videoCfg.url,
          entries: downloads,
          resolverHealthy: resolverHealthyFromTele(tele),
        })
      : null;

  /**
   * What this window knows about the panel — the ONE derivation (round 6).
   *
   * `setupDone` is the latch (`displaySeen.ts`); the telemetry mirror's own
   * timestamp is the freshness. Both were already read on this screen, and both
   * were being interpreted separately by the status line and the download
   * ladder, which is how the two ended up disagreeing with each other about the
   * same panel eighteen pixels apart. One signal, every claim.
   */
  const presence = panelPresence({ everSeen: setupDone, lastSeenAt: tele?.ts ?? null }, now);

  const status = describeStatus({
    activeId,
    tele,
    videoCfg,
    clipNames,
    now,
    downloading: flow?.stage === 'downloading',
    presence,
    // One voice: "Streaming" is claimed only when nothing is being kept — the
    // user asked for stream-only, or the server refused the copy (R5).
    streamingOnly: videoCfg.downloadMode === 'stream-only' || flow?.stage === 'streaming',
  });

  const fresh = tele !== null && now - tele.ts < TELE_FRESH_MS ? tele : null;
  const liveStats = fresh?.stats;
  const durationSec =
    liveStats == null
      ? null
      : liveStats.durationSec !== null && liveStats.durationSec > 0
        ? liveStats.durationSec
        : liveStats.bufferedEnd > 0
          ? liveStats.bufferedEnd
          : null;
  const haloProgress =
    liveStats == null || durationSec === null
      ? null
      : Math.max(0, Math.min(1, liveStats.currentTime / durationSec));

  /**
   * The receipt's own retirement, owned by the screen rather than by the card.
   *
   * It used to live inside `DownloadFlow`, which was the natural place for it
   * right up until round 4 measured what the card costs the composition: the
   * ladder is ~180 px, and the page ran 179–189 px past CAM's fold for as long
   * as it was up — on the flagship paste path, the app's single most common
   * gesture. The halo's floor-yielding rule (below) is what pays for a second
   * object on this screen, and it could not see this one because the fact that
   * the receipt was up was a `useState` two components down.
   *
   * ## Round 7's F6 — a receipt is keyed to STORY time, not to mount time
   *
   * The timer used to start on mount, which made "four seconds old" mean *four
   * seconds since this component rendered*. Reopening CAM on a day-old stored
   * state therefore replayed the entire ladder — "Sent to your Kraken · On
   * screen now" — narrating an event from yesterday as though it had just
   * happened, and taking the floor from the halo for four seconds while it did
   * it, so the first thing a returning user saw was a 64 px thumbnail under a
   * stale narration.
   *
   * A receipt is a claim about a MOMENT, so the moment is what it is measured
   * against, and there are only two kinds of moment here:
   *
   *  - a download job has one — `updatedAt`, the last time the story actually
   *    moved, which is also what makes `downloading → stored` restart the clock
   *    without a `stage` key to hang it on;
   *  - a link that produced no job has none *on disk*, and inventing one would
   *    be the same lie in a new place. What is true is that **this window** was
   *    handed the link: `pasted` is stamped by `submit()` and by nothing else,
   *    so a state committed yesterday, or from a phone, is not narrated here.
   *    It is still on the panel, and the status line under the halo says so.
   */
  const stage = flow?.stage ?? null;
  const [pasted, setPasted] = useState<{ url: string; at: number } | null>(null);
  const storyAt =
    flow?.entry?.updatedAt ?? (pasted !== null && pasted.url === videoCfg.url ? pasted.at : null);
  /**
   * True while the ladder is taking room, whatever stage it is telling.
   *
   * **The floor holds one object.** The receipt, the options panel and the loop
   * scrubber all open into the space the halo gives up, and that space is one
   * halo wide — measured, at CAM's window, the ladder is 148 px and the video
   * options are 201 px and the composition is 537 px including a header, a nav
   * row and a footer. Two of them at once does not fit and never could.
   *
   * So the receipt yields, because of the three it is the only one that is
   * *narration*: the options panel and the scrubber are things the user is
   * doing, and the ladder is the app talking about something it already did.
   * Pressing the chip is moving on. Nothing is lost by it — the status line
   * under the halo carries the live state ("Keeping a copy of dunes.mp4"), the
   * Library carries the progress bar and the retry, and if the story is still
   * running when the panel closes the ladder is still there to come back to.
   */
  const receiptUp =
    stage !== null && receiptIsCurrent(stage, storyAt, now) && !openOps && !loopOpen;

  /**
   * The halo yields the floor when something opens in its place.
   *
   * Round 2 measured the options panel overflowing the CAM window by 426–888 px
   * for every module: the panel opened UNDER a full-height composition, so the
   * thing you had just asked to see was the one thing off the bottom of the
   * screen. The options take the halo's place instead — the mirror cross-fades
   * down to a corner thumb (still the live display page, still ticking) and the
   * vacated ~180 px is what the panel opens into. Closing restores it, on the
   * same spring, both ways.
   *
   * Round 4's F1: the mechanism was written for the two objects that were
   * photographed opening in the halo's place, and the RECEIPT is a third — the
   * same size, in the same slot, produced by the primary action itself. It
   * overflowed CAM's window by 179–189 px on the flagship path and by 11 px more
   * in the error state, for the whole four seconds it was up, because the rule
   * listed its callers rather than asking what was on the screen. Anything that
   * takes the floor gets the floor.
   */
  const compact = openOps || loopOpen || receiptUp;

  /**
   * What the selection strip is about — the selected layer, or the base.
   *
   * The base is the resting selection because the base is what the panel mostly
   * IS: with nothing selected the strip carries the background's own controls,
   * which is exactly what the old branch-based ops strip did, and selecting an
   * overlay swaps the row and changes nothing else on the screen (principle 3).
   */
  /**
   * The keyboard map (§2.1).
   *
   * Undo is the one that has to work from anywhere — it is the promise the whole
   * editor rests on (principle 4) — so the listener is on `window` rather than
   * on the canvas, and it stands down while the caret is in a field, because
   * ⌘Z in a text box means "undo my typing" and always will.
   */
  useEffect(() => {
    if (!editorMode) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 'z') {
        if (typing) return;
        event.preventDefault();
        if (event.shiftKey) editor.redo();
        else editor.undo();
        return;
      }
      if (typing) return;

      /*
       * Escape deselects — round 10's F8.
       *
       * Measured: one layer selected, press Escape, one layer still selected.
       * Every other surface in the product treats Escape as "put that down", and
       * the canvas was the one place it did nothing at all — on the screen where
       * a stray selection is what makes the next arrow press move the wrong
       * thing.
       *
       * It stands down while something is open on top: Escape's first meaning is
       * always "close the thing in front of me", and the handlers for the
       * options panel, the scrubber and the sheets are the ones that own it
       * then. It also stands down in a text field, like every key here.
       */
      if (event.key === 'Escape') {
        if (openOps || loopOpen) return;
        if (addOpen || looksOpen || inspectOpen) {
          setAddOpen(false);
          setLooksOpen(false);
          setInspectOpen(false);
          return;
        }
        if (editor.selection.length === 0) return;
        event.preventDefault();
        editor.select(null);
        return;
      }

      const id = editor.selection[0];
      if (mod && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        editor.selectMany(editor.overlays.map((l) => l.id));
        return;
      }
      if (id === undefined) return;

      if (mod && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        editor.duplicate(id);
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        editor.remove(id);
        return;
      }
      if (event.key === '[' || event.key === ']') {
        const at = state.look.layers.findIndex((l) => l.id === id);
        if (at > 0) editor.move(id, at + (event.key === ']' ? 1 : -1));
        return;
      }
      /*
       * One PANEL pixel, ten with Shift — §2.1, and round 10's M4.
       *
       * It shipped as `0.01` of a unit, which is 3.2 px on a 640 Elite and 1.2
       * on a 240 square: the same press, a different visible distance, and
       * neither of them a pixel. `nudgeStep` converts through the panel's own
       * radius (and not through the halo's on-screen scale — a nudge must move
       * the same distance on the Kraken whatever size the CAM window is).
       */
      const step = nudgeStep(event.shiftKey, haloPanel.radiusPx);
      const nudge: Record<string, { x?: number; y?: number }> = {
        ArrowLeft: { x: -step },
        ArrowRight: { x: step },
        ArrowUp: { y: -step },
        ArrowDown: { y: step },
      };
      const delta = nudge[event.key];
      if (delta === undefined) return;
      const layer = state.look.layers.find((l) => l.id === id);
      if (layer === undefined) return;
      event.preventDefault();
      editor.transform(id, {
        x: layer.t.x + (delta.x ?? 0),
        y: layer.t.y + (delta.y ?? 0),
      });
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [
    editor,
    editorMode,
    state.look,
    haloPanel.radiusPx,
    openOps,
    loopOpen,
    addOpen,
    looksOpen,
    inspectOpen,
  ]);

  const stripLayer = editor.selected ?? editor.layers[0] ?? null;
  const stripModule = stripLayer === null ? null : getModule(stripLayer.kind);
  const stripIsBase = stripLayer !== null && stripLayer.id === BASE_LAYER_ID;
  const stripConfig =
    stripLayer === null || stripModule === null
      ? null
      : stripModule.validate(selectLayerConfig(state, stripLayer));

  /** A config write lands in the layer's ONE home, decided by position (§4.1). */
  const writeStripConfig = (next: unknown): void => {
    if (stripLayer === null || stripModule === null) return;
    if (stripIsBase) {
      runtime.store.commit((sn) =>
        withModuleConfig(sn, stripModule.id, stripModule.configVersion, next),
      );
      return;
    }
    editor.writeConfig(stripLayer.id, stripModule.configVersion, next);
  };

  /**
   * Whether anything on this look is reading invented numbers (F8).
   *
   * `now` rather than `Date.now()` — this is a render, and the page's one
   * sampled clock is what every other freshness question on the screen uses.
   */
  const sampleReadings =
    state.look.layers.some(
      (l) => l.on && getModule(l.kind)?.capabilities.needsMonitoring === true,
    ) &&
    monitoringIsSimulated({ snapshot: decodeMonitorSnapshot(fresh?.mon), at: fresh?.ts ?? 0 }, now);

  const budget = budgetReading({
    look: state.look,
    registry: getModule,
    configOf: (layer) => selectLayerConfig(state, layer),
    presence,
    targetFps: facts?.targetFps ?? null,
    achievedFps: fresh?.achievedFps ?? null,
  });

  /**
   * The strip's own actions.
   *
   * Every one of them opens something that already exists on this screen: the
   * primary action's field, the A/B scrubber, the module's options panel. The
   * strip does not grow a second copy of anything.
   */
  const runStripAction = (
    action: 'source' | 'loop' | 'colours' | 'preset' | 'effect' | 'quality',
  ): void => {
    if (action === 'loop') {
      setLoopOpen((open) => !open);
      return;
    }
    if (action === 'source') {
      pasteRef.current?.focus();
      return;
    }
    /*
     * Colours, presets, the effect catalog and the quality ladder all need data
     * a manifest may not carry, and all of it is in the kind's own panel.
     *
     * At editor widths that panel lives in the INSPECTOR (§2.4, M6) rather than
     * in the floor-yielding options panel — which is why Effect's "Effect" and
     * "Preset" both landing on the same 621 px wall stopped being four buttons
     * pretending to be four buttons. On the phone's single-column home there is
     * no rail to open a sheet in, so it is the panel exactly as before.
     */
    if (editorMode) {
      setReveal((prev) => ({ section: 'options', nonce: (prev?.nonce ?? 0) + 1 }));
      openSheet('inspect');
      return;
    }
    showOps(true);
  };

  /**
   * The group operations, committed as ONE entry each (§2.1, F7).
   *
   * `arrange.ts` decides what moves and by how much; `transformMany` writes it.
   * Nothing here does geometry, and nothing here writes a layer.
   */
  const runAlign = (edge: AlignEdge): void => {
    editor.transformMany(
      alignPatches({ look: state.look, ids: editor.selection, panel: haloPanel }, edge, alignRef),
    );
  };
  const runDistribute = (axis: 'x' | 'y'): void => {
    editor.transformMany(
      distributePatches({ look: state.look, ids: editor.selection, panel: haloPanel }, axis),
    );
  };

  /**
   * The three blocks the editor RE-HOMES rather than rebuilds.
   *
   * The chip row, the primary action and the nav row exist once, with the same
   * ids and the same behaviour they have always had; at editor widths the rail
   * hosts them in its column, and at phone widths they stay in the flow. Two
   * copies of the chips would be two rows that can disagree, which is the
   * duplication the whole strip contract exists to end.
   */
  /**
   * The chip row is the BASE picker, so it offers exactly the backgrounds —
   * round 11's M-a.
   *
   * It used to be `listModules()`: nine chips in registry order, including
   * Text, Icon and Date, whose manifests declare `roles: ['overlay']` and
   * therefore cannot be a background at all. Pressing one asked
   * `withBaseKind()` for something the model does not describe. Meanwhile the
   * add sheet's BACKGROUND row — the OTHER base picker, one press away in the
   * same column — was already derived from `roles` and offered a seventh entry
   * this row did not have (Solid colour). Two pickers for one question,
   * disagreeing in both directions.
   *
   * `basePicker.ts` is the one derivation now; the sheet reads it too.
   */
  const baseKinds = baseCapableKinds(modules);
  const chipRow = (
    <div
      ref={attachChips}
      className="kh-mods"
      role="group"
      aria-label="What's on the screen"
      data-testid="mods-row"
      /*
        The row is a WRAPPED block at every size the editor runs at — round
        12's F12-2 measured what the alternative cost. At CAM's 866x537 the
        short-viewport branch used to turn it into a one-line hidden-scrollbar
        scroller: 231 px of box against 417 px of chips, no fade, and a mouse
        wheel that left `scrollLeft` at 0, so three of the seven backgrounds
        were simply unreachable with a mouse.

        The measured `data-clipped` and the wheel mapping stay wired anyway,
        because "does this row fit" is a question about a box and a window and
        not about which stylesheet branch is live: a narrower rail, a longer
        module name or a fork with a tenth base kind puts the row back into
        overflow, and when it does the fade and the wheel are already there. On
        a row that fits, `clipped` is `none` and both are inert.
      */
      data-clipped={chipsClipped}
      onScroll={remeasureChips}
      onWheel={chipsWheel}
    >
      {baseKinds.map((m) => {
        const active = m.id === activeId;
        return (
          <button
            key={m.id}
            type="button"
            className="kh-mod"
            aria-pressed={active}
            // Only the ACTIVE chip is a disclosure. An inactive chip switches
            // modules and nothing else, and claiming otherwise in the
            // accessibility tree would promise a panel that does not open.
            aria-expanded={active ? openOps : undefined}
            aria-controls={active ? 'kh-ops-panel' : undefined}
            data-testid={`module-chip-${m.id}`}
            onClick={() => {
              if (active) {
                showOps(!openOps);
                return;
              }
              /*
                §7's third transition: the base cross-fades, it does not cut.

                The SAME mechanism a Look switch uses (`crossFade.ts`), reached
                by class rather than rebuilt here — the audit's F9 found
                `document.getAnimations()` empty after a base switch, and the
                fix for that is one more caller of the animation that already
                exists, not a second way to fade the same element.
              */
              crossFadeLookSwitch();
              runtime.store.commit((sn) => withBaseKind(sn, m.id));
              editor.select(BASE_LAYER_ID);
              showOps(false);
              setLoopOpen(false);
            }}
          >
            {m.chipName ?? m.name}
          </button>
        );
      })}

      {/*
        Solid colour — the add sheet's seventh background, here too (M-a).

        It is the shape kind wearing `SOLID_BASE_CFG` rather than a kind of its
        own (§10), which is why its id is `base-chip-solid` and not
        `module-chip-…`: `module-chip-<id>` names a MODULE, and two suites
        enumerate that prefix and open each chip's options by it. A chip whose
        id promised a module called "solid" would have sent them looking for a
        panel that does not exist.
      */}
      {hasSolidBase(modules) && (
        <button
          type="button"
          className="kh-mod"
          data-testid="base-chip-solid"
          onClick={() => {
            crossFadeLookSwitch();
            runtime.store.commit((sn) =>
              withModuleConfig(
                withBaseKind(sn, SOLID_BASE_KIND),
                SOLID_BASE_KIND,
                getModule(SOLID_BASE_KIND)?.configVersion ?? 1,
                SOLID_BASE_CFG,
              ),
            );
            editor.select(BASE_LAYER_ID);
            showOps(false);
            setLoopOpen(false);
          }}
        >
          Solid
        </button>
      )}
    </div>
  );

  const pasteRow = (
    <>
      {action === null ? (
        /*
      Clock and Stats have nothing to be handed. The row used to shout
      "Paste a video link" at them anyway — the most prominent control in
      the product, asking for something the screen in front of you cannot
      use (R9). It is one quiet sentence that changes the subject instead.
    */
        <p className="kh-paste kh-paste--quiet">
          <button
            type="button"
            className="kh-quiet"
            data-testid="paste-switch"
            onClick={() => {
              runtime.store.commit((s) => withBaseKind(s, videoModule.id));
              showOps(false);
              setLoopOpen(false);
              wantsPaste.current = true;
            }}
          >
            Play something
          </button>
        </p>
      ) : (
        <form
          className="kh-paste"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            ref={pasteRef}
            className="kh-paste__input"
            type="text"
            value={draft}
            data-testid="paste-input"
            /*
          The spine's fingerprint — round 6's C1.

          Every url-accepting field in the product carries the module it is
          currently the field FOR, put there by `pasteAction` and by nothing
          else. `tests/e2e/paste-spine.spec.ts` walks every route and state,
          finds the fields by role, and fails on one that has no such
          attribute — so a link field added later cannot quietly reintroduce
          the hard-wiring `RemoteAdd` and `LibraryView` shipped with.
        */
            data-paste-field={action.moduleId}
            aria-label={action.label}
            placeholder={action.placeholder}
            onChange={(e) => {
              setDraft(e.target.value);
              setIssue(null);
            }}
          />
          <button type="submit" className="kh-btn kh-btn--primary" data-testid="paste-submit">
            {action.submitLabel}
          </button>
        </form>
      )}
    </>
  );

  const navRow = (
    <nav className="kh-more" aria-label="More">
      <a href="#/remote" data-testid="disclosure-remote">
        Remote
      </a>
      <span aria-hidden="true">·</span>
      {/*
      Two destinations, still — and the shelf's ONE name (A5).

      The door stays on every surface, because the Library is a property of
      the Kraken rather than of the window: hiding it would be the app
      telling a phone it has no library, which is the impression this wave
      exists to remove. What changed is on the other side of it — a window
      that owns no bytes and is paired to no Kraken has nothing to show, so
      `ConfigApp` lands that case on pairing instead of drawing an empty
      grid and calling it yours.
    */}
      <a href="#/library" data-testid="disclosure-library">
        {LIBRARY_NOUN}
      </a>
    </nav>
  );

  /**
   * A selection of several layers is a different subject (F7).
   *
   * The strip went on showing the BASE's controls while four rail rows were
   * marked, which is the app answering a question nobody asked. Two or more
   * selected layers get the group row instead: six alignments, what to align
   * them to, and distribute.
   */
  const multiSelected = editor.selection.filter((id) => id !== BASE_LAYER_ID);

  const selectionStrip =
    editorMode && multiSelected.length >= 2 ? (
      <ArrangeStrip
        count={multiSelected.length}
        reference={alignRef}
        onReference={setAlignRef}
        onAlign={runAlign}
        onDistribute={runDistribute}
        canDistribute={multiSelected.length >= 3}
      />
    ) : stripLayer === null || stripModule?.editor === undefined ? null : (
      <SelectionStrip
        layer={stripLayer}
        config={stripConfig}
        loopOpen={loopOpen}
        onConfig={writeStripConfig}
        onTransform={(patch) => {
          editor.transform(stripLayer.id, patch);
        }}
        onResize={(factor) => {
          editor.commitLook(resizeLayer(state.look, stripLayer.id, factor, editor.registry));
        }}
        onAction={runStripAction}
        onMore={() => {
          if (editorMode) {
            setReveal(null);
            openSheet('inspect');
          } else {
            showOps(true);
          }
        }}
      />
    );

  return (
    <section
      className="kh-home"
      data-testid="home"
      data-compact={compact ? 'true' : 'false'}
      /*
        Which promise the page is making right now (F1/F2).

        `false` — the whole composition, halo to footer, fits CAM's 866x537
        window with nothing clipped and nothing scrolled. `true` — Advanced is
        open, and the page is a full-height flow that scrolls, on purpose,
        visibly. The suite asserts both, per module, rather than measuring the
        panel and calling it the page.
      */
      data-advanced={advancedOpen ? 'true' : 'false'}
      /*
        The install band is a second object competing for the same 537 px.

        It is one line and one action, but at CAM's window the halo above it is
        178 px and the composition ran 63 px past the fold with the nav row in
        the overflow — the first screen a user ever sees, cut off. The halo
        gives up a little of its size for as long as the band is there, the same
        trade it makes for the options panel, and takes it back for good the
        moment a display has published anything (`displaySeen.ts`).
      */
      data-firstrun={setupDone ? 'false' : 'true'}
      /*
        Which composition this is.

        `true` — the two-column editor: the halo as the canvas on the left, the
        layer rail on the right, no tabs. `false` — the single-column screen a
        phone still gets, because the remote is what a phone is for and half an
        editor on 390 px would be worse than none (§5). The stylesheet reads
        this, and so does `tests/e2e/editor.spec.ts`.
      */
      data-editor={editorMode ? 'true' : 'false'}
    >
      {/*
        The editor's header (§2): the Look's name, undo/redo, the budget meter.
        No tabs, and never more than one row — the composition below it is
        promised to fit CAM's 537 px window and this is the first thing that
        would eat it.
      */}
      {editorMode && (
        <EditorHeader
          name={lookName}
          onRename={renameLook}
          onOpenLooks={() => {
            openSheet(looksOpen ? null : 'looks');
          }}
          budget={budget}
          canUndo={editor.canUndo}
          canRedo={editor.canRedo}
          onUndo={editor.undo}
          onRedo={editor.redo}
        />
      )}

      {isLowFps(facts) && (
        <div
          className="kh-fps-banner"
          role="status"
          data-testid="fps-banner"
          /*
            Round 12's F12-1, on the config side.

            The banner's second half is an INSTRUCTION — *drag CAM → … → Frame
            Rate to maximum* — and on a Kraken Z the slider's maximum IS 1 FPS
            (`devicePresets.ts`: the ceiling is a property of the panel, which
            is why round 3 stopped hardcoding "40 on Elite"). So on that panel
            the app was telling a person to go and do a thing that was already
            done, in the one place they had gone looking for a remedy.

            The reading itself stays in every case — 1 FPS is still why the
            video looks like a slideshow, and that is worth knowing about a
            panel whose ceiling is 1 — and only the instruction is gated, on the
            measured maximum for the panel that actually reported.
          */
          data-capped={fpsIsAtPanelMax(facts) ? 'true' : 'false'}
        >
          {/*
            The reading is persisted; the tense is not — round 8's D.

            `readDisplayFacts()` reads `localStorage`, so this banner survives the
            session that observed the frame rate: a window opened a week later
            said "Your Kraken **is running at** 1 FPS" on its first paint, from a
            record, with nothing on the other end. The number stays in every
            tense — it is the last thing the panel reported, and the CAM setting
            named after it is the remedy either way — and only the verb is tensed.
          */}
          <PanelClaim claim={CLAIM_FRAME_RATE} presence={presence} />{' '}
          <b>{String(facts?.targetFps ?? 0)} FPS</b>, so anything that moves looks like a slideshow.{' '}
          {fpsIsAtPanelMax(facts) ? (
            <PanelClaim claim={CLAIM_FRAME_RATE_AT_MAX} presence={presence} />
          ) : (
            <>
              {CAM_FRAME_RATE_LEAD_SENTENCE} <b>{CAM_PATH_FRAME_RATE}</b> {CAM_FRAME_RATE_TAIL}.
            </>
          )}
        </div>
      )}

      {/*
        The mirror and the sentence about it are one object, so that when the
        options take the floor they travel together: the halo shrinks to a thumb
        and the line steps alongside it rather than being orphaned under a
        64 px circle.
      */}
      <div className="kh-home__mirror" data-mirror-preset={preset.id}>
        {editorMode ? (
          /*
            Principle 1: the canvas IS the halo.

            A real `LayerHost` at halo size, running the real renderers through
            the preview registry — the same compositor and the same `layerBox`
            maths the LCD uses, so what you drag is what the panel shows. The
            iframe mirror below is what a PHONE still gets: it is one document
            for one module, which is exactly what the remote surface is for.
          */
          <EditorCanvas
            editor={editor}
            state={state}
            panel={haloPanel}
            monitor={decodeMonitorSnapshot(fresh?.mon)}
            monitorAt={fresh?.ts ?? 0}
            progress={haloProgress}
            coarsePointer={narrow}
          />
        ) : (
          <div
            className={preset.shape === 'circle' ? 'kh-halo' : 'kh-halo kh-halo--square'}
            data-testid="mirror"
            data-mirror-preset={preset.id}
            data-mirror-mode={activeId === videoModule.id || !owns ? 'surface' : 'live'}
          >
            <div className="kh-halo__lcd">
              {activeId === videoModule.id || !owns ? (
                /*
                The mirror is an iframe of the REAL display page, and that is
                only honest on the window that owns the storage (A1).

                On CAM's Configuration Browser it boots the same document the
                LCD boots, on the same origin, sharing the same IndexedDB — so
                what it shows IS what the panel shows. In any other browser it
                would boot a SECOND display: a second decoder and a second
                download, on a battery, reading a database with nothing in it
                and rendering a confident picture of a Kraken it has never seen.
                A remote surface gets the same named card the video path already
                uses, and the ring on `#/remote` is where a live replica lives.
              */
                <VideoHalo
                  url={activeId === videoModule.id ? videoCfg.url : ''}
                  name={status.name}
                  progress={haloProgress}
                  held={liveStats?.held === true}
                  compact={compact}
                />
              ) : (
                <iframe
                  className="kh-halo__frame"
                  title={`Your Kraken — live mirror (${preset.label})`}
                  src={`./?kraken=1&sim=${preset.id}`}
                  style={
                    {
                      '--kh-mirror-w': preset.width,
                      '--kh-mirror-h': preset.height,
                    } as CSSProperties
                  }
                />
              )}
            </div>
          </div>
        )}

        <p className="kh-status" data-testid="status-line">
          {status.live && <span className="kh-status__live" aria-hidden="true" />}
          <span>
            {status.verb} <b>{status.name}</b>
            {status.detail !== null && (
              <>
                {' · '}
                <span className="kh-tnum">{status.detail}</span>
              </>
            )}
          </span>
        </p>
      </div>

      {/*
        The numbers in the halo are the simulator's, and it says so (F8).

        The editor mounts the real stats renderer against `previewMonitoring`,
        which falls back to `platform/simulator.ts` when nothing is publishing —
        the right call, because an empty gauge teaches nobody anything about the
        face they are arranging. It was made in silence: the halo read
        `41 °C · CPU · 16 % load` on a window that had never heard from a Kraken,
        and a cooler app showing a made-up temperature without saying so is the
        worst thing it can do.

        Two conditions, and both are necessary: the source has to be simulated
        (`monitoringIsSimulated`, the same test the source's own `isSimulated()`
        runs), and the look has to contain a layer that reads it —
        `capabilities.needsMonitoring`, off the manifest, so a kind added later
        is covered without an edit here.

        A SIBLING of the mirror rather than a child of it: `ui.css` parks it in
        the canvas column's own corner with `grid-area`, which costs the halo no
        height, and making the mirror a positioned ancestor instead would have
        re-parented the status line — which is absolutely positioned too — out of
        the rail's column and onto the selection strip.
      */}
      {editorMode && sampleReadings && (
        <PanelClaim
          claim={CLAIM_SAMPLE_READINGS}
          presence={presence}
          as="p"
          className="kh-samplenote"
          testId="sample-readings"
        />
      )}

      {/*
        First run, and only first run — BELOW the halo.

        Until something the DISPLAY published has been seen on this origin, this
        band is the most important thing on the page. It used to be a full card
        pinned above the halo, and at CAM's real 866×537 window that meant the
        first thing a user ever saw of kraken-hub was a page of instructions with
        the entire product below the fold (design audit, F7). Halo first, always:
        the band is one line and one primary action, and it never displaces the
        object. Afterwards it lives under `#/about` ("Add to CAM") and never
        appears here again — see `displaySeen.ts` for why the trigger is evidence
        rather than a dismiss button.
      */}
      {!setupDone && (
        <CamSetupCard runtime={runtime} variant="first-run" presence={presence} dense={compact} />
      )}

      {/*
        …and three Looks to press — §4, and round 11's M-h.

        The band above is an errand: point CAM at this address. It is the right
        thing to say first and it is the only thing a cold profile said at all,
        so the first screen of the product was an instruction with no product
        under it — measured on a cold profile at 866x537, `look-template-*`
        appeared nowhere in the DOM. §4 asks for template cards on first run and
        they were never built; `FirstRunTemplates` is them, using the same
        `LookPreview` and the same apply path the Looks sheet uses.

        It is a SIBLING of the setup card here and a column beside the halo on
        screen: `ui.css` moves it into the canvas column's left gutter, which is
        the width a square halo leaves over in a column that is not square — so
        it costs the canvas row nothing, and the halo on a cold profile is the
        320 px it is with no band at all rather than the 199 the first version
        of this band left it at. Where the gutter closes (a narrow window, or a
        tall one where the halo outgrows the column) the same markup falls back
        to a compact row under the card.

        Editor widths only, and only while the options panel is not taking the
        floor: on a phone the remote is the screen (§5), and with a panel open
        the band is already down to one clause and one button (`dense`).
      */}
      {editorMode && !setupDone && !compact && (
        <FirstRunTemplates
          editor={editor}
          state={state}
          panel={haloPanel}
          monitor={decodeMonitorSnapshot(fresh?.mon)}
          monitorAt={fresh?.ts ?? 0}
          onRename={renameLook}
        />
      )}

      {!editorMode && pasteRow}

      {issue !== null && (
        <div className="kh-home__notice">
          <Notice tone={issue.severity === 'error' ? 'error' : 'warn'}>{issue.message}</Notice>
        </div>
      )}

      {flow !== null && (
        <DownloadFlow flow={flow} url={videoCfg.url} gone={!receiptUp} presence={presence} />
      )}

      {/*
        The rail (§2.2) — the stack, and the column the chip row, the primary
        action and the nav live in at editor widths. It renders only there: a
        phone gets the remote, not half an editor (§5).
      */}
      {editorMode && (
        <LayerRail
          editor={editor}
          heaviestId={budget.worstId}
          onAdd={() => {
            // `+ Add a layer` asks the sheet's own question, so it opens at the
            // top: the reveal is reset rather than left where BASE put it.
            setBaseReveal(0);
            openSheet('add');
          }}
          /*
            `BASE` is a disclosure now — round 12's F12-2.

            It selected the base and opened nothing, which left the chip row as
            the ONLY way to change the background: seven chips in a rail column
            that is 231 px wide. The label is the question ("what is behind
            everything?") and the add sheet's Background row is the answer with
            all seven as tiles, so pressing it opens that row rather than
            leaving a person to find it four groups down a sheet they reached
            through a button called *Add a layer*.

            It still selects the base, because it always did and because that
            is what puts the base's own controls on the strip.
          */
          baseOpen={addOpen}
          onOpenBase={() => {
            editor.select(BASE_LAYER_ID);
            openSheet(addOpen ? null : 'add');
            setBaseReveal((n) => n + 1);
          }}
          baseRow={chipRow}
          footer={
            <>
              {pasteRow}
              {navRow}
            </>
          }
        />
      )}

      {!editorMode && chipRow}

      {/*
        The strip is DECLARED now, not branched.

        `SelectionStrip` renders `KrakenModule.editor.strip` for whichever layer
        is selected — the base by default. The old `OpsStrip` was a chain of
        `if (activeId === …)` cases that knew four modules by name, so the three
        that shipped after it had no strip at all. The `data-testid`s are
        unchanged on purpose (`ops-fill`, `ops-face`, `ops-format`,
        `ops-seconds`, `ops-loop-button`): a redesign that renamed them would be
        a redesign that hid whether it had changed behaviour.
      */}
      <div className="kh-ops" data-testid="ops-strip" data-strip-kind={stripLayer?.kind ?? ''}>
        {selectionStrip}
      </div>

      {activeId === videoModule.id && loopOpen && (
        <div className="kh-home__loop" id="ops-loop-panel" data-testid="ops-loop-panel">
          <LoopScrubber
            idPrefix="home"
            max={durationSec ?? LOOP_MAX_SEC}
            durationKnown={durationSec !== null && durationSec > 0}
            positionSec={Math.min(liveStats?.currentTime ?? 0, durationSec ?? LOOP_MAX_SEC)}
            loop={videoCfg.loop}
            onLoopChange={(loop) => {
              setVideo({ loop });
            }}
          />
        </div>
      )}

      {(openOps || closingOps) && (
        <div
          ref={panelRef}
          className={closingOps ? 'kh-disclosure kh-disclosure--closing' : 'kh-disclosure'}
          id="kh-ops-panel"
          data-testid="ops-panel"
          // A panel on its way out is scenery: it must not take a click or a
          // tab stop away from whatever the user pressed to dismiss it.
          {...(closingOps ? { inert: true } : {})}
        >
          <div className="kh-disclosure__head">
            {/*
              The module's name, not the word "Options".

              The panel underneath used to print it again as its own heading, one
              line lower — "Options" over "Video" — and a heading that says the
              same thing as the heading above it is 30 px this composition does
              not have. The head names what you opened; the panel gets on with it.
            */}
            <h2>{activeModuleName(activeId)}</h2>
            <button
              type="button"
              className="kh-iconbtn"
              data-testid="ops-close"
              aria-label="Close options"
              onClick={() => {
                showOps(false);
              }}
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
          <ModuleSettingsView runtime={runtime} id={activeId} />
        </div>
      )}

      {/*
        Exactly two destinations (F7).

        Diagnostics was the third, and it was never a destination — it was an
        errand, and the same errand as About, which lived in a *different row* in
        a *different type style*. Both are one page now, reached by clicking the
        version line in the footer: the exact string a bug report asks you to
        quote is the thing you press to get the report.
      */}
      {!editorMode && navRow}

      {/*
        The Looks sheet (§4). Mutually exclusive with the add sheet — they share
        the same grid area, and two sheets stacked is the composition running
        past CAM's fold, which is the one thing this screen promises not to do.
      */}
      {editorMode && looksOpen && (
        <LooksSheet
          editor={editor}
          state={state}
          panel={haloPanel}
          monitor={decodeMonitorSnapshot(fresh?.mon)}
          monitorAt={fresh?.ts ?? 0}
          name={lookName}
          onRename={renameLook}
          owns={owns}
          presence={presence}
          onCarousel={(next) => {
            runtime.store.commit((s2) => {
              if (next === undefined) {
                const { carousel: _dropped, ...rest } = s2;
                return rest;
              }
              return { ...s2, carousel: next };
            });
          }}
          onClose={() => {
            setLooksOpen(false);
          }}
        />
      )}

      {editorMode && addOpen && (
        <AddSheet
          modules={editor.modules}
          canAdd={editor.layers.length < MAX_LAYERS}
          /*
            Non-zero only when the sheet was opened by the rail's BASE label,
            and a new number every time it is pressed — the same nonce shape
            `reveal` uses for the inspector, for the same reason.
          */
          revealBase={baseReveal}
          onAdd={(kind, cfg) => {
            editor.add(kind, cfg);
            setAddOpen(false);
          }}
          onBase={(kind, cfg) => {
            crossFadeLookSwitch();
            runtime.store.commit((sn) => {
              const based = withBaseKind(sn, kind);
              return cfg === undefined
                ? based
                : withModuleConfig(based, kind, getModule(kind)?.configVersion ?? 1, cfg);
            });
            editor.select(BASE_LAYER_ID);
            setAddOpen(false);
          }}
          onClose={() => {
            setAddOpen(false);
          }}
        />
      )}

      {/*
        The inspector (§2.4) — everything about the selected layer, in the
        rail's own column, with its body the thing that scrolls.
      */}
      {editorMode && inspectOpen && stripLayer !== null && (
        <InspectorSheet
          editor={editor}
          layer={stripLayer}
          module={stripModule}
          config={stripConfig}
          panel={haloPanel}
          reveal={reveal}
          onConfig={writeStripConfig}
          onClose={() => {
            setInspectOpen(false);
          }}
        />
      )}

      {editor.refusal !== null && (
        <div className="kh-home__notice" data-testid="editor-refusal">
          <Notice tone="warn">{editor.refusal}</Notice>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The ops strip — controls, not links
// ---------------------------------------------------------------------------

/*
 * `OpsStrip` used to live here, and it is worth saying what replaced it.
 *
 * It was a chain of `if (activeId === 'video')` / `'clock'` / `'stats'` /
 * `'image'` branches, one per module, each hand-writing that module's three
 * controls. It shipped before text, shape and effect existed — and those three
 * therefore had NO strip at all, because a view cannot grow a case for a module
 * that was not written yet, and nothing in the contract said it had to.
 *
 * The strip is DATA now: `KrakenModule.editor.strip`, ≤ 5 controls with `More`
 * last, enumerated over every registered kind by `registry.test.ts`, and
 * rendered generically by `views/editor/SelectionStrip.tsx`. Nothing in this
 * file knows a module's name any more, and a kind added next year arrives with
 * its own strip.
 */

/**
 * The download story, told in plain words (prototype screen 2).
 *
 * Driven by the real `kraken-hub:v1:video:downloads` mirror, which the DISPLAY
 * writes while it fetches: CAM's two browsers share a storage partition, so
 * this window watches a download running in the other one with zero network.
 *
 * **What this component is not allowed to do**, and got wrong twice:
 *
 *  1. Treat a download that did not happen as a video that did not play (see
 *     `homeState.FlowStage`). Every terminal state here is an *outcome* — kept
 *     locally, streaming instead, playing through YouTube — and the only red
 *     card in the product stays where it belongs, on the display, for a link
 *     that genuinely cannot be played.
 *  2. Answer a success with a sales pitch. The audit found the first thing that
 *     ever works — a YouTube link, playing — met by an apology and a primary
 *     teal `Get the downloader` button. The downloader is a real differentiator
 *     and it is still one tap away, in the module's Advanced options and in the
 *     Library, but it is not what "it worked" looks like.
 *
 * Which entry the story is about is decided by `describeFlow`, keyed on the URL
 * that is configured RIGHT NOW. The mirror is a ring nobody prunes, so a job
 * from a link three pastes ago is not this link's story.
 */
function DownloadFlow({
  flow,
  url,
  gone,
  presence,
}: {
  flow: FlowState;
  url: string;
  gone: boolean;
  /** What the app is allowed to claim about the panel — round 6's C2. */
  presence: PanelPresence;
}) {
  const { stage, entry } = flow;
  const pct = entry === null ? null : progressPct(entry);
  // Everything except an in-flight download is finished business: the video is
  // on the panel, whatever happened to the copy.
  const settled = stage !== 'downloading';

  /*
   * `gone` is decided by `HomeView` (round 4, F1).
   *
   * The retirement timer used to live here, which hid the one fact the
   * composition needed: whether this card is taking 180 px of a 537 px window
   * right now. The halo yields the floor to it, so the screen has to know. The
   * node still stays in the DOM once collapsed and simply stops taking space —
   * the stage is readable to anything that asks, and hiding is a thing CSS can
   * cross-fade where an unmount is a hard cut.
   */
  const subLine = receiptSubLine(
    detectedHeadline(entry?.sourceUrl ?? url),
    entry?.name ?? sourceLabel(url),
  );

  return (
    <ol
      className={gone ? 'kh-flow kh-flow--gone' : 'kh-flow'}
      data-testid="paste-flow"
      data-flow-stage={stage}
      data-collapsed={gone ? 'true' : 'false'}
      aria-hidden={gone ? true : undefined}
    >
      <li className="kh-step kh-step--on">
        <span className="kh-step__ic" aria-hidden="true">
          ▶
        </span>
        <span className="kh-step__text">
          <b>{detectedHeadline(entry?.sourceUrl ?? url)}</b>
          {/*
            The sub-line is dropped when it merely restates the headline
            (round 4, minors).

            "YouTube video detected" over "a YouTube video" is one fact set
            twice, in two type sizes, on the app's most common path — and the
            second line is 18 px of a 537 px window. It earns its place when it
            names something the headline does not: a filename, a host.
          */}
          {subLine !== null && <small>{subLine}</small>}
        </span>
      </li>

      {stage === 'youtube-embed' ? (
        /*
          One transition, and no source properties (F4).

          The second line here used to read "Ads and all, the way YouTube sends
          it" — which is not something that just happened, it is what a YouTube
          link permanently IS. It lives in the video module's own options now,
          next to the control that answers it, and this card narrates the
          transition and then gets out of the way like every other steady state.
        */
        <li className="kh-step kh-step--on" data-testid="paste-step-downloader">
          <span className="kh-step__ic" aria-hidden="true">
            ▸
          </span>
          <span className="kh-step__text">
            {/*
              Round 7's F2. This was `<b>Playing through YouTube</b>` — flat, in
              the present progressive, on every window, including a first-run one
              whose NEXT card was at that same moment correctly refusing to claim
              a screen. The claim is a type now: there is no way to render it
              without handing over what this window knows.
            */}
            <PanelClaim claim={CLAIM_YOUTUBE_EMBED} presence={presence} as="b" />
          </span>
        </li>
      ) : (
        <li
          className={
            stage === 'downloading' && entry?.state === 'queued' ? 'kh-step' : 'kh-step kh-step--on'
          }
        >
          <span className="kh-step__ic" aria-hidden="true">
            ↓
          </span>
          <span className="kh-step__text">
            <b>{secondHeadline(stage, presence)}</b>
            {/*
              …and the other half of round 7's F2.

              "so your Kraken is playing it straight from the web" was the same
              unasked present-tense claim, in a sub-line, and `failureLine`'s
              four sentences ended in a third copy of it. All three go through
              `panelClaims` now; the CORS fact and the disk fact are unchanged in
              every tense, because those are facts about a server and a disk.
            */}
            <small>
              {stage === 'streaming'
                ? panelClaimText(CLAIM_STREAMING_NO_COPY, presence)
                : stage === 'accepted'
                  ? panelClaimText(CLAIM_HANDOFF_PICKUP, presence)
                  : stage === 'unsaved'
                    ? failureLine(entry, presence)
                    : entry === null
                      ? ''
                      : downloadingLine(entry, pct)}
            </small>
            {(stage === 'downloading' || stage === 'stored') && <Meter pct={pct} />}
          </span>
        </li>
      )}

      {/*
        The last card asks before it claims a screen — round 6's C2.

        It said "On screen now — Playing on your Kraken" the instant the story
        settled, including on a first-run window where nothing had ever
        published anything, directly above the band explaining how to install
        CAM. The page was simultaneously telling the user their video was
        playing and telling them their Kraken was not connected yet.

        `settledReceipt` is the whole rule, and it is the same rule the status
        line six pixels away consumes. The `stored` sub-line survives as the
        one exception that is a fact about the COPY rather than about the panel:
        the bytes really did land, whether or not anybody has seen the LCD.
      */}
      <li className={settled ? 'kh-step kh-step--on' : 'kh-step'} data-presence={presence}>
        <span className="kh-step__ic" aria-hidden="true">
          ✓
        </span>
        <span className="kh-step__text">
          <b>{settledReceipt(presence).headline}</b>
          <small>
            {stage === 'stored'
              ? // One destination phrase, app-wide — `config/vocabulary.ts` (F7).
                `${KEPT_A_COPY.charAt(0).toUpperCase()}${KEPT_A_COPY.slice(1)}`
              : settledReceipt(presence).sub}
          </small>
        </span>
      </li>
    </ol>
  );
}

/**
 * One story, one vocabulary (R5).
 *
 * "Saving to your Kraken" was a third word for the thing the ops strip called
 * "Keeping a copy" and the status line called "Streaming", all on one screen.
 * The ladder says the same words the status line says, in the same order:
 * *keeping a copy of it*, then *playing it*.
 */
function secondHeadline(stage: FlowState['stage'], presence: PanelPresence): string {
  if (stage === 'stored' || stage === 'downloading') return KEEPING_A_COPY;
  // "Sent to your Kraken" names a hand-off, and a hand-off needs somebody to
  // hand it TO. `handoffHeadline` is the same question the card below asks.
  if (stage === 'accepted') return handoffHeadline(presence);
  return panelClaimText(CLAIM_STREAMING_HEADLINE, presence);
}

/** The first step's second line before any job exists to name the file. */
function sourceLabel(url: string): string {
  return sourceName(url, new Map());
}

/**
 * "YouTube video detected", the way the prototype writes it.
 *
 * The prototype's first step NAMES what it found, because the whole point of
 * the flow is that detection is legible: a user who pasted a YouTube link wants
 * to see the app agree that it was one. It is not provider jargon — nobody is
 * shown "adapter" or "resolver", only the name of the site they came from.
 * Anything we cannot name confidently falls back to the neutral line rather than
 * guessing at a brand.
 */
function detectedHeadline(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'Video link detected';
  }
  if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com')) {
    return 'YouTube video detected';
  }
  if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) return 'Vimeo video detected';
  return 'Video link detected';
}

/**
 * The download line, with the number folded into the sentence.
 *
 * Before the first byte lands there is no percentage to report, so the line is
 * the pitch — what keeping a copy BUYS you. Once the bar is moving the sentence
 * becomes the progress, and when it is finished it becomes the receipt, exactly
 * the three phrasings the prototype's demo cycles through. A server that sent no
 * `Content-Length` leaves `pct` null; the pitch stands in, because "—%" is worse
 * than a sentence.
 */
function downloadingLine(entry: DownloadEntry, pct: number | null): string {
  const pitch = LOCAL_COPY_PITCH;
  if (entry.state === 'queued') return pitch;
  if (entry.state === 'done') return `${formatBytes(entry.receivedBytes)} · ${KEPT_A_COPY}`;
  /*
   * No `Content-Length`, so there is no percentage — and the bar beside this
   * line is indeterminate for the same reason (round 5, S3). What IS known is
   * how much has landed, so the sentence says that rather than repeating the
   * pitch at a user who can see the bytes moving.
   */
  if (pct === null) {
    return entry.receivedBytes > 0
      ? `Downloading locally — ${formatBytes(entry.receivedBytes)} so far`
      : pitch;
  }
  return `Downloading locally — ${String(Math.round(pct))}%`;
}

/**
 * The line under the halo.
 *
 * Video is the interesting case and lives in `homeState.describeVideoStatus`,
 * where it is unit-tested; everything else on the panel is a live iframe one
 * line above, so the honest sentence is simply what it is showing.
 */
function describeStatus(input: {
  activeId: string;
  tele: TelePacket | null;
  videoCfg: VideoModuleConfig;
  clipNames: ReadonlyMap<string, string>;
  now: number;
  downloading: boolean;
  presence: PanelPresence;
  streamingOnly: boolean;
}): Status {
  if (input.activeId !== videoModule.id) {
    // The module's own name, from the registry — not a table in this file that
    // could disagree with the chip six lines below it (R11).
    const mod = getModule(input.activeId);
    return {
      /*
        The dot, from the same evidence as the verb — round 8's A.

        This was `true`, a literal, for clock, stats and image: the presence was
        threaded into `panelVerb` one line below and thrown away here, so the
        live dot burned beside "Showing Clock" on a first-run window that has
        never heard from a panel — under a band explaining how to install CAM.
        The dot is the app's smallest and loudest present-tense claim, and
        `panelClaims.panelVerb` documents the collapse of the `showing` tense
        onto exactly this pixel: the word may stay in the participle BECAUSE
        the dot is what asserts "this second". That trade is only paid if the
        dot is derived, so it is — the video path has read `describeVideoStatus`
        for its dot since round 6, and this is the same rule for the other three.
      */
      live: panelIsLive(input.presence),
      // The word was typed here and again as the remote's module-picker label.
      // One claim, one place — `panelClaims.panelVerb` (round 7).
      verb: panelVerb(input.presence, 'showing'),
      name: mod === null ? 'this module' : (mod.chipName ?? mod.name),
      detail: null,
    };
  }
  return describeVideoStatus({
    url: input.videoCfg.url,
    loopEnabled: input.videoCfg.loop.enabled,
    loopEnd: input.videoCfg.loop.end,
    tele: input.tele,
    clipNames: input.clipNames,
    now: input.now,
    downloading: input.downloading,
    presence: input.presence,
    streamingOnly: input.streamingOnly,
  });
}

/** One source of truth for a module's name — the registry (R11). */
function activeModuleName(id: string): string {
  const mod = getModule(id);
  return mod === null ? 'Options' : (mod.chipName ?? mod.name);
}
