/**
 * The video module's display-side renderer — the end-to-end playback path.
 *
 * Order of business on every source change (the download-first policy from the
 * plan, overriding design-videoEngine.md §5.3's upload-first framing):
 *
 *   1. Validate the URL again, here, on the display. State can arrive from a URL
 *      param or a retained snapshot written by an older or forked client, and
 *      the display never trusts incoming state (§7.2).
 *   2. `kraken-hub-clip:<id>` → play it from IndexedDB. Done.
 *   3. Already downloaded from this URL? Play the local copy. This is what makes
 *      a reboot with the network down keep working.
 *   4. **Resolver policy** (§1.4). Default `youtube-only`: health-check the
 *      companion silently, and when it is there route YouTube through it — which
 *      also means the bytes are fetchable, so step 5 can keep them. When it is
 *      not there, fall back to the geometry engine **silently**; the user never
 *      sees an error for a resolver miss.
 *   5. `downloadMode: 'auto'` and a file-shaped source → download it into the
 *      clip library right here, on the display, with a low-entropy progress card
 *      on the panel. Then play the local copy — which keeps playing after the
 *      companion is stopped.
 *   6. A CORS refusal is not an error: fall back to streaming the remote URL,
 *      record `download-cors-blocked`, and say nothing to the user.
 *   7. An unmatched URL runs §7.3's fallback chain (`<video>` → range sniff →
 *      blind manifest → optional proxy) before anything is declared unplayable.
 *
 * Everything per-frame is imperative (invariant I4). React is not involved in
 * this file at all, and the transform is written by `RenderController` alone, so
 * a config change never re-creates the `<video>` and never restarts playback.
 */

import { createLogger } from '../../lib/log';

import { loadAdapter } from './adapters/registry';
import { toVideoError, type AdapterEvent, type VideoError } from './adapters/VideoAdapter';
import { findClipBySourceUrl } from './local/clipStore';
import {
  CHECKPOINT_INTERVAL_MS,
  CHECKPOINT_MIN_SEC,
  checkpointKey,
  readCheckpoint,
  resumeTarget,
  writeCheckpoint,
} from './local/positionCheckpoint';
import { createCrossfadeLoop, crossfadeAllowed } from './loop/crossfade';
import { createHtmlVideoLoop } from './loop/HtmlVideoLoop';
import {
  SILENT_SEEK_MASK_MS,
  implicitLoop,
  isDurationKnown,
  validateLoop,
  type AbLoop,
} from './loop/LoopEngine';
import { createPolledLoop, type PolledLoop } from './loop/PolledLoop';
import { createRenderController, type RenderController } from './render/RenderController';
import { applyResolverPolicy, detect, type ProviderMatch } from './routing/detect';
import { LOCAL_CLIP_SCHEME } from './routing/patterns';
import { runFallbackChain } from './routing/sniff';
import { validateUrl } from './routing/validate';
import { publish, publishStats, setTelemetryContext, urlHash } from './telemetry/videoTelemetry';
import { createPerfPromoter, perfProfile, type ProviderId, type VideoModuleConfig } from './types';
import {
  isRetryableCode,
  middleEllipsize,
  renderErrorCard,
  renderFallbackBadge,
  retryDelayMs,
  shouldFallbackToPrevious,
} from './ui/ErrorCard';
import { createFpsAdvisory, renderFpsBadge, renderFpsCard } from './ui/FpsAdvisory';

import type { DisplayRenderer, ModuleContext, UpdateReason } from '../types';
import type { VideoAdapter } from './adapters/VideoAdapter';
import type * as DownloadManager from './local/downloadManager';
import type { DownloadEntry } from './local/downloadManager';
import type { FrameInfo } from '../../platform/fpsGovernor';

import './video.css';

const log = createLogger('video/display');

/**
 * The ingestion machinery — the download manager and, through it, the media
 * probes and thumbnailer it shares with manual upload — behind a dynamic import.
 *
 * It is ~26 kB of source that the LCD's first frame does not depend on: steps 2
 * and 3 of the resolution order (a `kraken-hub-clip:` URL, and "have we already
 * downloaded this URL") are served by `clipStore`, which stays eagerly imported
 * precisely so a cold boot with the network down still works. Only step 5 —
 * actually fetching bytes — needs this, and by then we are about to make a
 * network request anyway, so one same-origin chunk fetch is free.
 *
 * The alternative was letting `module-video` keep growing against a 25 kB
 * budget it was already at 97 % of.
 */
type DownloadsModule = typeof DownloadManager;
let downloadsModule: DownloadsModule | null = null;

/**
 * Loads the download manager once and caches it for the life of the page.
 *
 * Cached at module scope rather than per-renderer so a source change — which
 * tears the renderer's session down — does not re-await the import; the browser
 * would serve it from its own module map anyway, but the null check keeps the
 * synchronous `downloadsModule.progressPct` read in `renderProgress` honest.
 */
async function loadDownloads(): Promise<DownloadsModule> {
  downloadsModule ??= await import('./local/downloadManager');
  return downloadsModule;
}

