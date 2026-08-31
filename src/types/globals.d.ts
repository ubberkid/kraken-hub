/**
 * Ambient globals for kraken-hub.
 *
 * The NZXT types below intentionally mirror the official (but effectively
 * abandoned) `@nzxt/web-integrations-types` package rather than depending on it:
 * https://github.com/NZXTCorp/web-integrations-types/blob/main/v1/index.d.ts
 *
 * Contract notes that the types cannot express, but that callers must honour:
 *  - CAM injects `window.nzxt.v1`; injection may land *after* `load`.
 *    Never reassign `window.nzxt` or `window.nzxt.v1` wholesale — doing so
 *    destroys CAM's injected `width` / `height` / `shape` / `targetFps`.
 *    Subscribe by property assignment only (see `src/platform/nzxt.ts`).
 *  - `onMonitoringDataUpdate` is called at ~1 Hz once assigned.
 *  - Every numeric field of `MonitoringData` is `number | undefined`.
 *  - `kraken` exposes ONLY `liquidTemperature`. There is no pump-RPM field.
 */

/** Injected by Vite `define` at build time. */
declare const __APP_VERSION__: string;
/** Short git SHA of the build, or `'dev'` when unavailable. */
declare const __GIT_SHA__: string;
/** ISO-8601 timestamp of the build. */
declare const __BUILD_TIME__: string;
/**
 * The repository this build came from, normalised from `package.json`'s
 * `repository.url`. Derived at build time rather than written down anywhere in
 * `src/`, so a fork points at the fork (invariant 4).
 */
declare const __REPO_URL__: string;

declare namespace NzxtV1 {
  /** CAM reports `'circle'` for Kraken Elite / Z and `'square'` for Kraken (2023). */
  type Shape = 'circle' | 'square';

  interface Cpu {
    name?: string | undefined;
    manufacturer?: string | undefined;
    codeName?: string | undefined;
    socket?: string | undefined;
    /** Fraction in 0..1, not a percentage. */
    load?: number | undefined;
    numCores?: number | undefined;
    numThreads?: number | undefined;
    /** Celsius. */
    temperature?: number | undefined;
    minTemperature?: number | undefined;
    maxTemperature?: number | undefined;
    /** MHz. */
    frequency?: number | undefined;
    minFrequency?: number | undefined;
    maxFrequency?: number | undefined;
    stockFrequency?: number | undefined;
    /** RPM. */
    fanSpeed?: number | undefined;
    minFanSpeed?: number | undefined;
    maxFanSpeed?: number | undefined;
    /** Watts. */
    tdp?: number | undefined;
    power?: number | undefined;
  }

  interface Gpu {
    name?: string | undefined;
    /** Fraction in 0..1, not a percentage. */
    load?: number | undefined;
    /** Celsius. */
    temperature?: number | undefined;
    minTemperature?: number | undefined;
    maxTemperature?: number | undefined;
    /** MHz. */
    frequency?: number | undefined;
    minFrequency?: number | undefined;
    maxFrequency?: number | undefined;
    stockFrequency?: number | undefined;
    /** RPM. */
    fanSpeed?: number | undefined;
    minFanSpeed?: number | undefined;
    maxFanSpeed?: number | undefined;
    /** Watts. */
    power?: number | undefined;
  }

  interface RamModule {
    kind?: string | undefined;
    /** Mebibytes. */
    size?: number | undefined;
    model?: string | undefined;
    /** MHz. */
    frequency?: number | undefined;
    stockFrequency?: number | undefined;
  }

  interface Ram {
    /** Mebibytes. */
    totalSize?: number | undefined;
    /** Mebibytes. */
    inUse?: number | undefined;
    modules?: RamModule[] | undefined;
  }

  /** The ONLY field CAM exposes for the cooler. There is no pump RPM. */
  interface Kraken {
    /** Celsius. */
    liquidTemperature?: number | undefined;
  }

  interface MonitoringData {
    cpus?: Cpu[] | undefined;
    gpus?: Gpu[] | undefined;
    ram?: Ram | undefined;
    kraken?: Kraken | undefined;
  }

  interface Api {
    /** Assign (never replace the parent object) to receive the ~1 Hz feed. */
    onMonitoringDataUpdate?: (data: MonitoringData) => void;
    width: number;
    height: number;
    shape: Shape;
    targetFps: number;
  }
}

/**
 * The YouTube IFrame Player API surface kraken-hub actually uses
 * (design-videoEngine.md §2.5–2.7).
 *
 * Declared here rather than pulled from `@types/youtube` so the contract is
 * exactly what the geometry engine depends on and nothing more — in particular
 * `setPlaybackQuality` is deliberately ABSENT: it has been a documented no-op
 * for years, and having it in scope invites somebody to call it.
 */
declare namespace YtApi {
  /** UNSTARTED −1, ENDED 0, PLAYING 1, PAUSED 2, BUFFERING 3, CUED 5. */
  type PlayerStateValue = -1 | 0 | 1 | 2 | 3 | 5;

