/**
 * Video-module telemetry — all three sinks (design-videoEngine.md §7.5).
 *
 * Every error, every warning and the 0.5 Hz continuous stats sample go to the
 * same three places, and the ORDER of preference matters:
 *
 *  1. **`localStorage`** — `kraken-hub:v1:video:lastError` (one object) and
 *     `kraken-hub:v1:video:log` (ring buffer, last 20, capped at 32 KB). The CAM
 *     Configuration Browser shares this origin, so it receives both for free via
 *     the `storage` event with **zero network**. This is the single most
 *     reliable diagnostic path in the product and must never be skipped.
 *     §7.5 also mandates a 1 s polling fallback, because the `storage` event's
 *     cross-window reliability inside CAM's Electron webview is unverified
 *     (hardware checklist H16) — `subscribeTelemetry()` below installs it.
 *  2. **The sync `tele` channel** — MQTT/ntfy, throttled to 2 Hz, so the phone
 *     remote sees what the LCD sees. The transport itself lands in M2; today
 *     this file owns the *interface* (`TeleSink`) and a local emitter, plus a
 *     `kraken-hub:v1:video:tele` mirror so the config UI can already render the
 *     stream the remote will later receive over the wire.
 *  3. **`console`** with a `[kraken-hub/video]` prefix, for anybody with CAM's
 *     devtools open.
 *
 * `urlHash` is the first 8 hex characters of SHA-256. Raw URLs never travel on a
 * shared channel — the payloads are AES-GCM encrypted in M2 anyway, but a hash
 * is defence in depth and costs nothing.
 */

import { createLogger } from '../../../lib/log';
import { readRaw, writeRaw } from '../../../platform/storage';

const log = createLogger('video');

export const LAST_ERROR_SUFFIX = 'video:lastError';
export const LOG_SUFFIX = 'video:log';
/** The `tele` channel mirror — what M2's transport will publish, verbatim. */
export const TELE_SUFFIX = 'video:tele';

const RING_MAX = 20;
const RING_MAX_BYTES = 32_768;
/** §7.5 — the `tele` channel is throttled to 2 Hz. */
const TELE_THROTTLE_MS = 500;
/** §7.5 — the `storage`-event fallback poll, in case Electron drops the event. */
export const TELEMETRY_POLL_MS = 1000;

/** Open on purpose: telemetry codes are diagnostic strings, not a wire contract. */
export interface TelemetryEvent {
  ts: number;
  code: string;
  severity: 'info' | 'warn' | 'error';
  provider?: string;
  message?: string;
  /** Never a raw URL on any shared channel — the first 8 hex of SHA-256. */
  urlHash?: string;
  detail?: Record<string, number | string | boolean | null>;
}

// ---------------------------------------------------------------------------
// Sink 1: the localStorage ring buffer
// ---------------------------------------------------------------------------

function readRing(): TelemetryEvent[] {
  const raw = readRaw(LOG_SUFFIX);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TelemetryEvent[]) : [];
  } catch {
    return [];
  }
}

export function readTelemetryLog(): TelemetryEvent[] {
  return readRing();
}

