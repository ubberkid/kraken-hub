/**
 * Sending something bigger than one envelope over the telemetry channel.
 *
 * Invariant I6 caps a sync payload at 8 KB, which is generous for a position
 * sample and nowhere near enough for a hardware report or an image thumbnail.
 * The diagnostics pull solved that first — split the payload into numbered
 * parts, key them on one timestamp, reassemble on the far side — and this file
 * is that mechanism with the diagnostics-specific parts taken out, so the video
 * and image modules' thumbnails can travel the same way.
 *
 * Everything that was subtle in the original is preserved here verbatim,
 * because every one of these was a real bug waiting:
 *
 *  - **Parts of one capture share a `ts`.** That is what lets a receiver throw
 *    away a half-arrived older payload the moment a newer one starts, instead
 *    of splicing two captures into one corrupt document.
 *  - **The buffer is `.fill()`ed.** `new Array(n)` is SPARSE and
 *    `Array.prototype.some` skips holes, so the completeness check would pass
 *    on the very first part and reassemble a truncated payload.
 *  - **The chunk shape is uniform.** A payload that fits is still `part 1 of 1`,
 *    so a receiver has one code path and no "was it chunked?" branch to get
 *    wrong.
 *  - **Two bytes per character.** The payload is a string nested inside another
 *    JSON document, so every `"` becomes `\"` and a pathological chunk very
 *    nearly doubles on the way into the envelope. The budget is halved to cover
 *    that worst case rather than measured optimistically.
 *
 * This file is a LEAF on purpose. `MAX_ENVELOPE_BYTES` is copied rather than
 * imported from `src/sync/types.ts`, which is claimed by the `sync-core` chunk:
 * importing a runtime value from there would drag this — which the display
 * fetches lazily and the config page imports statically — into that chunk's
 * graph in both directions. `chunkedTele.test.ts` asserts the two constants are
 * equal, so the copy cannot drift.
 */

/** `MAX_ENVELOPE_BYTES` from `src/sync/types.ts`. Kept honest by a test. */
export const ENVELOPE_CAP_BYTES = 8192;

/**
 * Room reserved for the envelope's own keys and the chunk's own header.
 * ~120 bytes are actually used; the rest is slack for a long `src` id.
 */
export const CHUNK_ENVELOPE_HEADROOM = 1024;

/** Payload characters per part. Halved for JSON-in-JSON escaping — see above. */
export const CHUNK_CHARS = Math.floor((ENVELOPE_CAP_BYTES - CHUNK_ENVELOPE_HEADROOM) / 2);

/**
 * Spacing between parts.
 *
 * `SyncService.publishTele()` throttles and DROPS what arrives inside the
 * window rather than queueing it — publishing three parts in a loop would
 * silently send one. Anything above the throttle works; 250 ms keeps a
 * four-part payload under a second.
 */
export const CHUNK_SPACING_MS = 250;

/** One part of one payload, as it appears on the `tele` channel. */
export interface TeleChunk {
  /** The capture's timestamp. Identical across every part of one payload. */
  ts: number;
  kind: string;
  /** 1-based. */
  part: number;
  of: number;
  payload: string;
  /**
   * An optional identity for the payload, carried on every part.
   *
   * Diagnostics does not need one — there is only ever one report in flight and
   * `ts` distinguishes captures. A thumbnail does: the receiver caches by
   * content hash so an unchanged image is never re-sent, and it has to know
   * which image arrived before it can decide that.
   */
  id?: string;
}

/**
 * Split a payload into publishable parts. Always at least one.
 *
 * `chars` is a parameter rather than the constant so a caller with a tighter
 * budget (a packet that also carries other fields) can say so, and so the tests
 * can force multi-part behaviour on a short string.
 */
export function toTeleChunks(o: {
  kind: string;
  ts: number;
  payload: string;
  id?: string;
  chars?: number;
}): TeleChunk[] {
  const chars = o.chars ?? CHUNK_CHARS;
  const of = Math.max(1, Math.ceil(o.payload.length / chars));
  const parts: TeleChunk[] = [];
  for (let i = 0; i < of; i += 1) {
    parts.push({
      ts: o.ts,
      kind: o.kind,
      part: i + 1,
      of,
      payload: o.payload.slice(i * chars, (i + 1) * chars),
      ...(o.id === undefined ? {} : { id: o.id }),
    });
  }
  return parts;
}

/** True for a `tele` body that is one part of a payload of the given kind. */
export function isTeleChunk(body: unknown, kind: string): body is TeleChunk {
  if (typeof body !== 'object' || body === null) return false;
  const o = body as Record<string, unknown>;
  return (
    o['kind'] === kind &&
    typeof o['ts'] === 'number' &&
    typeof o['part'] === 'number' &&
    typeof o['of'] === 'number' &&
    typeof o['payload'] === 'string' &&
    o['part'] >= 1 &&
    o['part'] <= o['of']
  );
}

export interface ChunkAssembly {
  ts: number;
  id: string | null;
  payload: string;
}

export interface ChunkAssembler {
  /**
   * Feed one `tele` body. Returns the reassembled payload once the LAST missing
   * part of a capture arrives, and `null` every other time — including for
   * bodies that are not chunks of this kind at all, so a caller can hand it
   * every packet on the channel.
   */
  accept(body: unknown): ChunkAssembly | null;
}

/**
 * Reassembles chunked payloads, one capture at a time.
 *
 * Parts may arrive out of order (two transports, one retained replay) and a
 * capture may never complete at all — the display could be reloaded mid-send.
 * Keying the buffer on `ts` handles both: a part from a newer capture discards
 * everything held for the older one, so a half-arrived payload can never be
 * completed by parts of a different one.
 */
export function createChunkAssembler(kind: string): ChunkAssembler {
  let capturedAt = -1;
  let id: string | null = null;
  let parts: (string | undefined)[] = [];

  return {
    accept(body) {
      if (!isTeleChunk(body, kind)) return null;
      if (body.ts !== capturedAt) {
        capturedAt = body.ts;
        id = body.id ?? null;
        // `.fill()` is not decorative — see the header.
        parts = new Array<string | undefined>(body.of).fill(undefined);
      }
      if (parts.length !== body.of) return null;
      parts[body.part - 1] = body.payload;
      if (parts.some((p) => p === undefined)) return null;

      const payload = parts.join('');
      const ts = capturedAt;
      const assembledId = id;
      // The buffer is spent either way: a payload that does not parse will not
      // start parsing because the same broken part is redelivered.
      capturedAt = -1;
      id = null;
      parts = [];
      return { ts, id: assembledId, payload };
    },
  };
}
