/**
 * ntfy — the fallback network transport.
 *
 * It was chosen over a second MQTT broker precisely because it fails
 * DIFFERENTLY: plain HTTP POST plus Server-Sent Events, rather than a WebSocket
 * upgrade on a non-standard port. A corporate firewall or a captive portal that
 * kills `wss://…:8084` usually leaves `https://` alone, so the fallback is a
 * genuinely independent path rather than a second roll of the same dice.
 *
 * Three design consequences of what ntfy actually is:
 *
 *  - **No retention, but a 12 h replay cache** (verified: `expires-time` =
 *    43200 s). So `caps.retained` is false and recovery is a poll of
 *    `/json?poll=1&since=10m` that takes the LAST `state` message and delivers
 *    it flagged `retained: true`. `since=10m` rather than `all`: replay is
 *    capped at 10 MB per topic and a truncated replay would silently drop the
 *    newest messages.
 *  - **No topic hierarchy**, so all three channels share one topic and a
 *    one-character tag (`S`/`C`/`T`) in front of the base64url frame says which
 *    channel a message belongs to. The tag is the only thing an observer learns
 *    that MQTT's separate topics would not also have told them.
 *  - **`Content-Type: text/plain` and no custom headers**, which keeps the POST
 *    a CORS *simple request* — no preflight, no second round trip, and no
 *    dependency on the server's OPTIONS handling.
 */

import { createLogger } from '../../lib/log';
import { fromBase64Url, toBase64Url } from '../crypto';
import { ntfyTopic } from '../endpoints';

import { createChannelBus } from './transportBase';

import type { Channel, SyncTransport, TransportCaps, TransportOpts } from '../types';

const log = createLogger('sync/ntfy');

/** Recovery window. Must stay comfortably inside the state keepalive below. */
export const NTFY_RECOVERY = 'since=10m';
/** The state owner re-publishes this often, so recovery always finds something. */
export const NTFY_KEEPALIVE_MS = 240_000;
/** No SSE traffic for this long and the EventSource is torn down and rebuilt. */
export const NTFY_LIVENESS_MS = 90_000;

const CAPS: TransportCaps = {
  retained: false,
  replayMs: 600_000,
  // The recovery poll takes the last `state` message only, and `/sse` carries no
  // `since=` — a fresh subscriber is delivered no command it did not wait for.
  cmdReplayMs: 0,
  needsNetwork: true,
  maxPayload: 64_000,
  channels: ['state', 'cmd', 'tele'],
  encrypted: true,
  keepaliveMs: NTFY_KEEPALIVE_MS,
};

const TAGS: Record<Channel, string> = { state: 'S', cmd: 'C', tele: 'T' };
const BY_TAG: Record<string, Channel> = { S: 'state', C: 'cmd', T: 'tele' };

function decodeLine(text: string): { ch: Channel; frame: Uint8Array } | null {
  const sep = text.indexOf('|');
  if (sep !== 1) return null;
  const ch = BY_TAG[text.slice(0, 1)];
  if (ch === undefined) return null;
  const frame = fromBase64Url(text.slice(sep + 1));
  return frame === null ? null : { ch, frame };
}

export function createNtfyTransport(): SyncTransport {
  const bus = createChannelBus('ntfy');
  let base = '';
  let topic = '';
  let source: EventSource | null = null;
  let liveness: ReturnType<typeof setInterval> | null = null;
  let lastTrafficAt = 0;
  let signal: AbortSignal | null = null;

  const url = (): string => `${base}/${topic}`;

  const handleMessage = (raw: string, retained: boolean, ts?: number): void => {
    const decoded = decodeLine(raw);
    if (decoded === null) return;
    lastTrafficAt = Date.now();
    bus.deliver(decoded.ch, decoded.frame, {
      retained,
      ...(ts === undefined ? {} : { ts }),
    });
  };

  const openStream = (): void => {
    source?.close();
    const es = new EventSource(`${url()}/sse`);
    source = es;
    lastTrafficAt = Date.now();
    es.onopen = () => {
      lastTrafficAt = Date.now();
      bus.setStatus('online');
    };
    es.onerror = () => {
      bus.setStatus('degraded', 'SSE stream error');
    };
    es.onmessage = (ev: MessageEvent<string>) => {
      lastTrafficAt = Date.now();
      try {
        const parsed = JSON.parse(ev.data) as { event?: string; message?: string; time?: number };
        if (parsed.event !== 'message' || typeof parsed.message !== 'string') return;
        handleMessage(
          parsed.message,
          false,
          typeof parsed.time === 'number' ? parsed.time * 1000 : undefined,
        );
      } catch {
        /* keepalives and open events are not JSON messages; ignore */
      }
    };
  };

  /**
   * Take the LAST `state` message from the replay window and deliver it as if
   * it were retained. Commands are deliberately NOT replayed: they are
   * imperative, and a 12 h cache full of `seekBy(+10)` is a hazard, not a
   * feature. (`SyncService` drops stale commands too — defence in depth.)
   */
  const recover = async (): Promise<void> => {
    let text: string;
    try {
      const res = await fetch(`${url()}/json?poll=1&${NTFY_RECOVERY}`, {
        ...(signal === null ? {} : { signal }),
      });
      if (!res.ok) return;
      text = await res.text();
    } catch (err) {
      log.warn('replay poll failed', err);
      return;
    }

    let lastState: { message: string; time?: number } | null = null;
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line) as { event?: string; message?: string; time?: number };
        if (parsed.event !== 'message' || typeof parsed.message !== 'string') continue;
        if (!parsed.message.startsWith(`${TAGS.state}|`)) continue;
        lastState = {
          message: parsed.message,
          ...(parsed.time === undefined ? {} : { time: parsed.time }),
        };
      } catch {
        /* a truncated final line is expected on a capped replay */
      }
    }
    if (lastState !== null) {
      handleMessage(
        lastState.message,
        true,
        lastState.time === undefined ? undefined : lastState.time * 1000,
      );
    }
  };

  const publish = async (ch: Channel, frame: Uint8Array): Promise<void> => {
    const res = await fetch(url(), {
      method: 'POST',
      // Simple request: no preflight. Do not add headers here.
      headers: { 'Content-Type': 'text/plain' },
      body: `${TAGS[ch]}|${toBase64Url(frame)}`,
      ...(signal === null ? {} : { signal }),
    });
    if (!res.ok) {
      throw new Error(`ntfy publish failed: HTTP ${String(res.status)}`);
    }
  };

  return {
    id: 'ntfy',
    caps: CAPS,

    async connect(o: TransportOpts) {
      bus.setStatus('connecting');
      base = o.ntfyBase;
      topic = ntfyTopic(o.topicId);
      signal = o.signal;

      // Recovery FIRST: a cold display must see the last snapshot even if the
      // stream never delivers another message.
      await recover();
      openStream();

      liveness = setInterval(() => {
        if (Date.now() - lastTrafficAt < NTFY_LIVENESS_MS) return;
        log.warn('no SSE traffic — rebuilding the stream');
        openStream();
      }, NTFY_LIVENESS_MS);
      bus.setStatus('online');
    },

    disconnect() {
      source?.close();
      source = null;
      if (liveness !== null) clearInterval(liveness);
      liveness = null;
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
