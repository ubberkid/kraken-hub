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
 * So this is a notice board, in the same shape as
 * `videoTelemetry.registerTeleSink` and for the same reason. A module SETS what
 * is showing; whoever is listening decides whether that is worth putting on a
 * wire. With no listener — no room configured, telemetry turned off, the
 * display running with no network at all — setting is a couple of pointer
 * writes and nothing else happens.
 *
 * `null` means "there is no picture", which is a real state a replica has to
 * render: a clock is not a missing image.
 *
 * **Keyed by layer id** since W2. It used to be one slot, which was exactly
 * right while a look could only contain one module and exactly wrong the moment
 * it could contain two pictures — the second mount would have overwritten the
 * first, and unmounting either would have blanked both. `§3.3` calls this out
 * as the module-scope singleton inventory; the two-instance conformance test
 * (`twoInstances.dom.test.ts`) is what keeps it honest.
 *
 * The single-slot API below it (`currentReplicaThumb`, `subscribeReplicaThumb`)
 * is still here and still means the BASE layer, because that is what today's
 * replica feed publishes and what an old phone can display. W6 moves the feed
 * onto the keyed API and it can go.
 */

import { createLogger } from '../lib/log';
import { BASE_LAYER_ID, type LayerId } from '../state/look/types';

const log = createLogger('modules/replica');

/** The keyed listener: told which layer changed, and to what. */
export type ReplicaThumbsListener = (layerId: LayerId, blob: Blob | null) => void;

/** The legacy single-slot listener. Fires for the base layer only. */
export type ReplicaThumbListener = (blob: Blob | null) => void;

const listeners = new Set<ReplicaThumbsListener>();
const baseListeners = new Set<ReplicaThumbListener>();
const current = new Map<LayerId, Blob | null>();

/**
 * Called by a display renderer whenever the picture on ITS layer changes.
 *
 * `layerId` is `ctx.layer?.id ?? BASE_LAYER_ID` — a renderer mounted by the
 * legacy single-module path has no `ctx.layer` and is, by definition, the base.
 *
 * Deliberately synchronous and deliberately cheap: it runs on the source-change
 * path, which already has a decoder to start. All the expensive work — hashing,
 * re-encoding, chunking — happens in the listener, off this call.
 */
export function setReplicaThumb(layerId: LayerId, blob: Blob | null): void {
  current.set(layerId, blob);
  for (const listener of listeners) {
    try {
      listener(layerId, blob);
    } catch (err) {
      // A replica that cannot show a thumbnail is a cosmetic problem on a
      // second screen. Playback on the panel is not allowed to care.
      log.warn('replica thumbnail listener threw', err);
    }
  }
  if (layerId !== BASE_LAYER_ID) return;
  for (const listener of baseListeners) {
    try {
      listener(blob);
    } catch (err) {
      log.warn('replica thumbnail listener threw', err);
    }
  }
}

/** A layer that is gone entirely, as opposed to a layer showing nothing. */
export function clearReplicaThumb(layerId: LayerId): void {
  if (!current.has(layerId)) return;
  current.delete(layerId);
  for (const listener of listeners) {
    try {
      listener(layerId, null);
    } catch (err) {
      log.warn('replica thumbnail listener threw', err);
    }
  }
}

/** Every picture on the panel right now, by layer, for a late listener. */
export function currentReplicaThumbs(): ReadonlyMap<LayerId, Blob | null> {
  return current;
}

/** The base layer's picture — what today's single-still replica feed publishes. */
export function currentReplicaThumb(): Blob | null {
  return current.get(BASE_LAYER_ID) ?? null;
}

export function subscribeReplicaThumbs(listener: ReplicaThumbsListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Legacy: the base layer only. */
export function subscribeReplicaThumb(listener: ReplicaThumbListener): () => void {
  baseListeners.add(listener);
  return () => {
    baseListeners.delete(listener);
  };
}

/** Test hook — module-level state would otherwise leak between cases. */
export function resetReplicaThumb(): void {
  listeners.clear();
  baseListeners.clear();
  current.clear();
}
