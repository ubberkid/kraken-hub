// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VideoFailure } from '../adapters/VideoAdapter';

import { loadYtApi, resetYtApiLoader } from './ytApiLoader';

/**
 * §2.5 — the three loader rules, each of which has a specific failure mode:
 * a double injection clobbers a `YT` that already owns live players; replacing
 * `onYouTubeIframeAPIReady` silently breaks any other embed on the page; and no
 * timeout leaves a display nobody can click sitting on a black screen forever.
 */

function fakeNamespace(): YtApi.Namespace {
  return {
    Player: function Player() {
      /* not constructed in these tests */
    } as never,
  };
}

/** Simulates the real script: define `YT`, then call the global callback. */
function apiArrives(): void {
  window.YT = fakeNamespace();
  window.onYouTubeIframeAPIReady?.();
}

beforeEach(() => {
  resetYtApiLoader();
  delete window.YT;
  delete window.onYouTubeIframeAPIReady;
  document.head.replaceChildren();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('script injection', () => {
  it('injects the loader exactly once, however many callers there are', async () => {
    const a = loadYtApi();
    const b = loadYtApi();
    expect(document.querySelectorAll('script[src*="iframe_api"]')).toHaveLength(1);

    apiArrives();
    await expect(a).resolves.toBeDefined();
    // Both callers share one promise, so nobody races for `window.YT`.
    expect(await b).toBe(await a);
  });

  it('resolves immediately when the API is already present', async () => {
    window.YT = fakeNamespace();
    await expect(loadYtApi()).resolves.toBeDefined();
    expect(document.querySelectorAll('script[src*="iframe_api"]')).toHaveLength(0);
  });
});

describe('chaining the global callback', () => {
  it('runs a pre-existing onYouTubeIframeAPIReady instead of replacing it', async () => {
    const theirs = vi.fn();
    window.onYouTubeIframeAPIReady = theirs;

    const pending = loadYtApi();
    apiArrives();
    await expect(pending).resolves.toBeDefined();
    expect(theirs).toHaveBeenCalledTimes(1);
  });
});

describe('the 10 s timeout', () => {
  it('rejects with yt-api-unavailable so the display can render a card', async () => {
    const pending = loadYtApi().then(
      () => null,
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const err = await pending;

    expect(err).toBeInstanceOf(VideoFailure);
    const detail = (err as VideoFailure).detail;
    expect(detail.code).toBe('yt-api-unavailable');
    // A script that did not arrive is a network condition: it must retry.
    expect(detail.retryable).toBe(true);
  });

  it('does not reject a load that arrived just in time', async () => {
    const pending = loadYtApi();
    await vi.advanceTimersByTimeAsync(9000);
    apiArrives();
    await expect(pending).resolves.toBeDefined();
    await vi.advanceTimersByTimeAsync(5000);
  });

  it('forgets a failed load, so §7.4’s backoff genuinely retries', async () => {
    const first = loadYtApi();
    const settled = first.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await settled).toBeInstanceOf(VideoFailure);

    const second = loadYtApi();
    expect(second).not.toBe(first);
    apiArrives();
    await expect(second).resolves.toBeDefined();
  });
});
