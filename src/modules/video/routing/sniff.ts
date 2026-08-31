/**
 * The unknown-URL fallback chain (design-videoEngine.md §7.3).
 *
 * `detect()` settles anything with a recognisable host or extension. What is
 * left is a bare HTTPS URL — a redirect, a CDN path with no extension, a
 * signed link — and for those the routing table's answer is a guess with
 * `confidence: 0.2`. This file is what turns the guess into an answer, and the
 * ORDER is the whole design:
 *
 *  1. **`<video>` attempt first**, because plain progressive playback needs *no
 *     CORS at all*. A `<video src>` plays files that `fetch` cannot even read,
 *     and that is the majority of real-world direct links. 6 s for
 *     `loadedmetadata`.
 *  2. **Range-probe sniff** — `fetch` with `Range: bytes=0-2047`. A CORS
 *     rejection here is *expected* and is not an error; when it does succeed,
 *     the content type and the first bytes identify HLS (`#EXTM3U`) or DASH
 *     (`<MPD`) precisely.
 *  3. **Blind attempts** — `m3u` in the path means try HLS anyway; `mpd` or
 *     `manifest` means try DASH anyway.
 *  4. **Proxy retry**, only if the user configured one. Ships empty; see
 *     `types.ts` and `docs/providers.md` for why a passthrough proxy cannot fix
 *     HLS.
 *  5. **`source-unplayable`**, with every step's reason in telemetry.
 *
 * The whole chain is capped at 25 s and every step takes the `AbortSignal`, so
 * a display never sits on a spinner because one CDN decided to hang.
 */

import { publish } from '../telemetry/videoTelemetry';

import type { ProviderId } from '../types';

/** §7.3 step 1. */
export const VIDEO_PROBE_TIMEOUT_MS = 6000;
/** §7.3 step 2. */
export const RANGE_PROBE_TIMEOUT_MS = 5000;
/** §7.3 — the whole chain, end to end. */
export const CHAIN_BUDGET_MS = 25_000;
const RANGE_BYTES = 2047;

export type SniffVerdict = 'hls' | 'dash' | 'progressive' | 'unknown';

/**
 * §7.3 step 2, as a pure function so the interesting half is testable without a
 * network: content type wins, then the magic bytes.
 */
export function sniffBody(contentType: string | null, head: string): SniffVerdict {
  const ct = (contentType ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  if (
    ct === 'application/vnd.apple.mpegurl' ||
    ct === 'audio/mpegurl' ||
    ct === 'application/x-mpegurl'
  ) {
    return 'hls';
  }
  if (ct === 'application/dash+xml') return 'dash';
  const start = head.trimStart();
  if (start.startsWith('#EXTM3U')) return 'hls';
  if (start.includes('<MPD')) return 'dash';
  if (ct === 'video/mp4' || ct === 'video/webm' || ct === 'video/ogg' || ct === 'application/mp4') {
    return 'progressive';
  }
  return 'unknown';
}

/** §7.3 step 3 — the blind attempt, decided from the path alone. */
export function blindGuess(url: string): ProviderId | null {
  const path = url.toLowerCase();
  if (path.includes('m3u')) return 'hls';
  if (path.includes('mpd') || path.includes('manifest')) return 'dash';
  return null;
}

/** §7.3 step 4 — `<base><encoded url>`; empty base means "no proxy configured". */
export function proxied(base: string, url: string): string | null {
  if (base.trim() === '') return null;
  return base.endsWith('=') ? base + encodeURIComponent(url) : `${base}${url}`;
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

export interface ChainStep {
  step: string;
  ok: boolean;
  reason: string;
}

export interface ChainResult {
  provider: ProviderId | null;
  /** The URL that actually worked — may be the proxied form. */
  url: string;
  steps: ChainStep[];
}

export interface ChainDeps {
  /** Injected in tests. `true` when `<video>` produced usable metadata. */
  probeVideo?: (url: string, timeoutMs: number, signal: AbortSignal) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function probeVideoElement(url: string, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
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
      el.removeEventListener('error', onErr);
      signal.removeEventListener('abort', onErr);
      el.removeAttribute('src');
      el.load();
      resolve(ok);
    };
    const onMeta = (): void => {
      finish(el.videoWidth > 0 || Number.isFinite(el.duration));
    };
    const onErr = (): void => {
      finish(false);
    };
    const timer = setTimeout(onErr, timeoutMs);
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('error', onErr);
    signal.addEventListener('abort', onErr, { once: true });
    el.src = url;
    el.load();
  });
}

