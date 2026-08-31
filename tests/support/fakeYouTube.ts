import type { Page } from '@playwright/test';

/**
 * A minimal, deterministic stand-in for the YouTube IFrame Player API.
 *
 * Why a fake at all: the geometry engine's contract with YouTube is entirely
 * *observable from our side* — the element width we mount, the transform we
 * write, the calls we make, and the mask we raise in response to player states.
 * None of that needs YouTube's servers, and depending on them would make CI fail
 * for reasons that have nothing to do with this repo (rate limits, ads, a
 * changed player build, no network on a runner).
 *
 * What is therefore NOT proved here, and is proved by `npm run test:e2e:live`
 * instead: that YouTube actually serves 1080p to a 1920-wide element, and that
 * its real chrome lands where the crop expects it. Those are claims about
 * YouTube; everything else is a claim about us.
 *
 * The fake records every call it receives, which is what lets a test assert the
 * single most important negative in the whole module: **`pauseVideo` is never
 * called**, because it raises a suggested-video grid inside the video rect.
 */

export interface FakeYouTubeConfig {
  /** Seconds. */
  duration?: number;
  /** The label reported by `onPlaybackQualityChange` right after `onReady`. */
  quality?: string;
  /** `getVideoLoadedFraction()`. */
  loadedFraction?: number;
  /** Wall-clock ms before `onReady` fires. */
  readyDelayMs?: number;
}

/** The recorder the fake exposes on `window.__ytFake`. */
export interface FakeYouTubeRecorder {
  calls: string[];
  emitState: (state: number) => void;
  emitQuality: (label: string) => void;
  playerCount: number;
}

const FAKE_API_SCRIPT = String.raw`
(function () {
  var cfg = window.__ytFakeConfig || {};
  var duration = cfg.duration === undefined ? 60 : cfg.duration;
  var quality = cfg.quality === undefined ? 'hd1080' : cfg.quality;
  var loaded = cfg.loadedFraction === undefined ? 1 : cfg.loadedFraction;
  var readyDelay = cfg.readyDelayMs === undefined ? 10 : cfg.readyDelayMs;

  var rec = window.__ytFake || { calls: [], playerCount: 0 };
  window.__ytFake = rec;

  function Player(el, options) {
    var self = this;
    var events = (options && options.events) || {};
    var t = 0;
    var state = -1;
    var rate = 1;
    var playing = false;
    var dead = false;
    var readyFired = false;
    var last = performance.now();

    rec.playerCount += 1;
    rec.calls.push('construct');

    function setState(s) {
      state = s;
      if (events.onStateChange) events.onStateChange({ target: self, data: s });
    }

    function step() {
      if (dead) return;
      var now = performance.now();
      if (playing) t += ((now - last) / 1000) * rate;
      last = now;
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);

    /*
     * REAL TIMING, deliberately.
     *
     * new YT.Player() returns a bare object: the IFrame API grafts its methods
     * on only after the postMessage handshake, i.e. at onReady. A fake that
     * hands out working methods immediately cannot see the production bug where
     * setMuted(true) ran before the handshake and threw
     * "r?.mute is not a function" on hardware.
     *
     * So every method sits behind a getter that, before ready, records
     * preready:<name> and returns undefined -- exactly what the real API does,
     * TypeError and all. Those entries in rec.calls are the assertable signal.
     */
    var impl = {
      playVideo: function () {
        rec.calls.push('playVideo');
        playing = true;
        last = performance.now();
        if (state !== 1) setState(1);
      },
      /* Recorded, never expected. See the file header. */
      pauseVideo: function () {
        rec.calls.push('pauseVideo');
        playing = false;
        setState(2);
      },
      seekTo: function (sec) {
        rec.calls.push('seekTo:' + Number(sec).toFixed(2));
        t = Number(sec);
        last = performance.now();
      },
      mute: function () { rec.calls.push('mute'); },
      unMute: function () { rec.calls.push('unMute'); },
      setPlaybackRate: function (r) { rec.calls.push('setPlaybackRate:' + r); rate = r; },
      getAvailablePlaybackRates: function () { return [0.25, 0.5, 1, 1.5, 2]; },
      getCurrentTime: function () { return t; },
      getDuration: function () { return duration; },
      getVideoLoadedFraction: function () { return loaded; },
      getPlaybackQuality: function () { return quality; },
      getPlayerState: function () { return state; },
      destroy: function () { rec.calls.push('destroy'); dead = true; playing = false; },
    };

    Object.keys(impl).forEach(function (name) {
      Object.defineProperty(self, name, {
        configurable: true,
        enumerable: true,
        get: function () {
          if (!readyFired) {
            rec.calls.push('preready:' + name);
            return undefined;
          }
          return impl[name];
        },
      });
    });

    /* Drive states and quality reports from the test. */
    rec.emitState = function (s) { setState(s); };
    rec.emitQuality = function (label) {
      quality = label;
      if (events.onPlaybackQualityChange) {
        events.onPlaybackQualityChange({ target: self, data: label });
      }
    };

    setTimeout(function () {
      if (dead) return;
      readyFired = true;
      if (events.onReady) events.onReady({ target: self });
      if (events.onPlaybackQualityChange) {
        events.onPlaybackQualityChange({ target: self, data: quality });
      }
    }, readyDelay);
  }

  window.YT = {
    Player: Player,
    PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
  };
  if (typeof window.onYouTubeIframeAPIReady === 'function') window.onYouTubeIframeAPIReady();
})();
`;

