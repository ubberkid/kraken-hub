import { useEffect, useRef, useState, type CSSProperties } from 'react';

import {
  CAM_FRAME_RATE_LEAD,
  CAM_FRAME_RATE_TAIL,
  CAM_PATH_FRAME_RATE,
} from '../../../config/camPaths';
import { KEEPING_A_COPY, KEPT_A_COPY, LIBRARY_NOUN } from '../../../config/vocabulary';
import { formatBytes } from '../../../lib/bytes';
import { validateClock } from '../../../modules/clock/schema';
import { validateImageConfig } from '../../../modules/image/schema';
import { getModule, listModules } from '../../../modules/registry';
import { validateStatsConfig } from '../../../modules/stats/schema';
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
import { withModuleConfig } from '../../../state/selectors';
import { Meter, Notice, Segmented } from '../../../ui';
import { FitControl } from '../../../ui/Framing';
import { hasDisplayBeenSeen } from '../displaySeen';
import {
  RECEIPT_LINGER_MS,
  TELE_FRESH_MS,
  describeFlow,
  describeVideoStatus,
  failureLine,
  formatSeconds,
  isLowFps,
  pickMirrorPreset,
  readDisplayFacts,
  receiptPersists,
  receiptSubLine,
  resolverHealthyFromTele,
  sourceName,
  type FlowStage,
  type FlowState,
  type Status,
} from '../homeState';
import {
  handoffHeadline,
  panelIsKnown,
  panelPresence,
  settledReceipt,
  type PanelPresence,
} from '../panelPresence';
import { pasteAction, type PasteAction, type PasteIssue } from '../pasteLink';
import { ownsBytes } from '../surface';
import { PHONE_QUERY, useNarrow } from '../useNarrow';

import { CamSetupCard } from './CamSetupCard';
import { prefetchConfigPanel } from './configPanels';
import { LoopScrubber, LOOP_MAX_SEC } from './LoopScrubber';
import { ModuleSettingsView } from './ModuleSettingsView';
import { VideoHalo } from './VideoHalo';

import type { AppState } from '../../../state/schema';
import type { ConfigRuntime } from '../runtime';
import type { ReactNode } from 'react';

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
    runtime.store.commit((s) => ({ ...s, activeModuleId: openModule }));
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
   * Keyed on `stage` so a story that moves on — downloading → stored — restarts
   * the clock rather than inheriting a timer from a stage that has passed.
   */
  const stage = flow?.stage ?? null;
  const [retiredStage, setRetiredStage] = useState<FlowStage | null>(null);
  useEffect(() => {
    if (stage === null) return undefined;
    // Not a list of stages: a question about one. See `homeState.receiptPersists`.
    if (receiptPersists(stage)) return undefined;
    const timer = setTimeout(() => {
      setRetiredStage(stage);
    }, RECEIPT_LINGER_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [stage]);
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
  const receiptUp = stage !== null && retiredStage !== stage && !openOps && !loopOpen;

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
    >
      {isLowFps(facts) && (
        <div className="kh-fps-banner" role="status" data-testid="fps-banner">
          Your Kraken is running at <b>{String(facts?.targetFps ?? 0)} FPS</b>, so anything that
          moves looks like a slideshow. {CAM_FRAME_RATE_LEAD} <b>{CAM_PATH_FRAME_RATE}</b>{' '}
          {CAM_FRAME_RATE_TAIL}.
        </div>
      )}

      {/*
        The mirror and the sentence about it are one object, so that when the
        options take the floor they travel together: the halo shrinks to a thumb
        and the line steps alongside it rather than being orphaned under a
        64 px circle.
      */}
      <div className="kh-home__mirror">
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
                  { '--kh-mirror-w': preset.width, '--kh-mirror-h': preset.height } as CSSProperties
                }
              />
            )}
          </div>
        </div>

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
      {!setupDone && <CamSetupCard runtime={runtime} variant="first-run" dense={compact} />}

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
              runtime.store.commit((s) => ({ ...s, activeModuleId: videoModule.id }));
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

      {issue !== null && (
        <div className="kh-home__notice">
          <Notice tone={issue.severity === 'error' ? 'error' : 'warn'}>{issue.message}</Notice>
        </div>
      )}

      {flow !== null && (
        <DownloadFlow flow={flow} url={videoCfg.url} gone={!receiptUp} presence={presence} />
      )}

      <div className="kh-mods" role="group" aria-label="What's on the screen">
        {modules.map((m) => {
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
                runtime.store.commit((s) => ({ ...s, activeModuleId: m.id }));
                showOps(false);
                setLoopOpen(false);
              }}
            >
              {m.chipName ?? m.name}
            </button>
          );
        })}
      </div>

      <div className="kh-ops" data-testid="ops-strip">
        <OpsStrip
          activeId={activeId}
          state={state}
          runtime={runtime}
          videoCfg={videoCfg}
          setVideo={setVideo}
          loopOpen={loopOpen}
          onToggleLoop={() => {
            setLoopOpen((open) => !open);
          }}
        />
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
    </section>
  );
}

