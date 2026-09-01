/**
 * The on-LCD error surface (design-videoEngine.md §7.4).
 *
 * The display is **non-interactive** — no clicks, no keyboard, no scroll — so an
 * error must be self-explanatory and must not depend on any action taken on the
 * LCD itself. Every rule below follows from that one fact:
 *
 *  - **Flat, low-entropy, no animation beyond a 1 Hz pulse dot.** CAM's Elite
 *    pipeline compresses every captured frame, so a busy card costs achieved FPS
 *    exactly the way busy video does (§8.2). Gradients, blur and shadows are
 *    banned here, not discouraged.
 *  - **Inside the circular safe box** (398×398 at 640), because the corners of a
 *    round panel are not there.
 *  - **A fixed footer naming where the fix is.** The user is not at the LCD;
 *    they are at CAM. The footer says so, and carries the room code when the
 *    sync channel is up so the phone remote is discoverable too.
 *  - **Auto-retry with backoff, for transient classes only.** Retrying a `.mkv`
 *    forever is how an LCD ends up in a permanent spinner, so deterministic
 *    classes get one card and no retries.
 *  - **A previous source that worked beats a card.** After three failed
 *    retries, if something played successfully earlier this session, go back to
 *    it and shrink to a corner badge. A working picture with a badge is a better
 *    LCD than a perfect explanation of a broken one.
 *
 * Deliberate deviation from the doc's file list: this is `.ts` building DOM, not
 * `.tsx`. The whole display renderer is imperative (invariant I4, and
 * `display.ts` never touches React), and a module's `.tsx` is config-only code
 * that invariant I8 keeps out of the display graph entirely.
 */

import { CAM_PATH_CONFIGURE } from '../../../config/camPaths';

import type { VideoErrorCode } from '../adapters/VideoAdapter';

const URL_ELLIPSIS_LEN = 40;
const HALF = 0.5;

/**
 * §7.4 — `2s, 4s, 8s, 30s (cap)`.
 *
 * Named individually because invariant I5 (`no-magic-numbers`) exempts object
 * properties and `const` initialisers, but not array elements.
 */
const BACKOFF = { first: 2000, second: 4000, third: 8000, cap: 30_000 } as const;
export const RETRY_BACKOFF_MS: readonly number[] = [
  BACKOFF.first,
  BACKOFF.second,
  BACKOFF.third,
  BACKOFF.cap,
];

/** §7.4 — after this many failed retries, fall back to the last good source. */
export const RETRIES_BEFORE_FALLBACK = 3;

/**
 * §7.4 — the transient classes, and only these.
 *
 * `codec-unsupported`, `unsupported-container`, `http-not-upgradable` and
 * `clip-missing` are *answers*, not bad luck: the same URL will fail the same
 * way in thirty seconds, so retrying only wastes frames and hides the message.
 */
const RETRYABLE_CODES: readonly VideoErrorCode[] = [
  'network',
  'stall',
  'autoplay-blocked',
  'yt-api-unavailable',
  'provider-unavailable',
];

export function isRetryableCode(code: VideoErrorCode): boolean {
  return RETRYABLE_CODES.includes(code);
}

/** `attempt` is 1-based; anything past the table repeats the 30 s cap. */
export function retryDelayMs(attempt: number): number {
  const index = Math.max(0, Math.min(RETRY_BACKOFF_MS.length - 1, attempt - 1));
  return RETRY_BACKOFF_MS[index] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1] ?? 0;
}

export function shouldFallbackToPrevious(attempt: number, hasPrevious: boolean): boolean {
  return hasPrevious && attempt >= RETRIES_BEFORE_FALLBACK;
}

/** §7.4 — the category glyph. One character, so it survives compression. */
export function glyphFor(code: VideoErrorCode): string {
  switch (code) {
    case 'network':
    case 'stall':
      return '⚡';
    case 'autoplay-blocked':
      return '▶';
    case 'clip-missing':
      return '⌧';
    case 'codec-unsupported':
      return '⚙';
    case 'provider-unavailable':
    case 'yt-api-unavailable':
      return '☁';
    case 'aborted':
      return '⏹';
    default:
      return '!';
  }
}

/** §7.4 — the offending URL, middle-ellipsized to 40 characters. */
export function middleEllipsize(text: string, max = URL_ELLIPSIS_LEN): string {
  if (text.length <= max) return text;
  const keep = Math.floor((max - 1) * HALF);
  return `${text.slice(0, keep)}…${text.slice(text.length - keep)}`;
}

export const FIX_FOOTER = `Fix in ${CAM_PATH_CONFIGURE}`;

export interface ErrorCardModel {
  code: VideoErrorCode;
  title: string;
  /** One line of human cause. The renderer clamps it to three lines. */
  body: string;
  /** The offending URL or provider; middle-ellipsized by the renderer. */
  detail?: string;
  /** Room code, when the sync channel is up. Appended to the fixed footer. */
  roomCode?: string;
  /** `n` in `retry n/∞`. Omit to hide the counter. */
  retryCount?: number;
}

/**
 * Builds the card. Returns the element; the caller owns placement inside
 * `RenderController.overlays`, which is already inset to the safe box.
 */
export function renderErrorCard(model: ErrorCardModel): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'kh-video__card';
  wrap.dataset['errorCode'] = model.code;

  const inner = document.createElement('div');
  inner.className = 'kh-video__card-inner';

  const glyph = document.createElement('p');
  glyph.className = 'kh-video__card-glyph';
  glyph.textContent = glyphFor(model.code);

  const title = document.createElement('p');
  title.className = 'kh-video__card-title';
  title.textContent = model.title;

  const body = document.createElement('p');
  body.className = 'kh-video__card-body';
  body.textContent = model.body;

  inner.append(glyph, title, body);

  if (model.detail !== undefined && model.detail !== '') {
    const detail = document.createElement('p');
    detail.className = 'kh-video__card-detail';
    detail.textContent = middleEllipsize(model.detail);
    inner.append(detail);
  }

  if (model.retryCount !== undefined && isRetryableCode(model.code)) {
    const retry = document.createElement('p');
    retry.className = 'kh-video__card-retry';
    // The 1 Hz pulse dot is the ONLY animation on this card.
    const dot = document.createElement('span');
    dot.className = 'kh-video__pulse';
    const label = document.createElement('span');
    label.textContent = ` retry ${String(model.retryCount)}/∞`;
    retry.append(dot, label);
    inner.append(retry);
  }

  const footer = document.createElement('p');
  footer.className = 'kh-video__card-footer';
  footer.textContent =
    model.roomCode === undefined || model.roomCode === ''
      ? FIX_FOOTER
      : `${FIX_FOOTER}  ·  room ${model.roomCode}`;
  inner.append(footer);

  wrap.append(inner);
  return wrap;
}

/**
 * §7.4 — the corner badge that replaces the card once a previous source has
 * been resumed. Small, static, and honest about what the user is looking at.
 */
export function renderFallbackBadge(): HTMLElement {
  const badge = document.createElement('div');
  badge.className = 'kh-video__badge';
  badge.dataset['badge'] = 'previous-source';
  badge.textContent = 'last source failed — playing previous';
  return badge;
}
