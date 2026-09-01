/**
 * The provider adapter contract (design-videoEngine.md §1.1).
 *
 * Every playback backend — a `<video>` on a progressive file, a blob URL out of
 * the clip library, and later a cross-origin YouTube iframe — is reduced to this
 * one interface. Two rules make that possible and are the only reason the render
 * layer has no per-provider branches:
 *
 *  1. **`mount()` MUST NOT touch any transform.** An adapter builds its surface
 *     at natural (or deliberately oversized) *layout* size and stops there.
 *     `RenderController` owns `transform` on the stage, always, for everyone.
 *  2. **Every adapter emits `sourcerect`** the moment natural dimensions become
 *     known (`loadedmetadata`, YT `onReady`, a resolver response).
 *     `RenderController` recomputes on that event only — never per frame.
 *
 * `teardown()` must be idempotent, must remove every listener, must null out
 * `video.src` and call `video.load()` *before* revoking any blob URL, and must
 * destroy any third-party player it created.
 */

import type { QualityLevel } from '../quality';
import type { ProviderMatch } from '../routing/detect';
import type { ProviderCapabilities, ProviderId, SourceRect, VideoModuleConfig } from '../types';

/**
 * Closed error enum. `retryable` drives §7.4's backoff: transient classes retry
 * on `2s, 4s, 8s, 30s`, deterministic ones never do — retrying a `.mkv` forever
 * is how an LCD ends up in a permanent spinner.
 */
export type VideoErrorCode =
  | 'autoplay-blocked'
  | 'source-unplayable'
  | 'codec-unsupported'
  | 'clip-missing'
  | 'network'
  | 'stall'
  | 'provider-unavailable'
  /** §2.5 — `iframe_api` did not load within 10 s. A network class, so it retries. */
  | 'yt-api-unavailable'
  | 'aborted';

export interface VideoError {
  code: VideoErrorCode;
  message: string;
  retryable: boolean;
  provider: ProviderId | null;
  /** Middle-ellipsized by the error card; kept raw here for telemetry hashing. */
  url?: string;
}

const RETRYABLE: readonly VideoErrorCode[] = [
  'network',
  'stall',
  'autoplay-blocked',
  // A script that did not arrive in 10 s is a transient network condition, not
  // a property of the source: the same URL will play once the network returns.
  'yt-api-unavailable',
];

export function videoError(
  code: VideoErrorCode,
  message: string,
  provider: ProviderId | null,
  url?: string,
): VideoError {
  return {
    code,
    message,
    retryable: RETRYABLE.includes(code),
    provider,
    ...(url === undefined ? {} : { url }),
  };
}

/** A throwable carrying a `VideoError`, so `catch` sites keep the closed enum. */
export class VideoFailure extends Error {
  readonly detail: VideoError;

  constructor(detail: VideoError) {
    super(detail.message);
    this.name = 'VideoFailure';
    this.detail = detail;
  }
}

export function fail(
  code: VideoErrorCode,
  message: string,
  provider: ProviderId | null,
  url?: string,
): VideoFailure {
  return new VideoFailure(videoError(code, message, provider, url));
}

/** Normalises anything a `catch` caught into the closed error enum. */
export function toVideoError(err: unknown, provider: ProviderId | null, url?: string): VideoError {
  if (err instanceof VideoFailure) return err.detail;
  if (err instanceof Error && err.name === 'AbortError') {
    return videoError('aborted', 'Playback setup was aborted.', provider, url);
  }
  return videoError(
    'source-unplayable',
    err instanceof Error ? err.message : 'Unknown playback failure.',
    provider,
    url,
  );
}

/** The subset of `Geometry` an adapter is allowed to see (§1.1). */
export interface DisplayInfo {
  width: number;
  height: number;
  shape: 'circle' | 'square';
  targetFps: number;
  dpr: number;
}

/**
 * The height hint that means "give the provider its adaptive logic back".
 *
 * A sentinel rather than a second method because every `setQuality` caller — the
 * host, the loop, the twitch READY handler — already has a number in hand, and
 * an `auto` that is a different code path is an `auto` somebody forgets to wire
 * up. Negative is unambiguous: no rendition has a negative height.
 */
export const AUTO_QUALITY_HINT = -1;

export function isAutoQualityHint(heightHint: number): boolean {
  return !Number.isFinite(heightHint) || heightHint <= 0;
}

