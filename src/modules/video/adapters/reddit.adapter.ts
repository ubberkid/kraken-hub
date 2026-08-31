/**
 * `reddit` — v.redd.it, resolved at mount (design-videoEngine.md §1.5).
 *
 * The important simplification, restated: **the Kraken display is always muted**,
 * so v.redd.it's split-audio problem does not affect the LCD at all. Reddit
 * publishes its renditions as plain progressive files next to the manifest —
 * `https://v.redd.it/<id>/DASH_1080.mp4` and friends — and `v.redd.it` sends
 * `Access-Control-Allow-Origin: *`. So the muted path is:
 *
 *   1. probe `DASH_1080 → 720 → 480 → 360` with a throwaway
 *      `<video preload="metadata">` and a 4 s timeout each;
 *   2. play the first one that produces `loadedmetadata` as a plain
 *      `direct-file`, skipping the dash.js bundle entirely;
 *   3. only if the user opted audio in, **or** the whole ladder failed, load
 *      dash.js and mount `DASHPlaylist.mpd`.
 *
 * Step 2 is worth the probe: it removes ~130 kB gzip of library, an MSE
 * pipeline, and the audio-403 failure mode from the common case — on a device
 * whose frame budget is the scarce resource.
 */

import { publish } from '../telemetry/videoTelemetry';

import { createHtmlVideoAdapter, type HtmlVideoAdapter } from './HtmlVideoAdapterBase';

import type { DashHandle } from './dash.adapter';

/**
 * §1.5 — probed in this order, highest first.
 *
 * The rungs are named individually because invariant I5 (`no-magic-numbers`)
 * exempts `const` initialisers and object properties, but not array elements.
 */
const RUNG = { p1080: 1080, p720: 720, p480: 480, p360: 360 } as const;
export const REDDIT_LADDER: readonly number[] = [RUNG.p1080, RUNG.p720, RUNG.p480, RUNG.p360];
/** §1.5 — each rung gets 4 s to produce metadata before we move on. */
export const REDDIT_PROBE_TIMEOUT_MS = 4000;

/** `https://v.redd.it/<id>` → the progressive rendition URL for one rung. */
export function redditRenditionUrl(baseUrl: string, height: number): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}/DASH_${String(height)}.mp4`;
}

export function redditManifestUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/DASHPlaylist.mpd`;
}

export function redditLadderUrls(baseUrl: string): string[] {
  return REDDIT_LADDER.map((h) => redditRenditionUrl(baseUrl, h));
}

export interface ProbeDeps {
  /** Injected in tests. Resolves true when the URL produced `loadedmetadata`. */
  probe?: (url: string, timeoutMs: number, signal: AbortSignal) => Promise<boolean>;
}

/**
 * One throwaway element per rung. `preload="metadata"` means we pay for the
 * `moov` atom and nothing else, and the element is torn down whether it
 * succeeded, errored or timed out — a leaked probe element keeps a socket open.
 */
function probeWithVideoElement(
  url: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const el = document.createElement('video');
    el.preload = 'metadata';
    el.muted = true;
    el.playsInline = true;
    let settled = false;

    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
      el.removeAttribute('src');
      el.load();
      resolve(ok);
    };
    const onMeta = (): void => {
      finish(el.videoWidth > 0);
    };
    const onError = (): void => {
      finish(false);
    };
    const onAbort = (): void => {
      finish(false);
    };

    const timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    el.src = url;
    el.load();
  });
}

/** Walks the ladder top-down and returns the first URL that answered. */
export async function probeRedditLadder(
  baseUrl: string,
  signal: AbortSignal,
  deps: ProbeDeps = {},
): Promise<string | null> {
  const probe = deps.probe ?? probeWithVideoElement;
  for (const url of redditLadderUrls(baseUrl)) {
    if (signal.aborted) return null;
    if (await probe(url, REDDIT_PROBE_TIMEOUT_MS, signal)) return url;
  }
  return null;
}

export function createAdapter(deps: ProbeDeps = {}): HtmlVideoAdapter {
  let handle: DashHandle | null = null;

  const adapter = createHtmlVideoAdapter({
    id: 'reddit',
    caps: { canSeekSilently: false },

    attach: async (el, ctx) => {
      const base = ctx.match.url;

      if (!ctx.config.audioEnabled) {
        const direct = await probeRedditLadder(base, ctx.signal, deps);
        if (ctx.signal.aborted) return;
        if (direct !== null) {
          publish({
            code: 'reddit-direct-rendition',
            severity: 'info',
            provider: 'reddit',
            message: direct.slice(direct.lastIndexOf('/') + 1),
          });
          el.src = direct;
          el.load();
          return;
        }
        publish({
          code: 'reddit-ladder-failed',
          severity: 'warn',
          provider: 'reddit',
          message: 'no DASH_<h>.mp4 rendition answered; falling back to the manifest',
        });
      }

      // Audio was asked for, or every rung failed. Either way the manifest is
      // the remaining option, and dash.js is loaded only now.
      const { attachDash } = await import('./dash.adapter');
      if (ctx.signal.aborted) return;
      adapter.capabilities.canSetQuality = true;
      adapter.capabilities.canReadQuality = true;
      handle = await attachDash({
        el,
        url: redditManifestUrl(base),
        ctx,
        caps: adapter.capabilities,
        setMuted: (m) => {
          adapter.setMuted(m);
        },
        provider: 'reddit',
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
