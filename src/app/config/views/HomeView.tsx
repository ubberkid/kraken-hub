import { useEffect, useState, type CSSProperties } from 'react';

import { validateClock } from '../../../modules/clock/schema';
import { validateImageConfig } from '../../../modules/image/schema';
import { listModules } from '../../../modules/registry';
import { validateStatsConfig } from '../../../modules/stats/schema';
import { videoModule } from '../../../modules/video';
import { readClipIndex } from '../../../modules/video/local/clipStore';
import {
  progressPct,
  readMirroredDownloads,
  type DownloadEntry,
} from '../../../modules/video/local/downloadManager';
import {
  primaryIssue,
  validateUrl,
  type ValidationIssue,
} from '../../../modules/video/routing/validate';
import { readTeleMirror, type TelePacket } from '../../../modules/video/telemetry/videoTelemetry';
import { validateVideoConfig, type VideoModuleConfig } from '../../../modules/video/types';
import { DEVICE_PRESETS } from '../../../platform/devicePresets';
import { withModuleConfig } from '../../../state/selectors';
import { Meter, Notice } from '../../../ui';
import { hasDisplayBeenSeen } from '../displaySeen';
import {
  formatSeconds,
  isLowFps,
  pickMirrorPreset,
  readDisplayFacts,
  sourceName,
} from '../homeState';

import { CamSetupCard } from './CamSetupCard';
import { ModuleSettingsView } from './ModuleSettingsView';

import type { AppState } from '../../../state/schema';
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
 *  - **Except for video.** Two players on one origin means two decoders, twice
 *    the network and — for a YouTube embed — a second set of ads, on a page
 *    whose whole job is to watch the first one. The video mirror is therefore a
 *    stylized surface, and the truth about what is playing comes from the
 *    telemetry the display publishes to localStorage, one line below it.
 *  - **The advisory never guesses.** See `homeState.readDisplayFacts`: the
 *    low-frame-rate banner is drawn only on a number the DISPLAY published, not
 *    on this window's own geometry fallback.
 */

/** The telemetry and download mirrors are polled at 1 Hz, as §7.5 mandates. */
const MIRROR_POLL_MS = 1000;
/** Older than this and the "live" dot would be a lie, so it is not drawn. */
const TELE_FRESH_MS = 6000;

/**
 * How long the inline-ops line will wait for the module panel to arrive before
 * it gives up trying to focus a control inside it.
 *
 * The panels are `React.lazy`, so the element named by `focusId` does not exist
 * on the tick the disclosure opens — it exists one network round trip later, on
 * a cold cache. Polling rather than a `ref` because the target lives inside a
 * component this view does not own and must not have to know the shape of.
 */
const FOCUS_POLL_MS = 60;
const FOCUS_TIMEOUT_MS = 3000;

interface Op {
  key: string;
  label: string;
  value: string;
  /**
   * The `id` of the control this line NAMES, inside the module's own panel.
   *
   * "Fill · Cover" that opens a settings page is a link; "Fill · Cover" that
   * scrolls to the fill control and focuses it is the control itself, seen from
   * a distance. The ids are the ones the panels already give their inputs, so
   * this is a promise the panels have to keep — see the note in each panel.
   */
  focusId: string;
}

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

