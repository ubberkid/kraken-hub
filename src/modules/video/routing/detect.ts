/**
 * `detect(url) -> ProviderMatch` (design-videoEngine.md §1.3, §1.4, §7.3).
 * Pure and unit-testable: no fetch, no DOM, no probing.
 */

import { MAX_URL_LEN } from '../types';

import {
  FALLBACK_CONFIDENCE,
  FALLBACK_PROVIDER,
  MATCH_CONFIDENCE,
  URL_ROUTES,
  normalizeUrl,
} from './patterns';

import type { ProviderCapabilities, ProviderId, ResolverPolicy } from '../types';
import type { RouteErrorCode, RouteMeta, RouteWarnCode } from './patterns';

export interface ProviderMatch {
  provider: ProviderId | null;
  /** The normalized url every adapter should actually use. */
  url: string;
  originalUrl: string;
  /** Route id, for telemetry and tests. */
  routeId: string | null;
  /** Captured media id — a YouTube id, a clip id, a Twitch vod number… */
  id: string | null;
  meta: RouteMeta;
  error: RouteErrorCode | null;
  warnings: RouteWarnCode[];
  /** 1 for a table match, 0.2 for the unmatched-https guess, 0 for no idea. */
  confidence: number;
  /** §7.3 — the `<video>` → range-probe → blind-attempt chain must run. */
  needsFallbackChain: boolean;
  /** `http:` was rewritten to `https:` (§7.1 `mixed-content-http`). */
  upgradedFromHttp: boolean;
  /** Neither http(s) nor `kraken-hub-clip:` — nothing can play it. */
  unsupportedScheme: boolean;
  tooLong: boolean;
}

function emptyMatch(originalUrl: string, url: string): ProviderMatch {
  return {
    provider: null,
    url,
    originalUrl,
    routeId: null,
    id: null,
    meta: {},
    error: null,
    warnings: [],
    confidence: 0,
    needsFallbackChain: false,
    upgradedFromHttp: false,
    unsupportedScheme: false,
    tooLong: false,
  };
}

/**
 * First provider match wins; hard rejects short-circuit; annotate-only routes
 * always contribute their warning regardless of where the provider matched
 * (a `&list=` on a YouTube link is a warning, not a different provider).
 */
export function detect(raw: string): ProviderMatch {
  const norm = normalizeUrl(raw);
  const out = emptyMatch(raw, norm.url);
  out.upgradedFromHttp = norm.upgraded;
  out.tooLong = norm.url.length > MAX_URL_LEN;

  const u = norm.url;
  // Loopback http is a potentially-trustworthy origin (§6) and is treated
  // exactly like https everywhere below: it is where the resolver companion and
  // a LAN dev server live, and it is the one http origin browsers do not block.
  const isWeb = norm.isHttps || norm.isLoopbackHttp;

  // Everything below this line assumes an https url or our own clip scheme.
  // Without the guard the extension routes are scheme-blind and would happily
  // route `file:///Users/me/a.mp4` to `direct-file`, which the browser then
  // refuses to load with a far less helpful message than ours.
  if (!isWeb && !norm.isLocalClip) {
    out.unsupportedScheme = u.length > 0;
    return out;
  }

  for (const route of URL_ROUTES) {
    const m = route.re.exec(u);
    if (m === null) continue;

    if (route.error !== undefined) {
      // A hard reject beats everything, including a provider that matched
      // earlier — the table is ordered so rejects are seen first anyway.
      out.error = route.error;
      out.routeId = route.id;
      out.provider = null;
      out.confidence = MATCH_CONFIDENCE;
      out.warnings = [];
      return out;
    }

    if (route.annotate === true) {
      if (route.warn !== undefined && !out.warnings.includes(route.warn)) {
        out.warnings.push(route.warn);
      }
      continue;
    }

    if (out.provider !== null || route.provider === undefined) continue;

    out.provider = route.provider;
    out.routeId = route.id;
    out.confidence = MATCH_CONFIDENCE;
    if (route.group !== undefined) out.id = m[route.group] ?? null;
    if (route.meta !== undefined) out.meta = route.meta(u, m);
    if (route.group2 !== undefined) {
      const hash = m[route.group2];
      if (hash !== undefined) out.meta = { ...out.meta, hash };
    }
    if (route.warn !== undefined && !out.warnings.includes(route.warn)) {
      out.warnings.push(route.warn);
    }
  }

  if (out.provider !== null) return out;

  if (isWeb) {
    // §1.3 — an unmatched https url is a `direct-file` guess with low
    // confidence, and §7.3's fallback chain is what actually settles it.
    out.provider = FALLBACK_PROVIDER;
    out.routeId = null;
    out.confidence = FALLBACK_CONFIDENCE;
    out.needsFallbackChain = true;
    return out;
  }

  return out;
}

/**
 * §1.4 — the resolver is a POLICY layer applied to a finished match, never a
 * URL pattern. Any resolver failure downgrades back to `match` and emits
 * `tele.resolver-fallback`; the user never sees an error for a resolver miss.
 */
export function applyResolverPolicy(
  match: ProviderMatch,
  policy: ResolverPolicy,
  ctx: { healthy: boolean; caps?: Pick<ProviderCapabilities, 'hasOwnChrome' | 'canSetQuality'> },
): ProviderMatch {
  if (policy === 'off' || !ctx.healthy || match.provider === null) return match;
  if (match.provider === 'local-file') return match;

  if (policy === 'youtube-only') {
    return match.provider === 'youtube-embed' ? { ...match, provider: 'resolver' } : match;
  }
  if (policy === 'preferred') {
    const caps = ctx.caps;
    const worthSwapping = caps === undefined ? false : caps.hasOwnChrome || !caps.canSetQuality;
    return worthSwapping ? { ...match, provider: 'resolver' } : match;
  }
  // 'fallback' — only after the primary adapter emits a fatal error, which is
  // the caller's business, not detection's.
  return match;
}
