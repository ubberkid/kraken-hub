// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import {
  FIX_FOOTER,
  RETRIES_BEFORE_FALLBACK,
  RETRY_BACKOFF_MS,
  glyphFor,
  isRetryableCode,
  middleEllipsize,
  renderErrorCard,
  renderFallbackBadge,
  retryDelayMs,
  shouldFallbackToPrevious,
} from './ErrorCard';

/**
 * §7.4. The classification is the part that matters: the LCD is
 * non-interactive, so a wrong answer here is either a permanent spinner (a
 * deterministic failure retried forever) or a screen that gives up on a network
 * blip it would have recovered from.
 */

describe('retry classification', () => {
  it('retries the transient classes', () => {
    expect(isRetryableCode('network')).toBe(true);
    expect(isRetryableCode('stall')).toBe(true);
    expect(isRetryableCode('autoplay-blocked')).toBe(true);
    expect(isRetryableCode('yt-api-unavailable')).toBe(true);
    expect(isRetryableCode('provider-unavailable')).toBe(true);
  });

  it('never retries a deterministic answer', () => {
    // Retrying a .mkv every 30 s forever is how an LCD ends up in a permanent
    // spinner with the real message scrolled away.
    expect(isRetryableCode('codec-unsupported')).toBe(false);
    expect(isRetryableCode('clip-missing')).toBe(false);
    expect(isRetryableCode('source-unplayable')).toBe(false);
    expect(isRetryableCode('aborted')).toBe(false);
  });
});

describe('retryDelayMs', () => {
  it('walks §7.4’s ladder: 2, 4, 8, then 30 s forever', () => {
    expect(RETRY_BACKOFF_MS).toEqual([2000, 4000, 8000, 30_000]);
    expect(retryDelayMs(1)).toBe(2000);
    expect(retryDelayMs(2)).toBe(4000);
    expect(retryDelayMs(3)).toBe(8000);
    expect(retryDelayMs(4)).toBe(30_000);
    expect(retryDelayMs(99)).toBe(30_000);
  });

  it('treats a nonsensical attempt count as the first one', () => {
    expect(retryDelayMs(0)).toBe(2000);
    expect(retryDelayMs(-3)).toBe(2000);
  });
});

describe('shouldFallbackToPrevious', () => {
  it('needs both three failures and something to fall back TO', () => {
    expect(shouldFallbackToPrevious(RETRIES_BEFORE_FALLBACK, true)).toBe(true);
    expect(shouldFallbackToPrevious(RETRIES_BEFORE_FALLBACK, false)).toBe(false);
    expect(shouldFallbackToPrevious(RETRIES_BEFORE_FALLBACK - 1, true)).toBe(false);
  });
});

describe('middleEllipsize', () => {
  it('leaves a short URL alone', () => {
    expect(middleEllipsize('https://a.example/v.mp4')).toBe('https://a.example/v.mp4');
  });

  it('keeps both ends of a long one — the host AND the filename', () => {
    const long = `https://cdn.example.com/${'x'.repeat(80)}/clip-final-v2.mp4`;
    const out = middleEllipsize(long);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.startsWith('https://c')).toBe(true);
    expect(out.endsWith('.mp4')).toBe(true);
    expect(out).toContain('…');
  });
});

describe('glyphFor', () => {
  it('gives each category its own single character', () => {
    const glyphs = new Set([
      glyphFor('network'),
      glyphFor('autoplay-blocked'),
      glyphFor('clip-missing'),
      glyphFor('codec-unsupported'),
    ]);
    expect(glyphs.size).toBe(4);
    // One code point each: a multi-character glyph would wrap on a 398 px box.
    for (const g of glyphs) expect(Array.from(g)).toHaveLength(1);
  });
});

describe('renderErrorCard', () => {
  it('carries the fixed footer, because the fix is never on the LCD', () => {
    const el = renderErrorCard({ code: 'network', title: 'Video unavailable', body: 'No route.' });
    expect(el.querySelector('.kh-video__card-footer')?.textContent).toBe(FIX_FOOTER);
  });

  it('appends the room code when the sync channel is up', () => {
    const el = renderErrorCard({
      code: 'network',
      title: 'x',
      body: 'y',
      roomCode: 'K3M7QPZ2',
    });
    expect(el.querySelector('.kh-video__card-footer')?.textContent).toContain('K3M7QPZ2');
  });

  it('shows a retry counter only for a class that actually retries', () => {
    const transient = renderErrorCard({ code: 'network', title: 'x', body: 'y', retryCount: 2 });
    expect(transient.querySelector('.kh-video__card-retry')?.textContent).toContain('retry 2/∞');

    const permanent = renderErrorCard({
      code: 'codec-unsupported',
      title: 'x',
      body: 'y',
      retryCount: 2,
    });
    expect(permanent.querySelector('.kh-video__card-retry')).toBeNull();
  });

  it('middle-ellipsizes the detail line for the reader, not the log', () => {
    const el = renderErrorCard({
      code: 'network',
      title: 'x',
      body: 'y',
      detail: `https://cdn.example.com/${'y'.repeat(90)}.mp4`,
    });
    const text = el.querySelector('.kh-video__card-detail')?.textContent ?? '';
    expect(text.length).toBeLessThanOrEqual(40);
  });

  it('tags the card with its code so an e2e can assert on the category', () => {
    expect(renderErrorCard({ code: 'stall', title: 'x', body: 'y' }).dataset['errorCode']).toBe(
      'stall',
    );
  });
});

describe('renderFallbackBadge', () => {
  it('says what the viewer is actually looking at', () => {
    const el = renderFallbackBadge();
    expect(el.textContent).toContain('playing previous');
    expect(el.dataset['badge']).toBe('previous-source');
  });
});
