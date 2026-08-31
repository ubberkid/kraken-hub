/**
 * The download manager — **the featured ingestion path**.
 *
 * This file is not in `design-videoEngine.md`; it implements the product
 * decision that supersedes §5.3's upload-first framing (plan, "Local-clip
 * pipeline — AUTO-DOWNLOAD FIRST"): the user pastes a URL, kraken-hub downloads
 * the bytes into its own clip library, and plays the local copy from then on.
 * Manual upload stays as the fallback in `ingest.ts`.
 *
 * Three consequences shape the code:
 *
 *  - **The DISPLAY page downloads, headlessly.** The Kraken Browser shares CAM's
 *    storage partition, so it — not the phone, not an ordinary browser tab — is
 *    the only context whose IndexedDB the LCD can read back. A URL set from the
 *    remote must therefore be fetched by the display itself, with a low-entropy
 *    progress card on the panel.
 *  - **Progress is mirrored to `kraken-hub:v1:video:downloads`.** The
 *    Configuration Browser shares the origin, so the panel shows live progress
 *    for a download running in the other window with zero network.
 *  - **A CORS refusal is not an error.** Most of the web does not send
 *    `Access-Control-Allow-Origin`, so `fetch` fails where a plain `<video src>`
 *    would have played. That case silently falls back to streaming and records
 *    `download-cors-blocked`; the user sees their video either way.
 */

import { createLogger } from '../../../lib/log';
import { readRaw, writeRaw } from '../../../platform/storage';
import { publish } from '../telemetry/videoTelemetry';

import { checkQuotaFor } from './clipStore';
import { ingestBlob } from './ingest';

import type { ProviderMatch } from '../routing/detect';
import type { DownloadMode, ProviderId } from '../types';

const log = createLogger('video/download');

/** Mirrored progress document; the config panel reads it live. */
export const DOWNLOADS_SUFFIX = 'video:downloads';

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 800;
const BACKOFF_FACTOR = 2;
const PROGRESS_THROTTLE_MS = 200;
const MAX_MIRRORED = 8;
const BYTES_PER_MB = 1_048_576;
const PCT = 100;

export type DownloadState = 'queued' | 'downloading' | 'storing' | 'done' | 'error' | 'aborted';

export interface DownloadEntry {
  id: string;
  url: string;
  name: string;
  state: DownloadState;
  receivedBytes: number;
  /** `null` when the server sent no `Content-Length` (chunked responses). */
  totalBytes: number | null;
  attempt: number;
  error: string | null;
  clipId: string | null;
  startedAt: number;
  updatedAt: number;
}

export type DownloadFailureReason =
  'cors' | 'network' | 'quota' | 'aborted' | 'not-downloadable' | 'store-failed';

export type DownloadResult =
  | { ok: true; clipId: string; entry: DownloadEntry }
  | { ok: false; reason: DownloadFailureReason; message: string; entry: DownloadEntry };

// ---------------------------------------------------------------------------
// Live state + the localStorage mirror
// ---------------------------------------------------------------------------

const entries = new Map<string, DownloadEntry>();
const controllers = new Map<string, AbortController>();
const inFlight = new Map<string, Promise<DownloadResult>>();
const listeners = new Set<(all: DownloadEntry[]) => void>();
let lastMirrorAt = 0;

export function listDownloads(): DownloadEntry[] {
  return [...entries.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/** Reads the mirror written by the OTHER window (display ↔ config). */
export function readMirroredDownloads(): DownloadEntry[] {
  const raw = readRaw(DOWNLOADS_SUFFIX);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DownloadEntry[]) : [];
  } catch {
    return [];
  }
}

