/**
 * Input validation and the exact user-facing messages (design-videoEngine.md
 * §7.1, §7.2). Pure — this runs in the config UI at keystroke time, in the
 * remote page, and AGAIN on the display at mount, because state can arrive from
 * a URL param or a retained MQTT snapshot written by an older or forked client.
 * The display never trusts incoming state.
 *
 * Severity model: warnings NEVER block. Errors block *saving from the config
 * UI*, but on the display an error always renders as a card (§7.4) rather than
 * a blank screen — so callers get `blocking` and decide for themselves.
 */

import { MAX_URL_LEN } from '../types';

import { detect } from './detect';

import type { ProviderMatch } from './detect';

export type Severity = 'error' | 'warn' | 'auto-fix';

export type ValidationCode =
  | 'mixed-content-http'
  | 'http-not-upgradable'
  | 'unsupported-container'
  | 'discord-expiring-url'
  | 'imgur-unreliable'
  | 'reddit-comment-url'
  | 'youtube-playlist-ignored'
  | 'local-clip-remote-context'
  | 'url-too-long'
  | 'mov-codec-risk'
  | 'codec-unsupported'
  | 'unsupported-scheme';

/**
 * §7.1, verbatim. These strings are part of the product: the LCD is
 * non-interactive and the config panel is the only place a user can read a
 * cause, so every one of them names the fix, not just the fault.
 *
 * `unsupported-scheme` is the one addition to the doc's table: §7.1 has no row
 * for `file:` / `data:` / a bare typo, and returning nothing at all for those
 * would leave the panel silent.
 */
export const VALIDATION_MESSAGES: Readonly<Record<ValidationCode, string>> = {
  'mixed-content-http':
    'Upgraded to https:// — GitHub Pages is HTTPS-only and browsers block http:// media.',
  'http-not-upgradable':
    'This link is http:// only. The Kraken display is served over HTTPS, so the browser will block it. Download the file and add it as a local clip instead.',
  'unsupported-container':
    ".mkv can't be played — Chromium has no Matroska support in `<video>`, and no library fixes that. Remux to MP4: `ffmpeg -i in.mkv -c copy out.mp4`.",
  'discord-expiring-url':
    'Discord links are signed and expire in about 24 hours — this will stop working. Download the file and add it as a local clip.',
  'imgur-unreliable': "Imgur redirects hotlinked videos to its homepage; this often won't load.",
  'reddit-comment-url':
    'Paste the `v.redd.it/…` link (open the video, copy the video link), not the comments page.',
  'youtube-playlist-ignored': "Playlists aren't supported in v1 — only this video will play.",
  'local-clip-remote-context':
    "That clip isn't in this display's library. Local clips live in NZXT CAM's browser storage on your PC — add it there (CAM → Lighting → Kraken → Configure), then pick it again.",
  'url-too-long': "That link is unusually long and won't survive the sync channel.",
  'mov-codec-risk':
    '`.mov` files often contain ProRes or HEVC, which may not decode. MP4/H.264 is safest.',
  'codec-unsupported':
    "Your PC can't decode this file (HEVC needs GPU support Chromium won't emulate).",
  'unsupported-scheme':
    'That is not a link the display can open. Paste an https:// URL, or add the file as a local clip.',
};

const SEVERITIES: Readonly<Record<ValidationCode, Severity>> = {
  'mixed-content-http': 'auto-fix',
  'http-not-upgradable': 'error',
  'unsupported-container': 'error',
  'discord-expiring-url': 'warn',
  'imgur-unreliable': 'warn',
  'reddit-comment-url': 'error',
  'youtube-playlist-ignored': 'warn',
  'local-clip-remote-context': 'error',
  'url-too-long': 'error',
  'mov-codec-risk': 'warn',
  'codec-unsupported': 'error',
  'unsupported-scheme': 'error',
};

export function severityOf(code: ValidationCode): Severity {
  return SEVERITIES[code];
}

export interface ValidationIssue {
  code: ValidationCode;
  severity: Severity;
  message: string;
}

export interface UrlValidation {
  /** Normalized url — the `https:` upgrade of `mixed-content-http` is applied. */
  url: string;
  match: ProviderMatch;
  issues: ValidationIssue[];
  /** No errors. Warnings and auto-fixes leave this true. */
  ok: boolean;
  /** The config UI refuses to save; the display still renders a card. */
  blocking: boolean;
}

export interface ValidateUrlOptions {
  /** Where validation is running. `remote` cannot resolve a local clip (§5.1). */
  context?: 'config' | 'display' | 'remote';
  /** Clip ids this context can actually play. `undefined` = do not check. */
  knownClipIds?: readonly string[];
  /** The caller probed the https rewrite and it failed (§7.1). */
  httpsProbeFailed?: boolean;
}

function issue(code: ValidationCode): ValidationIssue {
  return { code, severity: SEVERITIES[code], message: VALIDATION_MESSAGES[code] };
}

export function validateUrl(raw: string, opts: ValidateUrlOptions = {}): UrlValidation {
  const match = detect(raw);
  const issues: ValidationIssue[] = [];

  if (match.upgradedFromHttp) {
    issues.push(
      issue(opts.httpsProbeFailed === true ? 'http-not-upgradable' : 'mixed-content-http'),
    );
  }
  if (match.tooLong) issues.push(issue('url-too-long'));
  if (match.error !== null) issues.push(issue(match.error));
  if (match.unsupportedScheme) issues.push(issue('unsupported-scheme'));

  for (const warn of match.warnings) issues.push(issue(warn));

  if (match.provider === 'local-file') {
    const unreachable =
      opts.context === 'remote' ||
      (opts.knownClipIds !== undefined &&
        (match.id === null || !opts.knownClipIds.includes(match.id)));
    if (unreachable) issues.push(issue('local-clip-remote-context'));
  }

  const blocking = issues.some((i) => i.severity === 'error');
  return { url: match.url, match, issues, ok: !blocking, blocking };
}

/** Convenience for the panel: the first error, or the first warning, or null. */
export function primaryIssue(result: UrlValidation): ValidationIssue | null {
  return (
    result.issues.find((i) => i.severity === 'error') ??
    result.issues.find((i) => i.severity === 'warn') ??
    result.issues[0] ??
    null
  );
}

export { MAX_URL_LEN };
