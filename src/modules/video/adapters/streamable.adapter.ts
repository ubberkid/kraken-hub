/**
 * `streamable` — the minimal provider (design-videoEngine.md §1.2, §3.5).
 *
 * Streamable ships **no player API**. There is no `postMessage` protocol, no
 * SDK, no way to read the clock, seek, pause or change quality. The one piece of
 * machine-readable information it offers is oEmbed, and that is worth exactly
 * one thing: the source's true `width`/`height`, which lets the crop be computed
 * against the real aspect instead of an assumed 16:9. A vertical Streamable clip
 * cropped as 16:9 would show the wrong third of the picture.
 *
 * So the capability row is nearly all `false`, `hold()` is a documented no-op,
 * and the A-B loop is unavailable. That is not a gap to be filled later — it is
 * the provider. `docs/providers.md` says so in the same words.
 *
 * The oEmbed call is best-effort: it is a cross-origin `fetch`, and if it is
 * refused (or slow) we fall back to 16:9 and play anyway.
 */

import {
  STREAMABLE_OEMBED,
  streamableEmbedUrl,
  streamableWatchUrl,
} from '../../../config/knownHosts';
import { ASPECT_16_9 } from '../types';

import { applyEmbedSize, createEmbedIframe, embedGeometry, embedSourceRect } from './embedSurface';
import { fail } from './VideoAdapter';

import type { AdapterEvent, MountContext, VideoAdapter } from './VideoAdapter';
import type { ProviderCapabilities, SourceRect } from '../types';

const OEMBED_TIMEOUT_MS = 4000;

/** §1.2 — the streamable row, and it is the honest one. */
export const STREAMABLE_CAPS: ProviderCapabilities = {
  canSeekSilently: false,
  canSetQuality: false,
  canReadQuality: false,
  hasOwnChrome: true,
  needsMuteForAutoplay: true,
  // No API means no pause: `hold()` resolves and changes nothing (§3.5).
  canTruePause: false,
  canSetRate: false,
  canSeek: false,
  reportsDuration: false,
  pixelSource: 'cross-origin-iframe',
};

interface OEmbed {
  width?: unknown;
  height?: unknown;
  duration?: unknown;
}

/** oEmbed's `width`/`height` are the SOURCE dimensions, which is the useful bit. */
export function aspectFromOEmbed(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { width, height } = raw as OEmbed;
  if (typeof width !== 'number' || typeof height !== 'number') return null;
  if (width <= 0 || height <= 0) return null;
  return width / height;
}

export function durationFromOEmbed(raw: unknown): number {
  if (typeof raw !== 'object' || raw === null) return Number.NaN;
  const { duration } = raw as OEmbed;
  return typeof duration === 'number' && duration > 0 ? duration : Number.NaN;
}

export function oembedUrl(shortcode: string): string {
  return STREAMABLE_OEMBED + encodeURIComponent(streamableWatchUrl(shortcode));
}

export function createAdapter(): VideoAdapter {
  const capabilities: ProviderCapabilities = { ...STREAMABLE_CAPS };

  let ctx: MountContext | null = null;
  let iframe: HTMLIFrameElement | null = null;
  let rect: SourceRect | null = null;
  let aspect = ASPECT_16_9;
  let duration = Number.NaN;
  let tornDown = false;

  const emit = (e: AdapterEvent): void => {
    if (!tornDown) ctx?.emit(e);
  };

  function publishGeometry(c: MountContext): void {
    const g = embedGeometry(c, aspect);
    rect = embedSourceRect(g, aspect);
    if (iframe !== null) applyEmbedSize(iframe, g.elementW, g.elementH);
    emit({ type: 'sourcerect', rect });
  }

  return {
    id: 'streamable',
    capabilities,

    async mount(next) {
      ctx = next;
      const shortcode = next.match.id;
      if (shortcode === null || shortcode === '') {
        throw fail(
          'source-unplayable',
          'That Streamable link has no shortcode in it.',
          'streamable',
          next.url,
        );
      }

      const g0 = embedGeometry(next, aspect);
      const el = createEmbedIframe({
        src: streamableEmbedUrl(shortcode),
        width: g0.elementW,
        height: g0.elementH,
        allow: 'autoplay; fullscreen',
        className: 'kh-video__embed-frame',
        title: 'video',
      });
      iframe = el;
      next.container.append(el);
      publishGeometry(next);

      // Best effort, and genuinely optional: a refused oEmbed means the crop
      // assumes 16:9, which is right for the overwhelming majority of clips.
      try {
        const res = await fetch(oembedUrl(shortcode), {
          signal: AbortSignal.any([next.signal, AbortSignal.timeout(OEMBED_TIMEOUT_MS)]),
          mode: 'cors',
          credentials: 'omit',
        });
        const body: unknown = await res.json();
        if (tornDown) return;
        const measured = aspectFromOEmbed(body);
        if (measured !== null) {
          aspect = measured;
          publishGeometry(next);
        }
        duration = durationFromOEmbed(body);
        if (Number.isFinite(duration)) {
          capabilities.reportsDuration = true;
          emit({ type: 'durationchange', duration });
        }
      } catch {
        /* oEmbed is an optimisation, never a requirement */
      }

      if (tornDown) return;
      emit({ type: 'ready', duration, caps: capabilities });
      // There is no `play` event to wait for, and no clock to read: once the
      // iframe is up, the embed autoplays muted or it does not.
      emit({ type: 'playing' });
    },

    async play() {
      return Promise.resolve();
    },

    /** §3.5 — not supported. Resolves, changes nothing, and says so in caps. */
    async hold() {
      return Promise.resolve();
    },

    isHeld() {
      return false;
    },

    async seek() {
      return Promise.resolve();
    },

    async setRate() {
      return Promise.resolve();
    },

    getCurrentTime() {
      return 0;
    },

    getDuration() {
      return duration;
    },

    getBufferedEnd() {
      return 0;
    },

    setMuted() {
      // The embed is muted by URL parameter; there is no API to change it.
    },

    getSurface() {
      if (iframe === null) throw new Error('kraken-hub/video: Streamable surface before mount');
      return iframe;
    },

    getSourceRect() {
      if (rect === null) throw new Error('kraken-hub/video: source rect before mount');
      return rect;
    },

    async teardown() {
      if (tornDown) return Promise.resolve();
      tornDown = true;
      iframe?.remove();
      iframe = null;
      rect = null;
      ctx = null;
      return Promise.resolve();
    },
  };
}
