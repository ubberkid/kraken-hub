/**
 * The broker endpoint table — the ONE file allowed to name a sync host.
 *
 * Invariant 4 (no hardcoded origins) is waived here in eslint.config.js for the
 * same reason it is waived in `src/config/knownHosts.ts`: a fork must be able to
 * see, in one place, every third-party service this app can talk to. Both
 * defaults are user-overridable from the Remote view, and self-hosting either
 * one is a supported configuration (docs/remote-control.md).
 *
 * Both were probed live on 2026-08-30 (docs/design/research/research-providersAndSync.md):
 *  - `broker.emqx.io:8084/mqtt` answers a WSS upgrade with `sec-websocket-protocol: mqtt`
 *    and honours RETAINED messages, which is the whole reason MQTT is primary.
 *  - `ntfy.sh` sends `access-control-allow-origin: *` on POST/OPTIONS/SSE and
 *    caches messages for 12 h, which gives replay-based last-value semantics
 *    from a completely different failure domain (HTTP/SSE rather than WSS).
 */

import type { Channel } from './types';

/** Public MQTT-over-WSS broker. No account, no auth, no uptime promise. */
export const DEFAULT_MQTT_URL = 'wss://broker.emqx.io:8084/mqtt';

/** Public ntfy instance. Same caveats. */
export const DEFAULT_NTFY_BASE = 'https://ntfy.sh';

/** Canonical topic root (plan, "Canonical conventions"). Never versionless. */
export const MQTT_TOPIC_ROOT = 'kraken-hub/v1/';

/** ntfy has no topic hierarchy, so the separators become dashes. */
export const NTFY_TOPIC_PREFIX = 'kraken-hub-v1-';

export function mqttTopic(topicId: string, ch: Channel): string {
  return `${MQTT_TOPIC_ROOT}${topicId}/${ch}`;
}

export function ntfyTopic(topicId: string): string {
  return `${NTFY_TOPIC_PREFIX}${topicId}`;
}

/**
 * Accepts a user-supplied endpoint override, or falls back.
 *
 * Deliberately permissive about the host (self-hosting is the point) and strict
 * about the scheme: an `http://` broker on a `https://` page is blocked as mixed
 * content anyway, and silently producing a connection that can never succeed is
 * worse than ignoring the override.
 */
export function normalizeEndpoint(
  raw: string,
  fallback: string,
  allowed: readonly string[],
): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fallback;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return fallback;
  }
  if (!allowed.includes(url.protocol)) return fallback;
  return trimmed.replace(/\/+$/, '');
}

export const MQTT_SCHEMES = ['wss:', 'ws:'] as const;
export const NTFY_SCHEMES = ['https:', 'http:'] as const;
