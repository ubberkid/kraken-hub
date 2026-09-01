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

import {
  CHUNK_CHARS,
  CHUNK_SPACING_MS,
  createChunkAssembler,
  isTeleChunk,
  toTeleChunks,
  type TeleChunk,
} from '../lib/chunkedTele';

import { DIAG_SCHEMA_VERSION, type DiagReport } from './report';

/** The `TeleBody.kind` a diagnostics chunk carries. */
export const DIAG_TELE_KIND = 'diagReport';

/**
 * The chunking mechanics moved to `src/lib/chunkedTele.ts` when the remote's
 * live ring needed to ship thumbnails the same way.
 *
 * Everything that was subtle here — the shared `ts` per capture, the `.fill()`
 * on the parts buffer, the uniform `part 1 of 1` shape, the two-bytes-per-
 * character budget for JSON-in-JSON escaping — moved with it, comments and all.
 * What stays here is the part that is genuinely about diagnostics: the compact
 * report serialisation, and the schema check on reassembly.
 *
 * These three constants are re-exported under their original names because the
 * display's sync layer and the remote both import them by those names.
 */
export const DIAG_CHUNK_CHARS = CHUNK_CHARS;
export const DIAG_CHUNK_SPACING_MS = CHUNK_SPACING_MS;

/**
 * How long the remote waits before it says the display never answered.
 *
 * The display's own probe budget is ~5 s and a chunked report adds a second on
 * top, so this is roughly three times the honest worst case — long enough that
 * a slow ntfy poll is not reported as a dead display.
 */
export const DIAG_REQUEST_TIMEOUT_MS = 20_000;

export type DiagChunk = TeleChunk & { kind: typeof DIAG_TELE_KIND };

/** Drops null-valued keys; `undefined` is simply omitted by `JSON.stringify`. */
function withoutNulls(_key: string, value: unknown): unknown {
  return value === null ? undefined : value;
}

/**
 * The wire serialisation: no whitespace, no nulls.
 *
 * A dropped key and an explicit `null` mean the same thing in every consumer of
 * a `DiagReport` — "not measured" — so this loses no information, and the
 * reassembled document is still a valid report. It is worth roughly a third of
 * the bytes and often the difference between one part and two.
 */
export function compactReport(report: DiagReport): string {
  return JSON.stringify(report, withoutNulls);
}

/** Split a report into publishable parts. Always at least one. */
export function toDiagChunks(report: DiagReport): DiagChunk[] {
  return toTeleChunks({
    kind: DIAG_TELE_KIND,
    ts: report.capturedAt,
    payload: compactReport(report),
  }) as DiagChunk[];
}

/** True for a `tele` body that is one part of a diagnostics report. */
export function isDiagChunk(body: unknown): body is DiagChunk {
  return isTeleChunk(body, DIAG_TELE_KIND);
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
  const chunks = createChunkAssembler(DIAG_TELE_KIND);
  return {
    accept(body) {
      const done = chunks.accept(body);
      if (done === null) return null;
      try {
        const parsed: unknown = JSON.parse(done.payload);
        if (typeof parsed !== 'object' || parsed === null) return null;
        const report = parsed as DiagReport;
        // A report from a build with a different report schema is not a report
        // we can render; dropping it is better than half-filling the table.
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
