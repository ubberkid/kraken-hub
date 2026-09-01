/**
 * What the phone's mini-halo needs, and nothing else.
 *
 * The remote's ring renders the **real** module output — the actual clock
 * renderer, the actual stats renderer, the actual picture — driven by synced
 * state rather than by streamed pixels. That is the whole design decision: a
 * phone is a different browser on a different machine, so an iframe there would
 * boot a SECOND display, with a second decoder and a second download, on a
 * battery. Instead the display volunteers the few facts a replica cannot
 * compute for itself, and the phone renders them with the same code the LCD
 * runs.
 *
 * Exactly two things cannot be computed on the phone:
 *
 *  1. **Monitoring readings.** CPU and GPU temperature and load and the liquid
 *     temperature exist only on the machine running CAM. Five numbers, about
 *     sixty bytes, on the 0.5 Hz telemetry cadence (`src/sync/monitorSnapshot.ts`).
 *  2. **The picture.** An image or a stored clip lives in the CAM browser
 *     profile's IndexedDB, which the phone can never read. So the display ships
 *     a **≤6 KB WebP thumbnail** over the shared chunked-tele channel, keyed by
 *     content hash, and never sends the same image twice.
 *
 * Local time is not on that list, and that is the point: a clock replica is
 * correct by definition, because the phone has its own clock. Panel geometry is
 * not either — it rides the telemetry packet the display already sends.
 *
 * Everything here is behind the `publishTelemetry` toggle, like the clip index:
 * a user who has turned off "your Kraken reports back to this page" is turning
 * off exactly this.
 */

import { toTeleChunks, CHUNK_SPACING_MS } from '../../lib/chunkedTele';
import { createLogger } from '../../lib/log';
import { encodeMonitorSnapshot } from '../../sync/monitorSnapshot';

import type { DisplayRuntime } from './runtime';

const log = createLogger('display/replica');

/** The `TeleBody.kind` values this feed publishes. */
export const MONITOR_TELE_KIND = 'monitor';
export const THUMB_TELE_KIND = 'thumb';

/**
 * 2.5 s — the telemetry cadence, deliberately NOT the video module's 2 s.
 *
 * Two decisions are packed in here and the second one is load-bearing.
 *
 * The rate is ~0.4 Hz because the replica is a 132 px ring on a phone: a dial
 * that redraws twice a second is already smoother than anyone can read, and
 * halving the packet rate halves the radio cost of leaving the remote open,
 * which is the thing a phone actually notices.
 *
 * The period differs from `publishStats`' 2 s because **`SyncService.publishTele`
 * throttles to 200 ms and DROPS what lands inside the window**. Two publishers
 * on the *same* period have a constant phase difference, so if that difference
 * happens to be under 200 ms at start-up, one of them is silently dropped for
 * the entire life of the page — measured, not feared: with both at 2 s the
 * remote's scrubber never received a single `videoStats` packet and sat at
 * 0:00 / 60:00 forever. Different periods make the phase drift, so a collision
 * costs one packet instead of all of them.
 */
export const MONITOR_PERIOD_MS = 2500;

/**
 * The thumbnail budget.
 *
 * 6 KB is one envelope's usable payload plus change, so a typical thumbnail is
 * one or two chunks and lands inside half a second. It is also small enough
 * that re-sending one by accident is a nuisance rather than a bill — but the
 * hash cache below means it does not happen at all.
 */
export const THUMB_MAX_BYTES = 6144;
// device-size-ok: the replica thumbnail's edge in image px, not a panel dimension.
const THUMB_EDGE_PX = 192;
/**
 * Quality steps, named individually because invariant I5's `no-magic-numbers`
 * exempts `const` initialisers but not array elements. The ladder is short on
 * purpose: four `toDataURL` calls is the worst case, and the last rung is low
 * enough that anything still over budget is a picture that genuinely cannot be
 * described in 6 KB.
 */
const Q_HIGH = 0.7;
const Q_MID = 0.55;
const Q_LOW = 0.4;
const Q_FLOOR = 0.28;
const THUMB_QUALITY_STEPS = [Q_HIGH, Q_MID, Q_LOW, Q_FLOOR] as const;
const HASH_HEX_CHARS = 12;
const HEX = 16;
const HEX_PAD = 2;

export interface ReplicaFeed {
  /** Announce a new picture. A repeat of the current hash is a no-op. */
  publishThumb(blob: Blob | null): void;
  stop(): void;
}

