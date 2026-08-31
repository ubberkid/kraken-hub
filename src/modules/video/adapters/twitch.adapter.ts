/**
 * `twitch` — VODs, clips and live channels via the Embed JS API
 * (design-videoEngine.md §1.2, §3.4, §3.5).
 *
 * Two things make Twitch different from every other provider here.
 *
 * **`parent` is mandatory and must be computed at runtime.** Twitch refuses to
 * render `player.twitch.tv` unless every hostname that frames it is listed in
 * `parent`. Hardcoding it would mean a fork on its own `<user>.github.io`, a
 * custom domain, or plain `127.0.0.1` silently shows a black rectangle — so it
 * comes from `location.hostname` (invariant I4, and the reason the fork guide
 * has nothing to say about Twitch).
 *
 * **Quality control genuinely works.** `setQuality` is not tier-gated the way
 * Vimeo's is, so the adapter asks for the rendition that matches the crop once
 * the player is ready, instead of leaving ABR to pick for a 640 px panel it
 * cannot see.
 *
 * Live channels (`kind: 'channel'`) disable both loop and seek: there is no
 * meaningful `duration`, the window slides, and seeking into it is how you get
 * an unrecoverable spinner on a screen nobody can click (§3.2, §3.4).
 */

import { TWITCH_EMBED_SCRIPT } from '../../../config/knownHosts';
import { publish } from '../telemetry/videoTelemetry';
import { ASPECT_16_9 } from '../types';

import { applyEmbedSize, embedGeometry, embedSourceRect, loadEmbedScript } from './embedSurface';
import { fail, videoError } from './VideoAdapter';

import type { AdapterEvent, MountContext, SeekOptions, VideoAdapter } from './VideoAdapter';
import type { ProviderCapabilities, SourceRect } from '../types';

const SDK_TIMEOUT_MS = 10_000;
/** Twitch's clock is a synchronous getter, so a 250 ms emit cadence is plenty. */
const TIMEUPDATE_INTERVAL_MS = 250;
const POLL_MS = 100;

/** §1.2 — the twitch row. `canSeekSilently` is promoted at runtime (§3.4). */
export const TWITCH_CAPS: ProviderCapabilities = {
  canSeekSilently: false,
  canSetQuality: true,
  canReadQuality: true,
  hasOwnChrome: true,
  needsMuteForAutoplay: true,
  // Twitch has no pause-overlay ad grid, so pause is a real, quiet pause (§3.5).
  canTruePause: true,
  canSetRate: false,
  canSeek: true,
  reportsDuration: true,
  pixelSource: 'cross-origin-iframe',
};

/**
 * §1.4 — `parent` must list every hostname that frames the player, derived from
 * where this page actually is. Exported for the unit test, which is the only
 * place that can prove a fork's hostname flows through.
 */
export function twitchParents(hostname: string): string[] {
  return hostname === '' ? [] : [hostname];
}

/**
 * Twitch quality labels are `'chunked'` (source), `'1080p60'`, `'720p'`, `'auto'`…
 * Pick the highest that does not exceed the crop, treating `chunked` as source.
 */
export function pickTwitchQuality(
  available: readonly string[],
  wantedHeight: number,
): string | null {
  let best: string | null = null;
  let bestH = -1;
  for (const q of available) {
    const h = twitchQualityHeight(q);
    if (h === null || h > wantedHeight) continue;
    // On a tie, prefer an explicit rendition over `chunked`: `chunked` is the
    // untranscoded source, so it carries the streamer's full bitrate even when
    // its resolution matches — and bitrate is what costs frames here.
    if (h > bestH || (h === bestH && best === SOURCE_LABEL)) {
      best = q;
      bestH = h;
    }
  }
  if (best !== null) return best;
  // Nothing fits: take the lowest real rendition rather than leaving ABR to
  // pick a 4 Mbit source stream for a 640 px panel.
  let lowest: string | null = null;
  let lowestH = Number.POSITIVE_INFINITY;
  for (const q of available) {
    const h = twitchQualityHeight(q);
    if (h !== null && h < lowestH) {
      lowest = q;
      lowestH = h;
    }
  }
  return lowest;
}