// ---------------------------------------------------------------------------
// The ops strip — controls, not links
// ---------------------------------------------------------------------------

/** One labelled item on the strip. The label names the thing, never the system. */
function Op({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <span className="kh-op" data-testid={testId}>
      <span className="kh-op__lab">{label}</span>
      {children}
    </span>
  );
}

/**
 * What a person actually changes about the module that is on screen.
 *
 * Every one of these resolves where it stands. The rule the old line broke, and
 * the reason the audit called it "a lie": a control that looks like a toggle
 * must BE a toggle. Anything that genuinely needs a panel is reached by tapping
 * the active chip, which is a different gesture with a different promise.
 */
function OpsStrip({
  activeId,
  state,
  runtime,
  videoCfg,
  setVideo,
  loopOpen,
  onToggleLoop,
}: {
  activeId: string;
  state: AppState;
  runtime: ConfigRuntime;
  videoCfg: VideoModuleConfig;
  setVideo: (patch: Partial<VideoModuleConfig>) => void;
  loopOpen: boolean;
  onToggleLoop: () => void;
}) {
  /** Commit a module's own config, at the version the registry declares. */
  const setModule = (id: string, cfg: unknown): void => {
    const mod = getModule(id);
    if (mod === null) return;
    runtime.store.commit((s) => withModuleConfig(s, mod.id, mod.configVersion, cfg));
  };

  if (activeId === videoModule.id) {
    const loop = videoCfg.loop;
    const loopLabel = loop.enabled
      ? `${formatSeconds(loop.start)} – ${loop.end === null ? 'end' : formatSeconds(loop.end)}`
      : 'Off';
    return (
      <>
        <Op label="Fit" testId="ops-fill">
          <FitControl
            id="home-video-fit"
            ariaLabel="Fit"
            value={videoCfg.render.fit}
            onChange={(fit) => {
              setVideo({ render: { ...videoCfg.render, fit } });
            }}
          />
        </Op>
        <span className="kh-op" data-testid="ops-loop">
          <button
            type="button"
            className="kh-op__btn"
            aria-expanded={loopOpen}
            aria-controls="ops-loop-panel"
            data-testid="ops-loop-button"
            onClick={onToggleLoop}
          >
            <span className="kh-op__lab">Loop</span>
            <b className="kh-tnum">{loopLabel}</b>
          </button>
        </span>
        {/*
          No "Keeping a copy" badge here any more.

          It was a permanent green chip asserting a *policy* in the grammar of a
          *stage*, next to a status line that said "Streaming clip.mp4" about the
          same file at the same moment (round 2, R5). Keeping a copy is something
          that happens and then is over: it belongs to the ladder — "Keeping a
          copy of X", then "Playing X · 0:12 / 3:02" — and the setting behind it
          is one control in the module's options, where a setting lives.
        */}
      </>
    );
  }

  if (activeId === 'clock') {
    const c = validateClock(state.modules['clock']?.cfg);
    const commit = (patch: Record<string, unknown>): void => {
      setModule('clock', { ...c, ...patch });
    };
    return (
      <>
        <Op label="Face" testId="ops-face">
          <Segmented
            id="home-clock-face"
            ariaLabel="Face"
            value={c.face}
            options={[
              { value: 'digital', label: 'Digital' },
              { value: 'analog', label: 'Analog' },
            ]}
            onChange={(face) => {
              commit({ face });
            }}
          />
        </Op>
        <Op label="Hours" testId="ops-format">
          <Segmented
            id="home-clock-hour-format"
            ariaLabel="Hours"
            value={c.hourFormat}
            options={[
              { value: '24', label: '24' },
              { value: '12', label: '12' },
            ]}
            onChange={(hourFormat) => {
              commit({ hourFormat });
            }}
          />
        </Op>
        <Op label="Seconds" testId="ops-seconds">
          <Segmented
            id="home-clock-seconds"
            ariaLabel="Seconds"
            value={c.showSeconds ? 'on' : 'off'}
            options={[
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
            onChange={(v) => {
              commit({ showSeconds: v === 'on' });
            }}
          />
        </Op>
      </>
    );
  }

  if (activeId === 'stats') {
    const s = validateStatsConfig(state.modules['stats']?.cfg);
    const commit = (patch: Record<string, unknown>): void => {
      setModule('stats', { ...s, ...patch });
    };
    return (
      <>
        <Op label="Layout" testId="ops-layout">
          <Segmented
            id="home-stats-layout"
            ariaLabel="Layout"
            value={s.layout}
            options={[
              { value: 'single', label: 'One' },
              { value: 'dual', label: 'Two' },
              { value: 'grid', label: 'All' },
            ]}
            onChange={(layout) => {
              commit({ layout });
            }}
          />
        </Op>
        <Op label="Degrees" testId="ops-unit">
          <Segmented
            id="home-stats-unit"
            ariaLabel="Degrees"
            value={s.unit}
            options={[
              { value: 'c', label: '°C' },
              { value: 'f', label: '°F' },
            ]}
            onChange={(unit) => {
              commit({ unit });
            }}
          />
        </Op>
        <Op label="Labels" testId="ops-labels">
          <Segmented
            id="home-stats-labels"
            ariaLabel="Labels"
            value={s.showLabels ? 'on' : 'off'}
            options={[
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
            onChange={(v) => {
              commit({ showLabels: v === 'on' });
            }}
          />
        </Op>
      </>
    );
  }

  if (activeId === 'image') {
    const i = validateImageConfig(state.modules['image']?.cfg);
    return (
      <>
        <Op label="Fit" testId="ops-fill">
          <FitControl
            id="home-image-fit"
            ariaLabel="Fit"
            value={i.render.fit}
            onChange={(fit) => {
              setModule('image', { ...i, render: { ...i.render, fit } });
            }}
          />
        </Op>
        <Op label="Slideshow" testId="ops-slideshow">
          <Segmented
            id="home-image-slideshow"
            ariaLabel="Slideshow"
            value={i.slideshow.enabled ? 'on' : 'off'}
            options={[
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
            onChange={(v) => {
              setModule('image', {
                ...i,
                slideshow: { ...i.slideshow, enabled: v === 'on' },
              });
            }}
          />
        </Op>
      </>
    );
  }

  return null;
}

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
            <b>Playing through YouTube</b>
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
            <small>
              {stage === 'streaming'
                ? 'This server does not allow saving a copy, so your Kraken is playing it straight from the web.'
                : stage === 'accepted'
                  ? panelIsKnown(presence)
                    ? 'Your Kraken picks it up straight away.'
                    : 'Your Kraken picks it up as soon as it connects.'
                  : stage === 'unsaved'
                    ? failureLine(entry)
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
  return 'Streaming from the link';
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
  const pitch = 'Downloading locally — plays forever, no ads, no buffering';
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
      live: true,
      verb: 'Showing',
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