/**
 * Routes the three YouTube hosts the module touches, and seeds the fake's
 * config before any app code runs.
 *
 * The embed host is served a blank black document rather than aborted: the
 * geometry under test is the size of OUR iframe element, and a failed
 * navigation inside it would be an unrelated console error in every test.
 */
export async function installFakeYouTube(page: Page, cfg: FakeYouTubeConfig = {}): Promise<void> {
  await page.addInitScript((value) => {
    (window as unknown as { __ytFakeConfig: unknown }).__ytFakeConfig = value;
  }, cfg);

  await page.route('https://www.youtube.com/iframe_api*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript; charset=utf-8',
      body: FAKE_API_SCRIPT,
    }),
  );

  await page.route('https://www.youtube-nocookie.com/embed/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><meta charset="utf-8"><body style="margin:0;background:#111"></body>',
    }),
  );

  // No poster: the mask controller must fall back to its flat colour, which is
  // also what performance mode uses, so this exercises the third fallback.
  await page.route('https://i.ytimg.com/**', (route) => route.abort());
}

/**
 * Every player method the adapter reached for BEFORE the fake fired `onReady`.
 *
 * On the real API those reads return `undefined` and the call throws, which is
 * how `r?.mute is not a function` reached hardware. Any non-empty result here
 * is that bug, reproduced.
 */
export async function readPrereadyCalls(page: Page): Promise<string[]> {
  return (await readFakeCalls(page))
    .filter((c) => c.startsWith('preready:'))
    .map((c) => c.slice('preready:'.length));
}

/** Everything the fake recorded, read out of the page. */
export function readFakeCalls(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __ytFake?: { calls: string[] } }).__ytFake?.calls ?? [],
  );
}

export function emitPlayerState(page: Page, state: number): Promise<void> {
  return page.evaluate((s) => {
    (window as unknown as { __ytFake?: { emitState?: (n: number) => void } }).__ytFake?.emitState?.(
      s,
    );
  }, state);
}

export function emitQuality(page: Page, label: string): Promise<void> {
  return page.evaluate((l) => {
    (
      window as unknown as { __ytFake?: { emitQuality?: (s: string) => void } }
    ).__ytFake?.emitQuality?.(l);
  }, label);
}

/** The IFrame API's player states, for readable tests. */
export const YT_PLAYER_STATE = {
  unstarted: -1,
  ended: 0,
  playing: 1,
  paused: 2,
  buffering: 3,
  cued: 5,
} as const;
