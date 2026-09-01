/**
 * The low-FPS advisory (design-videoEngine.md §8.1).
 *
 * The highest-leverage piece of UX in the product, and the reason is arithmetic:
 * **CAM ships the LCD Web Integration at 1 frame per second.** A user who never
 * touches that slider sees a slideshow and concludes kraken-hub is broken. So
 * the video module — the one module a 1 FPS ceiling genuinely ruins — says
 * exactly where the slider is.
 *
 * The rules, all of them from §8.1:
 *  - `targetFps` is read at boot and **re-read every 2 s** (CAM changes it live,
 *    without reloading the page). The platform's `FrameClock` already does that;
 *    this state machine just consumes `FrameInfo.targetFps`.
 *  - `targetFps <= 5` → a full card for 20 s, then a persistent corner badge.
 *  - It clears itself the moment `targetFps > 5` is observed, and re-arms as a
 *    full card if the rate drops again.
 *  - It is **never dismissible from the LCD** — the LCD is non-interactive — but
 *    it **is** dismissible from the config UI, which is what
 *    `kraken-hub:v1:video:fpsAdvisoryDismissed` records.
 *
 * The video module owns this rather than the display shell (whose generic
 * banner is suppressed by `capabilities.ownsFpsAdvisory`) because only the
 * module knows about the dismiss key and the module's own safe-area overlays.
 */

import { CAM_PATH_FRAME_RATE } from '../../../config/camPaths';
import { readRaw, writeRaw } from '../../../platform/storage';

/** §8.1 — the config-UI dismiss key. */
export const FPS_DISMISSED_SUFFIX = 'video:fpsAdvisoryDismissed';
/** §8.1 — at or below this, the slider is the problem. */
export const LOW_FPS_THRESHOLD = 5;
/** §8.1 — full card, then badge. */
export const ADVISORY_CARD_MS = 20_000;

export function isFpsAdvisoryDismissed(): boolean {
  return readRaw(FPS_DISMISSED_SUFFIX) === '1';
}

export function setFpsAdvisoryDismissed(dismissed: boolean): void {
  writeRaw(FPS_DISMISSED_SUFFIX, dismissed ? '1' : '0');
}

export type AdvisoryState = 'hidden' | 'card' | 'badge';

export interface FpsAdvisoryOptions {
  threshold?: number;
  cardMs?: number;
  now?: () => number;
  isDismissed?: () => boolean;
}

export interface FpsAdvisory {
  /** Feed it `FrameInfo.targetFps`; returns the state to render. */
  update(targetFps: number): AdvisoryState;
  state(): AdvisoryState;
  targetFps(): number;
}

/**
 * Pure-ish state machine (the only impurity is the clock, which is injected).
 * `lowSince` resets whenever the rate recovers, so a slider that is dragged up
 * and back down shows the full card again rather than a badge nobody reads.
 */
export function createFpsAdvisory(opts: FpsAdvisoryOptions = {}): FpsAdvisory {
  const threshold = opts.threshold ?? LOW_FPS_THRESHOLD;
  const cardMs = opts.cardMs ?? ADVISORY_CARD_MS;
  const now = opts.now ?? Date.now;
  const dismissed = opts.isDismissed ?? isFpsAdvisoryDismissed;

  // NaN, not 0: an injected clock that legitimately starts at 0 would otherwise
  // keep re-arming the sentinel and the card would never shrink.
  let lowSince = Number.NaN;
  let current: AdvisoryState = 'hidden';
  let fps = 0;

  return {
    update(targetFps) {
      fps = targetFps;
      if (targetFps > threshold || dismissed()) {
        lowSince = Number.NaN;
        current = 'hidden';
        return current;
      }
      if (Number.isNaN(lowSince)) lowSince = now();
      current = now() - lowSince >= cardMs ? 'badge' : 'card';
      return current;
    },
    state() {
      return current;
    },
    targetFps() {
      return fps;
    },
  };
}

/** §8.1 — the card copy, verbatim, including the device maximum. */
export function fpsAdvisoryBody(): string {
  return `${CAM_PATH_FRAME_RATE} → drag to max (40 on Elite).`;
}

export function renderFpsCard(targetFps: number): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'kh-video__card kh-video__fps-card';
  wrap.dataset['advisory'] = 'card';

  const inner = document.createElement('div');
  inner.className = 'kh-video__card-inner';

  const title = document.createElement('p');
  title.className = 'kh-video__card-title';
  title.textContent = `LCD frame rate is ${String(targetFps)} FPS`;

  const body = document.createElement('p');
  body.className = 'kh-video__card-body';
  body.textContent = fpsAdvisoryBody();

  const footer = document.createElement('p');
  footer.className = 'kh-video__card-footer';
  footer.textContent = 'This notice disappears once a higher frame rate is set.';

  inner.append(title, body, footer);
  wrap.append(inner);
  return wrap;
}

export function renderFpsBadge(targetFps: number): HTMLElement {
  const badge = document.createElement('div');
  badge.className = 'kh-video__badge kh-video__fps-badge';
  badge.dataset['advisory'] = 'badge';
  // Deliberately tiny and static: a persistent overlay must cost as close to
  // nothing to encode as an overlay can (§8.2).
  badge.textContent = `${String(targetFps)} FPS ⚠`;
  return badge;
}