/** The bundled low-entropy clip. Relative so a fork on any base URL works (I7). */
const DEMO_PATH = 'demo/demo.mp4';
/** Plan: the cold-boot demo carries a hint for 15 s, then gets out of the way. */
const DEMO_HINT_MS = 15_000;
const PCT_DECIMALS = 0;
const MS_PER_SEC = 1000;
const PERCENT = 100;

function demoUrl(): string {
  return new URL(DEMO_PATH, document.baseURI).href;
}

export { middleEllipsize };

interface Card {
  title: string;
  body: string;
  detail?: string;
  footer?: string;
}

interface ResolvedSource {
  url: string;
  /** True when the bytes are local, i.e. offline-proof. */
  local: boolean;
  /**
   * Overrides detection. `undefined` means "use whatever `detect()` said";
   * **`null` means nothing can play this** — which is not the same thing, and
   * conflating the two is how a URL that failed every step of §7.3's chain gets
   * handed to `direct-file` anyway on the strength of detection's 0.2-confidence
   * guess, and fails again one layer further down with a worse message.
   */
  provider?: ProviderId | null;
}

/**
 * M2.5 — "the companion answered, and then went away mid-download."
 *
 * A third answer `tryResolver` needs, distinct from both a `ResolvedSource`
 * ("play this") and `null` ("the resolver policy did not apply here, carry on
 * down the chain"). It means: the resolver path was taken and has silently
 * failed, so play the ORIGINAL url with ordinary detection — for a YouTube
 * link that is the geometry engine — and do not spend the download step on a
 * page URL the browser cannot fetch anyway.
 */
const RESOLVER_GONE = Symbol('resolver-gone');

