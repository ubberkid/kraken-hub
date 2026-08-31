import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HOLD_AFTER_PLAYING_MS,
  MASK_FADE_MS,
  MASK_MAX_MS,
  MASK_STALL_MS,
  YT_STATE,
  createMaskController,
  type MaskClock,
  type MaskController,
} from './maskController';

import type { MaskSurface } from '../adapters/VideoAdapter';

/**
 * The §2.6 transition table, one test per row, on a fake clock.
 *
 * Every rule here exists because the alternative is visible on a 640×640 panel
 * nobody can click: a spinner leaking through the crop, a suggested-video grid,
 * or — the worst one — a mask that never comes down and leaves the LCD black.
 */

interface FakeTimer {
  id: number;
  at: number;
  fn: () => void;
}

class FakeClock implements MaskClock {
  t = 0;
  private next = 1;
  private timers: FakeTimer[] = [];

  now(): number {
    return this.t;
  }

  schedule(fn: () => void, ms: number): never {
    const id = this.next++;
    this.timers.push({ id, at: this.t + ms, fn });
    return id as never;
  }

  cancel(handle: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== (handle as number));
  }

  /** Advances time and fires everything due, in order. */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers
        .filter((x) => x.at <= target)
        .sort((a, b) => a.at - b.at)
        .at(0);
      if (due === undefined) break;
      this.timers = this.timers.filter((x) => x.id !== due.id);
      this.t = due.at;
      due.fn();
    }
    this.t = target;
  }
}

function setup(over: Partial<Parameters<typeof createMaskController>[0]> = {}): {
  mask: MaskController;
  clock: FakeClock;
  surface: {
    showInstant: ReturnType<typeof vi.fn>;
    fadeOut: ReturnType<typeof vi.fn>;
    setPoster: ReturnType<typeof vi.fn>;
  };
  stalled: ReturnType<typeof vi.fn>;
} {
  const clock = new FakeClock();
  const surface = { showInstant: vi.fn(), fadeOut: vi.fn(), setPoster: vi.fn() };
  const stalled = vi.fn();
  const mask = createMaskController({
    surface: surface satisfies MaskSurface,
    posterUrls: ['max.jpg', 'hq.jpg'],
    usePoster: false,
    flatColor: '#000000',
    clock,
    onStalled: stalled,
    ...over,
  });
  return { mask, clock, surface, stalled };
}

describe('§2.6 mount', () => {
  it('starts VISIBLE — the first frame of an embed is its poster and title', () => {
    const { mask, surface } = setup();
    mask.mount();
    expect(mask.state()).toBe('visible');
    expect(surface.showInstant).toHaveBeenCalledWith('#000000');
  });
});

describe('§2.6 states that paint chrome raise the mask instantly', () => {
  const rows: [string, number][] = [
    ['UNSTARTED', YT_STATE.unstarted],
    ['CUED', YT_STATE.cued],
    ['PAUSED', YT_STATE.paused],
    ['ENDED', YT_STATE.ended],
    ['BUFFERING', YT_STATE.buffering],
  ];

  it.each(rows)('%s', (_label, state) => {
    const { mask, clock, surface } = setup();
    mask.mount();
    mask.onPlayerState(YT_STATE.playing, 5);
    clock.advance(HOLD_AFTER_PLAYING_MS + MASK_FADE_MS + 1);
    expect(mask.state()).toBe('hidden');

    surface.showInstant.mockClear();
    mask.onPlayerState(state, 5);
    expect(mask.state()).toBe('visible');
    // Instant, not faded: a mask that fades UP shows the frame it hides.
    expect(surface.showInstant).toHaveBeenCalledTimes(1);
    expect(surface.fadeOut).toHaveBeenCalledTimes(1); // only the earlier hide
  });
});