export function HomeView({ runtime }: { runtime: ConfigRuntime }) {
  const state = runtime.store.getSnapshot();
  const modules = listModules();
  const activeId = state.activeModuleId;

  const [draft, setDraft] = useState('');
  const [issue, setIssue] = useState<ValidationIssue | null>(null);
  const [openOps, setOpenOps] = useState(false);
  /** The control the last-pressed inline op named, until it has been focused. */
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const setupDone = hasDisplayBeenSeen();

  /**
   * Take the user to the control they pointed at.
   *
   * The disclosure opening is not the same as the answer arriving: the module
   * panel is lazy, so the element is missing for a frame or for a whole fetch.
   * This retries on a short interval, scrolls the control into view and focuses
   * it, then stops — and stops regardless after `FOCUS_TIMEOUT_MS`, so a panel
   * that failed to load never leaves a timer running.
   */
  useEffect(() => {
    if (focusTarget === null) return undefined;
    const started = Date.now();
    const timer = setInterval(() => {
      const el = document.getElementById(focusTarget);
      if (el === null) {
        if (Date.now() - started > FOCUS_TIMEOUT_MS) setFocusTarget(null);
        return;
      }
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.focus({ preventScroll: true });
      setFocusTarget(null);
    }, FOCUS_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [focusTarget]);

  const facts = useMirror(readDisplayFacts);
  const tele = useMirror(readTeleMirror);
  const downloads = useMirror(readMirroredDownloads);
  const clips = useMirror(readClipIndex);
  const now = useNow();

  const preset = DEVICE_PRESETS[pickMirrorPreset(facts)];
  // Not memoized on purpose: both are pure, cheap and derived from state the
  // component already re-renders on, and a manual memo here is exactly the kind
  // the React compiler cannot preserve.
  const videoCfg = validateVideoConfig(state.modules[videoModule.id]?.cfg);
  const clipNames = new Map(clips.map((c) => [c.id, c.name]));

  const submit = (): void => {
    const raw = draft.trim();
    if (raw === '') return;
    const result = validateUrl(raw, { context: 'config' });
    setIssue(primaryIssue(result));
    if (result.blocking) return;
    // The NORMALIZED url, never the typed one: an http:// link has already been
    // upgraded by the time it reaches here (§7.1 `mixed-content-http`).
    runtime.store.commit((s) => ({
      ...withModuleConfig(s, videoModule.id, videoModule.configVersion, {
        ...videoCfg,
        url: result.url,
      }),
      activeModuleId: videoModule.id,
    }));
    setDraft('');
  };

  const ops = describeOps(activeId, state);
  const status = describeStatus({ activeId, tele, videoCfg, clipNames, now });

  return (
    <section className="kh-home" data-testid="home">
      {/*
        First run, and only first run. Until something the DISPLAY published has
        been seen on this origin, the install card is the most important thing
        on the page and sits above the halo. Afterwards it lives under
        `#/about` ("Add to CAM") and never appears here again — see
        `displaySeen.ts` for why the trigger is evidence rather than a dismiss.
      */}
      {!setupDone && <CamSetupCard runtime={runtime} variant="first-run" />}

      {isLowFps(facts) && (
        <div className="kh-fps-banner" role="status" data-testid="fps-banner">
          Your Kraken is running at <b>{String(facts?.targetFps ?? 0)} FPS</b>, so anything that
          moves looks like a slideshow. In CAM:{' '}
          <b>Lighting → Kraken → Web Integration → Frame Rate</b> → drag it to maximum.
        </div>
      )}

      <div
        className={preset.shape === 'circle' ? 'kh-halo' : 'kh-halo kh-halo--square'}
        data-testid="mirror"
        data-mirror-preset={preset.id}
        data-mirror-mode={activeId === videoModule.id ? 'surface' : 'live'}
      >
        <div className="kh-halo__lcd">
          {activeId === videoModule.id ? (
            <div className="kh-halo__surface" />
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

      <form
        className="kh-paste"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          className="kh-paste__input"
          type="text"
          value={draft}
          data-testid="paste-input"
          aria-label="Paste a video link"
          placeholder="Paste a video link — YouTube, MP4, HLS…"
          onChange={(e) => {
            setDraft(e.target.value);
            setIssue(null);
          }}
        />
        <button type="submit" className="kh-btn kh-btn--primary" data-testid="paste-submit">
          Play
        </button>
      </form>

      {issue !== null && (
        <div className="kh-home__notice">
          <Notice tone={issue.severity === 'error' ? 'error' : 'warn'}>{issue.message}</Notice>
        </div>
      )}

      <DownloadFlow entries={downloads} />

      <div className="kh-mods" role="group" aria-label="What's on the screen">
        {modules.map((m) => (
          <button
            key={m.id}
            type="button"
            className="kh-mod"
            aria-pressed={m.id === activeId}
            data-testid={`module-chip-${m.id}`}
            onClick={() => {
              runtime.store.commit((s) => ({ ...s, activeModuleId: m.id }));
              setOpenOps(false);
            }}
          >
            {m.chipName ?? m.name}
          </button>
        ))}
      </div>

      <div className="kh-ops">
        {ops.map((op) => (
          <button
            key={op.key}
            type="button"
            className="kh-op"
            aria-expanded={openOps}
            data-testid={`ops-${op.key}`}
            onClick={() => {
              // Always open — never a toggle. The line names a control; pressing
              // it a second time because the panel scrolled out of view must
              // bring the control back, not hide it.
              setOpenOps(true);
              setFocusTarget(op.focusId);
            }}
          >
            {op.label} <b>{op.value}</b>
          </button>
        ))}
      </div>

      {openOps && (
        <div className="kh-disclosure" id="kh-ops-panel" tabIndex={-1} data-testid="ops-panel">
          <div className="kh-disclosure__head">
            <h2>Options</h2>
            <button
              type="button"
              className="kh-btn"
              data-testid="ops-close"
              onClick={() => {
                setOpenOps(false);
              }}
            >
              Done
            </button>
          </div>
          <ModuleSettingsView runtime={runtime} id={activeId} />
        </div>
      )}

      <nav className="kh-more" aria-label="More">
        <a href="#/remote" data-testid="disclosure-remote">
          Remote
        </a>
        <span aria-hidden="true">·</span>
        <a href="#/library" data-testid="disclosure-library">
          Library
        </a>
        <span aria-hidden="true">·</span>
        <a href="#/diag" data-testid="disclosure-diag">
          Diagnostics ⌄
        </a>
      </nav>
    </section>
  );
}

/**
 * The download story, told in plain words (prototype screen 2).
 *
 * Driven by the real `kraken-hub:v1:video:downloads` mirror, which the DISPLAY
 * writes while it fetches: CAM's two browsers share a storage partition, so
 * this window watches a download running in the other one with zero network.
 * Nothing is rendered when nothing has been downloaded.
 */
function DownloadFlow({ entries }: { entries: readonly DownloadEntry[] }) {
  const active = entries.find((e) => e.state !== 'done' && e.state !== 'aborted');
  const entry = active ?? entries[0];
  if (entry === undefined || entry.state === 'aborted') return null;

  const pct = progressPct(entry);
  const stored = entry.state === 'done';
  const failed = entry.state === 'error';

  return (
    <ol className="kh-flow" data-testid="paste-flow">
      <li className="kh-step kh-step--on">
        <span className="kh-step__ic" aria-hidden="true">
          ▶
        </span>
        <span className="kh-step__text">
          <b>{detectedHeadline(entry.url)}</b>
          <small>{entry.name}</small>
        </span>
      </li>
      <li className={entry.state === 'queued' ? 'kh-step' : 'kh-step kh-step--on'}>
        <span className="kh-step__ic" aria-hidden="true">
          ↓
        </span>
        <span className="kh-step__text">
          <b>Saving to your Kraken</b>
          <small>
            {failed
              ? (entry.error ?? 'Could not download — playing from the link instead.')
              : downloadingLine(entry, pct)}
          </small>
          {!failed && <Meter pct={pct} />}
        </span>
      </li>
      <li className={stored ? 'kh-step kh-step--on' : 'kh-step'}>
        <span className="kh-step__ic" aria-hidden="true">
          ✓
        </span>
        <span className="kh-step__text">
          <b>On screen now</b>
          <small>Kept in your library</small>
        </span>
      </li>
    </ol>
  );
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
 * The contextual line under the chips: one item per thing a user actually
 * changes about the active module. Each opens that module's full settings in
 * place, so nobody has to know a settings page exists.
 */
function describeOps(activeId: string, state: AppState): Op[] {
  const cfg = state.modules[activeId]?.cfg;
  switch (activeId) {
    case 'video': {
      const v = validateVideoConfig(cfg);
      const loop = v.loop.enabled
        ? `${formatSeconds(v.loop.start)} – ${v.loop.end === null ? 'end' : formatSeconds(v.loop.end)}`
        : 'Off';
      return [
        { key: 'loop', label: 'Loop', value: loop, focusId: 'video-loop-enabled' },
        { key: 'fill', label: 'Fill ·', value: capitalize(v.render.fit), focusId: 'video-fit' },
        {
          key: 'saved',
          label: 'Saved locally',
          value: v.downloadMode === 'auto' ? '✓' : 'Off',
          focusId: 'video-downloadmode',
        },
      ];
    }
    case 'clock': {
      const c = validateClock(cfg);
      return [
        { key: 'face', label: 'Face ·', value: capitalize(c.face), focusId: 'clock-face' },
        {
          key: 'format',
          label: 'Format ·',
          value: `${c.hourFormat} h`,
          focusId: 'clock-hour-format',
        },
        {
          key: 'seconds',
          label: 'Seconds ·',
          value: c.showSeconds ? 'On' : 'Off',
          focusId: 'clock-seconds',
        },
      ];
    }
    case 'stats': {
      const s = validateStatsConfig(cfg);
      return [
        { key: 'layout', label: 'Layout ·', value: capitalize(s.layout), focusId: 'stats-layout' },
        {
          key: 'unit',
          label: 'Unit ·',
          value: s.unit === 'f' ? '°F' : '°C',
          focusId: 'stats-unit',
        },
        {
          key: 'labels',
          label: 'Labels ·',
          value: s.showLabels ? 'On' : 'Off',
          focusId: 'stats-labels',
        },
      ];
    }
    case 'image': {
      const i = validateImageConfig(cfg);
      return [
        { key: 'fill', label: 'Fill ·', value: capitalize(i.render.fit), focusId: 'image-fit' },
        {
          key: 'slideshow',
          label: 'Slideshow ·',
          value: i.slideshow.enabled ? `${String(i.slideshow.intervalSec)} s` : 'Off',
          focusId: 'image-slideshow',
        },
      ];
    }
    default:
      return [{ key: 'settings', label: 'Settings ·', value: 'Open', focusId: 'kh-ops-panel' }];
  }
}

interface Status {
  live: boolean;
  verb: string;
  name: string;
  detail: string | null;
}

/**
 * The line under the halo.
 *
 * For video these are the telemetry mirror's own numbers — the display's clock,
 * not ours — and the "live" dot is drawn only while that mirror is fresh,
 * because a live dot over a stopped player is worse than no dot at all. The
 * display publishes no duration, so the total is the A-B loop's end when one is
 * set and the buffered end otherwise.
 */
function describeStatus(input: {
  activeId: string;
  tele: TelePacket | null;
  videoCfg: VideoModuleConfig;
  clipNames: ReadonlyMap<string, string>;
  now: number;
}): Status {
  const { activeId, tele, videoCfg, clipNames, now } = input;
  if (activeId !== videoModule.id) {
    return {
      live: true,
      verb: 'Showing',
      name: MODULE_LINE[activeId] ?? 'this module',
      detail: null,
    };
  }

  const name = sourceName(videoCfg.url, clipNames);
  const stats = tele !== null && now - tele.ts < TELE_FRESH_MS ? tele.stats : undefined;
  if (stats === undefined) return { live: false, verb: 'Ready to play', name, detail: null };

  const end =
    videoCfg.loop.enabled && videoCfg.loop.end !== null ? videoCfg.loop.end : stats.bufferedEnd;
  const detail =
    end > 0
      ? `${formatSeconds(stats.currentTime)} / ${formatSeconds(end)}`
      : formatSeconds(stats.currentTime);
  return { live: !stats.held, verb: stats.held ? 'Holding' : 'Playing', name, detail };
}

const MODULE_LINE: Readonly<Record<string, string>> = {
  clock: 'Clock',
  stats: 'Stats',
  image: 'Image',
};

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
