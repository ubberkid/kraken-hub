/**
 * The ONLY file allowed to name an external host (ESLint invariant override).
 *
 * Everything else derives its origin from `location`, so a fork on a different
 * `<user>.github.io`, a custom domain, or plain `http://127.0.0.1` works with
 * no configuration at all.
 */

/** CAM's deep link: opens the Web Integration setup with our URL pre-filled. */
export const CAM_INSTALL_BASE = 'https://cam-redirect.nzxt.com/action/load-web-integration?url=';

/** Same deep link for the CAM beta channel. */
export const CAM_BETA_INSTALL_BASE =
  'https://cam-beta-redirect.nzxt.com/action/load-web-integration?url=';

/**
 * The canonical install URL, WITH the trailing slash.
 *
 * Without it GitHub Pages answers `/<repo>?kraken=1` with a 301 to
 * `/<repo>/?kraken=1`. A redirect on load is not a client navigation and
 * probably works, but it is untested inside CAM and costs a round trip on every
 * LCD boot — so every copy button and every one-click link emits the slash.
 */
export function canonicalAppUrl(href: string = window.location.href): string {
  return new URL('./', href).href;
}

export function camInstallUrl(appUrl: string, beta = false): string {
  return (beta ? CAM_BETA_INSTALL_BASE : CAM_INSTALL_BASE) + encodeURIComponent(appUrl);
}

// ---------------------------------------------------------------------------
// YouTube (design-videoEngine.md §2.5, §2.6)
// ---------------------------------------------------------------------------

/**
 * The IFrame Player API loader.
 *
 * It is served from `youtube.com`, NOT from `youtube-nocookie.com` — the
 * privacy-enhanced host serves embeds only. Loading this script is the one
 * remote script kraken-hub fetches, and only when a YouTube URL is actually
 * playing: the display path, the demo clip and every local clip stay offline.
 */
export const YT_IFRAME_API_SRC = 'https://www.youtube.com/iframe_api';

/** §2.5 — the privacy-enhanced embed host. Never the plain `youtube.com` one. */
export const YT_EMBED_ORIGIN = 'https://www.youtube-nocookie.com';

/** §2.6 — poster frames for the overlay mask. */
export const YT_THUMB_ORIGIN = 'https://i.ytimg.com';

export function ytEmbedPath(videoId: string): string {
  return `${YT_EMBED_ORIGIN}/embed/${videoId}`;
}

/**
 * §2.6 — poster candidates in fallback order. `maxresdefault` does not exist for
 * every upload; `hqdefault` always does. A third fallback (a flat colour) lives
 * in the mask controller, because it needs no network at all.
 */
export function ytPosterUrls(videoId: string): readonly string[] {
  return [
    `${YT_THUMB_ORIGIN}/vi/${videoId}/maxresdefault.jpg`,
    `${YT_THUMB_ORIGIN}/vi/${videoId}/hqdefault.jpg`,
  ];
}

// ---------------------------------------------------------------------------
// Twitch (design-videoEngine.md §1.2, §3.4)
// ---------------------------------------------------------------------------

/**
 * The Embed JS API. Twitch's `player.twitch.tv` iframe *requires* a `parent`
 * parameter naming every hostname that frames it — which is exactly why it is
 * computed from `location.hostname` at runtime rather than baked in. A fork on
 * its own `<user>.github.io` therefore works with no configuration at all.
 */
export const TWITCH_EMBED_SCRIPT = 'https://embed.twitch.tv/embed/v1.js';
export const TWITCH_PLAYER_ORIGIN = 'https://player.twitch.tv';

// ---------------------------------------------------------------------------
// Vimeo (design-videoEngine.md §1.2, §3.5)
// ---------------------------------------------------------------------------

/** The official Player SDK. Vimeo's embed has no usable API without it. */
export const VIMEO_PLAYER_SCRIPT = 'https://player.vimeo.com/api/player.js';
export const VIMEO_PLAYER_ORIGIN = 'https://player.vimeo.com';

export function vimeoEmbedUrl(videoId: string, hash: string | undefined): string {
  const p = new URLSearchParams({
    autoplay: '1',
    muted: '1',
    loop: '0',
    controls: '0',
    title: '0',
    byline: '0',
    portrait: '0',
    dnt: '1',
    playsinline: '1',
    transparent: '0',
  });
  if (hash !== undefined && hash !== '') p.set('h', hash);
  return `${VIMEO_PLAYER_ORIGIN}/video/${videoId}?${p.toString()}`;
}

// ---------------------------------------------------------------------------
// Streamable (design-videoEngine.md §1.2)
// ---------------------------------------------------------------------------

/**
 * Streamable exposes no player API at all — only oEmbed, which answers with the
 * iframe HTML and the source's true dimensions. That single fact is why the
 * capability row is almost entirely `false`.
 */
export const STREAMABLE_OEMBED = 'https://api.streamable.com/oembed.json?url=';
export const STREAMABLE_ORIGIN = 'https://streamable.com';

export function streamableEmbedUrl(shortcode: string): string {
  return `${STREAMABLE_ORIGIN}/e/${shortcode}?autoplay=1&muted=1&nocontrols=1`;
}

export function streamableWatchUrl(shortcode: string): string {
  return `${STREAMABLE_ORIGIN}/${shortcode}`;
}

// ---------------------------------------------------------------------------
// CORS proxy presets (design-videoEngine.md §7.3 step 4)
// ---------------------------------------------------------------------------

/**
 * The ONE public proxy offered as a preset, and never as a default.
 *
 * `corsproxy.io` is deliberately absent: it 403s benign domains, producing a
 * failure that looks like the user's fault. And no plain passthrough proxy —
 * this one included — can fix HLS, because the variant and segment URLs inside
 * a manifest resolve back to the origin host and re-fail CORS. A worker that
 * rewrites playlist URLs is required, which is why `docs/providers.md` points
 * at "deploy your own" rather than at a service.
 */
export const ALLORIGINS_PROXY_BASE = 'https://api.allorigins.win/raw?url=';
