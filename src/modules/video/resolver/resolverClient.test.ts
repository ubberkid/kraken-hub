import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetNamespace } from '../../../platform/storage';
import { DEFAULT_RESOLVER, type ResolverConfig } from '../types';

import {
  checkHealth,
  deriveMaxHeight,
  invalidateHealth,
  resolve,
  resolverBase,
} from './resolverClient';
import { isLoopbackBase, parseEnvelope, parseHealth } from './resolverTypes';

/**
 * The client's three load-bearing behaviours (§6.4):
 *  - the `maxHeight` formula, which is what stops a 640 px panel from asking a
 *    companion to transcode 2160p;
 *  - `202` → `/job` polling, which is the normal case while yt-dlp is still
 *    downloading and must NOT be treated as an error;
 *  - loopback-only enforcement, which is a security boundary, not a preference.
 */

const cfg: ResolverConfig = { ...DEFAULT_RESOLVER };

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

beforeEach(() => {
  invalidateHealth();
  resetNamespace();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('deriveMaxHeight', () => {
  it('reproduces §6.4 exactly: a 640 panel at DPR 1, zoom 1 asks for 1080', () => {
    // ceil(640 * 1 * 1 * 1.25) = 800, snapped up onto the delivery ladder.
    expect(deriveMaxHeight({ displayW: 640, displayH: 640, dpr: 1, zoom: 1 })).toBe(1080);
  });

  it('never asks a 640 panel for 2160', () => {
    expect(deriveMaxHeight({ displayW: 640, displayH: 640, dpr: 1, zoom: 1.5 })).toBeLessThan(2160);
  });

  it('scales with dpr and with zoom', () => {
    // §6.4's "never 2160 for a 640 panel" is stated for DPR 1. At DPR 2 the
    // panel really does have 1280 device pixels, ceil(1280 * 1.25) = 1600, and
    // 2160 is the next rung a companion can actually deliver.
    expect(deriveMaxHeight({ displayW: 640, displayH: 640, dpr: 2, zoom: 1 })).toBe(2160);
    // A Kraken Z at 320 asks for the floor.
    expect(deriveMaxHeight({ displayW: 320, displayH: 320, dpr: 1, zoom: 1 })).toBe(480);
  });

  it('clamps the small end at 480 — nobody wants a 240p transcode', () => {
    expect(deriveMaxHeight({ displayW: 240, displayH: 240, dpr: 1, zoom: 1 })).toBe(480);
  });

  it('clamps the large end at 2160', () => {
    expect(deriveMaxHeight({ displayW: 4000, displayH: 4000, dpr: 3, zoom: 4 })).toBe(2160);
  });
});

describe('isLoopbackBase', () => {
  it('accepts the loopback forms the contract names', () => {
    expect(isLoopbackBase('http://127.0.0.1:8976')).toBe(true);
    expect(isLoopbackBase('http://localhost:8976')).toBe(true);
    expect(isLoopbackBase('http://[::1]:8976')).toBe(true);
  });

  it('rejects a LAN address — it is mixed content AND somebody else’s machine', () => {
    expect(isLoopbackBase('http://192.168.1.20:8976')).toBe(false);
    expect(isLoopbackBase('http://10.0.0.5:8976')).toBe(false);
    expect(isLoopbackBase('https://resolver.example.com')).toBe(false);
  });

  it('rejects a non-http scheme', () => {
    expect(isLoopbackBase('file:///tmp/resolver')).toBe(false);
    expect(isLoopbackBase('not a url')).toBe(false);
  });
});

describe('checkHealth', () => {
  it('accepts a v1 companion', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json({
        ok: true,
        name: 'kraken-hub-resolver',
        version: '1.0.0',
        api: 1,
        capabilities: [],
        maxHeight: 2160,
      }),
    );
    const state = await checkHealth(cfg, { fetchImpl: fetchImpl });
    expect(state.healthy).toBe(true);
    expect(state.base).toBe(resolverBase(cfg.port));
  });

  it('memoizes for 60 s so a mount never pays the probe twice', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        json({ ok: true, name: 'r', version: '1', api: 1, capabilities: [], maxHeight: 1080 }),
      );
    let clock = 1_000_000;
    const opts = { fetchImpl: fetchImpl, now: () => clock };
    await checkHealth(cfg, opts);
    await checkHealth(cfg, opts);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock += 61_000;
    await checkHealth(cfg, opts);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('is not healthy — and does not throw — when nothing is listening', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const state = await checkHealth(cfg, { fetchImpl: fetchImpl });
    expect(state.healthy).toBe(false);
    expect(state.reason).toContain('No companion');
  });

  it('refuses a mismatched api version rather than guessing at the wire format', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        json({ ok: true, name: 'r', version: '2', api: 2, capabilities: [], maxHeight: 1080 }),
      );
    const state = await checkHealth(cfg, { fetchImpl: fetchImpl });
    expect(state.healthy).toBe(false);
    expect(state.reason).toContain('api 2');
  });

  it('only ever addresses 127.0.0.1, whatever port is configured', () => {
    // The port is user-configurable; the HOST is not, and that is the security
    // boundary — `isLoopbackBase` above proves the predicate, this proves the
    // client never has a chance to build anything else.
    expect(resolverBase(1234)).toBe('http://127.0.0.1:1234');
    expect(resolverBase(8976)).toBe('http://127.0.0.1:8976');
  });
});