describe('§2.6 PLAYING drops the mask, but only with evidence', () => {
  it('fades 180 ms after holdAfterPlayingMs once the clock is past A + 0.05', () => {
    const { mask, clock, surface } = setup();
    mask.mount();
    mask.setBoundaryA(10);
    mask.onPlayerState(YT_STATE.playing, 10.1);

    clock.advance(HOLD_AFTER_PLAYING_MS - 1);
    expect(surface.fadeOut).not.toHaveBeenCalled();
    clock.advance(2);
    expect(surface.fadeOut).toHaveBeenCalledWith(MASK_FADE_MS);
    expect(mask.state()).toBe('hiding');
    clock.advance(MASK_FADE_MS);
    expect(mask.state()).toBe('hidden');
  });

  it('does NOT drop while the clock is still at or before A — the player lies about PLAYING', () => {
    const { mask, clock, surface } = setup();
    mask.mount();
    mask.setBoundaryA(10);
    mask.onPlayerState(YT_STATE.playing, 10);
    clock.advance(HOLD_AFTER_PLAYING_MS * 4);
    expect(surface.fadeOut).not.toHaveBeenCalled();
    expect(mask.state()).toBe('visible');
  });

  it('does NOT drop while a seek is still in flight', () => {
    const { mask, clock, surface } = setup();
    mask.mount();
    mask.onSeekIssued(30);
    mask.onPlayerState(YT_STATE.playing, 5); // stale clock, pre-seek
    clock.advance(HOLD_AFTER_PLAYING_MS * 4);
    expect(surface.fadeOut).not.toHaveBeenCalled();

    // The seek lands: the clock arrives past the target and the mask may go.
    mask.onPlayerState(YT_STATE.playing, 30.1);
    clock.advance(HOLD_AFTER_PLAYING_MS + 1);
    expect(surface.fadeOut).toHaveBeenCalledTimes(1);
  });

  it('clears seekPending from the poll clock too, not only from a state event', () => {
    const { mask, clock, surface } = setup();
    mask.mount();
    mask.onPlayerState(YT_STATE.playing, 5);
    clock.advance(HOLD_AFTER_PLAYING_MS + MASK_FADE_MS + 1);
    surface.fadeOut.mockClear();

    mask.onSeekIssued(30);
    expect(mask.state()).toBe('visible');
    mask.onTime(30.2);
    clock.advance(HOLD_AFTER_PLAYING_MS + 1);
    expect(surface.fadeOut).toHaveBeenCalledTimes(1);
  });
});

describe('§2.6 loop crossings', () => {
  it('caps the flash at 100 ms once the seek is known to be silent', () => {
    const { mask, clock, surface } = setup();
    mask.mount();
    mask.onLoopCrossing(2, true);
    expect(mask.state()).toBe('visible');
    clock.advance(100);
    expect(surface.fadeOut).toHaveBeenCalledWith(100);
  });

  it('waits for evidence of playback when the seek is not known to be silent', () => {
    const { mask, clock, surface } = setup();
    mask.mount();
    mask.onLoopCrossing(2, false);
    clock.advance(500);
    expect(surface.fadeOut).not.toHaveBeenCalled();
  });
});

describe('§2.6 failsafes', () => {
  it('forces the fade after 2.5 s of a masked PLAYING — never leave a black screen', () => {
    const { mask, clock, surface } = setup();
    mask.mount();
    // PLAYING arrives, but with a clock that never clears the A + 0.05 test.
    mask.onPlayerState(YT_STATE.playing, 0);
    clock.advance(MASK_MAX_MS - 1);
    mask.tick();
    expect(surface.fadeOut).not.toHaveBeenCalled();

    clock.advance(2);
    mask.tick();
    clock.advance(1);
    expect(surface.fadeOut).toHaveBeenCalled();
  });

  it('escalates to a stall exactly once after 15 s', () => {
    const { mask, clock, stalled } = setup();
    mask.mount();
    // BUFFERING keeps the mask up; nothing ever plays.
    mask.onPlayerState(YT_STATE.buffering, 0);
    clock.advance(MASK_STALL_MS + 10);
    mask.tick();
    mask.tick();
    mask.tick();
    expect(stalled).toHaveBeenCalledTimes(1);
    expect(stalled.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(MASK_STALL_MS);
  });

  it('does not escalate a mask that came back down', () => {
    const { mask, clock, stalled } = setup();
    mask.mount();
    mask.onPlayerState(YT_STATE.playing, 5);
    clock.advance(HOLD_AFTER_PLAYING_MS + MASK_FADE_MS + 1);
    clock.advance(MASK_STALL_MS * 2);
    mask.tick();
    expect(stalled).not.toHaveBeenCalled();
  });
});

describe('§2.6 poster fallback chain', () => {
  let loads: string[] = [];

  beforeEach(() => {
    loads = [];
  });

  it('falls back maxresdefault → hqdefault → flat colour', async () => {
    const { mask, surface } = setup({
      usePoster: true,
      loadPoster: (url: string) => {
        loads.push(url);
        return Promise.resolve(url === 'hq.jpg');
      },
    });
    mask.mount();
    await vi.waitFor(() => {
      expect(surface.setPoster).toHaveBeenCalledWith('url("hq.jpg")');
    });
    expect(loads).toEqual(['max.jpg', 'hq.jpg']);
  });

  it('uses the flat colour when neither poster exists', async () => {
    const { mask, surface } = setup({
      usePoster: true,
      loadPoster: () => Promise.resolve(false),
    });
    mask.mount();
    await vi.waitFor(() => {
      expect(surface.setPoster).toHaveBeenLastCalledWith(null);
    });
  });

  it('never fetches a poster in performance mode (§8.3: flat mask)', () => {
    const probe = vi.fn();
    const { mask, surface } = setup({ usePoster: false, loadPoster: probe });
    mask.mount();
    expect(probe).not.toHaveBeenCalled();
    expect(surface.setPoster).toHaveBeenCalledWith(null);
  });
});