export interface ReplicaFeedOptions {
  runtime: DisplayRuntime;
  /** The display's `service.publishTele`, already role- and room-gated. */
  publish: (body: { ts: number; kind: string }) => void;
}

/** First 12 hex of SHA-256 over the bytes — enough to key a cache, cheap to send. */
async function hashBlob(blob: Blob): Promise<string | null> {
  try {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(HEX).padStart(HEX_PAD, '0'))
      .join('')
      .slice(0, HASH_HEX_CHARS);
  } catch {
    return null;
  }
}

/**
 * Squeeze an image into `THUMB_MAX_BYTES` of WebP, or give up.
 *
 * Quality is stepped down rather than the edge shrunk, because the ring is
 * round and small: losing detail is invisible at 132 px, losing *size* is not.
 * Returning `null` when even the lowest step overflows is deliberate — a
 * replica showing the module's own placeholder is better than one showing a
 * thumbnail that ate the telemetry budget.
 */
export async function toReplicaThumb(blob: Blob): Promise<string | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return null;
  }
  try {
    const scale = Math.min(1, THUMB_EDGE_PX / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d');
    if (g === null) return null;
    g.drawImage(bitmap, 0, 0, w, h);

    for (const quality of THUMB_QUALITY_STEPS) {
      const url = canvas.toDataURL('image/webp', quality);
      // A browser with no WebP encoder silently hands back a PNG, which will
      // not fit — the length check below catches that without a special case.
      if (url.length <= THUMB_MAX_BYTES) return url;
    }
    return null;
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
}

export function startReplicaFeed(o: ReplicaFeedOptions): ReplicaFeed {
  const { runtime, publish } = o;
  let timer: ReturnType<typeof setInterval> | null = null;
  const chunkTimers = new Set<ReturnType<typeof setTimeout>>();
  /** The hash of the picture the remote already has. Never re-sent. */
  let sentThumbHash: string | null = null;
  let stopped = false;
  // Read through a function so TypeScript cannot narrow it to its initialiser
  // — the same trick `ModuleHost` and `display/sync.ts` use for their teardown
  // flags, and for the same reason: every check here is across an await.
  const isStopped = (): boolean => stopped;

  const tick = (): void => {
    const latest = runtime.monitoring.latest();
    const g = runtime.geometry.get();
    publish({
      ts: Date.now(),
      kind: MONITOR_TELE_KIND,
      // The active module, so the replica knows which renderer to load.
      module: runtime.store.getSnapshot().activeModuleId,
      // A fixed `DisplayInfo` for the replica: the phone must lay the module
      // out for the PANEL's geometry, not for a 132 px div, or a dial tuned to
      // a 240 px square would be drawn as if it were a 640 px circle.
      display: { w: g.width, h: g.height, shape: g.shape, targetFps: g.targetFps },
      ...(latest === null ? {} : { mon: encodeMonitorSnapshot(latest.norm) }),
      // Absent rather than `false` when the feed is fine: the replica shows the
      // module's own "waiting for CAM data" card, which already says it better.
      ...(runtime.monitoring.isStale() ? { stale: true } : {}),
    } as unknown as { ts: number; kind: string });
  };

  timer = setInterval(tick, MONITOR_PERIOD_MS);
  tick();

  return {
    publishThumb(blob) {
      if (isStopped()) return;
      if (blob === null) {
        sentThumbHash = null;
        return;
      }
      void (async () => {
        const hash = await hashBlob(blob);
        // An unhashable blob is sent once rather than never: the cache is an
        // optimisation, and losing it must not lose the picture.
        if (hash !== null && hash === sentThumbHash) return;
        const data = await toReplicaThumb(blob);
        if (isStopped() || data === null) return;
        sentThumbHash = hash;
        const chunks = toTeleChunks({
          kind: THUMB_TELE_KIND,
          ts: Date.now(),
          payload: data,
          ...(hash === null ? {} : { id: hash }),
        });
        chunks.forEach((chunk, index) => {
          // `publishTele` throttles and DROPS what lands inside the window, so
          // parts have to be spaced rather than looped out (see chunkedTele).
          if (index === 0) {
            publish(chunk);
            return;
          }
          const t = setTimeout(() => {
            chunkTimers.delete(t);
            publish(chunk);
          }, index * CHUNK_SPACING_MS);
          chunkTimers.add(t);
        });
      })().catch((err: unknown) => {
        log.warn('could not publish a replica thumbnail', err);
      });
    },

    stop() {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      for (const t of chunkTimers) clearTimeout(t);
      chunkTimers.clear();
      sentThumbHash = null;
    },
  };
}
