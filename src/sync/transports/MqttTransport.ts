/**
 * MQTT over WSS — the primary network transport.
 *
 * mqtt.js is `await import()`ed inside `connect()`, never at module scope. That
 * is a hard requirement, not a nicety: the library is ~110 kB gzip and the
 * hidden Kraken Browser must not download a byte of it unless the user has
 * actually configured a room AND chosen an MQTT-capable transport.
 *
 * Four details here are all consequences of things that were measured live
 * (docs/design/research/research-providersAndSync.md), not of style:
 *
 *  1. **`connect()` resolves only after CONNACK *and* SUBACK.** Publishing a
 *     retained message immediately after CONNECT and closing quickly silently
 *     LOSES the retained message. Resolving early would make that race the
 *     normal case for a page that sets a source and then navigates away.
 *  2. **Every publish awaits the broker callback**, not the enqueue. Same race,
 *     seen from the other end.
 *  3. **`end(false, cb)` and wait**, with a flush ceiling — `end(true)` discards
 *     the outbound queue, which is how the last state change before a reload
 *     goes missing.
 *  4. **The last will is on `tele` ONLY.** A will on `state` would publish a
 *     tombstone over the retained snapshot the moment a display dropped off —
 *     wiping the exact thing a reloading display depends on.
 *
 * `reconnectPeriod: 0` hands the retry schedule to `src/sync/backoff.ts` and
 * `SyncService`, because a silent library-level reconnect would hide the signal
 * that promotes ntfy into the network slot.
 */

import { createLogger } from '../../lib/log';
import { mqttTopic } from '../endpoints';

import { createChannelBus } from './transportBase';

import type { Channel, SyncTransport, TransportCaps, TransportOpts } from '../types';

const log = createLogger('sync/mqtt');

export const MQTT_CONNECT_TIMEOUT_MS = 8000;
export const MQTT_KEEPALIVE_SEC = 30;
/** `close()` waits at most this long for the outbound queue to flush. */
export const MQTT_FLUSH_CEILING_MS = 1500;
export const MQTT_RETAINED_KEEPALIVE_MS = 300_000;

const CAPS: TransportCaps = {
  retained: true,
  replayMs: Number.POSITIVE_INFINITY,
  needsNetwork: true,
  // Brokers accept far more; the 8 KB envelope cap is the real limit.
  maxPayload: 256_000,
  channels: ['state', 'cmd', 'tele'],
  encrypted: true,
  keepaliveMs: MQTT_RETAINED_KEEPALIVE_MS,
};

/**
 * The slice of mqtt.js we use, declared locally.
 *
 * The package's own types reach for node's `Buffer`, and `tsconfig.json` (the
 * app project) deliberately does not include `@types/node`. Narrowing the
 * import to this shape keeps the app project free of node types and documents
 * exactly how much of a 110 kB library we actually depend on.
 */
interface MqttClientLike {
  on(event: string, cb: (...args: unknown[]) => void): void;
  subscribe(topics: string[], opts: { qos: 0 }, cb: (err: Error | null | undefined) => void): void;
  publish(
    topic: string,
    payload: Uint8Array,
    opts: { qos: 0; retain: boolean },
    cb: (err?: Error) => void,
  ): void;
  end(force: boolean, opts: Record<string, never>, cb: () => void): void;
}

interface MqttModuleLike {
  connect(url: string, opts: Record<string, unknown>): MqttClientLike;
}

