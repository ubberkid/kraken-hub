/**
 * Single-flight loader for the YouTube IFrame Player API
 * (design-videoEngine.md §2.5).
 *
 * Three things this has to get right, all of which have bitten people:
 *
 *  1. **Single flight.** The API installs exactly one global callback and one
 *     global `window.YT`. Injecting the script twice produces two loads racing
 *     for the same globals; the second one can clobber a `YT` that already has
 *     live players attached.
 *  2. **Chain, never replace, `window.onYouTubeIframeAPIReady`.** A page may
 *     already define it — another embed, a browser extension, a fork that
 *     mounts two video modules. Replacing it silently breaks them.
 *  3. **A hard timeout.** The Kraken Browser has no user watching it and no way
 *     to click "reload". If the script never arrives (offline, a corporate
 *     proxy, a CAM webview that blocks cross-origin scripts — H05), the promise
 *     must reject with a specific error so the display renders a card instead of
 *     sitting on a black screen forever.
 */

import { YT_IFRAME_API_SRC } from '../../../config/knownHosts';
import { fail } from '../adapters/VideoAdapter';

/** §2.5 — 10 s, then `yt-api-unavailable`. */
export const YT_API_TIMEOUT_MS = 10_000;

const SCRIPT_ID = 'kh-yt-iframe-api';

export interface LoadYtApiOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

let pending: Promise<YtApi.Namespace> | null = null;

/** Tests only: forgets the in-flight/settled promise so the next call re-loads. */
export function resetYtApiLoader(): void {
  pending = null;
}

function readyNamespace(): YtApi.Namespace | null {
  const ns = window.YT;
  // `window.YT` appears BEFORE `YT.Player` is defined during the API's own
  // bootstrap, so the constructor — not the namespace — is the readiness test.
  return ns !== undefined && typeof ns.Player === 'function' ? ns : null;
}

function injectScript(): void {
  if (document.getElementById(SCRIPT_ID) !== null) return;
  const script = document.createElement('script');
  script.id = SCRIPT_ID;
  script.src = YT_IFRAME_API_SRC;
  script.async = true;
  document.head.append(script);
}

/**
 * Resolves with `window.YT` once `YT.Player` is constructible. Concurrent calls
 * share one promise; a rejected load is forgotten so a later retry (§7.4's
 * backoff) genuinely retries.
 */
export function loadYtApi(opts: LoadYtApiOptions = {}): Promise<YtApi.Namespace> {
  const ready = readyNamespace();
  if (ready !== null) return Promise.resolve(ready);

  pending ??= new Promise<YtApi.Namespace>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      pending = null;
      reject(
        fail(
          'yt-api-unavailable',
          'YouTube’s player API did not load. Check the network, or use a local clip.',
          'youtube-embed',
        ),
      );
    }, opts.timeoutMs ?? YT_API_TIMEOUT_MS);

    const finish = (): void => {
      const ns = readyNamespace();
      if (settled || ns === null) return;
      settled = true;
      clearTimeout(timer);
      resolve(ns);
    };

    // Chain: whatever was there runs first, and keeps running on later loads.
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      finish();
    };

    injectScript();
    // The API may already have fired between the readiness check and the
    // callback install (a warm cache makes this a real race, not a theoretical
    // one), so check once more now that the chain is in place.
    finish();
  });

  return pending;
}