export type AdapterEvent =
  | { type: 'ready'; duration: number; caps: ProviderCapabilities }
  /**
   * What this source can actually be switched to, published the moment the
   * provider knows — a parsed HLS manifest, an initialised DASH stream,
   * Twitch's `getQualities()`, or the resolver's reported source height.
   *
   * Emitted only where the list is KNOWABLE. A cross-origin YouTube iframe and
   * a plain `<video src>` never emit it, and the UI shows a bias control or a
   * read-only resolution respectively rather than a picker full of options
   * nothing would honour.
   */
  | { type: 'levels'; levels: QualityLevel[] }
  | { type: 'playing' }
  | { type: 'buffering' }
  | { type: 'held' }
  | { type: 'ended' }
  | { type: 'timeupdate'; t: number }
  | { type: 'durationchange'; duration: number }
  | { type: 'sourcerect'; rect: SourceRect }
  | { type: 'quality'; height: number | null; label: string | null }
  | { type: 'error'; err: VideoError }
  | { type: 'stalled'; sinceMs: number };

/**
 * The overlay mask above the stage, handed to adapters that must drive it
 * themselves (§2.6).
 *
 * A bare `<video>` needs nothing here: the browser simply shows no frame until
 * one is decoded. A cross-origin player paints a spinner, a poster, a title bar
 * and a pause overlay that CSS cannot reach, so hiding those is a state machine
 * that only the adapter has the events for — `RenderController` owns the
 * element, the adapter owns the timeline.
 */
export interface MaskSurface {
  /** Opacity 1 with `transition: none` — a mask that fades UP shows the frame it hides. */
  showInstant(color?: string): void;
  fadeOut(fadeMs: number): void;
  /** A CSS `background-image` value, or `null` for the flat colour. */
  setPoster(image: string | null): void;
}

export interface MountContext {
  /** The stage element the adapter appends its surface to. Never transformed by the adapter. */
  container: HTMLElement;
  url: string;
  match: ProviderMatch;
  display: DisplayInfo;
  config: VideoModuleConfig;
  /** Aborted on teardown. Pass it to every fetch and every listener. */
  signal: AbortSignal;
  emit: (e: AdapterEvent) => void;
  /** Resolved performance mode; `performance` caps the `<video>` layout size (§8.3). */
  perf: 'quality' | 'performance';
  /** Only adapters that set `ownsMask` touch this. */
  mask: MaskSurface;
}

export interface SeekOptions {
  precise?: boolean;
  loopSeek?: boolean;
  /**
   * §3.4 — the loop engine has observed three clean crossings in a row, so this
   * backward seek is expected to be silent and the mask flash can be capped at
   * 100 ms instead of waiting for a `PLAYING` that will arrive immediately.
   */
  silentExpected?: boolean;
}

export interface VideoAdapter {
  readonly id: ProviderId;
  /** Initial static caps, refined after mount (e.g. `isLive`). */
  capabilities: ProviderCapabilities;
  /**
   * The adapter drives `MountContext.mask` itself, so the host must not raise or
   * lower the mask on `playing`/`buffering`. True for `youtube-embed`, whose
   * mask has a poster, a failsafe and a stall escalation the host cannot see.
   */
  readonly ownsMask?: boolean;
  mount(ctx: MountContext): Promise<void>;
  play(): Promise<void>;
  /** Pause-EQUIVALENT. Semantics are per-adapter; see §3.5. */
  hold(): Promise<void>;
  isHeld(): boolean;
  seek(t: number, opts?: SeekOptions): Promise<void>;
  setRate(r: number): Promise<void>;
  /** Sync, best-known; may be interpolated. */
  getCurrentTime(): number;
  /** `NaN` when unknown. */
  getDuration(): number;
  /** Seconds; `0` when unknown. */
  getBufferedEnd(): number;
  setMuted(m: boolean): void;
  setQuality?(heightHint: number): Promise<boolean>;
  getQuality?(): { height: number | null; label: string | null };
  /** The element `RenderController` transforms. */
  getSurface(): HTMLElement;
  getSourceRect(): SourceRect;
  teardown(): Promise<void>;
}

export type AdapterFactory = () => VideoAdapter;

/** §1.2 — the html-video family's shared row. */
export const HTML_VIDEO_CAPS: ProviderCapabilities = {
  canSeekSilently: true,
  canSetQuality: false,
  canReadQuality: false,
  hasOwnChrome: false,
  needsMuteForAutoplay: true,
  canTruePause: true,
  canSetRate: true,
  canSeek: true,
  reportsDuration: true,
  pixelSource: 'video-element',
};
