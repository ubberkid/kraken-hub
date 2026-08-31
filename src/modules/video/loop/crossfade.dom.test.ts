/**
 * §3.6 — the dual-`<video>` crossfade.
 *
 * The gating (`crossfadeAllowed`) is pure and lives in `LoopEngine.test.ts`.
 * What is tested here is the part that needs a document: that a second element
 * really is created, that the fade begins one `crossfadeMs` before the seam and
 * not a tick earlier, that the two elements swap roles afterwards, and that
 * tearing the loop down leaves exactly one element behind.
 *
 * jsdom has no media pipeline, so `play`/`pause`/`load` are stubbed and
 * `currentTime` is a plain property. That is fine: every decision this module
 * makes is arithmetic on `currentTime`, `end` and `playbackRate`.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCrossfade, createCrossfadeLoop, crossfadeAllowed } from './crossfade';

const FADE_MS = 250;
const FADE_SEC = 0.25;

beforeAll(() => {
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => undefined;
  HTMLMediaElement.prototype.load = () => undefined;
});

function fakeVideo(): HTMLVideoElement {
  const el = document.createElement('video');
  let t = 0;
  Object.defineProperty(el, 'currentTime', {
    configurable: true,
    get: () => t,
    set: (v: number) => {
      t = v;
    },
  });
  Object.defineProperty(el, 'playbackRate', { configurable: true, writable: true, value: 1 });
  return el;
}

let host: HTMLElement;
let primary: HTMLVideoElement;

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  primary = fakeVideo();
  primary.style.width = '640px';
  primary.style.height = '640px';
  host.append(primary);
});

afterEach(() => {
  vi.useRealTimers();
  host.remove();
});

describe('createCrossfade', () => {
  it('makes a second element that shares the source and starts hidden', () => {
    const cf = createCrossfade({
      primary,
      src: 'blob:kraken',
      start: 0,
      end: 10,
      crossfadeMs: FADE_MS,
    });
    expect(cf.secondary).not.toBe(primary);
    expect(cf.secondary.tagName).toBe('VIDEO');
    expect(cf.secondary.src).toBe('blob:kraken');
    expect(cf.secondary.style.opacity).toBe('0');
    expect(cf.secondary.muted).toBe(true);
    cf.destroy();
  });

  it('does not fade until one crossfadeMs before the seam', () => {
    const onCrossing = vi.fn();
    const cf = createCrossfade({
      primary,
      src: 'blob:kraken',
      start: 0,
      end: 10,
      crossfadeMs: FADE_MS,
      onCrossing,
    });
    host.append(cf.secondary);

    primary.currentTime = 10 - FADE_SEC - 0.01;
    expect(cf.tick()).toBe(false);
    expect(onCrossing).not.toHaveBeenCalled();

    primary.currentTime = 10 - FADE_SEC;
    expect(cf.tick()).toBe(true);
    expect(onCrossing).toHaveBeenCalledTimes(1);
    cf.destroy();
  });

  it('swaps the two elements once the fade has run', () => {
    const cf = createCrossfade({
      primary,
      src: 'blob:kraken',
      start: 0,
      end: 10,
      crossfadeMs: FADE_MS,
    });
    const clone = cf.secondary;
    host.append(clone);

    primary.currentTime = 10;
    cf.tick();
    // Mid-fade the roles are unchanged; the clone is the one coming up.
    expect(cf.secondary).toBe(clone);
    expect(clone.style.opacity).toBe('1');
    expect(primary.style.opacity).toBe('0');

    vi.advanceTimersByTime(FADE_MS);
    // The clone is now the visible element, so the ORIGINAL is the idle one.
    expect(cf.secondary).toBe(primary);
    cf.destroy();
  });

  it('never fades while the span is disabled', () => {
    const cf = createCrossfade({
      primary,
      src: 'blob:kraken',
      start: 0,
      end: Number.NaN,
      crossfadeMs: FADE_MS,
    });
    primary.currentTime = 999;
    expect(cf.tick()).toBe(false);
    cf.destroy();
  });

  it('keeps the idle element the same size as the primary', () => {
    const cf = createCrossfade({
      primary,
      src: 'blob:kraken',
      start: 0,
      end: 10,
      crossfadeMs: FADE_MS,
    });
    primary.style.width = '1080px';
    primary.style.height = '1080px';
    cf.tick();
    expect(cf.secondary.style.width).toBe('1080px');
    expect(cf.secondary.style.height).toBe('1080px');
    cf.destroy();
  });
});

describe('createCrossfadeLoop', () => {
  it('is inactive until it is given a finite span', () => {
    const loop = createCrossfadeLoop({ primary, src: 'blob:kraken', crossfadeMs: FADE_MS });
    expect(loop.isActive()).toBe(false);
    loop.setSpan(0, 10);
    expect(loop.isActive()).toBe(true);
    loop.disable();
    expect(loop.isActive()).toBe(false);
    loop.setSpan(0, Number.NaN);
    expect(loop.isActive()).toBe(false);
    loop.stop();
  });

  it('counts crossings and removes its element on stop', () => {
    const loop = createCrossfadeLoop({ primary, src: 'blob:kraken', crossfadeMs: FADE_MS });
    host.append(loop.secondary);
    expect(host.querySelectorAll('video')).toHaveLength(2);

    loop.setSpan(0, 10);
    loop.start();
    primary.currentTime = 10;
    // Drive the fade through the same rAF the loop uses.
    vi.advanceTimersByTime(FADE_MS * 2);
    expect(loop.crossings()).toBeGreaterThanOrEqual(1);

    loop.stop();
    expect(host.querySelectorAll('video')).toHaveLength(1);
  });
});

describe('crossfadeAllowed is the single gate the display consults', () => {
  const base = { mode: 'crossfade', provider: 'local-file', perf: 'quality' } as const;

  it('refuses at or below 10 target FPS and allows just above it', () => {
    expect(crossfadeAllowed({ ...base, targetFps: 10 })).toBe(false);
    expect(crossfadeAllowed({ ...base, targetFps: 11 })).toBe(true);
  });

  it('refuses in performance mode and for every non-file provider', () => {
    expect(crossfadeAllowed({ ...base, perf: 'performance', targetFps: 40 })).toBe(false);
    for (const provider of ['youtube-embed', 'hls', 'dash', 'twitch', 'vimeo', 'streamable']) {
      expect(crossfadeAllowed({ ...base, provider, targetFps: 40 })).toBe(false);
    }
  });
});
