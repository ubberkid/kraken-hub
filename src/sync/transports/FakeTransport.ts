/**
 * An in-process broker simulator. Test-only, but shipped in `src/` on purpose.
 *
 * It exists because the two properties that matter most about the sync layer —
 * "a retained snapshot alone restores a cold display" and "the network slot
 * fails over" — are exactly the two that CANNOT be tested against a public
 * broker in CI without making every PR depend on somebody else's uptime.
 *
 * It is backed by `src/platform/storage.ts` rather than a module-scope Map, and
 * that choice is what makes it useful in both harnesses:
 *
 *  - **Vitest (node)**: there is no `localStorage`, so the platform wrapper
 *    degrades to its in-memory Map. Two `SyncService` instances in one process
 *    therefore share one "broker", which is precisely the two-peer fixture the
 *    failover/dedup/keepalive tests need.
 *  - **Playwright**: two pages in one browser context share a real
 *    `localStorage`, so a `?transport=fake` remote page really does drive a
 *    `?transport=fake` display page — including across a display reload, which
 *    is how the retained-snapshot cold restore is proved.
 *
 * It simulates the three broker behaviours the real transports rely on:
 * retained last-value on `state`, transient fan-out on `cmd`/`tele`, and going
 * away (`markDown`) so failover has something to fail over from.
 */

import { onStorageEvent, readRaw, removeRaw, writeRaw } from '../../platform/storage';
import { fromBase64Url, toBase64Url } from '../crypto';

import { createChannelBus } from './transportBase';

import type { Channel, SyncTransport, TransportCaps, TransportOpts } from '../types';

/** `kraken-hub:v1:fake:…` — a namespace of its own, never the canonical keys. */
export const FAKE_PREFIX = 'fake:';

export type FakeSlot = 'primary' | 'fallback';

/** Fast enough that the e2e "under one second" assertion is not about polling. */
export const FAKE_POLL_MS = 150;

const CAPS: TransportCaps = {
  retained: true,
  replayMs: Number.POSITIVE_INFINITY,
  needsNetwork: true,
  maxPayload: 64_000,
  channels: ['state', 'cmd', 'tele'],
  encrypted: true,
};

function downKey(slot: FakeSlot): string {
  return `${FAKE_PREFIX}down:${slot}`;
}

/** Take a simulated broker offline. Connects and publishes then fail. */
export function markFakeDown(slot: FakeSlot, down: boolean): void {
  if (down) writeRaw(downKey(slot), '1');
  else removeRaw(downKey(slot));
}

export function isFakeDown(slot: FakeSlot): boolean {
  return readRaw(downKey(slot)) === '1';
}

interface Slot {
  n: string;
  f: string;
  ts: number;
}

function parseSlot(raw: string | null): Slot | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const o = parsed as Record<string, unknown>;
    if (typeof o['n'] !== 'string' || typeof o['f'] !== 'string') return null;
    return { n: o['n'], f: o['f'], ts: typeof o['ts'] === 'number' ? o['ts'] : 0 };
  } catch {
    return null;
  }
}

export function createFakeTransport(slot: FakeSlot = 'primary'): SyncTransport {
  const bus = createChannelBus(`fake:${slot}`);
  let topicId = '';
  let counter = 0;
  const lastNonce: Partial<Record<Channel, string>> = {};
  let stopStorage: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let connected = false;

  const key = (ch: Channel): string => `${FAKE_PREFIX}${slot}:${topicId}:${ch}`;

  const drain = (ch: Channel, retained: boolean): void => {
    const parsed = parseSlot(readRaw(key(ch)));
    if (parsed === null || parsed.n === lastNonce[ch]) return;
    lastNonce[ch] = parsed.n;
    const frame = fromBase64Url(parsed.f);
    if (frame === null) return;
    bus.deliver(ch, frame, { retained, ts: parsed.ts });
  };

  const drainAll = (): void => {
    if (!connected) return;
    if (isFakeDown(slot)) {
      bus.setStatus('offline', 'simulated broker is down');
      return;
    }
    for (const ch of CAPS.channels) drain(ch, false);
  };

  const publish = (ch: Channel, frame: Uint8Array): Promise<void> => {
    if (!connected) return Promise.reject(new Error('fake transport is not connected'));
    if (isFakeDown(slot)) {
      return Promise.reject(new Error(`fake broker '${slot}' is down`));
    }
    counter += 1;
    const value: Slot = {
      n: `${String(Date.now())}.${String(counter)}`,
      f: toBase64Url(frame),
      ts: Date.now(),
    };
    writeRaw(key(ch), JSON.stringify(value));
    // A real broker echoes a publish back to every subscriber on the topic,
    // including the publisher's own connection. Not marking the nonce as seen
    // reproduces that, which is what keeps the service's echo-suppression path
    // exercised rather than accidentally dead.
    return Promise.resolve();
  };

  return {
    id: 'fake',
    caps: CAPS,

    connect(o: TransportOpts) {
      if (isFakeDown(slot)) {
        bus.setStatus('error', `fake broker '${slot}' is down`);
        return Promise.reject(new Error(`fake broker '${slot}' is down`));
      }
      topicId = o.topicId;
      connected = true;

      // Retained delivery, exactly like a broker: whatever `state` was last
      // published to this topic arrives immediately, flagged as retained.
      const retained = parseSlot(readRaw(key('state')));
      if (retained !== null) {
        lastNonce.state = retained.n;
        const frame = fromBase64Url(retained.f);
        if (frame !== null) bus.deliver('state', frame, { retained: true, ts: retained.ts });
      }
      for (const ch of ['cmd', 'tele'] as const) {
        const existing = parseSlot(readRaw(key(ch)));
        // Transient channels are NOT replayed on connect.
        if (existing !== null) lastNonce[ch] = existing.n;
      }

      stopStorage = onStorageEvent(() => {
        drainAll();
      });
      timer = setInterval(drainAll, FAKE_POLL_MS);
      bus.setStatus('online');
      return Promise.resolve();
    },

    disconnect() {
      connected = false;
      stopStorage?.();
      stopStorage = null;
      if (timer !== null) clearInterval(timer);
      timer = null;
      bus.setStatus('idle');
      bus.clear();
      return Promise.resolve();
    },

    publishState: (frame) => publish('state', frame),
    publishCmd: (frame) => publish('cmd', frame),
    publishTele: (frame) => publish('tele', frame),

    onState: (cb) => bus.subscribe('state', cb),
    onCmd: (cb) => bus.subscribe('cmd', cb),
    onTele: (cb) => bus.subscribe('tele', cb),
    status: () => bus.status(),
    onStatus: (cb) => bus.onStatus(cb),
  };
}
