import { useEffect, useRef, useState, type CSSProperties } from 'react';

import { CAM_PATH_FRAME_RATE } from '../../../config/camPaths';
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
  TELE_FRESH_MS,
  describeFlow,
  describeVideoStatus,
  failureLine,
  formatSeconds,
  isLowFps,
  pickMirrorPreset,
  readDisplayFacts,
  resolverHealthyFromTele,
  sourceName,
  type FlowState,
  type Status,
} from '../homeState';
import { submitImageLink, submitVideoLink, type PasteIssue } from '../pasteLink';

import { CamSetupCard } from './CamSetupCard';
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
 *  - **the ops strip is real controls.** Fit is a segmented control, Loop opens
 *    the A/B scrubber in place, and "Saved locally" is a status chip rather than
 *    a button that was never a button. Nothing here navigates and nothing here
 *    scrolls you anywhere.
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
 * How long a *successful* paste receipt stays on the screen.
 *
 * Round 2's R11: the three step-cards are narration, and narration that never
 * ends becomes furniture — 240 px of it, permanently, between the primary
 * action and the module chips, describing something that finished. The status
 * line under the halo already carries the state ("Playing sunset loop · 1:24 /
 * 3:02"), so the receipt says its piece and gets out of the way.
 *
 * Only for the plain success stages. A deviation the user has to know about — a
 * server that refuses a copy, a copy that failed, YouTube playing its own ads —
 * is not a receipt, and stays.
 */
const RECEIPT_LINGER_MS = 4000;

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

/**
 * A media query as React state.
 *
 * Used for exactly one thing — the paste field's placeholder — and it has to be
 * JavaScript because CSS cannot rewrite a `placeholder` attribute. At 390 px the
 * long form truncated mid-word to `Paste a video link — YouTube, MP4, HI`
 * (design audit, F11), which is worse than saying less: a hint that ends in a
 * fragment reads as a rendering bug.
 */
function useNarrow(query: string): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mql = window.matchMedia(query);
    const onChange = (): void => {
      setNarrow(mql.matches);
    };
    onChange();
    mql.addEventListener('change', onChange);
    return () => {
      mql.removeEventListener('change', onChange);
    };
  }, [query]);
  return narrow;
}

