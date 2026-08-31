/**
 * The bookkeeping every transport repeats: three channel subscriber sets, a
 * status value with listeners, and safe dispatch.
 *
 * Kept as a plain helper object rather than a base class so a transport stays a
 * closure and there is no `this` to lose across a callback boundary.
 */

import { createLogger } from '../../lib/log';

import type { Channel, FrameHandler, FrameMeta, TransportStatus, Unsub } from '../types';

const log = createLogger('sync/transport');

export interface ChannelBus {
  subscribe(ch: Channel, cb: FrameHandler): Unsub;
  deliver(ch: Channel, frame: Uint8Array, meta: FrameMeta): void;
  status(): TransportStatus;
  setStatus(s: TransportStatus, detail?: string): void;
  onStatus(cb: (s: TransportStatus, detail?: string) => void): Unsub;
  clear(): void;
}

export function createChannelBus(id: string): ChannelBus {
  const subs: Record<Channel, Set<FrameHandler>> = {
    state: new Set(),
    cmd: new Set(),
    tele: new Set(),
  };
  const statusSubs = new Set<(s: TransportStatus, detail?: string) => void>();
  let current: TransportStatus = 'idle';

  return {
    subscribe(ch, cb) {
      subs[ch].add(cb);
      return () => {
        subs[ch].delete(cb);
      };
    },
    deliver(ch, frame, meta) {
      for (const cb of [...subs[ch]]) {
        try {
          cb(frame, meta);
        } catch (err) {
          log.warn(`${id}: ${ch} subscriber threw`, err);
        }
      }
    },
    status() {
      return current;
    },
    setStatus(s, detail) {
      if (s === current && detail === undefined) return;
      current = s;
      for (const cb of [...statusSubs]) {
        try {
          cb(s, detail);
        } catch (err) {
          log.warn(`${id}: status subscriber threw`, err);
        }
      }
    },
    onStatus(cb) {
      statusSubs.add(cb);
      return () => {
        statusSubs.delete(cb);
      };
    },
    clear() {
      subs.state.clear();
      subs.cmd.clear();
      subs.tele.clear();
      statusSubs.clear();
    },
  };
}
