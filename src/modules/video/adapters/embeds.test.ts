// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  autoResolveScripts,
  installFakeTwitch,
  installFakeVimeo,
} from '../../../../tests/support/fakeEmbeds';
import { detect } from '../routing/detect';
import { VIDEO_DEFAULTS, type VideoModuleConfig } from '../types';

import { resetEmbedScriptCache } from './embedSurface';
import {
  aspectFromOEmbed,
  durationFromOEmbed,
  oembedUrl,
  STREAMABLE_CAPS,
} from './streamable.adapter';
import { pickTwitchQuality, twitchParents, twitchQualityHeight } from './twitch.adapter';
import { VIMEO_CAPS } from './vimeo.adapter';

import type { AdapterEvent, MountContext } from './VideoAdapter';

/**
 * Contract tests for the three SDK-backed embed providers, with the SDKs faked.
 *
 * Deliberately no network e2e for these: a CI job that needs Twitch to be up is
 * a CI job that fails for reasons unrelated to this repo. What IS worth pinning
 * down is everything a refactor could silently break — `parent` derived at
 * runtime, live channels refusing to seek, Vimeo's mask-before-pause ordering,
 * and the standing prohibition on `setLoop(true)`.
 */

function makeCtx(
  url: string,
  patch: Partial<VideoModuleConfig> = {},
): {
  ctx: MountContext;
  events: AdapterEvent[];
  masked: string[];
} {
  const events: AdapterEvent[] = [];
  const masked: string[] = [];
  const container = document.createElement('div');
  document.body.append(container);
  const ctx: MountContext = {
    container,
    url,
    match: detect(url),
    display: { width: 640, height: 640, shape: 'circle', targetFps: 40, dpr: 1 },
    config: { ...VIDEO_DEFAULTS, ...patch },
    signal: new AbortController().signal,
    emit: (e) => events.push(e),
    perf: 'quality',
    mask: {
      showInstant: () => masked.push('show'),
      fadeOut: () => masked.push('fade'),
      setPoster: () => masked.push('poster'),
    },
  };
  return { ctx, events, masked };
}

let stopScripts: (() => void) | null = null;

beforeEach(() => {
  resetEmbedScriptCache();
  stopScripts = autoResolveScripts();
});