export function subscribeDownloads(cb: (all: DownloadEntry[]) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function mirror(force: boolean): void {
  const now = Date.now();
  // Throttled: a 200 MB download would otherwise write localStorage thousands
  // of times, and every write wakes the other window's `storage` listener.
  if (!force && now - lastMirrorAt < PROGRESS_THROTTLE_MS) return;
  lastMirrorAt = now;
  writeRaw(DOWNLOADS_SUFFIX, JSON.stringify(listDownloads().slice(0, MAX_MIRRORED)));
}

function emit(entry: DownloadEntry, force = false): void {
  entry.updatedAt = Date.now();
  entries.set(entry.id, entry);
  mirror(force);
  const all = listDownloads();
  for (const cb of listeners) {
    try {
      cb(all);
    } catch (err) {
      log.warn('download listener threw', err);
    }
  }
}

export function abortDownload(id: string): void {
  controllers.get(id)?.abort();
}

export function clearFinishedDownloads(): void {
  for (const [id, entry] of entries) {
    if (entry.state === 'done' || entry.state === 'error' || entry.state === 'aborted') {
      entries.delete(id);
    }
  }
  mirror(true);
}

// ---------------------------------------------------------------------------
// Resolver seam (M2.5)
// ---------------------------------------------------------------------------

export interface ResolvedStream {
  streamUrl: string;
  name?: string;
  mime?: string;
}

/**
 * ── SEAM: resolver companion (M2.5) ──────────────────────────────────────────
 * The browser physically cannot fetch YouTube's media bytes (proved three ways;
 * see docs/design/research). The companion on `http://127.0.0.1:8976` is the
 * only path, and when it lands `resolverClient.ts` registers itself here. From
 * this file's point of view nothing else changes: it gets back a loopback
 * `streamUrl` that IS CORS-clean and Range-capable, and the same
 * fetch-into-IndexedDB pipeline below downloads it.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export type ResolverStreamProvider = (
  url: string,
  signal: AbortSignal,
) => Promise<ResolvedStream | null>;

let resolverProvider: ResolverStreamProvider | null = null;

export function setResolverStreamProvider(provider: ResolverStreamProvider | null): void {
  resolverProvider = provider;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** Providers whose bytes a plain `fetch` can plausibly reach. */
const FETCHABLE: readonly string[] = ['direct-file', 'hls', 'dash', 'reddit', 'resolver'];

/**
 * The ingestion policy in one predicate: `auto` downloads anything file-shaped,
 * `stream-only` never downloads. YouTube is deliberately absent — it goes
 * through the geometry engine today and the resolver seam above in M2.5.
 */
export function shouldAutoDownload(match: ProviderMatch, mode: DownloadMode): boolean {
  if (mode !== 'auto') return false;
  if (match.provider === null || match.provider === 'local-file') return false;
  if (match.error !== null) return false;
  if (resolverProvider !== null && match.provider === 'youtube-embed') return true;
  // `hls`/`dash` are manifests, not files: fetching one stores a playlist, not
  // a video. Only progressive sources are downloaded until the resolver lands.
  return match.provider === 'direct-file' || match.provider === 'reddit';
}

export function isFetchableProvider(provider: string | null): boolean {
  return provider !== null && FETCHABLE.includes(provider);
}

function fileNameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const last = path.split('/').filter(Boolean).pop();
    return last === undefined || last.length === 0 ? 'clip.mp4' : decodeURIComponent(last);
  } catch {
    return 'clip.mp4';
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

// ---------------------------------------------------------------------------
// The download itself
// ---------------------------------------------------------------------------

export interface DownloadOptions {
  /** Cancels the whole job, retries included. */
  signal?: AbortSignal;
  /** Overrides the name derived from the URL. */
  name?: string;
  /** The detected provider, so the resolver seam knows whether `fetch` can reach it. */
  provider?: ProviderId | null;
  /**
   * The URL the clip should be *remembered* by, when that differs from the URL
   * the bytes came from. The resolver path fetches a loopback `/stream/<opaque>`
   * whose token expires, but the clip must be findable again by the YouTube
   * watch URL the user actually pasted — otherwise the next boot re-downloads.
   */
  sourceUrl?: string;
}

interface FetchOutcome {
  blob: Blob | null;
  reason: DownloadFailureReason | null;
  message: string;
}

async function fetchToBlob(
  url: string,
  entry: DownloadEntry,
  signal: AbortSignal,
): Promise<FetchOutcome> {
  let response: Response;
  try {
    response = await fetch(url, { signal, mode: 'cors', credentials: 'omit' });
  } catch (err) {
    if (signal.aborted) return { blob: null, reason: 'aborted', message: 'Cancelled.' };
    // A cross-origin server with no `Access-Control-Allow-Origin` rejects the
    // fetch as an opaque TypeError. That is EXPECTED, not a bug: `<video src>`
    // will still play it, so the caller streams instead.
    return {
      blob: null,
      reason: 'cors',
      message: err instanceof Error ? err.message : 'The server refused a cross-origin read.',
    };
  }

  if (!response.ok) {
    return {
      blob: null,
      reason: 'network',
      message: `The server answered ${String(response.status)} ${response.statusText}.`,
    };
  }

  const lengthHeader = response.headers.get('content-length');
  const total = lengthHeader === null ? null : Number.parseInt(lengthHeader, 10);
  entry.totalBytes = total !== null && Number.isFinite(total) ? total : null;
  entry.state = 'downloading';
  emit(entry, true);

  // §5.3 step 5, applied before a single byte is kept.
  if (entry.totalBytes !== null) {
    const verdict = await checkQuotaFor(entry.totalBytes);
    if (!verdict.ok) {
      return { blob: null, reason: 'quota', message: verdict.message ?? 'Not enough room.' };
    }
  }

  const body = response.body;
  const mime = response.headers.get('content-type') ?? 'video/mp4';

  if (body === null) {
    // No streaming body (some environments): fall back to a single read. No
    // progress ticks, but the clip still lands.
    const blob = await response.blob();
    entry.receivedBytes = blob.size;
    emit(entry, true);
    return { blob, reason: null, message: '' };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      entry.receivedBytes = received;
      emit(entry);
    }
  } catch (err) {
    await reader.cancel().catch(() => {
      /* the stream is already dead */
    });
    if (signal.aborted) return { blob: null, reason: 'aborted', message: 'Cancelled.' };
    return {
      blob: null,
      reason: 'network',
      message: err instanceof Error ? err.message : 'The transfer stopped.',
    };
  }

  const blob = new Blob(chunks as BlobPart[], { type: mime.split(';')[0] ?? 'video/mp4' });
  entry.receivedBytes = blob.size;
  entry.totalBytes ??= blob.size;
  emit(entry, true);

  // Unknown-length responses are checked here instead.
  if (lengthHeader === null) {
    const verdict = await checkQuotaFor(blob.size);
    if (!verdict.ok) {
      return { blob: null, reason: 'quota', message: verdict.message ?? 'Not enough room.' };
    }
  }

  return { blob, reason: null, message: '' };
}

