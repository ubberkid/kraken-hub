/**
 * The URL routing table (design-videoEngine.md §1.3).
 *
 * Evaluated top to bottom, first provider match wins. Every regex runs against a
 * NORMALIZED url: trimmed, zero-width characters stripped, `http:` upgraded to
 * `https:`, host lowercased, one trailing slash removed.
 *
 * Canonical override from the plan: the local clip scheme is
 * `kraken-hub-clip:<id>`, not the design doc's `krakenhub-clip:`.
 */

import { normalizeMediaUrl } from '../../../lib/mediaUrl';

import type { ProviderId } from '../types';

/** Hard rejects. These run FIRST so `direct-file` can never swallow them. */
export type RouteErrorCode = 'unsupported-container' | 'reddit-comment-url';

/** Annotations. A warning never decides the provider and never blocks. */
export type RouteWarnCode =
  'mov-codec-risk' | 'discord-expiring-url' | 'imgur-unreliable' | 'youtube-playlist-ignored';

export interface RouteMeta {
  /** YouTube Shorts default to a 9:16 portrait geometry variant. */
  portrait?: boolean;
  /** `t=`/`start=` in seconds. */
  start?: number;
  /** Twitch: what kind of thing the id points at. */
  kind?: 'vod' | 'clip' | 'channel';
  live?: boolean;
  /** Vimeo unlisted hash (capture group 2). */
  hash?: string;
}

export interface Route {
  /** Stable identifier, used in telemetry and in tests. */
  id: string;
  re: RegExp;
  provider?: ProviderId;
  /** Capture group holding the media id. */
  group?: number;
  /** Second capture group, provider-specific (Vimeo unlisted hash). */
  group2?: number;
  error?: RouteErrorCode;
  warn?: RouteWarnCode;
  /** Annotate-only: contributes a warning, never a provider. */
  annotate?: boolean;
  meta?: (url: string, m: RegExpExecArray) => RouteMeta;
}

export const LOCAL_CLIP_SCHEME = 'kraken-hub-clip:';

/** `kraken-hub-clip:<id>` — our own scheme, travelling through URL params and MQTT. */
export const LOCAL_CLIP_RE = /^kraken-hub-clip:([A-Za-z0-9_-]{8,})$/;

const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/g;

export interface Normalized {
  url: string;
  /** The `http:` → `https:` upgrade of §7.1 `mixed-content-http` was applied. */
  upgraded: boolean;
  /** `https:` after normalization (the local clip scheme is not, and that is fine). */
  isHttps: boolean;
  /**
   * `http://127.0.0.1` / `http://localhost` — a *potentially trustworthy* origin
   * and therefore exempt from Chromium's mixed-content blocking (§6). The
   * resolver companion lives there, and so does a LAN dev server, so upgrading
   * these to `https:` would break the one http origin that actually works.
   */
  isLoopbackHttp: boolean;
  isLocalClip: boolean;
}

/**
 * Host is lowercased; the PATH is not. YouTube, Vimeo and Streamable ids are
 * case-sensitive, so lowercasing the whole string would silently break them.
 */
export function normalizeUrl(raw: string): Normalized {
  const trimmed = raw.trim().replace(ZERO_WIDTH_RE, '');
  if (LOCAL_CLIP_RE.test(trimmed)) {
    return {
      url: trimmed,
      upgraded: false,
      isHttps: false,
      isLoopbackHttp: false,
      isLocalClip: true,
    };
  }

  // The generic half — scheme upgrade, loopback exemption, host lowercasing,
  // trailing-slash rule — lives in `src/lib/mediaUrl.ts` since M3, so the image
  // module applies exactly the same mixed-content policy rather than a second
  // implementation of it. What stays here is what is genuinely about video
  // routing: the local clip scheme above, and the provider table below.
  const generic = normalizeMediaUrl(trimmed);
  return { ...generic, isLocalClip: false };
}

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const TIME_TOKEN_RE = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/i;

/**
 * `t=` / `start=` in seconds. YouTube accepts both a bare second count and
 * `1h2m3s`; both appear in links people actually paste.
 */
export function ytStartParam(url: string): number {
  let query = '';
  const q = url.indexOf('?');
  if (q >= 0) query = url.slice(q + 1);
  const hash = url.indexOf('#');
  if (hash >= 0) query = `${query}&${url.slice(hash + 1)}`;
  if (query === '') return 0;

  const params = new URLSearchParams(query);
  const raw = params.get('t') ?? params.get('start') ?? '';
  if (raw === '') return 0;

  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.floor(numeric);

  const m = TIME_TOKEN_RE.exec(raw);
  if (m === null) return 0;
  const h = Number(m[1] ?? 0);
  const min = Number(m[2] ?? 0);
  const s = Number(m[3] ?? 0);
  const total = h * SECONDS_PER_HOUR + min * SECONDS_PER_MINUTE + s;
  return Number.isFinite(total) ? Math.floor(total) : 0;
}

