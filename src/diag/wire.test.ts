import { describe, expect, it } from 'vitest';

import { encodeEnvelope } from '../sync/envelope';
import { MAX_ENVELOPE_BYTES, PROTOCOL_VERSION } from '../sync/types';

import { DIAG_SCHEMA_VERSION, type DiagReport } from './report';
import {
  compactReport,
  createDiagAssembler,
  diagPhase,
  diagReportFreshness,
  DIAG_CHUNK_CHARS,
  DIAG_REQUEST_TIMEOUT_MS,
  isDiagChunk,
  toDiagChunks,
  type DiagChunk,
} from './wire';

import type { Envelope } from '../sync/types';

/** A report shaped like a real one, with the fields the remote card renders. */
function report(overrides: Partial<DiagReport> = {}): DiagReport {
  return {
    schemaVersion: DIAG_SCHEMA_VERSION,
    capturedAt: 1_700_000_000_000,
    app: { version: '0.1.0', gitSha: 'a1b2c3d', buildTime: '2026-08-30T00:00:00.000Z' },
    mode: 'display',
    device: {
      width: 480,
      height: 480,
      shape: 'circle',
      targetFps: 30,
      geometrySource: 'nzxt',
      dpr: 1,
      safeInsetPx: 12,
      inscribedSquarePx: 339,
      screen: { width: 480, height: 480, innerWidth: 480, innerHeight: 480 },
      nzxtRaw: null,
    },
    injection: { firstSeenMs: 42, attempts: 1, reinjections: 0, present: true },
    capabilities: {
      userAgent: 'Mozilla/5.0 Chrome/126.0.0.0',
      chromiumVersion: '126.0.0.0',
      electronVersion: null,
      dpr: 1,
      screen: { width: 480, height: 480, innerWidth: 480, innerHeight: 480 },
      hardwareConcurrency: 8,
      deviceMemoryGb: 8,
      codecs: { h264: { element: 'probably', mse: true } },
      features: { webgl: true },
    },
    timings: {
      rafFps: { count: 90, p50: 29.7, p95: 30.1, max: 31 },
      monitoringIntervalMs: null,
      achievedFps: 29.5,
      longFrames: 2,
    },
    storage: {
      usageBytes: 1024,
      quotaBytes: 2048,
      persisted: true,
      localStorageAvailable: true,
      localStorageDegraded: false,
      delivery: { viaEvent: 3, viaPoll: 1, viaMem: 0 },
    },
    manual: { visibleRadiusPct: null, audioAudible: null, dimsWhenIdle: null },
    notes: [],
    ...overrides,
  };
}

/** Exactly what `SyncService.publishTele()` would put on the wire. */
function envelopeFor(body: DiagChunk): Envelope {
  return {
    v: PROTOCOL_VERSION,
    ch: 'tele',
    ts: body.ts,
    // 12 chars, the width `src/platform/env.ts` actually produces.
    src: 'abcdef123456',
    role: 'display',
    seq: 99,
    body,
  };
}

describe('the envelope cap', () => {
  it('is the same number the sync layer enforces', () => {
    // `wire.ts` copies the cap rather than importing it, so that the diag chunk
    // stays out of `sync-core`'s graph in both directions (invariant I8). This
    // is the guard that stops the copy from drifting: the chunk size is derived
    // from the cap, so a bump in `src/sync/types.ts` that never reached
    // `wire.ts` would silently start producing oversized parts.
    expect(DIAG_CHUNK_CHARS).toBe(Math.floor((MAX_ENVELOPE_BYTES - 1024) / 2));
  });
});

describe('compactReport', () => {
  it('drops whitespace and null-valued keys', () => {
    const json = compactReport(report());
    expect(json).not.toContain('\n');
    expect(json).not.toContain(': ');
    expect(json).not.toContain('null');
    // The fields the remote card renders survive the compaction.
    expect(JSON.parse(json)).toMatchObject({
      schemaVersion: DIAG_SCHEMA_VERSION,
      device: { dpr: 1, targetFps: 30 },
      capabilities: { chromiumVersion: '126.0.0.0' },
    });
  });

  it('is materially smaller than the human-readable form', () => {
    const pretty = JSON.stringify(report(), null, 2);
    expect(compactReport(report()).length).toBeLessThan(pretty.length * 0.7);
  });
});

describe('toDiagChunks', () => {
  it('sends an ordinary report as a single part', () => {
    const chunks = toDiagChunks(report());
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ kind: 'diagReport', part: 1, of: 1 });
    expect(chunks.every(isDiagChunk)).toBe(true);
  });

  it('keeps every part inside the 8 KB envelope cap (invariant I6)', () => {
    // The forced-oversize report: sixteen log lines of realistic width is what a
    // display that has actually been running for a while produces, and it is
    // exactly the case that used to silently exceed the cap.
    const chunks = toDiagChunks(
      report({
        notes: Array.from({ length: 16 }, (_unused, i) => ({
          at: 1_700_000_000_000 + i,
          level: 'warn' as const,
          scope: 'display/video',
          msg: `x`.repeat(500),
        })),
      }),
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // Throws `EnvelopeTooLargeError` above the cap, so this is the assertion.
      expect(encodeEnvelope(envelopeFor(chunk)).length).toBeLessThanOrEqual(MAX_ENVELOPE_BYTES);
    }
  });

  it('numbers the parts 1..of and shares one capture timestamp', () => {
    const big = report({ notes: [{ at: 1, level: 'info', scope: 's', msg: 'y'.repeat(9000) }] });
    const chunks = toDiagChunks(big);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.map((c) => c.part)).toEqual(chunks.map((_unused, i) => i + 1));
    expect(new Set(chunks.map((c) => c.of))).toEqual(new Set([chunks.length]));
    expect(new Set(chunks.map((c) => c.ts))).toEqual(new Set([big.capturedAt]));
    expect(chunks.every((c) => c.payload.length <= DIAG_CHUNK_CHARS)).toBe(true);
  });
});

