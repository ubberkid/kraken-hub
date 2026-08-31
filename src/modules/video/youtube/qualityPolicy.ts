/**
 * YouTube quality label map and ladder policy (design-videoEngine.md §2.7).
 * Decision logic only — the `onPlaybackQualityChange` wiring lands with the
 * adapter.
 *
 * `onPlaybackQualityChange` is the ONLY readable quality signal an embed gives
 * us (`setPlaybackQuality` has been a documented no-op for years), so every
 * decision here is inferred from one label plus buffer health.
 */

import { YT_LADDER } from '../types';

// device-size-ok: YouTube quality-label heights, not panel dimensions.
const H_240 = 240;
const H_360 = 360;
const H_480 = 480;
const H_720 = 720;
const H_1080 = 1080;
const H_1440 = 1440;
const H_2160 = 2160;

/** §2.7 — YouTube's label vocabulary, mapped to heights. */
export const YT_QUALITY_HEIGHTS: Readonly<Record<string, number>> = {
  small: H_240,
  medium: H_360,
  large: H_480,
  hd720: H_720,
  hd1080: H_1080,
  hd1440: H_1440,
  hd2160: H_2160,
  highres: H_2160,
};

export function qualityLabelToHeight(label: string | null | undefined): number | null {
  if (label === null || label === undefined) return null;
  return YT_QUALITY_HEIGHTS[label] ?? null;
}

/** Inverse, for telemetry: the largest label at or below `height`. */
export function heightToQualityLabel(height: number): string | null {
  let best: string | null = null;
  let bestH = -1;
  for (const [label, h] of Object.entries(YT_QUALITY_HEIGHTS)) {
    if (h <= height && h > bestH) {
      best = label;
      bestH = h;
    }
  }
  return best;
}

/** §2.7 — below this the video is visibly soft on a 640 panel. */
export const QUALITY_OK_HEIGHT = H_720;
/** The watchdog is armed this long after the first PLAYING. */
export const WATCHDOG_ARM_MS = 6000;
/** `loadedFraction × duration − currentTime` above this is a healthy buffer. */
export const BUFFER_HEALTHY_SEC = 6;
/** More than this many BUFFERING events in 30 s means the network is the limit. */
export const BUFFERING_TOLERANCE = 1;
export const BUFFERING_WINDOW_MS = 30_000;

export interface QualitySignals {
  /** Last height from `onPlaybackQualityChange`; `null` if it never fired. */
  observedHeight: number | null;
  loadedFraction: number;
  duration: number;
  currentTime: number;
  bufferingEventsIn30s: number;
  /** The iframe element width currently mounted. */
  currentWidth: number;
  /** Has the ladder already been stepped once this session? */
  steppedUp: boolean;
  perf: 'auto' | 'quality' | 'performance';
  ladder?: readonly number[];
}

export type QualityAction = 'ok' | 'step-up' | 'hold' | 'step-down';

export type QualityTelemetry =
  'quality' | 'quality-capped' | 'network-limited' | 'quality-unknown' | null;

export interface QualityDecision {
  action: QualityAction;
  /** The element width to mount next. Equal to `currentWidth` when holding. */
  nextWidth: number;
  telemetry: QualityTelemetry;
  reason: string;
  /** True once a step-up failed to raise the served height — a real size cap. */
  sizeCapProven: boolean;
}

export function bufferHealthy(
  s: Pick<QualitySignals, 'loadedFraction' | 'duration' | 'currentTime'>,
): boolean {
  if (!Number.isFinite(s.duration) || s.duration <= 0) return false;
  return s.loadedFraction * s.duration - s.currentTime > BUFFER_HEALTHY_SEC;
}

function nextRung(ladder: readonly number[], current: number): number {
  const sorted = [...ladder].sort((a, b) => a - b);
  return sorted.find((n) => n > current) ?? current;
}

function prevRung(ladder: readonly number[], current: number): number {
  const sorted = [...ladder].sort((a, b) => b - a);
  return sorted.find((n) => n < current) ?? current;
}

/**
 * §2.7, the whole watchdog decision:
 *
 *  - served ≥ 720 → we are done; publish `tele.quality`.
 *  - served < 720 with a healthy buffer and ≤1 buffering event → SIZE-limited.
 *    Step the ladder ONCE (1920 → 2560). If a step already happened and the
 *    height is still low, stop escalating and publish `tele.quality-capped`.
 *  - served < 720 with an unhealthy buffer or repeated buffering →
 *    NETWORK-limited. Stepping up would make it worse; in `auto` we step DOWN
 *    to cut decode and composite cost instead.
 */
export function decideQuality(s: QualitySignals): QualityDecision {
  const ladder = s.ladder ?? YT_LADDER;

  if (s.observedHeight === null) {
    return {
      action: 'hold',
      nextWidth: s.currentWidth,
      telemetry: 'quality-unknown',
      reason: 'onPlaybackQualityChange has not fired yet',
      sizeCapProven: false,
    };
  }

  if (s.observedHeight >= QUALITY_OK_HEIGHT) {
    return {
      action: 'ok',
      nextWidth: s.currentWidth,
      telemetry: 'quality',
      reason: `served ${String(s.observedHeight)}p`,
      sizeCapProven: false,
    };
  }

  const healthy = bufferHealthy(s);
  const networkLimited = !healthy || s.bufferingEventsIn30s > BUFFERING_TOLERANCE;

  if (networkLimited) {
    const stepDown = s.perf === 'auto';
    return {
      action: stepDown ? 'step-down' : 'hold',
      nextWidth: stepDown ? prevRung(ladder, s.currentWidth) : s.currentWidth,
      telemetry: 'network-limited',
      reason: 'buffer starved — a bigger element would make this worse',
      sizeCapProven: false,
    };
  }

  if (s.steppedUp) {
    return {
      action: 'hold',
      nextWidth: s.currentWidth,
      telemetry: 'quality-capped',
      reason: 'stepped the ladder once and the served height did not improve',
      sizeCapProven: true,
    };
  }

  const up = nextRung(ladder, s.currentWidth);
  if (up === s.currentWidth) {
    return {
      action: 'hold',
      nextWidth: s.currentWidth,
      telemetry: 'quality-capped',
      reason: 'already at the widest ladder rung',
      sizeCapProven: true,
    };
  }

  return {
    action: 'step-up',
    nextWidth: up,
    telemetry: null,
    reason: 'size-limited hypothesis: healthy buffer, low served height',
    sizeCapProven: false,
  };
}

/**
 * §2.7 — where the step-up survives a reload. The canonical storage prefix is
 * `kraken-hub:v1:`; the value is read and written through
 * `src/platform/storage.ts`, never through `sessionStorage` directly.
 */
export const YT_LADDER_STORAGE_KEY = 'video:ytLadder';
