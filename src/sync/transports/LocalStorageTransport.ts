/**
 * The zero-network transport: CAM's Configuration Browser ↔ the hidden Kraken
 * Browser, over the localStorage they already share.
 *
 * This one is ALWAYS running, whether or not a room is configured, and it has a
 * completely independent failure domain from anything on the network. It is
 * also the only sync path that is guaranteed to work on a machine with no
 * internet at all, which is why the display never *depends* on the network
 * slot for anything.
 *
 * ## Why `state` is not carried here
 *
 * The canonical `kraken-hub:v1:state` key already IS the retained state store,
 * and `src/state/storage.ts` already watches it with a `storage` event plus an
 * unconditional 1 s poll. Publishing the same document a second time under a
 * different key would create two sources of truth that can disagree, and the
 * `rev` counter would have to be reconciled across both. So `caps.channels` is
 * `['cmd', 'tele']` and `SyncService` skips the channels a transport declines.
 *
 * ## Why every slot carries a nonce
 *
 * The `storage` event does not fire when the written value is byte-identical to
 * the previous one. Two consecutive `ping` commands are byte-identical. The
 * nonce guarantees the value always differs, so the event always fires.
 */

import { createLogger } from '../../lib/log';
import { onStorageEvent, readRaw, writeRaw } from '../../platform/storage';
import { fromBase64Url, toBase64Url } from '../crypto';

import { createChannelBus } from './transportBase';

import type { Channel, SyncTransport, TransportCaps } from '../types';

const log = createLogger('sync/localstorage');

/** `kraken-hub:v1:bus:cmd`, `kraken-hub:v1:bus:tele`. */
export const BUS_PREFIX = 'bus:';

/** Matches `src/state/storage.ts`: the event is the fast path, the poll is the guarantee. */
export const BUS_POLL_MS = 1000;

const CARRIED: readonly Channel[] = ['cmd', 'tele'];

const CAPS: TransportCaps = {
  retained: false,
  replayMs: 0,
  needsNetwork: false,
  maxPayload: 64_000,
  channels: CARRIED,
  encrypted: false,
};

interface Slot {
  n: string;
  f: string;
  ts: number;
}

function readSlot(ch: Channel): Slot | null {
  const raw = readRaw(BUS_PREFIX + ch);
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

export function createLocalStorageTransport(): SyncTransport {
  const bus = createChannelBus('localstorage');
  const lastNonce: Partial<Record<Channel, string>> = {};
  let stopStorage: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let nonceCounter = 0;

  const drain = (ch: Channel): void => {
    const slot = readSlot(ch);
    if (slot === null || slot.n === lastNonce[ch]) return;
    lastNonce[ch] = slot.n;
    const frame = fromBase64Url(slot.f);
    if (frame === null) {
      log.warn(`${ch} slot was not base64url — ignored`);
      return;
    }
    bus.deliver(ch, frame, { retained: false, ts: slot.ts });
  };

  const drainAll = (): void => {
    for (const ch of CARRIED) drain(ch);
  };

  const publish = (ch: Channel, frame: Uint8Array): Promise<void> => {
    nonceCounter += 1;
    const slot: Slot = {
      n: `${String(Date.now())}.${String(nonceCounter)}`,
      f: toBase64Url(frame),
      ts: Date.now(),
    };
    // Our own write must not come back at us through the poll.
    lastNonce[ch] = slot.n;
    writeRaw(BUS_PREFIX + ch, JSON.stringify(slot));
    return Promise.resolve();
  };

  return {
    id: 'localstorage',
    caps: CAPS,

    connect() {
      // Seed the "already seen" marks so a stale slot from a previous page load
      // is not replayed as if it had just arrived. Commands are imperative.
      for (const ch of CARRIED) {
        const slot = readSlot(ch);
        if (slot !== null) lastNonce[ch] = slot.n;
      }
      stopStorage = onStorageEvent((e) => {
        if (e.suffix === null) {
          drainAll();
          return;
        }
        if (!e.suffix.startsWith(BUS_PREFIX)) return;
        const ch = e.suffix.slice(BUS_PREFIX.length) as Channel;
        if (CARRIED.includes(ch)) drain(ch);
      });
      timer = setInterval(drainAll, BUS_POLL_MS);
      bus.setStatus('online');
      return Promise.resolve();
    },

    disconnect() {
      stopStorage?.();
      stopStorage = null;
      if (timer !== null) clearInterval(timer);
      timer = null;
      bus.setStatus('idle');
      bus.clear();
      return Promise.resolve();
    },

    publishState() {
      // Declined by `caps.channels`; a caller that ignores that gets a no-op
      // rather than a second, divergent copy of the state document.
      return Promise.resolve();
    },
    publishCmd: (frame) => publish('cmd', frame),
    publishTele: (frame) => publish('tele', frame),

    onState: (cb) => bus.subscribe('state', cb),
    onCmd: (cb) => bus.subscribe('cmd', cb),
    onTele: (cb) => bus.subscribe('tele', cb),
    status: () => bus.status(),
    onStatus: (cb) => bus.onStatus(cb),
  };
}
