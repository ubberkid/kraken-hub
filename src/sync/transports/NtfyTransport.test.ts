import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toBase64Url } from '../crypto';

import { createNtfyTransport } from './NtfyTransport';

import type { FrameMeta, TransportOpts } from '../types';

const OPTS: TransportOpts = {
  topicId: 'TESTTOPIC0000000',
  clientId: 'test-client',
  role: 'display',
  mqttUrl: '',
  ntfyBase: 'https://ntfy.example.test',
  signal: new AbortController().signal,
};

/** ntfy replies to `?poll=1` with newline-delimited JSON, one message per line. */
function pollLine(tag: 'S' | 'C' | 'T', bytes: number[], time: number): string {
  return JSON.stringify({
    event: 'message',
    time,
    message: `${tag}|${toBase64Url(new Uint8Array(bytes))}`,
  });
}

interface StubEventSource {
  url: string;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  close: () => void;
}

let sources: StubEventSource[] = [];
let pollBody = '';
let posts: { url: string; body: string }[] = [];

beforeEach(() => {
  sources = [];
  posts = [];
  pollBody = '';

  vi.stubGlobal(
    'EventSource',
    class {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      constructor(public url: string) {
        sources.push(this);
      }
      close(): void {
        /* nothing to tear down in the stub */
      }
    },
  );

  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') {
        posts.push({ url: input, body: init.body ?? '' });
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') });
      }
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(pollBody) });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('recovery', () => {
  it('takes the LAST state message from the replay window', async () => {
    // Three snapshots in the cache. Only the newest is the current desired
    // state; applying an older one would move a display backwards in time.
    pollBody = [pollLine('S', [1], 1000), pollLine('S', [2], 2000), pollLine('S', [3], 3000)].join(
      '\n',
    );

    const t = createNtfyTransport();
    const received: { frame: Uint8Array; meta: FrameMeta }[] = [];
    t.onState((frame, meta) => received.push({ frame, meta }));
    await t.connect(OPTS);

    expect(received).toHaveLength(1);
    expect([...(received[0]?.frame ?? [])]).toEqual([3]);
    expect(received[0]?.meta.retained).toBe(true);
    await t.disconnect();
  });

  it('polls a bounded window, not the whole cache', async () => {
    const t = createNtfyTransport();
    await t.connect(OPTS);
    const call = (globalThis.fetch as unknown as { mock: { calls: [string][] } }).mock.calls[0];
    // `since=all` can be truncated at 10 MB per topic, and a truncated replay
    // silently drops the NEWEST messages — the only ones that matter.
    expect(call?.[0]).toContain('poll=1');
    expect(call?.[0]).toContain('since=10m');
    expect(call?.[0]).toContain('kraken-hub-v1-TESTTOPIC0000000');
    await t.disconnect();
  });

  it('never replays a command out of the cache', async () => {
    pollBody = [pollLine('C', [42], 1000), pollLine('S', [1], 2000)].join('\n');
    const t = createNtfyTransport();
    const cmds: number[][] = [];
    t.onCmd((frame) => cmds.push([...frame]));
    await t.connect(OPTS);
    expect(cmds).toEqual([]);
    await t.disconnect();
  });

  it('survives a truncated final line', async () => {
    pollBody = `${pollLine('S', [5], 1000)}\n{"event":"mess`;
    const t = createNtfyTransport();
    const frames: number[][] = [];
    t.onState((frame) => frames.push([...frame]));
    await t.connect(OPTS);
    expect(frames).toEqual([[5]]);
    await t.disconnect();
  });

  it('connects with no replay at all', async () => {
    pollBody = '';
    const t = createNtfyTransport();
    await expect(t.connect(OPTS)).resolves.toBeUndefined();
    expect(t.status()).toBe('online');
    await t.disconnect();
  });
});

describe('live stream', () => {
  it('routes an SSE message to the channel its tag names', async () => {
    const t = createNtfyTransport();
    const states: number[][] = [];
    const teles: number[][] = [];
    t.onState((frame) => states.push([...frame]));
    t.onTele((frame) => teles.push([...frame]));
    await t.connect(OPTS);

    const source = sources[0];
    expect(source?.url).toContain('/sse');
    source?.onmessage?.({ data: pollLine('T', [8], 4000) });
    source?.onmessage?.({ data: pollLine('S', [9], 5000) });

    expect(teles).toEqual([[8]]);
    expect(states).toEqual([[9]]);
    await t.disconnect();
  });

  it('ignores keepalive frames that are not JSON messages', async () => {
    const t = createNtfyTransport();
    const states: number[][] = [];
    t.onState((frame) => states.push([...frame]));
    await t.connect(OPTS);
    sources[0]?.onmessage?.({ data: '' });
    sources[0]?.onmessage?.({ data: JSON.stringify({ event: 'keepalive' }) });
    expect(states).toEqual([]);
    await t.disconnect();
  });
});

describe('publishing', () => {
  it('posts a tagged base64url body as a CORS simple request', async () => {
    const t = createNtfyTransport();
    await t.connect(OPTS);
    await t.publishState(new Uint8Array([1, 2, 3]));

    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe('https://ntfy.example.test/kraken-hub-v1-TESTTOPIC0000000');
    expect(posts[0]?.body.startsWith('S|')).toBe(true);
    await t.disconnect();
  });

  it('surfaces a rate limit rather than pretending it published', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: string, init?: { method?: string }) =>
        init?.method === 'POST'
          ? Promise.resolve({ ok: false, status: 429, text: () => Promise.resolve('') })
          : Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') }),
      ),
    );
    const t = createNtfyTransport();
    await t.connect(OPTS);
    await expect(t.publishCmd(new Uint8Array([1]))).rejects.toThrow(/429/);
    await t.disconnect();
  });
});
