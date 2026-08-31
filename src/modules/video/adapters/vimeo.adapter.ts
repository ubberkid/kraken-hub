/**
 * `vimeo` — player.js, lazily loaded (design-videoEngine.md §1.2, §3.4, §3.5).
 *
 * Two honest limitations, both documented in `docs/providers.md` and both
 * encoded here rather than papered over:
 *
 *  - **Quality is read-only for us.** `player.setQuality()` exists, but it is
 *    gated on the *uploader's* Vimeo tier (Plus/PRO/Business); for an ordinary
 *    public video it silently does nothing. So `canSetQuality` is `false` and
 *    the geometry crop is the only lever we actually have — the same lever that
 *    works on YouTube.
 *  - **Pause shows a play button and the title.** So `hold()` raises the mask
 *    *first*, waits, and only then pauses (§3.5). Doing it the other way round
 *    means one frame of Vimeo's UI on the LCD.
 *
 * And one rule that looks like an optimisation and is not: **never call
 * `setLoop(true)`.** It suppresses the `ended` event, which is the failure
 * signal the loop engine uses when a span is wrong (§3.4).
 *
 * Vimeo's getters are all Promises, so the clock is polled at 10 Hz with an
 * in-flight guard and `timeupdate`'s payload is the primary reading — exactly
 * as §3.4 prescribes.
 */

import { VIMEO_PLAYER_SCRIPT, vimeoEmbedUrl } from '../../../config/knownHosts';
import { ASPECT_16_9 } from '../types';

import {
  applyEmbedSize,
  createEmbedIframe,
  embedGeometry,
  embedSourceRect,
  loadEmbedScript,
} from './embedSurface';
import { fail, videoError } from './VideoAdapter';

import type { AdapterEvent, MountContext, SeekOptions, VideoAdapter } from './VideoAdapter';
import type { ProviderCapabilities, SourceRect } from '../types';

const SDK_TIMEOUT_MS = 10_000;
/** §3.4 — 10 Hz with an in-flight guard; `timeupdate` is the primary clock. */
const POLL_MS = 100;
/** §3.5 — two frames of mask before the pause, so the play button never lands. */
const MASK_SETTLE_MS = 60;
const RATE_MIN = 0.5;
const RATE_MAX = 2;

/** §1.2 — the vimeo row. Quality is deliberately `false`; see the header. */
export const VIMEO_CAPS: ProviderCapabilities = {
  canSeekSilently: false,
  canSetQuality: false,
  canReadQuality: false,
  hasOwnChrome: true,
  needsMuteForAutoplay: true,
  canTruePause: true,
  // `setPlaybackRate` is itself PRO-gated; we ask, and tolerate a rejection.
  canSetRate: true,
  canSeek: true,
  reportsDuration: true,
  pixelSource: 'cross-origin-iframe',
};

