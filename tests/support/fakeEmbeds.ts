/**
 * Fake Twitch / Vimeo SDKs and a fake oEmbed, for the adapter contract tests.
 *
 * There is deliberately **no network e2e** for these three providers: a CI run
 * that depends on Twitch being up is a CI run that fails for reasons that have
 * nothing to do with this repo. What the contract tests can prove without a
 * network is the part we actually get wrong — that `parent` is derived from
 * `location.hostname` at runtime, that a live channel disables seeking, that
 * Vimeo's mask goes up before its pause, and that `setLoop(true)` is never
 * called.
 */

export interface FakeTwitchPlayerRecord {
  options: TwitchApi.PlayerOptions;
  quality: string | null;
  played: boolean;
  paused: boolean;
  seeks: number[];
  destroyed: boolean;
  fire(event: string): void;
}

export interface FakeTwitch {
  namespace: TwitchApi.Namespace;
  players: FakeTwitchPlayerRecord[];
}

export function installFakeTwitch(
  qualities: string[] = ['chunked', '1080p60', '720p', '480p'],
): FakeTwitch {
  const players: FakeTwitchPlayerRecord[] = [];

  class FakePlayer implements TwitchApi.Player {
    private readonly listeners = new Map<string, (() => void)[]>();
    private readonly record: FakeTwitchPlayerRecord;

    constructor(_target: string | HTMLElement, options: TwitchApi.PlayerOptions) {
      this.record = {
        options,
        quality: null,
        played: false,
        paused: false,
        seeks: [],
        destroyed: false,
        fire: (event) => {
          for (const fn of this.listeners.get(event) ?? []) fn();
        },
      };
      players.push(this.record);
    }

    play(): void {
      this.record.played = true;
    }
    pause(): void {
      this.record.paused = true;
    }
    seek(seconds: number): void {
      this.record.seeks.push(seconds);
    }
    getCurrentTime(): number {
      return 12;
    }
    getDuration(): number {
      return 600;
    }
    getEnded(): boolean {
      return false;
    }
    getMuted(): boolean {
      return true;
    }
    setMuted(): void {
      /* always muted on the LCD */
    }
    getQuality(): string {
      return this.record.quality ?? 'auto';
    }
    getQualities(): string[] {
      return qualities;
    }
    setQuality(quality: string): void {
      this.record.quality = quality;
    }
    getPlaybackStats(): { bufferSize?: number } {
      return { bufferSize: 8 };
    }
    addEventListener(event: string, fn: () => void): void {
      const list = this.listeners.get(event) ?? [];
      list.push(fn);
      this.listeners.set(event, list);
    }
    removeEventListener(event: string, fn: () => void): void {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((f) => f !== fn),
      );
    }
    destroy(): void {
      this.record.destroyed = true;
    }
  }

  const ctor = FakePlayer as unknown as TwitchApi.PlayerCtor;
  ctor.READY = 'ready';
  ctor.PLAYING = 'playing';
  ctor.PAUSE = 'pause';
  ctor.ENDED = 'ended';
  ctor.OFFLINE = 'offline';
  ctor.PLAY = 'play';
  ctor.SEEK = 'seek';

  const namespace: TwitchApi.Namespace = { Player: ctor };
  window.Twitch = namespace;
  return { namespace, players };
}

export interface FakeVimeoRecord {
  loopCalls: boolean[];
  paused: number;
  played: number;
  muted: boolean | null;
  seeks: number[];
  destroyed: boolean;
  emit(event: string, data?: unknown): void;
}

export function installFakeVimeo(duration = 300): { players: FakeVimeoRecord[] } {
  const players: FakeVimeoRecord[] = [];

  class FakeVimeoPlayer implements VimeoApi.Player {
    private readonly listeners = new Map<string, ((data?: unknown) => void)[]>();
    private readonly record: FakeVimeoRecord;

    constructor(_el: HTMLElement) {
      this.record = {
        loopCalls: [],
        paused: 0,
        played: 0,
        muted: null,
        seeks: [],
        destroyed: false,
        emit: (event, data) => {
          for (const fn of this.listeners.get(event) ?? []) fn(data);
        },
      };
      players.push(this.record);
    }

    play(): Promise<void> {
      this.record.played += 1;
      return Promise.resolve();
    }
    pause(): Promise<void> {
      this.record.paused += 1;
      return Promise.resolve();
    }
    getCurrentTime(): Promise<number> {
      return Promise.resolve(4);
    }
    setCurrentTime(seconds: number): Promise<number> {
      this.record.seeks.push(seconds);
      return Promise.resolve(seconds);
    }
    getDuration(): Promise<number> {
      return Promise.resolve(duration);
    }
    setMuted(muted: boolean): Promise<boolean> {
      this.record.muted = muted;
      return Promise.resolve(muted);
    }
    setVolume(volume: number): Promise<number> {
      return Promise.resolve(volume);
    }
    getPlaybackRate(): Promise<number> {
      return Promise.resolve(1);
    }
    setPlaybackRate(rate: number): Promise<number> {
      return Promise.resolve(rate);
    }
    getVideoWidth(): Promise<number> {
      return Promise.resolve(1920);
    }
    getVideoHeight(): Promise<number> {
      return Promise.resolve(1080);
    }
    on(event: string, fn: (data?: unknown) => void): void {
      const list = this.listeners.get(event) ?? [];
      list.push(fn);
      this.listeners.set(event, list);
    }
    off(event: string, fn?: (data?: unknown) => void): void {
      if (fn === undefined) this.listeners.delete(event);
      else
        this.listeners.set(
          event,
          (this.listeners.get(event) ?? []).filter((f) => f !== fn),
        );
    }
    setLoop(loop: boolean): Promise<boolean> {
      // Recorded, never expected: `setLoop(true)` suppresses `ended`, which the
      // loop engine uses as its failure signal (§3.4).
      this.record.loopCalls.push(loop);
      return Promise.resolve(loop);
    }
    destroy(): Promise<void> {
      this.record.destroyed = true;
      return Promise.resolve();
    }
  }

  window.Vimeo = { Player: FakeVimeoPlayer };
  return { players };
}

/** `loadEmbedScript` only ever appends a `<script>`; jsdom never fires `load`. */
export function autoResolveScripts(): () => void {
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLScriptElement) node.dispatchEvent(new Event('load'));
      }
    }
  });
  observer.observe(document.head, { childList: true });
  return () => {
    observer.disconnect();
  };
}
