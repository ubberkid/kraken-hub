/**
 * Scheme normalization and mixed-content handling for any URL a module is asked
 * to display — video, image, whatever comes next.
 *
 * This is the half of `src/modules/video/routing/patterns.ts` that has nothing
 * to do with providers, lifted out in M3 so the image module gets the *same*
 * `http:` → `https:` upgrade with the same messages, instead of a second
 * implementation that drifts. `patterns.ts` still owns the local-clip scheme and
 * the provider route table, and delegates the generic part to this file.
 *
 * Why the upgrade matters at all: kraken-hub is served over HTTPS (GitHub Pages
 * has no other mode), so an `http://` sub-resource is blocked outright by the
 * browser. Silently upgrading is right far more often than it is wrong; the one
 * exception is loopback, which is a *potentially trustworthy* origin and is
 * therefore exempt from mixed-content blocking — upgrading it would break the
 * resolver companion and every LAN dev server.
 */

/** Long enough for a signed CDN URL, short enough to survive the sync channel. */
export const MAX_URL_LEN = 2048;

const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/g;
const HTTP_SCHEME_RE = /^http:/i;
const HTTPS_SCHEME_RE = /^https:/i;
const HTTPS_SCHEME = 'https:';
const LOOPBACK_HTTP_RE = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1])(?::\d+)?(?:[/?#]|$)/i;

export interface NormalizedMediaUrl {
  url: string;
  /** The `http:` → `https:` upgrade was applied (validation code `mixed-content-http`). */
  upgraded: boolean;
  isHttps: boolean;
  /** `http://127.0.0.1` / `http://localhost` / `http://[::1]` — never upgraded. */
  isLoopbackHttp: boolean;
}

/**
 * Host is lowercased; the PATH is not. Media ids are case-sensitive on every
 * provider we know of, so lowercasing the whole string would silently break
 * them.
 *
 * Never throws: unparseable input is handed back verbatim, because throwing
 * here would take the display down over a typo.
 */
export function normalizeMediaUrl(raw: string): NormalizedMediaUrl {
  const trimmed = raw.trim().replace(ZERO_WIDTH_RE, '');

  if (LOOPBACK_HTTP_RE.test(trimmed)) {
    return {
      url: stripTrailingSlash(trimmed),
      upgraded: false,
      isHttps: false,
      isLoopbackHttp: true,
    };
  }

  const upgraded = HTTP_SCHEME_RE.test(trimmed);
  const withScheme = upgraded ? trimmed.replace(HTTP_SCHEME_RE, HTTPS_SCHEME) : trimmed;

  let url = withScheme;
  if (HTTPS_SCHEME_RE.test(withScheme)) {
    try {
      const parsed = new URL(withScheme);
      parsed.hostname = parsed.hostname.toLowerCase();
      url = parsed.toString();
    } catch {
      url = withScheme;
    }
  }

  url = stripTrailingSlash(url);
  return { url, upgraded, isHttps: HTTPS_SCHEME_RE.test(url), isLoopbackHttp: false };
}

/**
 * One trailing slash only — `twitch.tv/<channel>/` must match the channel route,
 * but `https://example.com//` is not the same path as `https://example.com`.
 */
function stripTrailingSlash(url: string): string {
  return url.endsWith('/') && !url.endsWith('//') ? url.slice(0, -1) : url;
}
