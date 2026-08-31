/**
 * "The downloader just answered" — a one-key, zero-network nudge from the
 * CONFIG window to the DISPLAY window.
 *
 * The problem it solves: the guided connect panel is on the configuration
 * browser, and the companion it is waiting for is used by the *display*
 * browser. CAM runs the two as separate windows on one storage partition, so
 * the moment the panel sees `/health` answer, the only thing standing between
 * the user and their video is that the display resolved this source minutes ago
 * — with health memoized for 60 s and the geometry engine already mounted.
 *
 * Rather than invent a second channel, this reuses the mechanism the download
 * mirror and the telemetry mirror already use: one namespaced key, a `storage`
 * event for the fast path, and a slow poll because the event's reliability
 * inside CAM's Electron webview is measured on exactly one build (hardware
 * checklist H16).
 *
 * The value is a timestamp, and the display acts only on one it has not seen
 * yet — a ping is an *edge*, never a state, so a stale key can never put the
 * display into a restart loop.
 */

import { readRaw, writeRaw } from '../../../platform/storage';

export const RESOLVER_PING_SUFFIX = 'video:resolver:ping';

/** Belt-and-braces for the `storage` event (H16), as §7.5 mandates elsewhere. */
export const RESOLVER_PING_POLL_MS = 2000;

/** Announces, to any window sharing this origin, that the companion is up. */
export function pingResolverConnected(now: number = Date.now()): void {
  writeRaw(RESOLVER_PING_SUFFIX, String(now));
}

/** The last announcement's timestamp, or `0` when nobody has announced one. */
export function readResolverPing(): number {
  const raw = readRaw(RESOLVER_PING_SUFFIX);
  if (raw === null) return 0;
  const ts = Number.parseInt(raw, 10);
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * Calls back once per NEW announcement. The first value seen at subscribe time
 * is the baseline and is never delivered: a ping written before this window
 * mounted has already been acted on by whoever was listening then.
 */
export function subscribeResolverPing(cb: (ts: number) => void): () => void {
  let seen = readResolverPing();
  const check = (): void => {
    const ts = readResolverPing();
    if (ts <= seen) return;
    seen = ts;
    cb(ts);
  };
  window.addEventListener('storage', check);
  const timer = setInterval(check, RESOLVER_PING_POLL_MS);
  return () => {
    window.removeEventListener('storage', check);
    clearInterval(timer);
  };
}
