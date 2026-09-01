/**
 * The one seam between "a module knows what picture is on the panel" and "the
 * remote's ring would like to show it".
 *
 * A display renderer is the only code that knows which blob is currently
 * painted — the image module has just pulled it out of IndexedDB, the video
 * module has just resolved a clip and has its stored thumbnail in hand. The
 * replica feed (`src/app/display/replicaFeed.ts`) is the only code that knows
 * how to get 6 KB of WebP onto a phone. Neither should import the other:
 * `src/app/display` must not reach into a module's internals, and a module must
 * not know that a sync layer exists at all.
 *
 * So this is a one-slot notice board, in the same shape as
 * `videoTelemetry.registerTeleSink` and for the same reason. A module SETS what
 * is showing; whoever is listening decides whether that is worth putting on a
 * wire. With no listener — no room configured, telemetry turned off, the
 * display running with no network at all — setting is a couple of pointer
 * writes and nothing else happens.
 *
 * `null` means "there is no picture", which is a real state a replica has to
 * render: a clock is not a missing image.
 */

import { createLogger } from '../lib/log';

const log = createLogger('modules/replica');

export type ReplicaThumbListener = (blob: Blob | null) => void;

const listeners = new Set<ReplicaThumbListener>();
let current: Blob | null = null;

/**
 * Called by a display renderer whenever the picture on the panel changes.
 *
 * Deliberately synchronous and deliberately cheap: it runs on the source-change
 * path, which already has a decoder to start. All the expensive work — hashing,
 * re-encoding, chunking — happens in the listener, off this call.
 */
export function setReplicaThumb(blob: Blob | null): void {
  current = blob;
  for (const listener of listeners) {
    try {
      listener(blob);
    } catch (err) {
      // A replica that cannot show a thumbnail is a cosmetic problem on a
      // second screen. Playback on the panel is not allowed to care.
      log.warn('replica thumbnail listener threw', err);
    }
  }
}

/** The picture as it stands, for a listener that attached after the fact. */
export function currentReplicaThumb(): Blob | null {
  return current;
}

export function subscribeReplicaThumb(listener: ReplicaThumbListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test hook — module-level state would otherwise leak between cases. */
export function resetReplicaThumb(): void {
  listeners.clear();
  current = null;
}