export function readLastError(): TelemetryEvent | null {
  const raw = readRaw(LAST_ERROR_SUFFIX);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as TelemetryEvent;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sink 2: the sync `tele` channel (interface frozen here, transport in M2)
// ---------------------------------------------------------------------------

/**
 * §7.5 payload, exactly. `kind` distinguishes the error stream from the
 * continuous one so the remote can render them differently without sniffing.
 */
export interface TelePacket {
  ch: 'tele';
  kind: 'videoError' | 'videoStats';
  ts: number;
  code?: string;
  severity?: TelemetryEvent['severity'];
  provider?: string | null;
  urlHash?: string | null;
  message?: string;
  retryCount?: number;
  display?: { w: number; h: number; shape: string; targetFps: number };
  achievedFps?: number;
  quality?: { height: number | null; label: string | null };
  geometry?: { N: number; crop: number; scale: number };
  resolver?: { configured: boolean; healthy: boolean };
  /** Continuous stats (§7.5, second half). */
  stats?: {
    currentTime: number;
    bufferedEnd: number;
    held: boolean;
    loopCrossings: number;
    maskVisiblePct: number;
  };
}

export type TeleSink = (packet: TelePacket) => void;

const teleSinks = new Set<TeleSink>();
let lastTeleAt = 0;

/**
 * ── SEAM (M2): the sync layer registers its encrypted transport here. Until it
 * does, packets still reach the local emitter and the localStorage mirror, so
 * the config UI can render the exact stream the phone will later receive.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function registerTeleSink(sink: TeleSink): () => void {
  teleSinks.add(sink);
  return () => {
    teleSinks.delete(sink);
  };
}

export function readTeleMirror(): TelePacket | null {
  const raw = readRaw(TELE_SUFFIX);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as TelePacket;
  } catch {
    return null;
  }
}

/** Errors bypass the 2 Hz throttle; the continuous stream does not. */
function emitTele(packet: TelePacket, force: boolean): void {
  const now = Date.now();
  if (!force && now - lastTeleAt < TELE_THROTTLE_MS) return;
  lastTeleAt = now;
  writeRaw(TELE_SUFFIX, JSON.stringify(packet));
  for (const sink of teleSinks) {
    try {
      sink(packet);
    } catch (err) {
      log.warn('tele sink threw', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Ambient context — what every packet carries whether or not the caller knows it
// ---------------------------------------------------------------------------

export interface TelemetryContext {
  display: { w: number; h: number; shape: string; targetFps: number };
  achievedFps: number;
  quality: { height: number | null; label: string | null };
  geometry: { N: number; crop: number; scale: number } | null;
  resolver: { configured: boolean; healthy: boolean };
  retryCount: number;
}

const DEFAULT_CONTEXT: TelemetryContext = {
  display: { w: 0, h: 0, shape: 'circle', targetFps: 0 },
  achievedFps: 0,
  quality: { height: null, label: null },
  geometry: null,
  resolver: { configured: false, healthy: false },
  retryCount: 0,
};

let context: TelemetryContext = { ...DEFAULT_CONTEXT };

export function setTelemetryContext(patch: Partial<TelemetryContext>): void {
  context = { ...context, ...patch };
}

export function telemetryContext(): TelemetryContext {
  return context;
}

/** Test hook — the module-level context would otherwise leak between cases. */
export function resetTelemetryContext(): void {
  context = { ...DEFAULT_CONTEXT };
}

// ---------------------------------------------------------------------------
// publish()
// ---------------------------------------------------------------------------

export interface PublishOptions {
  /** Hash and attach the URL. Never publishes the URL itself. */
  url?: string;
}

/**
 * Appends to the ring buffer, mirrors errors to the single-object last-error
 * key, pushes a `tele` packet and logs to the console — all three sinks, always.
 */
export function publish(
  event: Omit<TelemetryEvent, 'ts'> & { ts?: number },
  opts: PublishOptions = {},
): void {
  const full: TelemetryEvent = { ...event, ts: event.ts ?? Date.now() };

  let ring = [...readRing(), full].slice(-RING_MAX);
  let json = JSON.stringify(ring);
  while (json.length > RING_MAX_BYTES && ring.length > 1) {
    ring = ring.slice(1);
    json = JSON.stringify(ring);
  }
  writeRaw(LOG_SUFFIX, json);

  if (full.severity === 'error') {
    writeRaw(LAST_ERROR_SUFFIX, JSON.stringify(full));
    log.error(`${full.code}: ${full.message ?? ''}`);
  } else if (full.severity === 'warn') {
    log.warn(`${full.code}: ${full.message ?? ''}`);
  } else {
    log.debug(`${full.code}: ${full.message ?? ''}`);
  }

  const packet: TelePacket = {
    ch: 'tele',
    kind: 'videoError',
    ts: full.ts,
    code: full.code,
    severity: full.severity,
    provider: full.provider ?? null,
    urlHash: full.urlHash ?? null,
    ...(full.message === undefined ? {} : { message: full.message }),
    retryCount: context.retryCount,
    display: context.display,
    achievedFps: context.achievedFps,
    quality: context.quality,
    ...(context.geometry === null ? {} : { geometry: context.geometry }),
    resolver: context.resolver,
  };
  emitTele(packet, full.severity === 'error');

  // Hashing is async and must never delay the synchronous sinks above, so the
  // hash lands as a follow-up packet rather than blocking the first one.
  if (opts.url !== undefined && full.urlHash === undefined) {
    void urlHash(opts.url).then((hash) => {
      if (hash !== null) emitTele({ ...packet, urlHash: hash }, false);
    });
  }
}

/** §7.5 — the continuous 0.5 Hz sample. Throttled by `emitTele` to 2 Hz max. */
export function publishStats(stats: NonNullable<TelePacket['stats']>): void {
  emitTele(
    {
      ch: 'tele',
      kind: 'videoStats',
      ts: Date.now(),
      display: context.display,
      achievedFps: context.achievedFps,
      quality: context.quality,
      ...(context.geometry === null ? {} : { geometry: context.geometry }),
      resolver: context.resolver,
      stats,
    },
    false,
  );
}

// ---------------------------------------------------------------------------
// The config-UI side: `storage` event + the mandated 1 s poll fallback
// ---------------------------------------------------------------------------

/**
 * §7.5 — the Configuration Browser reads the ring buffer over the shared origin.
 * The `storage` event is the fast path; the unconditional 1 s poll is the one
 * that still works if CAM's Electron build does not deliver it cross-window.
 */
export function subscribeTelemetry(cb: (events: TelemetryEvent[]) => void): () => void {
  let last = readRaw(LOG_SUFFIX);
  const fire = (): void => {
    const now = readRaw(LOG_SUFFIX);
    if (now === last) return;
    last = now;
    cb(readRing());
  };
  const onStorage = (): void => {
    fire();
  };
  window.addEventListener('storage', onStorage);
  const timer = setInterval(fire, TELEMETRY_POLL_MS);
  return () => {
    window.removeEventListener('storage', onStorage);
    clearInterval(timer);
  };
}

// ---------------------------------------------------------------------------

const HASH_HEX_CHARS = 8;
const HEX = 16;
const HEX_PAD = 2;

/** §7.5 — first 8 hex of SHA-256. Falls back to `null` where WebCrypto is absent. */
export async function urlHash(url: string): Promise<string | null> {
  try {
    const bytes = new TextEncoder().encode(url);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(HEX).padStart(HEX_PAD, '0'))
      .join('')
      .slice(0, HASH_HEX_CHARS);
  } catch {
    return null;
  }
}
