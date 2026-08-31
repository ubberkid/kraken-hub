/**
 * Ref-counted blob URLs (design-videoEngine.md §5.4).
 *
 * A leaked object URL pins its whole Blob in memory for the lifetime of the
 * document — and the Kraken Browser's document lives for *weeks*. So every
 * `createObjectURL` in the video module goes through here, is counted, and is
 * revoked the moment the last holder lets go.
 *
 * Two rules the callers must keep:
 *  - `acquire()` in `mount()`, `release()` in `teardown()`, and release only
 *    AFTER `video.removeAttribute('src'); video.load();` (§5.4).
 *  - Never call `acquire()` from a render function or a rAF loop.
 */

import { createLogger } from '../../../lib/log';

const log = createLogger('video/bloburl');

interface Entry {
  url: string;
  refs: number;
}

const entries = new Map<string, Entry>();

/** Creates the object URL on the first ref and reuses it for every later one. */
export function acquire(key: string, blob: Blob): string {
  const existing = entries.get(key);
  if (existing !== undefined) {
    existing.refs += 1;
    return existing.url;
  }
  const url = URL.createObjectURL(blob);
  entries.set(key, { url, refs: 1 });
  return url;
}

/** Drops one ref; revokes at zero. Unknown keys are ignored, never thrown on. */
export function release(key: string): void {
  const entry = entries.get(key);
  if (entry === undefined) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  entries.delete(key);
  URL.revokeObjectURL(entry.url);
}

/** Diagnostics: what is currently pinned, and by how many holders. */
export function inspect(): { key: string; refs: number }[] {
  return [...entries].map(([key, e]) => ({ key, refs: e.refs }));
}

/** `pagehide` and teardown-of-last-resort: revoke everything. */
export function releaseAll(): void {
  for (const [key, entry] of entries) {
    URL.revokeObjectURL(entry.url);
    log.debug(`revoked ${key} with ${String(entry.refs)} refs outstanding`);
  }
  entries.clear();
}

let installed = false;

/** Idempotent: one `pagehide` hook for the whole module, however many mounts. */
export function installPageHideRelease(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('pagehide', releaseAll);
}
