/**
 * `dash` — MPEG-DASH via **dash.js 5**, lazily imported
 * (design-videoEngine.md §1.5).
 *
 * dash.js was chosen over shaka deliberately, and the reason is one specific
 * workload: `v.redd.it`. Reddit's `DASHPlaylist.mpd` is non-conformant in small
 * ways — loose or missing `mimeType`, separate video-only and audio-only
 * AdaptationSets, and an audio set that intermittently 403s. dash.js is the
 * DASH-IF reference implementation and is deliberately permissive about
 * manifests it can still play; shaka validates harder and rejects a class of
 * manifests dash.js tolerates. It is also ~200 kB smaller, and on a device whose
 * *frame budget* is the scarce resource, less parse work at mount matters.
 *
 * The audio-failure rule below is §1.5 verbatim, and it exists because of that
 * 403: **an audio 403 must never kill video.** The Kraken display is always
 * muted, so losing the audio AdaptationSet costs the user precisely nothing —
 * but a naive player treats a fatal download error as fatal for the stream.
 *
 * `attachDash` is exported because `reddit.adapter.ts` reuses it as its last
 * resort: the muted display probes the far cheaper `DASH_<h>.mp4` progressive
 * ladder first, and only lands here when audio was asked for or the ladder came
 * up empty (§1.5).
 */

import { qualityLabel, type QualityLevel } from '../quality';
import { publish } from '../telemetry/videoTelemetry';

import { createHtmlVideoAdapter, type HtmlVideoAdapter } from './HtmlVideoAdapterBase';
import { isAutoQualityHint, videoError } from './VideoAdapter';

import type { MountContext } from './VideoAdapter';
import type { ProviderCapabilities } from '../types';
import type { MediaPlayerClass } from 'dashjs';

/** §1.5 — two audio failures in a row, then we give up on audio and play on. */
export const AUDIO_FAILURE_LIMIT = 2;

const BUFFER_SEC = 20;
const BUFFER_KEEP_SEC = 10;

interface LooseDashError {
  error?: unknown;
  event?: { id?: unknown; url?: unknown; request?: { mediaType?: unknown } | undefined };
}

/**
 * dash.js reports the failing media type in different places across error
 * shapes, so read all of them rather than trusting one. Returns `null` when the
 * event does not identify a media type at all.
 */
export function failingMediaType(e: unknown): string | null {
  // dash.js has been known to emit a bare `null` on a torn-down player, and an
  // exception thrown out of an event handler would take the whole mount with it.
  const err = (e ?? {}) as LooseDashError;
  const fromRequest = err.event?.request?.mediaType;
  if (typeof fromRequest === 'string') return fromRequest;
  const id = err.event?.id;
  if (typeof id === 'string') return id;
  return null;
}

export function isFatalDashError(e: unknown): boolean {
  const err = (e ?? {}) as LooseDashError;
  // A `download` error on one AdaptationSet is recoverable by definition — the
  // player keeps requesting later segments. Everything else is structural.
  return err.error !== 'download';
}

function describeDashError(e: unknown): string {
  const err = e as { error?: unknown; event?: { message?: unknown } };
  const message = err.event?.message;
  if (typeof message === 'string' && message.length > 0) return `DASH failed: ${message}`;
  return typeof err.error === 'string' ? `DASH failed: ${err.error}` : 'DASH playback failed.';
}

/** De-duplicated by height, low to high — see `hls.adapter.ts`'s twin. */
export function describeLevels(reps: readonly { height: number }[]): QualityLevel[] {
  const heights = [...new Set(reps.map((r) => r.height).filter((h) => h > 0))];
  return heights.sort((a, b) => a - b).map((h) => ({ height: h, label: qualityLabel(h) }));
}

export interface DashHandle {
  player: MediaPlayerClass;
  destroy(): void;
  setQuality(heightHint: number): boolean;
  getQuality(): { height: number | null; label: string | null };
}

/**
 * The ABR toggle, built as a deep PARTIAL.
 *
 * dash.js accepts partial settings while its shipped `.d.ts` declares the whole
 * settings object, so the shape is built separately and widened at the boundary
 * — exactly as the buffer settings above do.
 */
function setAutoSwitch(on: boolean): Parameters<MediaPlayerClass['updateSettings']>[0] {
  return { streaming: { abr: { autoSwitchBitrate: { video: on } } } };
}

export interface AttachDashOptions {
  el: HTMLVideoElement;
  url: string;
  ctx: MountContext;
  /** Mutated in place when the manifest turns out to be live (§3.2). */
  caps: ProviderCapabilities;
  /** So the audio-drop rule can force mute on whichever adapter owns the element. */
  setMuted: (muted: boolean) => void;
  provider: 'dash' | 'reddit';
}

