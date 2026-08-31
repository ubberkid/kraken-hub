/**
 * The `tele`-channel wire form of a `DiagReport` — the cross-MACHINE half of the
 * diagnostics hand-off.
 *
 * `report.ts` carries a report from the LCD to the configuration page through
 * `localStorage`, which works only because CAM's two browsers share one storage
 * partition. That is the whole trick, and it has one hard limit: **it never
 * leaves the machine**. Somebody running CAM on a Windows PC and working on a
 * Mac has no way to get the JSON out at all.
 *
 * This module is the answer. A paired remote sends the `requestDiag` command;
 * the display probes itself and publishes the report as telemetry, encrypted
 * under the room key like everything else on the wire.
 *
 * Two constraints shape the format:
 *
 *  1. **Invariant I6: 8 KB per envelope.** A full report with sixteen log lines
 *     and a codec table does not reliably fit, so the payload is a string that
 *     is split across numbered parts and reassembled by the receiver. Parts of
 *     one capture share the report's `ts`, which is what lets a receiver throw
 *     away a half-arrived older capture the moment a newer one starts.
 *  2. **Compactness is not cosmetic.** `JSON.stringify(report, null, 2)` is what
 *     `#/diag` shows a human; on the wire the same report is serialised with no
 *     whitespace and with null-valued keys dropped, which is worth roughly a
 *     third of the bytes and often the difference between one part and two.
 *
 * The chunk shape is uniform: a report that fits is still `part 1 of 1`, so the
 * receiver has exactly one code path and no "was it chunked?" branch to get
 * wrong.
 */

import { DIAG_SCHEMA_VERSION, type DiagReport } from './report';

/**
 * `MAX_ENVELOPE_BYTES`, copied rather than imported.
 *
 * `src/sync/types.ts` is claimed by the `sync-core` chunk, and importing a
 * runtime value from it here would make this leaf file — which the DISPLAY
 * fetches lazily and the config page imports statically — a member of that
 * chunk's graph in both directions. `wire.test.ts` asserts the two constants are
 * equal, so the copy cannot drift; the type-only imports elsewhere in `src/diag`
 * cost nothing and stay imports.
 */
const ENVELOPE_CAP_BYTES = 8192;

/** The `TeleBody.kind` a diagnostics chunk carries. */
export const DIAG_TELE_KIND = 'diagReport';

/**
 * Room reserved for the envelope's own keys and the chunk's `ts`/`part`/`of`.
 * ~120 bytes are actually used; the rest is slack for a long `src` id.
 */
const DIAG_ENVELOPE_HEADROOM = 1024;

/**
 * Payload characters per part.
 *
 * Derived from the cap rather than guessed, and halved on purpose: the payload
 * is a JSON string nested inside another JSON document, so every `"` in it
 * becomes `\"` and a pathological chunk very nearly doubles on the way into the
 * envelope. Two bytes per character is that worst case. `wire.test.ts` encodes a
 * real envelope and asserts the cap rather than trusting this arithmetic.
 */
export const DIAG_CHUNK_CHARS = Math.floor((ENVELOPE_CAP_BYTES - DIAG_ENVELOPE_HEADROOM) / 2);

/**
 * Spacing between parts.
 *
 * `SyncService.publishTele()` throttles to `PUBLISH_THROTTLE_MS` (200 ms) and
 * DROPS what arrives inside the window rather than queueing it — publishing
 * three parts in a loop would silently send one. Anything above the throttle
 * works; 250 ms keeps a four-part report under a second.
 */
export const DIAG_CHUNK_SPACING_MS = 250;

/**
 * How long the remote waits before it says the display never answered.
 *
 * The display's own probe budget is ~5 s and a chunked report adds a second on
 * top, so this is roughly three times the honest worst case — long enough that
 * a slow ntfy poll is not reported as a dead display.
 */
export const DIAG_REQUEST_TIMEOUT_MS = 20_000;

export interface DiagChunk {
  /** The capture's timestamp. Identical across every part of one report. */
  ts: number;
  kind: typeof DIAG_TELE_KIND;
  /** 1-based. */
  part: number;
  of: number;
  payload: string;
}

/** Drops null-valued keys; `undefined` is simply omitted by `JSON.stringify`. */
function withoutNulls(_key: string, value: unknown): unknown {
  return value === null ? undefined : value;
}

/**
 * The wire serialisation: no whitespace, no nulls.
 *
 * A dropped key and an explicit `null` mean the same thing in every consumer of
 * a `DiagReport` — "not measured" — so this loses no information, and the
 * reassembled document is still a valid report.
 */