export function twitchQualityHeight(label: string): number | null {
  if (label === SOURCE_LABEL) return SOURCE_HEIGHT;
  const m = /^(\d{3,4})p/.exec(label);
  return m === null ? null : Number(m[1]);
}

/** `chunked` is Twitch's name for the un-transcoded source; treat it as 1080p+. */
const SOURCE_LABEL = 'chunked';
const SOURCE_HEIGHT = 1080;

export function createAdapter(): VideoAdapter {
  const capabilities: ProviderCapabilities = { ...TWITCH_CAPS };

  let ctx: MountContext | null = null;
  let host: HTMLElement | null = null;
  let player: TwitchApi.Player | null = null;
  let rect: SourceRect | null = null;
  let duration = Number.NaN;
  let lastTime = 0;
  let lastTimeUpdate = 0;
  let held = false;
  let isLive = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let tornDown = false;
  const off: (() => void)[] = [];

  const emit = (e: AdapterEvent): void => {
    if (!tornDown) ctx?.emit(e);
  };

  function publishGeometry(c: MountContext): void {
    const g = embedGeometry(c, ASPECT_16_9);
    rect = embedSourceRect(g, ASPECT_16_9);
    if (host !== null) {
      host.style.width = `${String(g.elementW)}px`;
      host.style.height = `${String(g.elementH)}px`;
      const frame = host.querySelector('iframe');
      if (frame !== null) applyEmbedSize(frame, g.elementW, g.elementH);
    }
    emit({ type: 'sourcerect', rect });
    return;
  }

  function tick(): void {
    const p = player;
    if (p === null || tornDown) return;
    const t = p.getCurrentTime();
    if (Number.isFinite(t)) lastTime = t;
    if (!isLive && (!Number.isFinite(duration) || duration <= 0)) {
      const d = p.getDuration();
      if (Number.isFinite(d) && d > 0) {
        duration = d;
        emit({ type: 'durationchange', duration });
      }
    }
    const now = Date.now();
    if (now - lastTimeUpdate >= TIMEUPDATE_INTERVAL_MS) {
      lastTimeUpdate = now;
      emit({ type: 'timeupdate', t: lastTime });
    }
  }

  return {
    id: 'twitch',
    capabilities,

    async mount(next) {
      ctx = next;
      const id = next.match.id;
      if (id === null || id === '') {
        throw fail('source-unplayable', 'That Twitch link has no id in it.', 'twitch', next.url);
      }
      const kind = next.match.meta.kind ?? 'vod';
      isLive = kind === 'channel';
      if (isLive) {
        // §3.2/§3.4 — a live channel has no end and no stable timeline.
        capabilities.canSeek = false;
        capabilities.reportsDuration = false;
        publish({
          code: 'loop-unavailable-live',
          severity: 'info',
          provider: 'twitch',
          message: 'live channel — A-B loop and seek disabled',
        });
      }

      // The SDK writes its own iframe into a host element, so unlike YouTube we
      // do not pre-create it — but we still own the host's layout box, which is
      // what the geometry crop is measured against.
      const container = document.createElement('div');
      container.className = 'kh-video__embed';
      container.style.display = 'block';
      host = container;
      next.container.append(container);
      publishGeometry(next);

      await loadEmbedScript(TWITCH_EMBED_SCRIPT, () => window.Twitch !== undefined, SDK_TIMEOUT_MS);
      if (tornDown || next.signal.aborted) return;
      const api = window.Twitch;
      if (api === undefined) {
        throw fail(
          'provider-unavailable',
          'Twitch’s embed script loaded but exposed no player.',
          'twitch',
          next.url,
        );
      }

      const g = embedGeometry(next, ASPECT_16_9);
      const options: TwitchApi.PlayerOptions = {
        width: g.elementW,
        height: g.elementH,
        // Runtime, never baked in: this is what makes a fork work (I4).
        parent: twitchParents(window.location.hostname),
        autoplay: true,
        muted: true,
        controls: false,
      };
      // The Embed API addresses a VOD *and* a clip through `video` — there is
      // no dedicated clip field, and a clip slug is simply never numeric.
      if (kind === 'channel') options.channel = id;
      else options.video = id;

      const instance = new api.Player(container, options);
      player = instance;

      const on = (event: string, fn: () => void): void => {
        instance.addEventListener(event, fn);
        off.push(() => {
          instance.removeEventListener(event, fn);
        });
      };

      on(api.Player.READY, () => {
        if (tornDown) return;
        instance.setMuted(true);
        duration = isLive ? Number.NaN : instance.getDuration();
        // §1.2 — Twitch's quality control is real, so use it: ABR has no idea
        // the picture ends up on a 640 px panel.
        const wanted = Math.ceil(rect?.safe.h ?? 0);
        const quality = pickTwitchQuality(instance.getQualities(), wanted);
        if (quality !== null) instance.setQuality(quality);
        emit({ type: 'durationchange', duration });
        emit({ type: 'ready', duration, caps: capabilities });
        instance.play();
      });
      on(api.Player.PLAYING, () => {
        held = false;
        emit({ type: 'playing' });
      });
      on(api.Player.PAUSE, () => {
        emit({ type: 'held' });
      });
      on(api.Player.ENDED, () => {
        emit({ type: 'ended' });
      });
      on(api.Player.OFFLINE, () => {
        emit({
          type: 'error',
          err: videoError(
            'source-unplayable',
            'That Twitch channel is offline.',
            'twitch',
            next.url,
          ),
        });
      });

      timer = setInterval(tick, POLL_MS);
    },

    async play() {
      held = false;
      player?.play();
      return Promise.resolve();
    },

    async hold() {
      // §3.5 — Twitch has no pause-overlay ad grid, so a real pause is fine.
      player?.pause();
      held = true;
      emit({ type: 'held' });
      return Promise.resolve();
    },

    isHeld() {
      return held;
    },

    async seek(t: number, _opts?: SeekOptions) {
      // §3.4 — seek works for VOD and clip only; a live channel refuses.
      if (!capabilities.canSeek) return Promise.resolve();
      player?.seek(Math.max(0, t));
      return Promise.resolve();
    },

    async setRate() {
      // Twitch exposes no playback-rate control at all.
      return Promise.resolve();
    },

    getCurrentTime() {
      return lastTime;
    },

    getDuration() {
      return duration;
    },

    getBufferedEnd() {
      // The Embed API reports a buffer *size* in seconds, not an end position.
      const size = player?.getPlaybackStats()?.bufferSize ?? 0;
      return lastTime + size;
    },

    setMuted(m: boolean) {
      player?.setMuted(m);
    },

    async setQuality(heightHint: number) {
      const p = player;
      if (p === null) return Promise.resolve(false);
      const quality = pickTwitchQuality(p.getQualities(), heightHint);
      if (quality === null) return Promise.resolve(false);
      p.setQuality(quality);
      return Promise.resolve(true);
    },

    getQuality() {
      const label = player?.getQuality() ?? null;
      return { height: label === null ? null : twitchQualityHeight(label), label };
    },

    getSurface() {
      if (host === null) throw new Error('kraken-hub/video: Twitch surface before mount');
      return host;
    },

    getSourceRect() {
      if (rect === null) throw new Error('kraken-hub/video: source rect before mount');
      return rect;
    },

    async teardown() {
      if (tornDown) return Promise.resolve();
      tornDown = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      for (const remove of off.splice(0)) remove();
      try {
        player?.destroy?.();
      } catch {
        /* a player whose iframe already went away throws; not a failure */
      }
      player = null;
      host?.remove();
      host = null;
      rect = null;
      ctx = null;
      return Promise.resolve();
    },

    /** The embed paints its own chrome; the host must not fight its mask. */
    ownsMask: false,
  };
}