export function createAdapter(): VideoAdapter {
  const capabilities: ProviderCapabilities = { ...VIMEO_CAPS };

  let ctx: MountContext | null = null;
  let iframe: HTMLIFrameElement | null = null;
  let player: VimeoApi.Player | null = null;
  let rect: SourceRect | null = null;
  let duration = Number.NaN;
  let lastTime = 0;
  let bufferedEnd = 0;
  let held = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let clockInFlight = false;
  let tornDown = false;
  /**
   * Read through a function on purpose: `tornDown` is flipped by `teardown()`,
   * which can run between two `await`s, and TypeScript's control-flow analysis
   * would otherwise keep narrowing it to `false` across them.
   */
  const isTornDown = (): boolean => tornDown;
  const off: (() => void)[] = [];

  const emit = (e: AdapterEvent): void => {
    if (!tornDown) ctx?.emit(e);
  };

  function publishGeometry(c: MountContext): void {
    const g = embedGeometry(c, ASPECT_16_9);
    rect = embedSourceRect(g, ASPECT_16_9);
    if (iframe !== null) applyEmbedSize(iframe, g.elementW, g.elementH);
    emit({ type: 'sourcerect', rect });
  }

  function pollClock(): void {
    const p = player;
    if (p === null || tornDown || clockInFlight) return;
    clockInFlight = true;
    void p
      .getCurrentTime()
      .then((t) => {
        if (Number.isFinite(t)) lastTime = t;
      })
      .catch(() => {
        /* a destroyed player rejects; the teardown path already handled it */
      })
      .finally(() => {
        clockInFlight = false;
      });
  }

  return {
    id: 'vimeo',
    capabilities,

    async mount(next) {
      ctx = next;
      const id = next.match.id;
      if (id === null || id === '') {
        throw fail(
          'source-unplayable',
          'That Vimeo link has no video id in it.',
          'vimeo',
          next.url,
        );
      }

      const g = embedGeometry(next, ASPECT_16_9);
      const el = createEmbedIframe({
        src: vimeoEmbedUrl(id, next.match.meta.hash),
        width: g.elementW,
        height: g.elementH,
        allow: 'autoplay; fullscreen; picture-in-picture; encrypted-media',
        className: 'kh-video__embed-frame',
        title: 'video',
      });
      iframe = el;
      next.container.append(el);
      publishGeometry(next);

      await loadEmbedScript(VIMEO_PLAYER_SCRIPT, () => window.Vimeo !== undefined, SDK_TIMEOUT_MS);
      if (tornDown || next.signal.aborted) return;
      const api = window.Vimeo;
      if (api === undefined) {
        throw fail(
          'provider-unavailable',
          'Vimeo’s player.js loaded but exposed no player.',
          'vimeo',
          next.url,
        );
      }

      // Attach to the PRE-EXISTING iframe, so we keep ownership of its size —
      // the same reason the YouTube adapter does it (§2.5).
      const instance = new api.Player(el);
      player = instance;

      const on = (event: string, fn: (data?: unknown) => void): void => {
        instance.on(event, fn);
        off.push(() => {
          instance.off(event, fn);
        });
      };

      on('timeupdate', (data) => {
        const payload = data as { seconds?: number; duration?: number } | undefined;
        if (typeof payload?.seconds === 'number') lastTime = payload.seconds;
        if (typeof payload?.duration === 'number' && payload.duration > 0) {
          if (payload.duration !== duration) {
            duration = payload.duration;
            emit({ type: 'durationchange', duration });
          }
        }
        emit({ type: 'timeupdate', t: lastTime });
      });
      on('progress', (data) => {
        const payload = data as { seconds?: number } | undefined;
        if (typeof payload?.seconds === 'number') bufferedEnd = payload.seconds;
      });
      on('play', () => {
        held = false;
        emit({ type: 'playing' });
      });
      on('bufferstart', () => {
        emit({ type: 'buffering' });
      });
      on('bufferend', () => {
        emit({ type: 'playing' });
      });
      on('pause', () => {
        emit({ type: 'held' });
      });
      // §3.4 — `ended` is the failure signal, which is exactly why `setLoop(true)`
      // (which suppresses it) is never called.
      on('ended', () => {
        emit({ type: 'ended' });
      });
      on('error', (data) => {
        const payload = data as { message?: string } | undefined;
        emit({
          type: 'error',
          err: videoError(
            'source-unplayable',
            payload?.message ?? 'Vimeo refused to play this video here.',
            'vimeo',
            next.url,
          ),
        });
      });

      await instance.setMuted(true).catch(() => false);
      duration = await instance.getDuration().catch(() => Number.NaN);
      // `tornDown` is checked through a getter so the narrowing above the two
      // awaits does not survive them: teardown may well have run in between.
      if (isTornDown()) return;
      emit({ type: 'durationchange', duration });
      emit({ type: 'ready', duration, caps: capabilities });
      await instance.play().catch(() => {
        emit({
          type: 'error',
          err: videoError(
            'autoplay-blocked',
            'Vimeo refused to start playback without a user gesture.',
            'vimeo',
            next.url,
          ),
        });
      });
      timer = setInterval(pollClock, POLL_MS);
    },

    async play() {
      held = false;
      await player?.play().catch(() => undefined);
    },

    async hold() {
      // §3.5 — mask FIRST. Vimeo paints a play button and the title on pause,
      // and one unmasked frame of that is one frame too many on an LCD.
      ctx?.mask.showInstant();
      await new Promise<void>((resolve) => setTimeout(resolve, MASK_SETTLE_MS));
      if (tornDown) return;
      await player?.pause().catch(() => undefined);
      held = true;
      emit({ type: 'held' });
    },

    isHeld() {
      return held;
    },

    async seek(t: number, _opts?: SeekOptions) {
      await player?.setCurrentTime(Math.max(0, t)).catch(() => 0);
    },

    async setRate(r: number) {
      // PRO-gated; a rejection is expected and is not an error.
      await player?.setPlaybackRate(Math.min(RATE_MAX, Math.max(RATE_MIN, r))).catch(() => 0);
    },

    getCurrentTime() {
      return lastTime;
    },

    getDuration() {
      return duration;
    },

    getBufferedEnd() {
      return bufferedEnd;
    },

    setMuted(m: boolean) {
      void player?.setMuted(m).catch(() => false);
    },

    getSurface() {
      if (iframe === null) throw new Error('kraken-hub/video: Vimeo surface before mount');
      return iframe;
    },

    getSourceRect() {
      if (rect === null) throw new Error('kraken-hub/video: source rect before mount');
      return rect;
    },

    async teardown() {
      if (tornDown) return;
      tornDown = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      for (const remove of off.splice(0)) remove();
      await player?.destroy().catch(() => undefined);
      player = null;
      iframe?.remove();
      iframe = null;
      rect = null;
      ctx = null;
    },
  };
}