export function createRenderer(): DisplayRenderer<VideoModuleConfig> {
  let controller: RenderController | null = null;
  let adapter: VideoAdapter | null = null;
  let loop: AbLoop | null = null;
  /** Non-null only for polled providers; carries the BUFFERING/PLAYING feeds. */
  let polled: PolledLoop | null = null;
  let ctx: ModuleContext | null = null;
  let cfg: VideoModuleConfig | null = null;
  let abort: AbortController | null = null;
  /** Guards every async continuation against a source change or an unmount. */
  let session = 0;
  let duration = Number.NaN;
  let perf: 'quality' | 'performance' = 'quality';
  const perfPromoter = createPerfPromoter();
  let achievedFps = 0;
  let hintTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribeDownloads: (() => void) | null = null;
  let progressEl: HTMLElement | null = null;
  let playingDemo = false;

  // §7.4 — retry/backoff and the previous-source fallback.
  let retryAttempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** The last source that actually mounted and played this session. */
  let lastGoodSource: ResolvedSource | null = null;
  /** Set while we are deliberately playing the previous source instead. */
  let onFallbackSource = false;

  // §8.1 — the advisory the shell stands down for (`ownsFpsAdvisory`).
  const advisory = createFpsAdvisory();
  let advisoryEl: HTMLElement | null = null;
  let advisoryState: 'hidden' | 'card' | 'badge' = 'hidden';

  // §7.5 — the continuous 0.5 Hz sample.
  let statsTimer: ReturnType<typeof setInterval> | null = null;
  let maskVisibleMs = 0;
  let statsWindowMs = 0;

  /*
   * Cold-restore resume (see ./local/positionCheckpoint.ts).
   *
   * `checkpoint` is the identity of what is playing NOW; `pendingResume` is the
   * second the current session should jump to once a duration is known, and is
   * consumed exactly once so a `durationchange` mid-clip cannot re-seek.
   */
  let checkpoint: string | null = null;
  let pendingResume: number | null = null;
  let lastCheckpointAt = 0;
  let onPagehide: (() => void) | null = null;

  /** Stamps where we are, if the source is checkpointable at all. */
  function saveCheckpoint(): void {
    const owner = adapter;
    if (owner === null || checkpoint === null || cfg === null) return;
    // A live edge, an unseekable source and a configured A-B loop each have a
    // resume point that is not "wherever the clock happened to be".
    if (!isDurationKnown(duration) || !owner.capabilities.canSeek) return;
    if (cfg.loop.enabled) return;
    const posSec = owner.getCurrentTime();
    if (!Number.isFinite(posSec) || posSec < CHECKPOINT_MIN_SEC) return;
    lastCheckpointAt = Date.now();
    writeCheckpoint({ key: checkpoint, posSec, durationSec: duration, atMs: lastCheckpointAt });
  }

  /**
   * Applies a pending resume as soon as the duration is known.
   *
   * It waits for the duration because "is this live?" and "is this checkpoint
   * past the end?" are both unanswerable without one, and a `ready` event can
   * arrive with `duration` still `NaN` on a progressive file.
   */
  function applyResume(): void {
    if (pendingResume === null || adapter === null || cfg === null) return;
    if (!isDurationKnown(duration)) return;
    const target = resumeTarget(
      { key: checkpoint ?? '', posSec: pendingResume, durationSec: duration, atMs: 0 },
      { key: checkpoint, durationSec: duration, loopEnabled: cfg.loop.enabled },
    );
    pendingResume = null;
    if (target === null) return;
    void adapter.seek(target, { precise: true });
    publish({ code: 'position-resumed', severity: 'info', message: target.toFixed(1) });
  }

  // -------------------------------------------------------------------------
  // Overlays (§7.4): flat, low-entropy, inside the circular safe box.
  // -------------------------------------------------------------------------

  function clearOverlays(): void {
    controller?.overlays.replaceChildren();
    progressEl = null;
    advisoryEl = null;
    advisoryState = 'hidden';
  }

  function showCard(card: Card): void {
    const host = controller?.overlays;
    if (host === undefined) return;
    clearOverlays();
    const wrap = document.createElement('div');
    wrap.className = 'kh-video__card';
    const inner = document.createElement('div');
    inner.className = 'kh-video__card-inner';

    const title = document.createElement('p');
    title.className = 'kh-video__card-title';
    title.textContent = card.title;

    const body = document.createElement('p');
    body.className = 'kh-video__card-body';
    body.textContent = card.body;

    inner.append(title, body);

    if (card.detail !== undefined) {
      const detail = document.createElement('p');
      detail.className = 'kh-video__card-detail';
      detail.textContent = card.detail;
      inner.append(detail);
    }

    const footer = document.createElement('p');
    footer.className = 'kh-video__card-footer';
    // Fixed footer: the LCD is non-interactive, so the fix always lives in CAM.
    footer.textContent = card.footer ?? 'Fix in CAM → Kraken → Configure';
    inner.append(footer);

    wrap.append(inner);
    host.append(wrap);
  }

  function showHint(text: string): void {
    const host = controller?.overlays;
    if (host === undefined) return;
    const hint = document.createElement('div');
    hint.className = 'kh-video__hint';
    hint.textContent = text;
    host.append(hint);
    if (hintTimer !== null) clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      hint.remove();
      hintTimer = null;
    }, DEMO_HINT_MS);
  }

  function renderProgress(entries: DownloadEntry[]): void {
    const host = controller?.overlays;
    if (host === undefined) return;
    const active = entries.find(
      (e) => e.state === 'downloading' || e.state === 'queued' || e.state === 'storing',
    );
    if (active === undefined) {
      progressEl?.remove();
      progressEl = null;
      return;
    }
    if (progressEl === null) {
      progressEl = document.createElement('div');
      progressEl.className = 'kh-video__progress';
      host.append(progressEl);
    }
    const pct = downloadsModule === null ? null : downloadsModule.progressPct(active);
    const label =
      active.state === 'storing'
        ? 'Saving…'
        : pct === null
          ? 'Downloading…'
          : `${pct.toFixed(PCT_DECIMALS)}%`;
    progressEl.replaceChildren();
    const line = document.createElement('div');
    line.textContent = label;
    const name = document.createElement('div');
    name.className = 'kh-video__progress-name';
    name.textContent = active.name;
    progressEl.append(line, name);
    if (pct !== null) {
      const bar = document.createElement('div');
      bar.className = 'kh-video__progress-bar';
      const fill = document.createElement('div');
      fill.className = 'kh-video__progress-fill';
      fill.style.width = `${String(pct)}%`;
      bar.append(fill);
      progressEl.append(bar);
    }
  }

  /**
   * The renderer's handle on the lazily-imported download manager.
   *
   * Subscribing here rather than at mount is what keeps the chunk off the boot
   * path: the progress card only ever has something to draw once a download has
   * been asked for, and asking for one goes through this function. The
   * subscription is torn down in `stopSession`.
   */
  async function downloads(): Promise<DownloadsModule> {
    const mod = await loadDownloads();
    unsubscribeDownloads ??= mod.subscribeDownloads(renderProgress);
    return mod;
  }

  // -------------------------------------------------------------------------
  // Errors (§7.4)
  // -------------------------------------------------------------------------

  function clearRetry(): void {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  }

  function showError(err: VideoError): void {
    publish(
      {
        code: err.code,
        severity: 'error',
        ...(err.provider === null ? {} : { provider: err.provider }),
        message: err.message,
      },
      err.url === undefined ? {} : { url: err.url },
    );

    // §7.4 — three failed retries and a source that DID play earlier this
    // session: go back to it. A working picture with a corner badge beats a
    // perfect explanation of a broken one on a screen nobody can click.
    if (
      isRetryableCode(err.code) &&
      shouldFallbackToPrevious(retryAttempt, lastGoodSource !== null) &&
      !onFallbackSource
    ) {
      onFallbackSource = true;
      clearRetry();
      void startSession({ source: lastGoodSource });
      return;
    }

    const host = controller?.overlays;
    if (host === undefined) return;
    clearOverlays();
    host.append(
      renderErrorCard({
        code: err.code,
        title: 'Video unavailable',
        body: err.message,
        ...(err.url === undefined ? {} : { detail: err.url }),
        ...(isRetryableCode(err.code) ? { retryCount: retryAttempt + 1 } : {}),
      }),
    );

    // §7.4 — backoff for transient classes only. A deterministic failure gets
    // one card and stays there; retrying a `.mkv` forever is how an LCD ends up
    // in a permanent spinner.
    if (!isRetryableCode(err.code)) return;
    clearRetry();
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void startSession({});
    }, retryDelayMs(retryAttempt));
  }

  // -------------------------------------------------------------------------
  // FPS advisory (§8.1)
  // -------------------------------------------------------------------------

  function renderAdvisory(targetFps: number): void {
    const host = controller?.overlays;
    if (host === undefined) return;
    const next = advisory.update(targetFps);
    if (next === advisoryState) return;
    advisoryState = next;
    advisoryEl?.remove();
    advisoryEl = null;
    if (next === 'hidden') return;
    advisoryEl = next === 'card' ? renderFpsCard(targetFps) : renderFpsBadge(targetFps);
    host.append(advisoryEl);
  }

  // -------------------------------------------------------------------------
  // Loop
  // -------------------------------------------------------------------------

  function applyLoop(): void {
    if (loop === null || cfg === null) return;
    // §3.2 — a live source reports no usable duration and refuses to seek.
    if (!isDurationKnown(duration) || adapter?.capabilities.canSeek === false) {
      loop.disable();
      return;
    }
    const validation = validateLoop(cfg.loop, duration);
    if (validation.status === 'active') {
      loop.setSpan(validation.start, validation.end);
    } else {
      // §2.6 — with no A-B loop we still install the implicit one, so playback
      // never reaches `duration`. For a `<video>` that means no `ended` gap; for
      // YouTube it means no end screen.
      const implicit = implicitLoop(duration);
      if (implicit.end > implicit.start) loop.setSpan(implicit.start, implicit.end);
      else loop.disable();
    }
    for (const note of validation.notes) {
      publish({ code: note, severity: 'warn', message: 'loop configuration adjusted' });
    }
  }

  // -------------------------------------------------------------------------
  // Source resolution + mount
  // -------------------------------------------------------------------------

  /**
   * §1.4 — the resolver policy layer. Health is checked silently; **every**
   * failure downgrades to the original match with a `resolver-fallback` line in
   * telemetry and nothing at all on screen.
   */
  async function tryResolver(
    match: ProviderMatch,
    config: VideoModuleConfig,
    mine: number,
  ): Promise<ResolvedSource | typeof RESOLVER_GONE | null> {
    if (config.resolver.policy === 'off') return null;

    const client = await import('./resolver/resolverClient');
    if (session !== mine) return null;
    const health = await client.checkHealth(config.resolver);
    setTelemetryContext({ resolver: { configured: true, healthy: health.healthy } });
    if (session !== mine) return null;

    const routed = applyResolverPolicy(match, config.resolver.policy, {
      healthy: health.healthy,
      caps: { hasOwnChrome: true, canSetQuality: false },
    });
    if (routed.provider !== 'resolver') return null;

    const geometry = ctx?.geometry();
    const envelope = await client.resolveOrFallback(match.url, config.resolver, {
      maxHeight: client.deriveMaxHeight({
        displayW: geometry?.width ?? 0,
        displayH: geometry?.height ?? 0,
        dpr: geometry?.dpr ?? 1,
        zoom: config.render.zoom,
      }),
      audio: config.audioEnabled,
      ...(abort === null ? {} : { signal: abort.signal }),
    });
    if (session !== mine || envelope.status !== 'ok') return null;

    // ── The download seam. The companion serves from 127.0.0.1 with `ACAO: *`
    // and Range support (contract §6.2), so a progressive stream is exactly the
    // kind of thing `downloadToClip` can keep — and once it is kept, the clip
    // plays forever with the companion stopped. That is the whole point of the
    // download-first product decision.
    if (
      config.downloadMode === 'auto' &&
      (envelope.kind === 'progressive' || envelope.kind === 'file')
    ) {
      const stored = await (
        await downloads()
      ).downloadToClip(envelope.streamUrl, {
        ...(abort === null ? {} : { signal: abort.signal }),
        provider: 'resolver',
        ...(envelope.title === undefined ? {} : { name: envelope.title }),
        sourceUrl: match.url,
      });
      if (session !== mine) return null;
      if (stored.ok) {
        return { url: `${LOCAL_CLIP_SCHEME}${stored.clipId}`, local: true, provider: 'local-file' };
      }
      publish({
        code: 'resolver-download-failed',
        severity: 'warn',
        provider: 'resolver',
        message: stored.message,
      });

      // M2.5 — the companion was killed mid-download. Streaming from it now
      // would mount a `<video src>` on a socket nobody is listening to and put
      // an error card on the LCD, which §6.4 forbids for a resolver miss. Ask
      // once whether it is still there; if it is not, degrade to whatever the
      // app would have done with no companion at all (the geometry engine, for
      // YouTube). `RESOLVER_GONE` says "attempted and downgraded", which is a
      // different thing from `null`'s "policy says not applicable".
      client.invalidateHealth();
      const recheck = await client.checkHealth(config.resolver);
      if (session !== mine) return null;
      if (!recheck.healthy) {
        setTelemetryContext({ resolver: { configured: true, healthy: false } });
        return RESOLVER_GONE;
      }
    }

    const { setPreresolved } = await import('./adapters/resolver.adapter');
    if (session !== mine) return null;
    setPreresolved(match.url, envelope);
    return { url: match.url, local: false, provider: 'resolver' };
  }

  /** §7.3 — the chain, plus the same download-first keep for what it finds. */
  async function tryFallbackChain(
    match: ProviderMatch,
    config: VideoModuleConfig,
    mine: number,
  ): Promise<ResolvedSource | null> {
    if (abort === null) return null;
    const chain = await runFallbackChain(match.url, {
      proxyBase: config.proxyBase,
      signal: abort.signal,
    });
    if (session !== mine || chain.provider === null) return null;

    publish({
      code: 'fallback-chain-resolved',
      severity: 'info',
      provider: chain.provider,
      message: chain.steps.map((s) => `${s.step}=${s.reason}`).join('; '),
    });

    if (chain.provider === 'direct-file' && config.downloadMode === 'auto') {
      const stored = await (
        await downloads()
      ).downloadToClip(chain.url, {
        signal: abort.signal,
        provider: 'direct-file',
        sourceUrl: match.url,
      });
      if (session !== mine) return null;
      if (stored.ok) {
        return { url: `${LOCAL_CLIP_SCHEME}${stored.clipId}`, local: true, provider: 'local-file' };
      }
    }
    return { url: chain.url, local: false, provider: chain.provider };
  }

  async function resolveSource(config: VideoModuleConfig, mine: number): Promise<ResolvedSource> {
    const raw = config.url.trim();
    if (raw === '') {
      playingDemo = true;
      return { url: demoUrl(), local: false };
    }
    playingDemo = false;

    const match = detect(raw);
    if (match.provider === 'local-file') return { url: match.url, local: true };

    // Step 3: the local copy of this exact URL, if we already have one. Checked
    // BEFORE any network work so a cold boot with no network still plays.
    const existing = await findClipBySourceUrl(match.url);
    if (existing !== null) {
      return { url: `${LOCAL_CLIP_SCHEME}${existing.id}`, local: true };
    }
    if (session !== mine) return { url: match.url, local: false };

    // Step 4: the resolver policy. Silent on every failure path.
    const resolved = await tryResolver(match, config, mine);
    if (session !== mine) return { url: match.url, local: false };
    // The companion vanished mid-download: play the original link exactly as an
    // installation with no companion would, and skip the download step below —
    // a YouTube *page* URL is not something `fetch` can turn into a clip.
    if (resolved === RESOLVER_GONE) return { url: match.url, local: false };
    if (resolved !== null) return resolved;

    // Step 7: an unmatched URL gets §7.3's chain before anything is declared
    // unplayable — a bare CDN link with no extension is not a broken link.
    if (match.needsFallbackChain) {
      const chained = await tryFallbackChain(match, config, mine);
      if (session !== mine) return { url: match.url, local: false };
      if (chained !== null) return chained;
      // Every direct attempt, every sniff and the proxy have failed. The 0.2
      // confidence guess from `detect()` has already been disproved; saying so
      // is what turns this into §7.3 step 5 rather than a second failure.
      return { url: match.url, local: false, provider: null };
    }

    // Cheap pre-check before the chunk fetch: `shouldAutoDownload` is false for
    // every mode but `auto`, so `stream-only` never pays for the import.
    if (config.downloadMode !== 'auto') return { url: match.url, local: false };
    const dl = await downloads();
    if (session !== mine) return { url: match.url, local: false };
    if (!dl.shouldAutoDownload(match, config.downloadMode)) {
      return { url: match.url, local: false };
    }

    // Step 5: the display downloads it itself, headlessly, with a progress card.
    const result = await dl.downloadToClip(match.url, {
      ...(abort === null ? {} : { signal: abort.signal }),
      provider: match.provider,
    });
    if (session !== mine) return { url: match.url, local: false };
    if (result.ok) {
      return { url: `${LOCAL_CLIP_SCHEME}${result.clipId}`, local: true };
    }
    // Step 6: silent fallback. A CORS refusal means `fetch` cannot read what
    // `<video src>` can still play, which is most of the web.
    publish({
      code: result.reason === 'cors' ? 'download-cors-blocked' : 'download-fallback-stream',
      severity: 'warn',
      message: result.message,
    });
    return { url: match.url, local: false };
  }

  function onAdapterEvent(e: AdapterEvent): void {
    if (controller === null) return;
    switch (e.type) {
      case 'sourcerect':
        controller.setSourceRect(e.rect);
        controller.apply();
        break;
      case 'ready':
        controller.setCapabilities(e.caps);
        duration = e.duration;
        controller.apply();
        applyLoop();
        applyResume();
        break;
      case 'durationchange':
        duration = e.duration;
        applyLoop();
        applyResume();
        break;
      case 'playing':
        polled?.notePlaying();
        // A frame actually reached the panel: the retry ladder resets, so the
        // NEXT failure starts its backoff at 2 s rather than at the 30 s cap.
        retryAttempt = 0;
        // An adapter that owns the mask runs a state machine the host cannot
        // see (poster, failsafe, stall escalation). Second-guessing it here is
        // how a mask ends up flickering.
        if (adapter?.ownsMask !== true) controller.hideMask();
        break;
      case 'buffering':
        polled?.noteBuffering();
        if (adapter?.ownsMask !== true) controller.showMask();
        break;
      case 'quality':
        setTelemetryContext({ quality: { height: e.height, label: e.label } });
        break;
      case 'error':
        showError(e.err);
        break;
      case 'stalled':
        publish({ code: 'stall', severity: 'warn', message: `stalled ${String(e.sinceMs)} ms` });
        break;
      default:
        break;
    }
  }

  async function startSession(opts: { source?: ResolvedSource | null }): Promise<void> {
    const config = cfg;
    const context = ctx;
    if (config === null || context === null || controller === null) return;

    session += 1;
    const mine = session;

    // Tear the previous source down before touching the new one, so two
    // decoders never run at once on a machine already busy rendering a game.
    await stopSession();
    if (session !== mine) return;

    abort = new AbortController();
    controller.showMask();
    clearOverlays();

    const geometry = context.geometry();
    perf = perfPromoter.update(config.perf, {
      targetFps: geometry.targetFps,
      achievedFps: achievedFps === 0 ? geometry.targetFps : achievedFps,
    });
    controller.setPerf(perf);
    controller.setViewport(geometry.width, geometry.height);
    controller.setConfig(config.render);
    setTelemetryContext({
      display: {
        w: geometry.width,
        h: geometry.height,
        shape: geometry.shape,
        targetFps: geometry.targetFps,
      },
      retryCount: retryAttempt,
      resolver: { configured: config.resolver.policy !== 'off', healthy: false },
    });

    // Identify the source and pick up its checkpoint BEFORE the adapter mounts,
    // so `ready` can act on it the moment a duration exists. Keyed off
    // `config.url` rather than the resolved source: downloading a URL into the
    // clip library rewrites the source to `kraken-hub-clip:…`, and a resume must
    // survive that without becoming a different clip.
    checkpoint = null;
    pendingResume = null;
    lastCheckpointAt = 0;
    const key = await checkpointKey(config.url, urlHash);
    if (session !== mine) return;
    checkpoint = key;
    const saved = readCheckpoint();
    if (key !== null && saved !== null && saved.key === key && !config.loop.enabled) {
      pendingResume = saved.posSec;
    }

    try {
      const source = opts.source ?? (await resolveSource(config, mine));
      if (session !== mine) return;

      const validation = validateUrl(source.url, { context: 'display' });
      if (validation.blocking) {
        const issue = validation.issues.find((i) => i.severity === 'error');
        showCard({
          title: 'Source rejected',
          body: issue?.message ?? 'This link cannot be played on the display.',
          detail: middleEllipsize(source.url),
        });
        return;
      }

      const provider = source.provider === undefined ? validation.match.provider : source.provider;
      if (provider === null) {
        // §7.3 step 5 — every direct attempt, every sniff and the proxy (if the
        // user configured one) have now failed. This is the card, and its
        // per-step reasons are already in the ring buffer.
        showError(
          toVideoError(
            new Error('Nothing here could play that link — see the diagnostics log.'),
            null,
            source.url,
          ),
        );
        return;
      }

      const next = await loadAdapter(provider);
      if (session !== mine) {
        await next?.teardown();
        return;
      }
      if (next === null) {
        showCard({
          title: 'Provider not in this build',
          body: `"${provider}" playback is not available in this build.`,
          detail: middleEllipsize(source.url),
        });
        publish({ code: 'provider-unavailable', severity: 'warn', provider, message: source.url });
        return;
      }

      adapter = next;
      controller.setCapabilities(next.capabilities);
      await next.mount({
        container: controller.stage,
        url: source.url,
        match: { ...validation.match, provider },
        display: {
          width: geometry.width,
          height: geometry.height,
          shape: geometry.shape,
          targetFps: geometry.targetFps,
          dpr: geometry.dpr,
        },
        config,
        signal: abort.signal,
        emit: onAdapterEvent,
        perf,
        mask: controller.maskSurface(),
      });
      if (session !== mine) return;

      controller.apply();
      next.setMuted(true);
      await next.play();
      if (session !== mine) return;

      if (onFallbackSource) {
        // §7.4 — a badge, not a card: the user IS watching something, and the
        // corner note tells them it is not the thing they asked for.
        controller.overlays.append(renderFallbackBadge());
      } else {
        lastGoodSource = source;
      }

      // §3.3 vs §3.4: the `<video>` family gets the rAF-predictive
      // `currentTime` reset with the `timeupdate` safety net; a cross-origin
      // player has neither event, so it gets the lookahead poll instead. The
      // host does not care which — both are an `AbLoop`.
      const media = controller.stage.querySelector('video');
      if (next.capabilities.pixelSource === 'video-element' && media !== null) {
        // §3.6 — the optional dual-decoder seam. `crossfadeAllowed` is the one
        // decision point: it refuses for anything that is not a progressive
        // file, in performance mode, and at `targetFps <= 10`. The hard loop is
        // the default and the fallback, and only ever one of the two runs.
        if (
          crossfadeAllowed({
            mode: config.loop.mode,
            provider,
            perf,
            targetFps: geometry.targetFps,
          })
        ) {
          const cf = createCrossfadeLoop({
            primary: media,
            // `currentSrc` is what the element actually resolved and is already
            // in the HTTP (or blob) cache, so the second decoder does not fetch
            // the file a second time.
            src: media.currentSrc === '' ? media.src : media.currentSrc,
            crossfadeMs: config.loop.crossfadeMs,
          });
          media.parentElement?.append(cf.secondary);
          loop = cf;
          publish({
            code: 'loop-crossfade',
            severity: 'info',
            provider,
            message: `${String(config.loop.crossfadeMs)}ms`,
          });
        } else {
          loop = createHtmlVideoLoop({
            video: media,
            onSlowResume: () => {
              controller?.showMask();
            },
            onResumed: () => {
              controller?.hideMask();
            },
          });
        }
      } else {
        const owner = next;
        polled = createPolledLoop({
          host: {
            getCurrentTime: () => owner.getCurrentTime(),
            getRate: () => 1,
            getDuration: () => owner.getDuration(),
            getLoadedFraction: () => {
              const d = owner.getDuration();
              return Number.isFinite(d) && d > 0 ? owner.getBufferedEnd() / d : 0;
            },
            // The mask is coordinated through the seek itself: an adapter that
            // owns the mask needs to know a seek is a LOOP crossing, and
            // whether it is expected to be silent (§2.6 row 6).
            seek: (t, silentExpected) => {
              void owner.seek(t, { loopSeek: true, silentExpected });
            },
          },
          onCrossingStart: () => {
            if (owner.ownsMask !== true) controller?.showMask();
          },
          onCrossingSettled: (silent) => {
            if (owner.ownsMask === true) return;
            controller?.hideMask(silent ? SILENT_SEEK_MASK_MS : undefined);
          },
          onSilentSeekChange: (canSeekSilently) => {
            // §3.4 — publish the OBSERVED value, so the config UI can say
            // "loop is seamless" or "loop shows a brief flash" honestly.
            owner.capabilities.canSeekSilently = canSeekSilently;
            publish({
              code: 'loop-silent-seek',
              severity: 'info',
              provider: owner.id,
              message: String(canSeekSilently),
            });
          },
        });
        loop = polled;
      }
      loop.start();
      applyLoop();
      startStats();

      if (playingDemo) {
        showHint('Demo clip — paste a video URL in CAM → Kraken → Configure');
      }
    } catch (err) {
      if (session !== mine) return;
      showError(toVideoError(err, null, config.url));
      log.error('mount failed', err);
    }
  }

  // -------------------------------------------------------------------------
  // Continuous telemetry (§7.5): 0.5 Hz, 0.2 Hz in performance mode (§8.3).
  // -------------------------------------------------------------------------

  function startStats(): void {
    stopStats();
    const period = MS_PER_SEC / perfProfile(perf).telemetryHz;
    statsTimer = setInterval(() => {
      const owner = adapter;
      if (owner === null || controller === null) return;
      statsWindowMs += period;
      if (controller.isMaskVisible()) maskVisibleMs += period;
      // The 10 s checkpoint rides the sampler that already exists rather than
      // arming a second timer: one more interval on a panel that is short of
      // frame budget buys nothing.
      if (Date.now() - lastCheckpointAt >= CHECKPOINT_INTERVAL_MS) saveCheckpoint();
      publishStats({
        currentTime: owner.getCurrentTime(),
        bufferedEnd: owner.getBufferedEnd(),
        held: owner.isHeld(),
        loopCrossings: loop?.crossings() ?? 0,
        maskVisiblePct: statsWindowMs === 0 ? 0 : (maskVisibleMs / statsWindowMs) * PERCENT,
      });
    }, period);
  }

  function stopStats(): void {
    if (statsTimer !== null) clearInterval(statsTimer);
    statsTimer = null;
    maskVisibleMs = 0;
    statsWindowMs = 0;
  }

  async function stopSession(): Promise<void> {
    // Last chance to record where this source was: a source change, a reinit
    // and an unmount all come through here, and after this the adapter is gone.
    saveCheckpoint();
    if (hintTimer !== null) {
      clearTimeout(hintTimer);
      hintTimer = null;
    }
    stopStats();
    unsubscribeDownloads?.();
    unsubscribeDownloads = null;
    loop?.stop();
    loop = null;
    polled = null;
    abort?.abort();
    abort = null;
    const previous = adapter;
    adapter = null;
    duration = Number.NaN;
    if (previous !== null) await previous.teardown();
  }

  return {
    async mount(host: HTMLElement, context: ModuleContext, config: VideoModuleConfig) {
      ctx = context;
      cfg = config;
      const geometry = context.geometry();
      controller = createRenderController({
        host,
        perf: 'quality',
        background: '#000',
      });
      controller.setViewport(geometry.width, geometry.height);
      controller.setConfig(config.render);

      /*
       * The other half of the 10 s checkpoint.
       *
       * A power cut is not the interesting case — the last periodic write is
       * at most ten seconds stale and that is fine. The interesting case is an
       * orderly close: CAM restarting the LCD window, or a reload, where the
       * final position is known exactly and losing it would be gratuitous.
       * `pagehide` is the event that still fires for a page the browser is
       * putting in the bfcache, which `beforeunload` does not. Whether CAM's
       * webview delivers it on teardown is unverified — hardware checklist
       * **H23** — so the 10 s periodic write, not this, is the guarantee.
       */
      onPagehide = () => {
        saveCheckpoint();
      };
      window.addEventListener('pagehide', onPagehide);

      await startSession({});
    },

    update(config: VideoModuleConfig, reason: UpdateReason) {
      const previous = cfg;
      cfg = config;
      const sourceChanged =
        previous === null
          ? true
          : previous.url !== config.url ||
            previous.downloadMode !== config.downloadMode ||
            previous.perf !== config.perf ||
            // §3.6 — hard and crossfade are different loop machines (and the
            // crossfade owns a second `<video>`), so switching between them is
            // a remount, not a `setSpan`.
            previous.loop.mode !== config.loop.mode ||
            previous.loop.crossfadeMs !== config.loop.crossfadeMs ||
            previous.proxyBase !== config.proxyBase ||
            previous.resolver.policy !== config.resolver.policy ||
            previous.resolver.port !== config.resolver.port ||
            previous.resolver.token !== config.resolver.token;
      if (sourceChanged || reason.changed.some((p) => p.startsWith('url'))) {
        // A deliberate source change is a fresh start: the retry ladder and the
        // previous-source fallback belong to the source that failed, not this one.
        clearRetry();
        retryAttempt = 0;
        onFallbackSource = false;
        void startSession({});
        return;
      }
      controller?.setConfig(config.render);
      controller?.apply();
      applyLoop();
    },

    frame(f: FrameInfo) {
      achievedFps = f.achievedFps;
      if (cfg === null || controller === null) return;
      setTelemetryContext({ achievedFps: f.achievedFps });
      renderAdvisory(f.targetFps);
      const next = perfPromoter.update(cfg.perf, {
        targetFps: f.targetFps,
        achievedFps: f.achievedFps,
      });
      if (next !== perf) {
        // Rare and human-invisible: a mode flip only rewrites the transform and
        // the rotor, never the media element, so playback is untouched.
        perf = next;
        controller.setPerf(next);
        controller.apply();
        // §8.3 — the telemetry rate is one of the levers, so re-arm the sampler.
        if (statsTimer !== null) startStats();
      }
    },

    geometry(g) {
      controller?.setViewport(g.width, g.height);
      controller?.apply();
    },

    reinit() {
      // Idempotent: the watchdog may call this repeatedly after a sleep/wake.
      void adapter?.play();
      controller?.apply();
    },

    /**
     * The `cmd` channel's landing point (§4.3): imperative, one-shot, never
     * replayed. Unknown ops are ignored on purpose — a newer phone remote must
     * be able to talk to an older display without breaking it.
     *
     * `pause` is `hold()`, not a real pause, because for the YouTube engine a
     * real `pauseVideo()` raises the suggested-video grid over the frame (§2.6).
     * Every adapter defines `hold()` as "pause-equivalent, without the visual
     * side effect", which is the only thing that is safe on a non-interactive
     * panel.
     */
    command(op: string, arg?: unknown) {
      const a = adapter;
      if (a === null) return;
      const seconds = typeof arg === 'number' && Number.isFinite(arg) ? arg : null;
      switch (op) {
        case 'play':
          void a.play();
          break;
        case 'pause':
          void a.hold();
          break;
        case 'toggle':
          void (a.isHeld() ? a.play() : a.hold());
          break;
        case 'seekTo':
        case 'previewSeek':
          if (seconds !== null) void a.seek(Math.max(0, seconds), { precise: true });
          break;
        case 'seekBy':
          if (seconds !== null) {
            void a.seek(Math.max(0, a.getCurrentTime() + seconds), { precise: true });
          }
          break;
        case 'setRate':
          if (seconds !== null) void a.setRate(seconds);
          break;
        case 'reinit':
        case 'reload':
          void a.play();
          controller?.apply();
          break;
        default:
          break;
      }
    },

    unmount() {
      session += 1;
      clearRetry();
      if (onPagehide !== null) window.removeEventListener('pagehide', onPagehide);
      onPagehide = null;
      void stopSession();
      controller?.destroy();
      controller = null;
      ctx = null;
      cfg = null;
      progressEl = null;
      lastGoodSource = null;
      onFallbackSource = false;
      checkpoint = null;
      pendingResume = null;
    },
  };
}
