/**
 * Image URL validation. Pure — it runs in the config panel at keystroke time and
 * AGAIN on the display at mount, because state can arrive from a URL parameter
 * or a retained sync snapshot written by an older or forked client, and the
 * display never trusts incoming state.
 *
 * The mixed-content half is not reimplemented here: `normalizeMediaUrl()`
 * (`src/lib/mediaUrl.ts`) is the same function the video module's router uses,
 * so an `http://` link is upgraded identically and the loopback exemption is
 * identical. What this file adds is the part that is genuinely about pictures —
 * container sniffing from the extension, and the animated-format note.
 *
 * Severity model, copied from the video module deliberately: warnings NEVER
 * block; an error blocks *saving from the config UI*, but on the display it
 * renders as a card rather than a blank panel, so callers get `blocking` and
 * decide for themselves.
 */

import { MAX_URL_LEN, normalizeMediaUrl } from '../../lib/mediaUrl';

import { LOCAL_IMAGE_RE, localImageId } from './schema';

export type ImageIssueSeverity = 'error' | 'warn' | 'auto-fix';

export type ImageIssueCode =
  | 'mixed-content-http'
  | 'unsupported-scheme'
  | 'url-too-long'
  | 'unsupported-format'
  | 'local-image-missing'
  | 'svg-not-rendered'
  | 'animated-capture-fps';

/**
 * These strings are part of the product: the LCD is non-interactive and the
 * config panel is the only place a user can read a cause, so each one names the
 * fix, not just the fault.
 */
export const IMAGE_MESSAGES: Readonly<Record<ImageIssueCode, string>> = {
  'mixed-content-http':
    'Upgraded to https:// — GitHub Pages is HTTPS-only and browsers block http:// images.',
  'unsupported-scheme':
    'That is not a link the display can open. Paste an https:// image URL, or add the file to the image library.',
  'url-too-long': "That link is unusually long and won't survive the sync channel.",
  'unsupported-format':
    'That looks like a page, not an image file. Paste the direct link to the .jpg / .png / .webp / .gif itself (right-click the picture → Copy image address).',
  'local-image-missing':
    "That image isn't in this display's library. Local images live in NZXT CAM's browser storage on your PC — add it there (CAM → Lighting → Kraken → Configure), then pick it again.",
  'svg-not-rendered':
    'SVG is rendered, but scripts and external references inside it are blocked by the page policy. A PNG or WebP export is more predictable.',
  'animated-capture-fps':
    "Animated GIFs play at their own speed, but the LCD only shows what CAM captures — at CAM's default of 1 frame per second you will see one frame of the animation per second. Raise CAM → Lighting → Kraken → Web Integration → Frame Rate.",
};

const SEVERITIES: Readonly<Record<ImageIssueCode, ImageIssueSeverity>> = {
  'mixed-content-http': 'auto-fix',
  'unsupported-scheme': 'error',
  'url-too-long': 'error',
  'unsupported-format': 'warn',
  'local-image-missing': 'error',
  'svg-not-rendered': 'warn',
  'animated-capture-fps': 'warn',
};

export interface ImageIssue {
  code: ImageIssueCode;
  severity: ImageIssueSeverity;
  message: string;
}

export interface ImageUrlValidation {
  /** Normalized url — the `https:` upgrade of `mixed-content-http` is applied. */
  url: string;
  /** `local` when the url is `kraken-hub-image:<id>`. */
  kind: 'empty' | 'local' | 'remote';
  /** The library id, for a `kraken-hub-image:` url. */
  localId: string | null;
  animated: boolean;
  issues: ImageIssue[];
  ok: boolean;
  blocking: boolean;
}

/** Extensions Chromium decodes in an `<img>`. `.bmp` and `.ico` work but are not offered. */
const IMAGE_EXT_RE = /\.(?:jpe?g|png|webp|gif|avif|bmp|ico|svg)(?:$|[?#])/i;
const ANIMATED_EXT_RE = /\.(?:gif|webp|avif|png)(?:$|[?#])/i;
const SVG_EXT_RE = /\.svg(?:$|[?#])/i;
/** Hosts that serve images from a path with no extension at all. */
const EXTENSIONLESS_IMAGE_HOST_RE =
  /^https:\/\/(?:[a-z0-9-]+\.)*(?:googleusercontent\.com|ggpht\.com|twimg\.com|redd\.it|imgur\.com|unsplash\.com|githubusercontent\.com)\//i;

export interface ValidateImageUrlOptions {
  context?: 'config' | 'display' | 'remote';
  /** Library ids this context can actually paint. `undefined` = do not check. */
  knownImageIds?: readonly string[];
}

function issue(code: ImageIssueCode): ImageIssue {
  return { code, severity: SEVERITIES[code], message: IMAGE_MESSAGES[code] };
}

export function validateImageUrl(
  raw: string,
  opts: ValidateImageUrlOptions = {},
): ImageUrlValidation {
  const trimmed = raw.trim();
  const issues: ImageIssue[] = [];

  if (trimmed.length === 0) {
    return {
      url: '',
      kind: 'empty',
      localId: null,
      animated: false,
      issues,
      ok: true,
      blocking: false,
    };
  }

  if (LOCAL_IMAGE_RE.test(trimmed)) {
    const id = localImageId(trimmed);
    const unreachable =
      opts.context === 'remote' ||
      (opts.knownImageIds !== undefined && (id === null || !opts.knownImageIds.includes(id)));
    if (unreachable) issues.push(issue('local-image-missing'));
    const blocking = issues.some((i) => i.severity === 'error');
    return {
      url: trimmed,
      kind: 'local',
      localId: id,
      // Unknown until the row is read; the store's `animated` flag is authoritative.
      animated: false,
      issues,
      ok: !blocking,
      blocking,
    };
  }

  const norm = normalizeMediaUrl(trimmed);
  if (norm.upgraded) issues.push(issue('mixed-content-http'));
  if (norm.url.length > MAX_URL_LEN) issues.push(issue('url-too-long'));

  const web = norm.isHttps || norm.isLoopbackHttp;
  if (!web) {
    issues.push(issue('unsupported-scheme'));
  } else if (!IMAGE_EXT_RE.test(norm.url) && !EXTENSIONLESS_IMAGE_HOST_RE.test(norm.url)) {
    // A warning, never an error: plenty of CDNs serve images from extensionless
    // paths, and refusing one on a guess is worse than trying and failing with
    // a card that says what happened.
    issues.push(issue('unsupported-format'));
  }
  if (SVG_EXT_RE.test(norm.url)) issues.push(issue('svg-not-rendered'));

  const animated = ANIMATED_EXT_RE.test(norm.url);
  if (animated) issues.push(issue('animated-capture-fps'));

  const blocking = issues.some((i) => i.severity === 'error');
  return {
    url: norm.url,
    kind: 'remote',
    localId: null,
    animated,
    issues,
    ok: !blocking,
    blocking,
  };
}

/** Convenience for the panel: the first error, or the first warning, or null. */
export function primaryImageIssue(result: ImageUrlValidation): ImageIssue | null {
  return (
    result.issues.find((i) => i.severity === 'error') ??
    result.issues.find((i) => i.severity === 'warn') ??
    result.issues[0] ??
    null
  );
}