/** Loads dash.js and wires it onto an existing `<video>`. Returns `null` if aborted. */
export async function attachDash(opts: AttachDashOptions): Promise<DashHandle | null> {
  const { el, url, ctx, caps } = opts;
  const mod = await import('dashjs');
  if (ctx.signal.aborted) return null;

  const { MediaPlayer } = mod;
  const player = MediaPlayer().create();
  let audioFailures = 0;
  let audioDropped = false;

  // A page that lives for weeks must not accumulate buffer forever. dash.js
  // accepts a deep PARTIAL here while its shipped .d.ts declares the complete
  // settings object, so the shape is built separately and handed over widened.
  const settings = {
    streaming: {
      buffer: { bufferTimeAtTopQuality: BUFFER_SEC, bufferToKeep: BUFFER_KEEP_SEC },
    },
  } as unknown as Parameters<MediaPlayerClass['updateSettings']>[0];
  player.updateSettings(settings);

  player.on(MediaPlayer.events.ERROR, (e: unknown) => {
    const mediaType = failingMediaType(e);

    if (mediaType === 'audio' && !audioDropped) {
      audioFailures += 1;
      if (audioFailures >= AUDIO_FAILURE_LIMIT) {
        // §1.5 — the whole point. v.redd.it's audio set 403s; the LCD is muted;
        // carry on with video and say so once, in telemetry.
        audioDropped = true;
        opts.setMuted(true);
        publish({
          code: 'dash-audio-dropped',
          severity: 'warn',
          provider: opts.provider,
          message: 'the audio AdaptationSet kept failing; playing video only',
        });
      }
      return;
    }

    if (!isFatalDashError(e)) return;

    ctx.emit({
      type: 'error',
      err: videoError('source-unplayable', describeDashError(e), opts.provider, url),
    });
  });

  player.on(MediaPlayer.events.STREAM_INITIALIZED, () => {
    // The manifest is parsed and the representations exist: this is the only
    // moment the ladder is knowable, and the UI is waiting for it.
    try {
      const reps = player.getRepresentationsByType('video');
      caps.canSetQuality = reps.length > 1;
      ctx.emit({ type: 'levels', levels: describeLevels(reps) });
    } catch {
      /* a player torn down inside the event still must not throw here */
    }
    if (player.isDynamic()) {
      // §3.2 — a dynamic (live) MPD has a sliding window; nothing to loop.
      caps.canSeek = false;
      caps.reportsDuration = false;
      publish({
        code: 'loop-unavailable-live',
        severity: 'info',
        provider: opts.provider,
        message: 'dynamic MPD — A-B loop disabled',
      });
    }
  });

  // `initialize(view, source, autoPlay)` maps 1:1 onto the base adapter's
  // element — which is exactly why dash.js was chosen over shaka's
  // `Player` + `attach()` + `load()` lifecycle.
  player.initialize(el, url, true);

  return {
    player,
    destroy: () => {
      try {
        player.reset();
        player.destroy();
      } catch {
        /* a player whose element already went away throws; not a failure */
      }
    },
    setQuality: (heightHint: number) => {
      try {
        if (isAutoQualityHint(heightHint)) {
          // dash.js 5: pinning a representation implicitly turns ABR off for
          // that type, and it does NOT come back on by itself. Handing control
          // back is a settings write, not a representation call — forgetting it
          // is how "Auto" silently stays stuck on whatever was last pinned.
          player.updateSettings(setAutoSwitch(true));
          return true;
        }
        const reps = player.getRepresentationsByType('video');
        if (reps.length === 0) return false;
        let best = -1;
        let bestH = -1;
        for (const [i, rep] of reps.entries()) {
          const h = rep.height;
          if (h <= heightHint && h > bestH) {
            best = i;
            bestH = h;
          }
        }
        player.updateSettings(setAutoSwitch(false));
        player.setRepresentationForTypeByIndex('video', best >= 0 ? best : 0);
        return true;
      } catch {
        return false;
      }
    },
    getQuality: () => {
      try {
        const height = player.getCurrentRepresentationForType('video')?.height ?? null;
        return { height, label: height === null ? null : `${String(height)}p` };
      } catch {
        return { height: null, label: null };
      }
    },
  };
}

export function createAdapter(): HtmlVideoAdapter {
  let handle: DashHandle | null = null;

  const adapter = createHtmlVideoAdapter({
    id: 'dash',
    caps: { canSeekSilently: false, canSetQuality: true, canReadQuality: true },

    attach: async (el, ctx) => {
      handle = await attachDash({
        el,
        url: ctx.match.url,
        ctx,
        caps: adapter.capabilities,
        setMuted: (m) => {
          adapter.setMuted(m);
        },
        provider: 'dash',
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
