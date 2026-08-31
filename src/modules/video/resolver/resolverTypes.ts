/**
 * The resolver companion's wire contract — **FROZEN v1**
 * (design-videoEngine.md §6.1).
 *
 * This file is the normative TypeScript form of `docs/resolver-protocol.md`.
 * Both sides of the wire are written against it: the browser client in
 * `resolverClient.ts` and, from M2.5, the `companion/resolver/` npm workspace.
 * Anything added later must be **additive and optional** — a v1 client must keep
 * working against a v2 companion and vice versa, which is the whole point of
 * freezing it before either side ships.
 *
 * Endpoints (base `http://127.0.0.1:<port>`, default port 8976):
 *
 * ```
 * GET /health
 * 200 { ok, name, version, api, capabilities, maxHeight }
 *
 * GET /resolve?url=&maxHeight=&prefer=&audio=[&token=]
 * 200 { status:'ok',      kind, streamUrl, mime, width, height, fps, durationSec,
 *                         title, thumbUrl, expiresAt }
 * 202 { status:'pending', jobId, retryAfterMs }
 * 4xx/5xx { status:'error', code, message?, retryAfterMs? }
 *
 * GET /job/<jobId>            -> the same envelope as /resolve
 * GET /stream/<opaque>.mp4    -> 200/206; MUST support Range
 * ```
 *
 * Two rules that are part of the contract but cannot be expressed as a type:
 *  - **loopback only.** `127.0.0.1` / `localhost` / `[::1]` are *potentially
 *    trustworthy* origins and are therefore exempt from Chromium's
 *    mixed-content blocking on our HTTPS page. `http://<LAN-IP>` is **not**, and
 *    `isLoopbackBase()` below is what refuses it.
 *  - **CORS on every endpoint, `/stream` and `/thumb` included** — see §6.2 and
 *    `docs/resolver-protocol.md`. A plain `<video src>` on a progressive file
 *    would not need it, but `hls`/`dash` go through MSE, which does.
 */

/** §6.1 — the api revision this client speaks. */
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

export function isResolverErrorCode(value: unknown): value is ResolverErrorCode {
  return typeof value === 'string' && (RESOLVER_ERROR_CODES as readonly string[]).includes(value);
}

/** What a resolved stream actually is, which decides the adapter we mount. */
export type ResolverKind = 'progressive' | 'hls' | 'dash' | 'file';

export const RESOLVER_KINDS: readonly ResolverKind[] = ['progressive', 'hls', 'dash', 'file'];

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
  /** Unix seconds. `/stream/<opaque>` tokens are minted with a TTL (§6.3). */
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

/** §6.1 — `/resolve` query parameters, in their canonical spelling. */
export interface ResolveRequest {
  url: string;
  maxHeight: number;
  prefer?: 'progressive' | 'any';
  /** The LCD is always muted, so this is `0` unless the user opted audio in. */
  audio?: 0 | 1;
  token?: string;
}

/** §6.2 — the shared-token header. Part of the frozen contract from day one. */
export const RESOLVER_TOKEN_HEADER = 'X-Krakenhub-Token';

// ---------------------------------------------------------------------------
// Parsing — the client never trusts the companion's JSON
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function parseHealth(raw: unknown): ResolverHealth | null {
  if (!isRecord(raw) || raw['ok'] !== true) return null;
  const api = num(raw['api']);
  if (api === undefined) return null;
  const caps = raw['capabilities'];
  return {
    ok: true,
    name: str(raw['name']) ?? 'resolver',
    version: str(raw['version']) ?? '0.0.0',
    api,
    capabilities: Array.isArray(caps) ? caps.filter((c): c is string => typeof c === 'string') : [],
    maxHeight: num(raw['maxHeight']) ?? 0,
  };
}

/**
 * Anything that is not a recognisable `ok` or `pending` envelope becomes an
 * `internal` error rather than a thrown exception — a resolver miss must never
 * be able to take the display down (§6.4).
 */
export function parseEnvelope(raw: unknown): ResolverEnvelope {
  if (!isRecord(raw)) {
    return { status: 'error', code: 'internal', message: 'The resolver sent a non-object body.' };
  }

  if (raw['status'] === 'ok') {
    const streamUrl = str(raw['streamUrl']);
    const kind = raw['kind'];
    if (streamUrl === undefined || !RESOLVER_KINDS.includes(kind as ResolverKind)) {
      return {
        status: 'error',
        code: 'internal',
        message: 'The resolver answered ok without a usable streamUrl/kind.',
      };
    }
    const out: ResolverOk = {
      status: 'ok',
      kind: kind as ResolverKind,
      streamUrl,
      mime: str(raw['mime']) ?? 'video/mp4',
    };
    const width = num(raw['width']);
    const height = num(raw['height']);
    const fps = num(raw['fps']);
    const durationSec = num(raw['durationSec']);
    const title = str(raw['title']);
    const thumbUrl = str(raw['thumbUrl']);
    const expiresAt = num(raw['expiresAt']);
    if (width !== undefined) out.width = width;
    if (height !== undefined) out.height = height;
    if (fps !== undefined) out.fps = fps;
    if (durationSec !== undefined) out.durationSec = durationSec;
    if (title !== undefined) out.title = title;
    if (thumbUrl !== undefined) out.thumbUrl = thumbUrl;
    if (expiresAt !== undefined) out.expiresAt = expiresAt;
    return out;
  }

  if (raw['status'] === 'pending') {
    const jobId = str(raw['jobId']);
    if (jobId === undefined) {
      return { status: 'error', code: 'internal', message: 'A pending answer carried no jobId.' };
    }
    return {
      status: 'pending',
      jobId,
      retryAfterMs: num(raw['retryAfterMs']) ?? DEFAULT_RETRY_AFTER_MS,
    };
  }

  const code = raw['code'];
  const err: ResolverErr = {
    status: 'error',
    code: isResolverErrorCode(code) ? code : 'internal',
  };
  const message = str(raw['message']);
  const retryAfterMs = num(raw['retryAfterMs']);
  if (message !== undefined) err.message = message;
  if (retryAfterMs !== undefined) err.retryAfterMs = retryAfterMs;
  return err;
}

/** §6.1 — a `202` that forgot `retryAfterMs` still has to be polled at *some* rate. */
export const DEFAULT_RETRY_AFTER_MS = 1500;

// ---------------------------------------------------------------------------
// Loopback enforcement (§6, §6.3)
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * `http://127.0.0.1:8976` is fine; `http://192.168.1.20:8976` is not, and neither
 * is `https://resolver.example.com`.
 *
 * This is not a style rule. Loopback is the only http origin Chromium treats as
 * potentially trustworthy on an HTTPS page, so a non-loopback base is both a
 * mixed-content failure *and* an invitation to point the display at somebody
 * else's machine. The config UI rejects it, and so does the client.
 */
export function isLoopbackBase(base: string): boolean {
  try {
    const u = new URL(base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost');
  } catch {
    return false;
  }
}