describe('resolve', () => {
  const opts = { maxHeight: 1080 };

  it('returns an ok envelope straight through', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json({
        status: 'ok',
        kind: 'progressive',
        streamUrl: 'http://127.0.0.1:8976/stream/abc.mp4',
        mime: 'video/mp4',
        height: 1080,
      }),
    );
    const out = await resolve('https://youtu.be/dQw4w9WgXcQ', cfg, {
      ...opts,
      fetchImpl: fetchImpl,
    });
    expect(out.status).toBe('ok');
    const url = new URL((fetchImpl.mock.calls[0] as [string])[0]);
    expect(url.searchParams.get('maxHeight')).toBe('1080');
    // The LCD is muted, so audio is not requested unless the user opted in.
    expect(url.searchParams.get('audio')).toBe('0');
  });

  it('polls /job while the companion is still downloading (202 is NOT an error)', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ status: 'pending', jobId: 'j1', retryAfterMs: 300 }, 202))
      .mockResolvedValueOnce(json({ status: 'pending', jobId: 'j1', retryAfterMs: 300 }, 202))
      .mockResolvedValueOnce(
        json({
          status: 'ok',
          kind: 'file',
          streamUrl: 'http://127.0.0.1:8976/stream/j1.mp4',
          mime: 'video/mp4',
        }),
      );
    const promise = resolve('https://youtu.be/x', cfg, {
      ...opts,
      fetchImpl: fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(2000);
    const out = await promise;
    expect(out.status).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect((fetchImpl.mock.calls[1] as [string])[0]).toContain('/job/j1');
  });

  it('gives up on a job that never settles, with a closed-enum code', async () => {
    let clock = 0;
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(json({ status: 'pending', jobId: 'j1', retryAfterMs: 300 }, 202));
    const promise = resolve('https://youtu.be/x', cfg, {
      ...opts,
      fetchImpl: fetchImpl,
      now: () => {
        clock += 30_000;
        return clock;
      },
    });
    await vi.advanceTimersByTimeAsync(1000);
    const out = await promise;
    expect(out).toEqual({
      status: 'error',
      code: 'upstream-failed',
      message: 'The resolver was still downloading after 60 s.',
    });
  });

  it('turns a transport failure into an envelope rather than a throw', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const out = await resolve('https://youtu.be/x', cfg, {
      ...opts,
      fetchImpl: fetchImpl,
    });
    expect(out.status).toBe('error');
  });
});

describe('parseEnvelope', () => {
  it('keeps the error enum closed', () => {
    expect(parseEnvelope({ status: 'error', code: 'rate-limited', retryAfterMs: 5000 })).toEqual({
      status: 'error',
      code: 'rate-limited',
      retryAfterMs: 5000,
    });
    // A companion inventing its own code must not leak it into our telemetry.
    expect(parseEnvelope({ status: 'error', code: 'teapot' })).toEqual({
      status: 'error',
      code: 'internal',
    });
  });

  it('rejects an ok answer with no usable streamUrl', () => {
    const out = parseEnvelope({ status: 'ok', kind: 'progressive' });
    expect(out.status).toBe('error');
  });

  it('rejects an unknown kind', () => {
    const out = parseEnvelope({ status: 'ok', kind: 'magnet', streamUrl: 'http://127.0.0.1/x' });
    expect(out.status).toBe('error');
  });

  it('defaults a pending answer that forgot retryAfterMs', () => {
    expect(parseEnvelope({ status: 'pending', jobId: 'j' })).toEqual({
      status: 'pending',
      jobId: 'j',
      retryAfterMs: 1500,
    });
  });

  it('never throws on garbage', () => {
    expect(parseEnvelope(null).status).toBe('error');
    expect(parseEnvelope('nope').status).toBe('error');
    expect(parseHealth({ ok: false })).toBeNull();
  });
});
