/**
 * `hls` — HLS via hls.js, lazily imported (design-videoEngine.md §1.2, §3.2).
 *
 * Three things this adapter is careful about, in the order they bite:
 *
 *  1. **Native HLS first.** Safari and iOS play `application/vnd.apple.mpegurl`
 *     straight off a `<video src>`, with hardware demuxing and no MSE. Checking
 *     `canPlayType` before importing means those platforms never download the
 *     library at all. Chromium — the platform that actually matters here —
 *     returns `''`, so CAM's webview takes the hls.js path.
 *  2. **The LIGHT build, `import()`ed, never bundled into the module chunk.**
 *     hls.js's full bundle is 177 kB gzip; `hls.js/light` is 113 kB, and the
 *     three things it drops — subtitle rendering, EME/DRM and alternate-audio
 *     switching — are all meaningless on a muted 640×640 panel. A display
 *     playing a local clip pays for neither: `vite.config.ts` gives it its own
 *     `provider-hls` chunk.
 *  3. **Live streams are never looped.** `details.live` on the first loaded
 *     level is the signal; when it is set, `canSeek`/`reportsDuration` drop to
 *     false, duration is left `NaN` and the loop engine parks in `pending`
 *     forever rather than seeking into a sliding window (§3.2).
 *
 * Quality control is real here, unlike YouTube: `hls.currentLevel` picks a
 * rendition by index, so `setQuality(height)` maps a wanted height onto the
 * highest level that does not exceed it, and `-1` restores ABR.
 *
 * `attachHls` is exported because `resolver.adapter.ts` reuses it when the
 * companion answers with `kind: 'hls'`.
 */

import { publish } from '../telemetry/videoTelemetry';

import { createHtmlVideoAdapter, type HtmlVideoAdapter } from './HtmlVideoAdapterBase';
import { videoError } from './VideoAdapter';

import type { MountContext } from './VideoAdapter';
import type { ProviderCapabilities, ProviderId } from '../types';
import type { ErrorData, Level, LevelLoadedData } from 'hls.js';

const BACK_BUFFER_SEC = 30;
const AUTO_LEVEL = -1;

/** `canPlayType` answers `'probably' | 'maybe' | ''`; anything non-empty is a yes. */
export function nativeHlsSupported(el: HTMLVideoElement): boolean {
  return (
    el.canPlayType('application/vnd.apple.mpegurl') !== '' ||
    el.canPlayType('application/x-mpegURL') !== ''
  );
}

/**
 * The highest level whose height fits under `wanted`, or the lowest level when
 * none does — asking for 480p on a ladder that starts at 720p should still give
 * a picture, just not the one requested.
 */
export function pickLevel(levels: readonly { height: number }[], wanted: number): number {
  if (levels.length === 0) return AUTO_LEVEL;
  let best = -1;
  let bestH = -1;
  for (const [i, level] of levels.entries()) {
    if (level.height <= wanted && level.height > bestH) {
      best = i;
      bestH = level.height;
    }
  }
  if (best >= 0) return best;
  let lowest = 0;
  for (const [i, level] of levels.entries()) {
    if (level.height < (levels[lowest]?.height ?? Number.POSITIVE_INFINITY)) lowest = i;
  }
  return lowest;
}

export interface HlsHandle {
  destroy(): void;
  setQuality(heightHint: number): boolean;
  getQuality(): { height: number | null; label: string | null };
}

export interface AttachHlsOptions {
  el: HTMLVideoElement;
  url: string;
  ctx: MountContext;
  /** Mutated in place when the playlist turns out to be live (§3.2). */
  caps: ProviderCapabilities;
  provider: ProviderId;
}

/**
 * Wires HLS onto an existing `<video>`. Returns `null` when native playback took
 * over (nothing to tear down) or the mount was aborted.
 */