afterEach(() => {
  stopScripts?.();
  document.body.replaceChildren();
  delete window.Twitch;
  delete window.Vimeo;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Twitch
// ---------------------------------------------------------------------------

describe('twitch: quality mapping', () => {
  it('reads a height out of every label Twitch actually emits', () => {
    expect(twitchQualityHeight('1080p60')).toBe(1080);
    expect(twitchQualityHeight('720p')).toBe(720);
    // `chunked` is Twitch's name for the untranscoded source.
    expect(twitchQualityHeight('chunked')).toBe(1080);
    expect(twitchQualityHeight('auto')).toBeNull();
  });

  it('picks the highest rendition that fits the crop', () => {
    expect(pickTwitchQuality(['chunked', '1080p60', '720p', '480p'], 720)).toBe('720p');
    expect(pickTwitchQuality(['chunked', '1080p60', '720p', '480p'], 1080)).toBe('1080p60');
  });

  it('falls to the lowest rendition rather than leaving ABR to guess', () => {
    // A 640 px panel must never end up pulling a source stream by default.
    expect(pickTwitchQuality(['1080p60', '720p'], 360)).toBe('720p');
    expect(pickTwitchQuality(['auto'], 720)).toBeNull();
  });
});

describe('twitch: parent', () => {
  it('is derived from the hostname, never baked in — this is what makes a fork work', () => {
    expect(twitchParents('someone.github.io')).toEqual(['someone.github.io']);
    expect(twitchParents('127.0.0.1')).toEqual(['127.0.0.1']);
    expect(twitchParents('')).toEqual([]);
  });
});

describe('twitch adapter', () => {
  it('passes the runtime parent and asks for a rendition that fits the crop', async () => {
    const fake = installFakeTwitch();
    const { createAdapter } = await import('./twitch.adapter');
    const adapter = createAdapter();
    const { ctx, events } = makeCtx('https://www.twitch.tv/videos/123456789');
    await adapter.mount(ctx);

    const player = fake.players[0];
    expect(player?.options.parent).toEqual([window.location.hostname]);
    expect(player?.options.muted).toBe(true);
    expect(player?.options.controls).toBe(false);

    player?.fire('ready');
    // The crop side at the default geometry is 1080, so the 1080 rendition wins.
    expect(player?.quality).toBe('1080p60');
    expect(events.some((e) => e.type === 'ready')).toBe(true);
    await adapter.teardown();
  });

  it('reports a SourceRect before the SDK has even loaded', async () => {
    installFakeTwitch();
    const { createAdapter } = await import('./twitch.adapter');
    const adapter = createAdapter();
    const { ctx, events } = makeCtx('https://www.twitch.tv/videos/1');
    await adapter.mount(ctx);
    const rect = events.find((e) => e.type === 'sourcerect');
    expect(rect).toBeDefined();
    // The centre crop of the letterboxed 16:9 band, exactly as YouTube's is.
    expect(adapter.getSourceRect().safe.w).toBe(1080);
    await adapter.teardown();
  });

  it('disables seek and looping for a live channel', async () => {
    const fake = installFakeTwitch();
    const { createAdapter } = await import('./twitch.adapter');
    const adapter = createAdapter();
    const { ctx } = makeCtx('https://www.twitch.tv/somestreamer');
    await adapter.mount(ctx);
    expect(adapter.capabilities.canSeek).toBe(false);
    expect(adapter.capabilities.reportsDuration).toBe(false);

    await adapter.seek(30);
    // §3.4 — a live window slides; seeking into it is an unrecoverable spinner.
    expect(fake.players[0]?.seeks).toEqual([]);
    await adapter.teardown();
  });

  it('seeks a VOD', async () => {
    const fake = installFakeTwitch();
    const { createAdapter } = await import('./twitch.adapter');
    const adapter = createAdapter();
    const { ctx } = makeCtx('https://www.twitch.tv/videos/999');
    await adapter.mount(ctx);
    await adapter.seek(42);
    expect(fake.players[0]?.seeks).toEqual([42]);
    await adapter.teardown();
  });

  it('tears the player down idempotently', async () => {
    const fake = installFakeTwitch();
    const { createAdapter } = await import('./twitch.adapter');
    const adapter = createAdapter();
    const { ctx } = makeCtx('https://www.twitch.tv/videos/1');
    await adapter.mount(ctx);
    await adapter.teardown();
    await adapter.teardown();
    expect(fake.players[0]?.destroyed).toBe(true);
    expect(document.querySelector('.kh-video__embed')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Vimeo
// ---------------------------------------------------------------------------

describe('vimeo adapter', () => {
  it('declares quality control as unavailable, because for a public video it is', () => {
    // `setQuality` is gated on the UPLOADER's tier, so claiming otherwise would
    // make the config UI offer a control that silently does nothing.
    expect(VIMEO_CAPS.canSetQuality).toBe(false);
    expect(VIMEO_CAPS.hasOwnChrome).toBe(true);
  });

  it('mutes, reports a duration and starts playing', async () => {
    const fake = installFakeVimeo(300);
    const { createAdapter } = await import('./vimeo.adapter');
    const adapter = createAdapter();
    const { ctx, events } = makeCtx('https://vimeo.com/76979871');
    await adapter.mount(ctx);
    expect(fake.players[0]?.muted).toBe(true);
    expect(fake.players[0]?.played).toBe(1);
    expect(events.find((e) => e.type === 'ready')).toMatchObject({ duration: 300 });
    await adapter.teardown();
  });

  it('NEVER calls setLoop(true) — it would suppress the `ended` failure signal', async () => {
    const fake = installFakeVimeo();
    const { createAdapter } = await import('./vimeo.adapter');
    const adapter = createAdapter();
    const { ctx } = makeCtx('https://vimeo.com/76979871');
    await adapter.mount(ctx);
    await adapter.seek(10);
    await adapter.hold();
    expect(fake.players[0]?.loopCalls).toEqual([]);
    await adapter.teardown();
  });

  it('raises the mask BEFORE pausing — Vimeo paints a play button on pause', async () => {
    const fake = installFakeVimeo();
    const { createAdapter } = await import('./vimeo.adapter');
    const adapter = createAdapter();
    const { ctx, masked } = makeCtx('https://vimeo.com/76979871');
    await adapter.mount(ctx);
    masked.length = 0;
    await adapter.hold();
    expect(masked[0]).toBe('show');
    expect(fake.players[0]?.paused).toBe(1);
    expect(adapter.isHeld()).toBe(true);
    await adapter.teardown();
  });

  it('carries the unlisted hash into the embed URL', async () => {
    installFakeVimeo();
    const { createAdapter } = await import('./vimeo.adapter');
    const adapter = createAdapter();
    const { ctx } = makeCtx('https://vimeo.com/76979871/abc123def4');
    await adapter.mount(ctx);
    const src = (adapter.getSurface() as HTMLIFrameElement).src;
    expect(new URL(src).searchParams.get('h')).toBe('abc123def4');
    // Chrome-suppressing parameters that DO work on Vimeo.
    expect(new URL(src).searchParams.get('title')).toBe('0');
    expect(new URL(src).searchParams.get('byline')).toBe('0');
    await adapter.teardown();
  });
});

// ---------------------------------------------------------------------------
// Streamable
// ---------------------------------------------------------------------------

describe('streamable adapter', () => {
  it('declares the honest capability row: no clock, no seek, no pause', () => {
    expect(STREAMABLE_CAPS.canSeek).toBe(false);
    expect(STREAMABLE_CAPS.canTruePause).toBe(false);
    expect(STREAMABLE_CAPS.canSetQuality).toBe(false);
    expect(STREAMABLE_CAPS.reportsDuration).toBe(false);
  });

  it('builds the oEmbed URL against the watch page, not the embed page', () => {
    expect(oembedUrl('abc123')).toContain(encodeURIComponent('https://streamable.com/abc123'));
  });

  it('reads the SOURCE aspect out of oEmbed, which is the only reason to call it', () => {
    expect(aspectFromOEmbed({ width: 1080, height: 1920 })).toBeCloseTo(0.5625, 4);
    expect(aspectFromOEmbed({ width: 0, height: 100 })).toBeNull();
    expect(aspectFromOEmbed(null)).toBeNull();
    expect(durationFromOEmbed({ duration: 12.5 })).toBe(12.5);
    expect(Number.isNaN(durationFromOEmbed({}))).toBe(true);
  });

  it('re-crops to the measured aspect when oEmbed answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ width: 1080, height: 1920, duration: 30 }),
      }),
    );
    const { createAdapter } = await import('./streamable.adapter');
    const adapter = createAdapter();
    const { ctx, events } = makeCtx('https://streamable.com/abc123');
    await adapter.mount(ctx);
    // Two SourceRects: the 16:9 assumption, then the real 9:16 one.
    const rects = events.filter((e) => e.type === 'sourcerect');
    expect(rects.length).toBeGreaterThanOrEqual(2);
    expect(adapter.getSourceRect().mediaAspect).toBeCloseTo(0.5625, 4);
    await adapter.teardown();
  });

  it('plays anyway when oEmbed is refused — it is an optimisation, not a requirement', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const { createAdapter } = await import('./streamable.adapter');
    const adapter = createAdapter();
    const { ctx, events } = makeCtx('https://streamable.com/abc123');
    await adapter.mount(ctx);
    expect(events.some((e) => e.type === 'playing')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    await adapter.teardown();
  });
});