export function createMqttTransport(): SyncTransport {
  const bus = createChannelBus('mqtt');
  let client: MqttClientLike | null = null;
  let topics: Record<Channel, string> | null = null;

  return {
    id: 'mqtt',
    caps: CAPS,

    async connect(o: TransportOpts) {
      bus.setStatus('connecting');
      topics = {
        state: mqttTopic(o.topicId, 'state'),
        cmd: mqttTopic(o.topicId, 'cmd'),
        tele: mqttTopic(o.topicId, 'tele'),
      };

      // Lazy, and only here. The display's critical path never sees this.
      const mod = (await import('mqtt')) as unknown as MqttModuleLike;

      const c = mod.connect(o.mqttUrl, {
        clientId: `kh_${o.clientId}`,
        clean: true,
        keepalive: MQTT_KEEPALIVE_SEC,
        protocolVersion: 4,
        connectTimeout: MQTT_CONNECT_TIMEOUT_MS,
        // We own the retry schedule; see the module comment.
        reconnectPeriod: 0,
        ...(o.willFrame === undefined
          ? {}
          : {
              // tele ONLY. Never state.
              will: { topic: topics.tele, payload: o.willFrame, qos: 0, retain: false },
            }),
      });
      client = c;

      c.on('message', (...args: unknown[]) => {
        const topic = args[0];
        const payload = args[1];
        const packet = args[2] as { retain?: boolean } | undefined;
        if (typeof topic !== 'string' || !(payload instanceof Uint8Array) || topics === null) {
          return;
        }
        const ch = (Object.keys(topics) as Channel[]).find((k) => topics?.[k] === topic);
        if (ch === undefined) return;
        bus.deliver(ch, new Uint8Array(payload), { retained: packet?.retain === true });
      });

      c.on('error', (...args: unknown[]) => {
        const err = args[0];
        bus.setStatus('error', err instanceof Error ? err.message : 'mqtt error');
      });
      c.on('close', () => {
        bus.setStatus('offline', 'connection closed');
      });

      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          reject(new Error('aborted before CONNACK'));
        };
        o.signal.addEventListener('abort', onAbort, { once: true });

        c.on('connect', () => {
          // CONNACK is not enough: subscribe, and only resolve on SUBACK.
          c.subscribe(
            [topics?.state ?? '', topics?.cmd ?? '', topics?.tele ?? ''],
            { qos: 0 },
            (err) => {
              o.signal.removeEventListener('abort', onAbort);
              if (err) {
                reject(err instanceof Error ? err : new Error(String(err)));
                return;
              }
              bus.setStatus('online');
              resolve();
            },
          );
        });
        c.on('error', (...args: unknown[]) => {
          const err = args[0];
          o.signal.removeEventListener('abort', onAbort);
          reject(err instanceof Error ? err : new Error('mqtt connection failed'));
        });
      });
    },

    async disconnect() {
      const c = client;
      client = null;
      if (c === null) {
        bus.clear();
        return;
      }
      await new Promise<void>((resolve) => {
        const done = (): void => {
          resolve();
        };
        const ceiling = setTimeout(done, MQTT_FLUSH_CEILING_MS);
        // `false` = do NOT discard the outbound queue. See the module comment.
        c.end(false, {}, () => {
          clearTimeout(ceiling);
          done();
        });
      });
      bus.setStatus('idle');
      bus.clear();
    },

    publishState(frame) {
      return publish(client, topics?.state, frame, true);
    },
    publishCmd(frame) {
      return publish(client, topics?.cmd, frame, false);
    },
    publishTele(frame) {
      return publish(client, topics?.tele, frame, false);
    },

    onState: (cb) => bus.subscribe('state', cb),
    onCmd: (cb) => bus.subscribe('cmd', cb),
    onTele: (cb) => bus.subscribe('tele', cb),
    status: () => bus.status(),
    onStatus: (cb) => bus.onStatus(cb),
  };
}

/** Resolves on the BROKER's acknowledgement, never on enqueue. */
function publish(
  client: MqttClientLike | null,
  topic: string | undefined,
  frame: Uint8Array,
  retain: boolean,
): Promise<void> {
  if (client === null || topic === undefined) {
    return Promise.reject(new Error('mqtt transport is not connected'));
  }
  return new Promise<void>((resolve, reject) => {
    client.publish(topic, frame, { qos: 0, retain }, (err) => {
      if (err) {
        log.warn('publish failed', err);
        reject(err);
        return;
      }
      resolve();
    });
  });
}
