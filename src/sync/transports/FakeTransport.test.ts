import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetNamespace } from '../../platform/storage';

import { FAKE_POLL_MS, createFakeTransport, markFakeDown } from './FakeTransport';

import type { FrameMeta, TransportOpts } from '../types';

const OPTS: TransportOpts = {
  topicId: 'TESTTOPIC0000000',
  clientId: 'test-client',
  role: 'config',
  mqttUrl: '',
  ntfyBase: '',
  signal: new AbortController().signal,
};

beforeEach(() => {
  resetNamespace();
  markFakeDown('primary', false);
  markFakeDown('fallback', false);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetNamespace();
});

describe('retained semantics', () => {
  it('delivers the last state message to a peer that connects afterwards', async () => {
    const writer = createFakeTransport('primary');
    await writer.connect(OPTS);
    await writer.publishState(new Uint8Array([1, 2, 3]));
    await writer.disconnect();

    // A COLD peer: it was not connected when the message was published, and
    // there is nothing else in the world to tell it what the state is.
    const reader = createFakeTransport('primary');
    const received: { frame: Uint8Array; meta: FrameMeta }[] = [];
    reader.onState((frame, meta) => received.push({ frame, meta }));
    await reader.connect(OPTS);

    expect(received).toHaveLength(1);
    expect([...(received[0]?.frame ?? [])]).toEqual([1, 2, 3]);
    expect(received[0]?.meta.retained).toBe(true);
    await reader.disconnect();
  });

  it('keeps only the LAST state message, like a retained slot', async () => {
    const writer = createFakeTransport('primary');
    await writer.connect(OPTS);
    await writer.publishState(new Uint8Array([1]));
    await writer.publishState(new Uint8Array([2]));
    await writer.disconnect();

    const reader = createFakeTransport('primary');
    const frames: number[][] = [];
    reader.onState((frame) => frames.push([...frame]));
    await reader.connect(OPTS);

    expect(frames).toEqual([[2]]);
    await reader.disconnect();
  });

  it('does NOT replay transient channels on connect', async () => {
    const writer = createFakeTransport('primary');
    await writer.connect(OPTS);
    await writer.publishCmd(new Uint8Array([9]));
    await writer.disconnect();

    const reader = createFakeTransport('primary');
    const cmds: number[][] = [];
    reader.onCmd((frame) => cmds.push([...frame]));
    await reader.connect(OPTS);
    await vi.advanceTimersByTimeAsync(FAKE_POLL_MS * 3);

    // A replayed `seekBy(+10)` is a bug, not a feature.
    expect(cmds).toEqual([]);
    await reader.disconnect();
  });

  it('keeps two slots completely separate', async () => {
    const primary = createFakeTransport('primary');
    await primary.connect(OPTS);
    await primary.publishState(new Uint8Array([7]));

    const fallback = createFakeTransport('fallback');
    const frames: number[][] = [];
    fallback.onState((frame) => frames.push([...frame]));
    await fallback.connect(OPTS);

    expect(frames).toEqual([]);
    await primary.disconnect();
    await fallback.disconnect();
  });
});

describe('going down', () => {
  it('refuses to connect, which is what the failover ladder needs', async () => {
    markFakeDown('primary', true);
    const t = createFakeTransport('primary');
    await expect(t.connect(OPTS)).rejects.toThrow(/down/);
  });

  it('rejects publishes once it is down mid-session', async () => {
    const t = createFakeTransport('primary');
    await t.connect(OPTS);
    markFakeDown('primary', true);
    await expect(t.publishState(new Uint8Array([1]))).rejects.toThrow(/down/);
    await t.disconnect();
  });

  it('reports offline from its poll so the service can react', async () => {
    const t = createFakeTransport('primary');
    await t.connect(OPTS);
    expect(t.status()).toBe('online');
    markFakeDown('primary', true);
    await vi.advanceTimersByTimeAsync(FAKE_POLL_MS * 2);
    expect(t.status()).toBe('offline');
    await t.disconnect();
  });
});