/**
 * Download `url` into the clip library. Retries transient failures twice with
 * exponential backoff; never retries a CORS refusal or a quota refusal, both of
 * which are deterministic answers rather than bad luck.
 */
export function downloadToClip(url: string, opts: DownloadOptions = {}): Promise<DownloadResult> {
  const existing = inFlight.get(url);
  if (existing !== undefined) return existing;

  const id = globalThis.crypto.randomUUID();
  const controller = new AbortController();
  controllers.set(id, controller);
  if (opts.signal !== undefined) {
    if (opts.signal.aborted) controller.abort();
    else
      opts.signal.addEventListener('abort', () => {
        controller.abort();
      });
  }

  const entry: DownloadEntry = {
    id,
    url,
    name: opts.name ?? fileNameFromUrl(url),
    state: 'queued',
    receivedBytes: 0,
    totalBytes: null,
    attempt: 1,
    error: null,
    clipId: null,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  emit(entry, true);

  const run = async (): Promise<DownloadResult> => {
    try {
      // ── SEAM (M2.5): a provider the browser cannot fetch directly is handed
      // to the companion, which answers with a loopback stream URL we CAN.
      let target = url;
      if (resolverProvider !== null && !isFetchableProvider(opts.provider ?? 'direct-file')) {
        const resolved = await resolverProvider(url, controller.signal);
        if (resolved !== null) target = resolved.streamUrl;
      }

      let last: FetchOutcome = { blob: null, reason: 'network', message: 'Not attempted.' };
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        entry.attempt = attempt;
        entry.receivedBytes = 0;
        emit(entry, true);
        last = await fetchToBlob(target, entry, controller.signal);
        if (last.blob !== null) break;
        if (last.reason === 'cors' || last.reason === 'quota' || last.reason === 'aborted') break;
        if (attempt < MAX_ATTEMPTS) {
          await delay(BACKOFF_BASE_MS * Math.pow(BACKOFF_FACTOR, attempt - 1), controller.signal);
          if (controller.signal.aborted) {
            last = { blob: null, reason: 'aborted', message: 'Cancelled.' };
            break;
          }
        }
      }

      if (last.blob === null) {
        entry.state = last.reason === 'aborted' ? 'aborted' : 'error';
        entry.error = last.message;
        emit(entry, true);
        publish({
          code:
            last.reason === 'cors'
              ? 'download-cors-blocked'
              : `download-${last.reason ?? 'failed'}`,
          severity: last.reason === 'cors' ? 'warn' : 'error',
          message: last.message,
          detail: { url: entry.name, attempts: entry.attempt },
        });
        return {
          ok: false,
          reason: last.reason ?? 'network',
          message: last.message,
          entry,
        };
      }

      entry.state = 'storing';
      emit(entry, true);
      const stored = await ingestBlob(last.blob, entry.name, {
        force: true,
        sourceUrl: opts.sourceUrl ?? url,
      });
      if (!stored.ok || stored.clip === null) {
        entry.state = 'error';
        entry.error = stored.message ?? 'The clip could not be stored.';
        emit(entry, true);
        return {
          ok: false,
          reason: stored.failure === 'quota-exceeded' ? 'quota' : 'store-failed',
          message: entry.error,
          entry,
        };
      }

      entry.state = 'done';
      entry.clipId = stored.clip.id;
      emit(entry, true);
      publish({
        code: 'download-complete',
        severity: 'info',
        message: entry.name,
        detail: {
          bytes: entry.receivedBytes,
          mb: Number((entry.receivedBytes / BYTES_PER_MB).toFixed(2)),
          persisted: stored.persisted,
        },
      });
      return { ok: true, clipId: stored.clip.id, entry };
    } finally {
      controllers.delete(id);
      inFlight.delete(url);
    }
  };

  const promise = run();
  inFlight.set(url, promise);
  return promise;
}

/** `0..100`, or `null` when the server never said how big the file is. */
export function progressPct(entry: DownloadEntry): number | null {
  if (entry.totalBytes === null || entry.totalBytes <= 0) return null;
  return Math.min(PCT, (entry.receivedBytes / entry.totalBytes) * PCT);
}