  interface PlayerEvent {
    target: Player;
  }

  interface StateChangeEvent extends PlayerEvent {
    data: PlayerStateValue;
  }

  interface QualityChangeEvent extends PlayerEvent {
    data: string;
  }

  interface ErrorEvent extends PlayerEvent {
    data: number;
  }

  interface PlayerEvents {
    onReady?: (e: PlayerEvent) => void;
    onStateChange?: (e: StateChangeEvent) => void;
    onPlaybackQualityChange?: (e: QualityChangeEvent) => void;
    onError?: (e: ErrorEvent) => void;
  }

  interface PlayerOptions {
    events?: PlayerEvents;
  }

  interface Player {
    playVideo(): void;
    /**
     * NEVER call this from the youtube-embed adapter's `hold()` — it raises the
     * suggested-video grid and the title overlay INSIDE the video rect, where
     * the crop cannot reach them (§2.6). `maskedPause` is the only sanctioned
     * caller, and only behind a fully opaque mask.
     */
    pauseVideo(): void;
    seekTo(seconds: number, allowSeekAhead: boolean): void;
    mute(): void;
    unMute(): void;
    setPlaybackRate(rate: number): void;
    getAvailablePlaybackRates(): number[];
    getCurrentTime(): number;
    getDuration(): number;
    getVideoLoadedFraction(): number;
    getPlaybackQuality(): string;
    getPlayerState(): PlayerStateValue;
    destroy(): void;
  }

  interface Namespace {
    Player: new (element: HTMLElement | string, options?: PlayerOptions) => Player;
    PlayerState?: Record<string, number>;
  }
}

/**
 * Twitch's Embed JS API (`https://embed.twitch.tv/embed/v1.js`), reduced to the
 * surface this app uses.
 *
 * `parent` is the load-bearing one: Twitch refuses to render unless every
 * hostname that frames the player is listed, so it is computed from
 * `location.hostname` at runtime — never hardcoded, so a fork works unchanged.
 */
declare namespace TwitchApi {
  interface PlayerOptions {
    width: number | string;
    height: number | string;
    video?: string;
    channel?: string;
    collection?: string;
    parent: string[];
    autoplay?: boolean;
    muted?: boolean;
    controls?: boolean;
    time?: string;
  }

  interface Player {
    play(): void;
    pause(): void;
    seek(seconds: number): void;
    getCurrentTime(): number;
    getDuration(): number;
    getEnded(): boolean;
    getMuted(): boolean;
    setMuted(muted: boolean): void;
    getQuality(): string;
    getQualities(): string[];
    setQuality(quality: string): void;
    getPlaybackStats(): { bufferSize?: number } | null;
    addEventListener(event: string, fn: () => void): void;
    removeEventListener(event: string, fn: () => void): void;
    destroy?: () => void;
  }

  interface PlayerCtor {
    new (target: string | HTMLElement, options: PlayerOptions): Player;
    READY: string;
    PLAYING: string;
    PAUSE: string;
    ENDED: string;
    OFFLINE: string;
    PLAY: string;
    SEEK: string;
  }

  interface Namespace {
    Player: PlayerCtor;
  }
}

/**
 * Vimeo's player.js, reduced to the surface this app uses. Every getter is a
 * Promise, which is why `PolledLoop` treats Vimeo's clock as a 10 Hz poll with
 * an in-flight guard rather than a synchronous read (§3.4).
 */
declare namespace VimeoApi {
  interface Player {
    play(): Promise<void>;
    pause(): Promise<void>;
    getCurrentTime(): Promise<number>;
    setCurrentTime(seconds: number): Promise<number>;
    getDuration(): Promise<number>;
    setMuted(muted: boolean): Promise<boolean>;
    setVolume(volume: number): Promise<number>;
    getPlaybackRate(): Promise<number>;
    setPlaybackRate(rate: number): Promise<number>;
    getVideoWidth(): Promise<number>;
    getVideoHeight(): Promise<number>;
    getBuffered?: () => Promise<[number, number][]>;
    on(event: string, fn: (data?: unknown) => void): void;
    off(event: string, fn?: (data?: unknown) => void): void;
    /** NEVER call with `true`: it suppresses `ended`, our failure signal (§3.4). */
    setLoop(loop: boolean): Promise<boolean>;
    destroy(): Promise<void>;
  }

  interface Namespace {
    Player: new (
      element: HTMLIFrameElement | HTMLElement,
      options?: Record<string, unknown>,
    ) => Player;
  }
}

interface Window {
  nzxt?: {
    v1?: NzxtV1.Api;
  };
  YT?: YtApi.Namespace;
  Twitch?: TwitchApi.Namespace;
  Vimeo?: VimeoApi.Namespace;
  /**
   * The IFrame API's one global callback. A page may already have defined it
   * (another embed, an extension); `ytApiLoader` CHAINS rather than replaces.
   */
  onYouTubeIframeAPIReady?: () => void;
}
