import { describe, expect, it } from 'vitest';

import {
  RateLimiter,
  isPrivateHost,
  normaliseMaxHeight,
  validateTargetUrl,
} from '../src/resolve.js';

describe('normaliseMaxHeight', () => {
  it('snaps DOWN onto the delivery ladder, so a 640 panel never asks for 4K', () => {
    // The client computes 800 for a Kraken Elite and asks for 1080; a companion
    // capped at 2160 answers 1080, not 1440.
    expect(normaliseMaxHeight('1080', 2160)).toBe(1080);
    expect(normaliseMaxHeight('900', 2160)).toBe(720);
    expect(normaliseMaxHeight('2160', 2160)).toBe(2160);
  });

  it('honours a companion configured with a lower ceiling', () => {
    expect(normaliseMaxHeight('2160', 720)).toBe(720);
  });

  it('defaults rather than failing on junk', () => {
    expect(normaliseMaxHeight(null, 2160)).toBe(1080);
    expect(normaliseMaxHeight('abc', 2160)).toBe(1080);
    expect(normaliseMaxHeight('-4', 2160)).toBe(1080);
  });
});

describe('isPrivateHost', () => {
  it.each([
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    '10.1.2.3',
    '192.168.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '169.254.169.254',
    '100.64.0.1',
    'nas.local',
    '[::1]',
  ])('refuses %s', (host) => {
    expect(isPrivateHost(host)).toBe(true);
  });

  it.each(['youtube.com', 'example.com', '8.8.8.8', '172.32.0.1', '11.0.0.1'])(
    'allows %s',
    (host) => {
      expect(isPrivateHost(host)).toBe(false);
    },
  );
});

describe('validateTargetUrl', () => {
  it('accepts an ordinary https page URL', () => {
    const verdict = validateTargetUrl('https://www.youtube.com/watch?v=abc');
    expect(verdict.ok).toBe(true);
  });

  it('separates "refused on purpose" (403) from "not a thing we do" (400)', () => {
    const local = validateTargetUrl('file:///etc/passwd');
    expect(local).toMatchObject({ ok: false, status: 403, code: 'forbidden' });

    const plainHttp = validateTargetUrl('http://example.com/a.mp4');
    expect(plainHttp).toMatchObject({ ok: false, status: 400, code: 'unsupported-url' });
  });
});

describe('RateLimiter', () => {
  it('allows the configured burst and then refuses with a real retry delay', () => {
    let now = 0;
    const limiter = new RateLimiter(3, 1000, () => now);

    expect(limiter.take('a').allowed).toBe(true);
    now = 100;
    expect(limiter.take('a').allowed).toBe(true);
    now = 200;
    expect(limiter.take('a').allowed).toBe(true);

    now = 300;
    const refused = limiter.take('a');
    expect(refused.allowed).toBe(false);
    // The window opens again 1000 ms after the FIRST hit, i.e. in 700 ms.
    expect(refused.retryAfterMs).toBe(700);
  });

  it('is per-caller', () => {
    const limiter = new RateLimiter(1, 1000, () => 0);
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('b').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(false);
  });

  it('lets the window slide', () => {
    let now = 0;
    const limiter = new RateLimiter(1, 1000, () => now);
    expect(limiter.take('a').allowed).toBe(true);
    now = 1001;
    expect(limiter.take('a').allowed).toBe(true);
  });
});