async function rangeProbe(
  url: string,
  signal: AbortSignal,
  deps: ChainDeps,
): Promise<{ verdict: SniffVerdict; reason: string }> {
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  try {
    const res = await doFetch(url, {
      method: 'GET',
      headers: { Range: `bytes=0-${String(RANGE_BYTES)}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(RANGE_PROBE_TIMEOUT_MS)]),
      mode: 'cors',
      credentials: 'omit',
    });
    const head = await res.text().catch(() => '');
    const verdict = sniffBody(res.headers.get('content-type'), head);
    return { verdict, reason: `${String(res.status)} ${verdict}` };
  } catch (err) {
    // A CORS rejection is the EXPECTED outcome for most of the web, not a bug.
    return {
      verdict: 'unknown',
      reason: err instanceof Error ? `unreadable (${err.name})` : 'unreadable',
    };
  }
}

/**
 * Runs §7.3 in order and returns the first provider that answered, or `null`
 * with the per-step reasons for the error card's telemetry.
 */
export async function runFallbackChain(
  url: string,
  opts: { proxyBase: string; signal: AbortSignal },
  deps: ChainDeps = {},
): Promise<ChainResult> {
  const now = deps.now ?? Date.now;
  const probe = deps.probeVideo ?? probeVideoElement;
  const deadline = now() + CHAIN_BUDGET_MS;
  const steps: ChainStep[] = [];

  const outOfTime = (): boolean => now() >= deadline || opts.signal.aborted;

  const attempt = async (target: string, label: string): Promise<ProviderId | null> => {
    // 1. `<video>` — no CORS needed, so it goes first.
    if (outOfTime()) return null;
    const played = await probe(target, VIDEO_PROBE_TIMEOUT_MS, opts.signal);
    steps.push({
      step: `${label}:video`,
      ok: played,
      reason: played ? 'loadedmetadata' : 'no metadata in 6 s',
    });
    if (played) return 'direct-file';

    // 2. Range probe.
    if (outOfTime()) return null;
    const sniffed = await rangeProbe(target, opts.signal, deps);
    steps.push({
      step: `${label}:range`,
      ok: sniffed.verdict !== 'unknown',
      reason: sniffed.reason,
    });
    if (sniffed.verdict === 'hls') return 'hls';
    if (sniffed.verdict === 'dash') return 'dash';
    if (sniffed.verdict === 'progressive') return 'direct-file';

    // 3. Blind attempt from the path.
    if (outOfTime()) return null;
    const blind = blindGuess(target);
    steps.push({
      step: `${label}:blind`,
      ok: blind !== null,
      reason: blind ?? 'nothing in the path suggests a manifest',
    });
    return blind;
  };

  const direct = await attempt(url, 'direct');
  if (direct !== null) return { provider: direct, url, steps };

  // 4. Proxy retry — only when the user opted in.
  const viaProxy = proxied(opts.proxyBase, url);
  if (viaProxy !== null && !outOfTime()) {
    const proxiedProvider = await attempt(viaProxy, 'proxy');
    if (proxiedProvider !== null) {
      if (proxiedProvider === 'hls') {
        // Stated plainly rather than left to fail mysteriously: a passthrough
        // proxy does not fix HLS, because the manifest's own URLs point back at
        // the origin.
        publish({
          code: 'proxy-hls-caveat',
          severity: 'warn',
          message:
            'A passthrough proxy cannot fix HLS — segment URLs inside the manifest still resolve to the origin.',
        });
      }
      return { provider: proxiedProvider, url: viaProxy, steps };
    }
  } else {
    steps.push({
      step: 'proxy',
      ok: false,
      reason: viaProxy === null ? 'no proxy configured' : 'out of time',
    });
  }

  // 5. Give up, loudly, into telemetry.
  publish({
    code: 'source-unplayable',
    severity: 'error',
    message: steps.map((s) => `${s.step}=${s.reason}`).join('; '),
  });
  return { provider: null, url, steps };
}