const GROUP_1 = 1;
const GROUP_2 = 2;

/** §1.3, verbatim, in evaluation order. */
export const URL_ROUTES: readonly Route[] = [
  // --- hard rejects -------------------------------------------------------
  {
    id: 'reject-container',
    re: /\.(mkv|mka|avi|flv|wmv|rmvb|3gp)(\?|#|$)/i,
    error: 'unsupported-container',
  },
  {
    id: 'reject-reddit-comments',
    re: /^https:\/\/(www\.|old\.)?reddit\.com\/r\//i,
    error: 'reddit-comment-url',
  },

  // --- explicit local clip URI (canonical scheme) -------------------------
  { id: 'local-clip', provider: 'local-file', re: LOCAL_CLIP_RE, group: GROUP_1 },

  // --- YouTube (11-char ids) ----------------------------------------------
  {
    id: 'youtube-long',
    provider: 'youtube-embed',
    re: /^https:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com|youtube-nocookie\.com)\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/|v\/)([\w-]{11})/,
    group: GROUP_1,
    meta: (u) => ({ portrait: u.includes('/shorts/'), start: ytStartParam(u) }),
  },
  {
    id: 'youtube-short-link',
    provider: 'youtube-embed',
    re: /^https:\/\/youtu\.be\/([\w-]{11})/,
    group: GROUP_1,
    meta: (u) => ({ start: ytStartParam(u) }),
  },

  // --- Vimeo (group 2 = unlisted hash) ------------------------------------
  {
    id: 'vimeo',
    provider: 'vimeo',
    re: /^https:\/\/(?:www\.|player\.)?vimeo\.com\/(?:video\/)?(\d+)(?:\/([0-9a-f]{6,20}))?/,
    group: GROUP_1,
    group2: GROUP_2,
  },

  // --- Twitch --------------------------------------------------------------
  {
    id: 'twitch-vod',
    provider: 'twitch',
    re: /^https:\/\/(?:www\.|m\.)?twitch\.tv\/videos\/(\d+)/,
    group: GROUP_1,
    meta: () => ({ kind: 'vod' }),
  },
  {
    id: 'twitch-clip-host',
    provider: 'twitch',
    re: /^https:\/\/clips\.twitch\.tv\/([A-Za-z0-9_-]+)/,
    group: GROUP_1,
    meta: () => ({ kind: 'clip' }),
  },
  {
    id: 'twitch-clip-channel',
    provider: 'twitch',
    re: /^https:\/\/(?:www\.)?twitch\.tv\/[^/]+\/clip\/([A-Za-z0-9_-]+)/,
    group: GROUP_1,
    meta: () => ({ kind: 'clip' }),
  },
  {
    id: 'twitch-channel',
    provider: 'twitch',
    re: /^https:\/\/(?:www\.|m\.)?twitch\.tv\/([A-Za-z0-9_]{3,25})\/?$/,
    group: GROUP_1,
    meta: () => ({ kind: 'channel', live: true }),
  },

  {
    id: 'streamable',
    provider: 'streamable',
    re: /^https:\/\/streamable\.com\/(?:e\/)?([a-z0-9]{4,8})/,
    group: GROUP_1,
  },

  // --- Reddit video: resolves to direct-file at mount (§1.5) ---------------
  {
    id: 'reddit-video',
    provider: 'reddit',
    re: /^https:\/\/v\.redd\.it\/([a-z0-9]+)/i,
    group: GROUP_1,
  },

  // --- by extension --------------------------------------------------------
  { id: 'ext-hls', provider: 'hls', re: /\.m3u8?(\?|#|$)/i },
  { id: 'ext-dash', provider: 'dash', re: /\.mpd(\?|#|$)/i },
  { id: 'ext-progressive', provider: 'direct-file', re: /\.(mp4|m4v|webm|ogv|ogg)(\?|#|$)/i },
  { id: 'ext-mov', provider: 'direct-file', re: /\.(mov)(\?|#|$)/i, warn: 'mov-codec-risk' },

  // --- warn-only annotations (never decide the provider) -------------------
  {
    id: 'annotate-discord',
    annotate: true,
    re: /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\//i,
    warn: 'discord-expiring-url',
  },
  {
    id: 'annotate-imgur',
    annotate: true,
    re: /^https:\/\/i\.imgur\.com\//i,
    warn: 'imgur-unreliable',
  },
  { id: 'annotate-playlist', annotate: true, re: /[?&]list=/i, warn: 'youtube-playlist-ignored' },
];

/** §1.3 — an unmatched HTTPS url is a `direct-file` guess, and a weak one. */
export const FALLBACK_PROVIDER: ProviderId = 'direct-file';
export const FALLBACK_CONFIDENCE = 0.2;
export const MATCH_CONFIDENCE = 1;