export async function attachHls(opts: AttachHlsOptions): Promise<HlsHandle | null> {
  const { el, url, ctx, caps } = opts;

  if (nativeHlsSupported(el)) {
    // No MSE, no library, no CORS requirement beyond what the CDN already
    // sends. Nothing to tear down either.
    el.src = url;
    el.load();
    return null;
  }

  // The LIGHT build: no subtitles, no EME, no alternate audio — 64 kB gzip less
  // to fetch, parse and compile on a muted panel that needs none of them.
  const mod = await import('hls.js/light');
  if (ctx.signal.aborted) return null;
  const HlsCtor = mod.default;

  if (!HlsCtor.isSupported()) {
    ctx.emit({
      type: 'error',
      err: videoError(
        'provider-unavailable',
        'This browser has no Media Source Extensions, so HLS cannot be played here.',
        opts.provider,
        url,
      ),
    });
    return null;
  }

  let levels: Level[] = [];
  let recoveredMedia = false;

  const instance = new HlsCtor({
    // The LCD is a small panel behind a compressing capture pipeline: a
    // conservative buffer costs nothing visible and keeps memory down on a page
    // that runs for weeks.
    enableWorker: true,
    lowLatencyMode: false,
    backBufferLength: BACK_BUFFER_SEC,
  });

  instance.on(HlsCtor.Events.MANIFEST_PARSED, () => {
    levels = instance.levels;
    caps.canSetQuality = levels.length > 1;
  });

  instance.on(HlsCtor.Events.LEVEL_LOADED, (_e: unknown, data: LevelLoadedData) => {
    if (!data.details.live) return;
    // §3.2 — live sources are never looped, never seeked, and report no
    // duration. Saying so here is what stops the loop engine from ever trying
    // to seek into a window that has already slid away.
    caps.canSeek = false;
    caps.reportsDuration = false;
    publish({
      code: 'loop-unavailable-live',
      severity: 'info',
      provider: opts.provider,
      message: 'live HLS playlist — A-B loop disabled',
    });
  });

  instance.on(HlsCtor.Events.ERROR, (_e: unknown, data: ErrorData) => {
    if (!data.fatal) return;
    if (data.type === HlsCtor.ErrorTypes.NETWORK_ERROR) {
      instance.startLoad();
      return;
    }
    if (data.type === HlsCtor.ErrorTypes.MEDIA_ERROR && !recoveredMedia) {
      // Exactly once: a second media error after a recovery is a real decode
      // problem, and retrying it forever is how an LCD hangs.
      recoveredMedia = true;
      instance.recoverMediaError();
      return;
    }
    ctx.emit({
      type: 'error',
      err: videoError('source-unplayable', `HLS failed: ${data.details}`, opts.provider, url),
    });
  });

  instance.loadSource(url);
  instance.attachMedia(el);

  return {
    destroy: () => {
      // §1.1 — destroy the library before the element lets go of its MediaSource.
      instance.destroy();
      levels = [];
    },
    setQuality: (heightHint: number) => {
      if (levels.length === 0) return false;
      instance.currentLevel = pickLevel(levels, heightHint);
      return true;
    },
    getQuality: () => {
      const index =
        instance.currentLevel === AUTO_LEVEL ? instance.loadLevel : instance.currentLevel;
      const level = levels[index];
      if (level === undefined) return { height: null, label: null };
      return { height: level.height, label: `${String(level.height)}p` };
    },
  };
}

export function createAdapter(): HtmlVideoAdapter {
  let handle: HlsHandle | null = null;

  const adapter = createHtmlVideoAdapter({
    id: 'hls',
    caps: {
      // True only inside the buffered window; §3.4's promoter measures the truth.
      canSeekSilently: false,
      canSetQuality: true,
      canReadQuality: true,
    },

    attach: async (el, ctx) => {
      handle = await attachHls({
        el,
        url: ctx.match.url,
        ctx,
        caps: adapter.capabilities,
        provider: 'hls',
      });
    },

    detach: () => {
      handle?.destroy();
      handle = null;
    },

    quality: {
      set: (h) => Promise.resolve(handle?.setQuality(h) ?? false),
      get: () => handle?.getQuality() ?? { height: null, label: null },
    },
  });

  return adapter;
}