/** Matches `ui.css`'s own phone breakpoint, so the two never disagree. */
const PHONE_QUERY = '(max-width: 700px)';

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
  };
  /** The A/B scrubber, revealed under the ops strip by the Loop control. */
  const [loopOpen, setLoopOpen] = useState(false);
  const setupDone = hasDisplayBeenSeen();

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

  const imageCfg = validateImageConfig(state.modules['image']?.cfg);

  /**
   * The primary action, in the active module's own noun (R9).
   *
   * `null` means the module has nothing to be given — Clock and Stats — and the
   * row becomes the quiet switch instead of a loud, irrelevant video field.
   */
  const action: PasteAction | null =
    activeId === videoModule.id
      ? {
          label: 'Paste a video link',
          placeholder: narrow ? 'Paste a video link' : 'Paste a video link — YouTube, MP4, HLS…',
          submitLabel: 'Play',
          submit: (raw) => submitVideoLink(runtime, raw),
          clearOnAccept: true,
        }
      : activeId === 'image'
        ? {
            label: 'Paste a picture link',
            placeholder: narrow
              ? 'Paste a picture link'
              : 'Paste a picture link — JPG, PNG, WebP, GIF…',
            submitLabel: 'Show',
            // The row IS the field: it keeps the picture it is showing, the way
            // the panel's own text input used to.
            submit: (raw) => submitImageLink(runtime, raw),
            clearOnAccept: false,
          }
        : null;

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
    setDraft(activeId === 'image' ? imageCfg.url : '');
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

  const status = describeStatus({
    activeId,
    tele,
    videoCfg,
    clipNames,
    now,
    downloading: flow?.stage === 'downloading',
    displaySeen: setupDone,
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
   * The halo yields the floor when something opens in its place.
   *
   * Round 2 measured the options panel overflowing the CAM window by 426–888 px
   * for every module: the panel opened UNDER a full-height composition, so the
   * thing you had just asked to see was the one thing off the bottom of the
   * screen. The options take the halo's place instead — the mirror cross-fades
   * down to a corner thumb (still the live display page, still ticking) and the
   * vacated ~180 px is what the panel opens into. Closing restores it, on the
   * same spring, both ways.
   */
  const compact = openOps || loopOpen;

  return (
    <section className="kh-home" data-testid="home" data-compact={compact ? 'true' : 'false'}>
      {isLowFps(facts) && (
        <div className="kh-fps-banner" role="status" data-testid="fps-banner">
          Your Kraken is running at <b>{String(facts?.targetFps ?? 0)} FPS</b>, so anything that
          moves looks like a slideshow. <b>{CAM_PATH_FRAME_RATE}</b> → drag it to maximum.
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
          data-mirror-mode={activeId === videoModule.id ? 'surface' : 'live'}
        >
          <div className="kh-halo__lcd">
            {activeId === videoModule.id ? (
              <VideoHalo
                url={videoCfg.url}
                name={status.name}
                progress={haloProgress}
                held={liveStats?.held === true}
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
      {!setupDone && <CamSetupCard runtime={runtime} variant="first-run" />}

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

      {flow !== null && <DownloadFlow flow={flow} url={videoCfg.url} />}

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
        <a href="#/library" data-testid="disclosure-library">
          Library
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
/**
 * Stages whose receipt is allowed to leave.
 *
 * A plain success and nothing else. `streaming`, `unsaved` and `youtube-embed`
 * all report a *deviation* — no copy could be kept, or YouTube is playing its
 * own ads — and a user who looks away for five seconds must still be able to
 * find out why. `downloading` is not finished at all.
 */
const RECEIPT_COLLAPSES: ReadonlySet<FlowState['stage']> = new Set(['accepted', 'stored']);

function DownloadFlow({ flow, url }: { flow: FlowState; url: string }) {
  const { stage, entry } = flow;
  const pct = entry === null ? null : progressPct(entry);
  // Everything except an in-flight download is finished business: the video is
  // on the panel, whatever happened to the copy.
  const settled = stage !== 'downloading';

  /**
   * The receipt's own retirement.
   *
   * Keyed on `stage` so a story that moves on — downloading → stored — restarts
   * the clock rather than inheriting a timer from a stage that has passed. The
   * node stays in the DOM once collapsed and simply stops taking space: the
   * stage is still readable to anything that asks, and hiding is a thing CSS can
   * cross-fade, where an unmount is a hard cut.
   */
  const [retired, setRetired] = useState<FlowState['stage'] | null>(null);
  const gone = retired === stage;
  useEffect(() => {
    if (!RECEIPT_COLLAPSES.has(stage)) return undefined;
    const timer = setTimeout(() => {
      setRetired(stage);
    }, RECEIPT_LINGER_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [stage]);

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
          <small>{entry?.name ?? sourceLabel(url)}</small>
        </span>
      </li>

      {stage === 'youtube-embed' ? (
        <li className="kh-step kh-step--on" data-testid="paste-step-downloader">
          <span className="kh-step__ic" aria-hidden="true">
            ▸
          </span>
          <span className="kh-step__text">
            <b>Playing through YouTube</b>
            <small>Ads and all, the way YouTube sends it.</small>
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
            <b>{secondHeadline(stage)}</b>
            <small>
              {stage === 'streaming'
                ? 'This server does not allow saving a copy, so your Kraken is playing it straight from the web.'
                : stage === 'accepted'
                  ? 'Your Kraken picks it up straight away.'
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

      <li className={settled ? 'kh-step kh-step--on' : 'kh-step'}>
        <span className="kh-step__ic" aria-hidden="true">
          ✓
        </span>
        <span className="kh-step__text">
          <b>On screen now</b>
          <small>{stage === 'stored' ? 'Kept in your library' : 'Playing on your Kraken'}</small>
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
function secondHeadline(stage: FlowState['stage']): string {
  if (stage === 'stored' || stage === 'downloading') return 'Keeping a copy';
  if (stage === 'accepted') return 'Sent to your Kraken';
  return 'Streaming from the link';
}

/** The first step's second line before any job exists to name the file. */
function sourceLabel(url: string): string {
  return sourceName(url, new Map());
}

const BYTES_PER_MB = 1_048_576;
const MB_DECIMALS = 0;

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
  if (entry.state === 'done') {
    const mb = (entry.receivedBytes / BYTES_PER_MB).toFixed(MB_DECIMALS);
    return `${mb} MB · kept in your library`;
  }
  if (pct === null) return pitch;
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
  displaySeen: boolean;
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
    displaySeen: input.displaySeen,
    streamingOnly: input.streamingOnly,
  });
}

/** One source of truth for a module's name — the registry (R11). */
function activeModuleName(id: string): string {
  const mod = getModule(id);
  return mod === null ? 'Options' : (mod.chipName ?? mod.name);
}

/** What the one primary action is, for the module that is on the panel (R9). */
interface PasteAction {
  /** The input's accessible name. */
  label: string;
  placeholder: string;
  submitLabel: string;
  submit: (raw: string) => { issue: PasteIssue | null; accepted: boolean };
  /** False for a field that keeps showing what it committed — the picture link. */
  clearOnAccept: boolean;
}
