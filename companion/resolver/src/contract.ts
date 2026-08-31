/**
 * The server-side view of the **frozen v1 wire contract**.
 *
 * The normative form is the web app's
 * `src/modules/video/resolver/resolverTypes.ts`; this file exists because the
 * published npm package must not depend on the web app's source tree. Lockstep
 * is not a promise, it is a test: `test/lockstep.test.ts` imports *both* files
 * and fails if the api version, the closed error enum, the kind list or the
 * token header ever drift apart.
 *
 * Anything added after v1 must be additive and optional — a v1 client has to
 * keep working against a v2 companion, and vice versa.
 */

/** The contract revision this companion speaks (§6.1). */
export const RESOLVER_API_VERSION = 1;

/** §6.1 — the closed error enum. A companion MUST NOT invent codes. */
export const RESOLVER_ERROR_CODES = [
  'unsupported-url',
  'not-found',
  'upstream-failed',
  'rate-limited',
  'forbidden',
  'internal',
] as const;

export type ResolverErrorCode = (typeof RESOLVER_ERROR_CODES)[number];

/** What a resolved stream actually is, which decides the adapter the app mounts. */
export type ResolverKind = 'progressive' | 'hls' | 'dash' | 'file';

export const RESOLVER_KINDS = ['progressive', 'hls', 'dash', 'file'] as const;

export interface ResolverHealth {
  ok: true;
  name: string;
  version: string;
  api: number;
  capabilities: string[];
  maxHeight: number;
}

export interface ResolverOk {
  status: 'ok';
  kind: ResolverKind;
  streamUrl: string;
  mime: string;
  width?: number;
  height?: number;
  fps?: number;
  durationSec?: number;
  title?: string;
  thumbUrl?: string;
  /** Unix **seconds** — the TTL on the minted `/stream/<opaque>` id (§6.3). */
  expiresAt?: number;
}

export interface ResolverPending {
  status: 'pending';
  jobId: string;
  retryAfterMs: number;
}

export interface ResolverErr {
  status: 'error';
  code: ResolverErrorCode;
  message?: string;
  retryAfterMs?: number;
}

export type ResolverEnvelope = ResolverOk | ResolverPending | ResolverErr;

/** §6.2 — the shared-token header, part of the frozen contract from day one. */
export const RESOLVER_TOKEN_HEADER = 'X-Krakenhub-Token';

/**
 * §3 — mandated on **every** response, `/stream` and `/thumb` included.
 *
 * `Access-Control-Expose-Headers` is the one people forget: without it the app
 * can play the stream but cannot read `Content-Length`, so the download-into-
 * IndexedDB progress bar has no denominator.
 */
export const CORS_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type, X-Krakenhub-Token',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  'Accept-Ranges': 'bytes',
});

/** The default HTTP status for each code, when a call site has no better one. */
export const STATUS_FOR_CODE: Readonly<Record<ResolverErrorCode, number>> = Object.freeze({
  'unsupported-url': 400,
  'not-found': 404,
  'upstream-failed': 502,
  'rate-limited': 429,
  forbidden: 403,
  internal: 500,
});

/** §6.1 — a `202` that forgot `retryAfterMs` still has to be polled somehow. */
export const DEFAULT_RETRY_AFTER_MS = 1500;

/** The delivery ladder a `maxHeight` request is snapped down onto. */
export const HEIGHT_LADDER = [480, 720, 1080, 1440, 2160] as const;