describe('createDiagAssembler', () => {
  it('round-trips a single-part report', () => {
    const a = createDiagAssembler();
    const [only] = toDiagChunks(report());
    expect(a.accept(only)).toEqual(JSON.parse(compactReport(report())));
  });

  it('reassembles a forced-oversize report, out of order', () => {
    const source = report({
      notes: [{ at: 1, level: 'warn', scope: 'sync', msg: 'z'.repeat(12_000) }],
    });
    const chunks = toDiagChunks(source);
    expect(chunks.length).toBeGreaterThan(2);

    const a = createDiagAssembler();
    const shuffled = [...chunks].reverse();
    const results = shuffled.map((c) => a.accept(c));
    // Only the LAST part to arrive completes the report.
    expect(results.slice(0, -1).every((r) => r === null)).toBe(true);
    expect(results[results.length - 1]).toEqual(JSON.parse(compactReport(source)));
  });

  it('ignores telemetry that is not a diagnostics chunk', () => {
    const a = createDiagAssembler();
    expect(a.accept({ ts: 1, kind: 'stats', stats: { currentTime: 3 } })).toBeNull();
    expect(a.accept(null)).toBeNull();
    expect(a.accept('nonsense')).toBeNull();
  });

  it('discards a half-arrived capture when a newer one starts', () => {
    const older = toDiagChunks(
      report({
        capturedAt: 1000,
        notes: [{ at: 1, level: 'warn', scope: 's', msg: 'a'.repeat(9000) }],
      }),
    );
    const newer = report({
      capturedAt: 2000,
      notes: [{ at: 1, level: 'warn', scope: 's', msg: 'b'.repeat(9000) }],
    });
    const newerChunks = toDiagChunks(newer);

    const a = createDiagAssembler();
    expect(a.accept(older[0])).toBeNull();
    for (const c of newerChunks.slice(0, -1)) expect(a.accept(c)).toBeNull();
    // The stale first part must not have filled a slot for the new capture.
    expect(a.accept(newerChunks[newerChunks.length - 1])).toEqual(JSON.parse(compactReport(newer)));
  });

  it('returns null for a payload that does not parse', () => {
    const a = createDiagAssembler();
    expect(
      a.accept({ ts: 5, kind: 'diagReport', part: 1, of: 1, payload: '{not json' }),
    ).toBeNull();
  });

  it('rejects a report from a future schema version', () => {
    const a = createDiagAssembler();
    const [only] = toDiagChunks(report({ schemaVersion: DIAG_SCHEMA_VERSION + 1 }));
    expect(a.accept(only)).toBeNull();
  });
});

describe('diagPhase', () => {
  const at = 10_000;

  it('is idle before anyone has asked', () => {
    expect(diagPhase({ requestedAt: null, receivedAt: null, now: at })).toBe('idle');
  });

  it('waits while the display is still probing', () => {
    expect(diagPhase({ requestedAt: at, receivedAt: null, now: at + 3000 })).toBe('waiting');
  });

  it('times out after twenty seconds', () => {
    expect(
      diagPhase({ requestedAt: at, receivedAt: null, now: at + DIAG_REQUEST_TIMEOUT_MS }),
    ).toBe('timeout');
  });

  it('treats a report older than the request as no answer at all', () => {
    // The stale-answer trap: a report from a previous pull must not make a dead
    // display look healthy.
    expect(diagPhase({ requestedAt: at, receivedAt: at - 1, now: at + 1000 })).toBe('waiting');
    expect(
      diagPhase({ requestedAt: at, receivedAt: at - 1, now: at + DIAG_REQUEST_TIMEOUT_MS }),
    ).toBe('timeout');
  });

  it('is ready once an answer newer than the request lands', () => {
    expect(diagPhase({ requestedAt: at, receivedAt: at + 500, now: at + 600 })).toBe('ready');
  });
});

describe('diagReportFreshness', () => {
  const at = 10_000;

  it('calls a report fresh only while the card is ready', () => {
    expect(diagReportFreshness('ready')).toBe('fresh');
  });

  it('calls a report stale in every other phase', () => {
    // The card keeps the previous report on screen through a re-request so the
    // Copy JSON button survives; it must never be labelled as the answer.
    expect(diagReportFreshness('waiting')).toBe('stale');
    expect(diagReportFreshness('timeout')).toBe('stale');
    expect(diagReportFreshness('idle')).toBe('stale');
  });

  it('marks the report stale after a re-request times out', () => {
    // A report from the FIRST pull, still on screen, when the SECOND pull dies.
    const phase = diagPhase({
      requestedAt: at,
      receivedAt: at - 1,
      now: at + DIAG_REQUEST_TIMEOUT_MS,
    });
    expect(phase).toBe('timeout');
    expect(diagReportFreshness(phase)).toBe('stale');
  });
});