export function compactReport(report: DiagReport): string {
  return JSON.stringify(report, withoutNulls);
}

/** Split a report into publishable parts. Always at least one. */
export function toDiagChunks(report: DiagReport): DiagChunk[] {
  const payload = compactReport(report);
  const of = Math.max(1, Math.ceil(payload.length / DIAG_CHUNK_CHARS));
  const parts: DiagChunk[] = [];
  for (let i = 0; i < of; i += 1) {
    parts.push({
      ts: report.capturedAt,
      kind: DIAG_TELE_KIND,
      part: i + 1,
      of,
      payload: payload.slice(i * DIAG_CHUNK_CHARS, (i + 1) * DIAG_CHUNK_CHARS),
    });
  }
  return parts;
}

/** True for a `tele` body that is one part of a diagnostics report. */
export function isDiagChunk(body: unknown): body is DiagChunk {
  if (typeof body !== 'object' || body === null) return false;
  const o = body as Record<string, unknown>;
  return (
    o['kind'] === DIAG_TELE_KIND &&
    typeof o['ts'] === 'number' &&
    typeof o['part'] === 'number' &&
    typeof o['of'] === 'number' &&
    typeof o['payload'] === 'string' &&
    o['part'] >= 1 &&
    o['part'] <= o['of']
  );
}

export interface DiagAssembler {
  /**
   * Feed one `tele` body. Returns the report once the LAST missing part of a
   * capture arrives, and `null` every other time — including for bodies that are
   * not diagnostics chunks at all, so a caller can hand it every packet.
   */
  accept(body: unknown): DiagReport | null;
}

/**
 * Reassembles chunked reports, one capture at a time.
 *
 * Parts may arrive out of order (two transports, one retained replay) and a
 * capture may never complete at all — the display could be reloaded mid-send.
 * Keying the buffer on `ts` handles both: a part from a newer capture discards
 * everything held for the older one, so a half-arrived report can never be
 * completed by parts of a different one.
 */
export function createDiagAssembler(): DiagAssembler {
  let capturedAt = -1;
  let parts: (string | undefined)[] = [];

  return {
    accept(body) {
      if (!isDiagChunk(body)) return null;
      if (body.ts !== capturedAt) {
        capturedAt = body.ts;
        // `.fill()` is not decorative: `new Array(n)` is SPARSE, and
        // `Array.prototype.some` skips holes — so the completeness check below
        // would pass on the very first part and reassemble a truncated report.
        parts = new Array<string | undefined>(body.of).fill(undefined);
      }
      if (parts.length !== body.of) return null;
      parts[body.part - 1] = body.payload;
      if (parts.some((p) => p === undefined)) return null;

      const raw = parts.join('');
      // The buffer is spent either way: a payload that does not parse will not
      // start parsing because the same broken part is redelivered.
      capturedAt = -1;
      parts = [];
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) return null;
        const report = parsed as DiagReport;
        return report.schemaVersion === DIAG_SCHEMA_VERSION ? report : null;
      } catch {
        return null;
      }
    },
  };
}

export type DiagPhase = 'idle' | 'waiting' | 'timeout' | 'ready';

/**
 * What the remote's Diagnostics card should be showing, as a pure function of
 * three timestamps.
 *
 * Extracted from the component because "did the display answer in time" is the
 * one piece of this feature with a wrong answer that is invisible in a
 * screenshot: a report that arrived BEFORE the request was sent is a stale one
 * from a previous pull, and rendering it as the answer would make a dead display
 * look healthy.
 */
export function diagPhase(o: {
  requestedAt: number | null;
  receivedAt: number | null;
  now: number;
}): DiagPhase {
  if (o.requestedAt === null) return o.receivedAt === null ? 'idle' : 'ready';
  if (o.receivedAt !== null && o.receivedAt >= o.requestedAt) return 'ready';
  return o.now - o.requestedAt >= DIAG_REQUEST_TIMEOUT_MS ? 'timeout' : 'waiting';
}

/**
 * Whether a report already on screen is the answer to the request the user just
 * made, or a leftover from an earlier one.
 *
 * A report is kept on screen after a timed-out re-request on purpose — it is
 * still the last thing the display said, and throwing it away would take the
 * Copy JSON button with it. But it must not be dressed up as fresh: `ready` is
 * the only phase in which the visible report answers the visible request, so
 * everything else is stale and the card has to say so.
 */
export function diagReportFreshness(phase: DiagPhase): 'fresh' | 'stale' {
  return phase === 'ready' ? 'fresh' : 'stale';
}
