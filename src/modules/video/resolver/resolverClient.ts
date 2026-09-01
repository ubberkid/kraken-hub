/**
 * The browser half of the resolver protocol (design-videoEngine.md §6.4).
 *
 * The companion is **always optional**. Every function here is written so that a
 * failure — no companion, a timeout, a non-`ok` envelope, a firewall — is a
 * silent downgrade to whatever the app would have done without it, plus one
 * telemetry line. §6.4: *"Users never see a hard error for a resolver miss."*
 *
 * Three details are easy to get wrong and are therefore centralised here:
 *
 *  - **Health is memoized twice.** In memory for the life of the document, and
 *    in `sessionStorage` so the *other* CAM window (and a reload) does not pay
 *    the 1.2 s probe again. Re-checked every 60 s and on every fatal primary
 *    error.
 *  - **`202` is normal, not an error.** A companion that is still downloading
 *    answers `202 { jobId, retryAfterMs }`; we poll `/job/<id>` at the rate it
 *    asked for, capped at 60 s total.
 *  - **Loopback only.** `isLoopbackBase()` gates every request. A non-loopback
 *    base is refused before a byte leaves the page (§6.3).
 */

import { createLogger } from '../../../lib/log';
import { readSessionRaw, writeSessionRaw } from '../../../platform/storage';
import { publish } from '../telemetry/videoTelemetry';

import { probeLoopback } from './loopbackProbe';
import {
  DEFAULT_RETRY_AFTER_MS,
  RESOLVER_API_VERSION,
  RESOLVER_TOKEN_HEADER,
  isLoopbackBase,
  parseEnvelope,
  parseHealth,
  type ResolveRequest,
  type ResolverEnvelope,
  type ResolverHealth,
} from './resolverTypes';

import type { ResolverConfig } from '../types';

const log = createLogger('video/resolver');

/** §6.4 — the health probe must not stall a mount. */
export const HEALTH_TIMEOUT_MS = 1200;
/** §6.4 — memoization window. */
export const HEALTH_TTL_MS = 60_000;
export const RESOLVE_TIMEOUT_MS = 15_000;
/** §6.4 — the whole 202 → /job polling loop, end to end. */
export const JOB_POLL_BUDGET_MS = 60_000;
const JOB_POLL_MIN_MS = 250;
const JOB_POLL_MAX_MS = 5000;

export const HEALTH_SESSION_SUFFIX = 'video:resolver:health';

/**
 * The base URL. `127.0.0.1` is spelled out rather than derived because it is not
 * an *origin of ours* — it is the fixed loopback address the contract names, and
 * invariant I4's origin rule exempts it for exactly that reason.
 */
export function resolverBase(port: number): string {
  return `http://127.0.0.1:${String(port)}`;
}

// ---------------------------------------------------------------------------
// maxHeight (§6.4)
// ---------------------------------------------------------------------------

const MAX_HEIGHT_HEADROOM = 1.25;
const MAX_HEIGHT_MIN = 480;
const MAX_HEIGHT_MAX = 2160;
/** The heights a companion can realistically deliver; requests snap UP onto it. */
const RUNG = { p480: 480, p720: 720, p1080: 1080, p1440: 1440, p2160: 2160 } as const;
const HEIGHT_LADDER: readonly number[] = [RUNG.p480, RUNG.p720, RUNG.p1080, RUNG.p1440, RUNG.p2160];

/**
 * §6.4, verbatim:
 * `maxHeight = clamp(ceil(max(displayW,displayH) * dpr * zoom * 1.25), 480, 2160)`
 * then snapped up onto the delivery ladder — so a 640 panel at DPR 1 and zoom 1
 * computes 800 and asks for **1080**, and never for 2160.
 */
export function deriveMaxHeight(args: {
  displayW: number;
  displayH: number;
  dpr: number;
  zoom: number;
}): number {
  const raw = Math.ceil(
    Math.max(args.displayW, args.displayH) * args.dpr * args.zoom * MAX_HEIGHT_HEADROOM,
  );
  const clamped = Math.min(MAX_HEIGHT_MAX, Math.max(MAX_HEIGHT_MIN, raw));
  return HEIGHT_LADDER.find((h) => h >= clamped) ?? MAX_HEIGHT_MAX;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface HealthState {
  healthy: boolean;
  checkedAt: number;
  base: string;
  health: ResolverHealth | null;
  /** Why it is not healthy, for the config card. Empty when it is. */
  reason: string;
}

let cached: HealthState | null = null;

function readSessionHealth(base: string): HealthState | null {
  const raw = readSessionRaw(HEALTH_SESSION_SUFFIX);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as HealthState;
    return parsed.base === base ? parsed : null;
  } catch {
    return null;
  }
}

function writeSessionHealth(state: HealthState): void {
  writeSessionRaw(HEALTH_SESSION_SUFFIX, JSON.stringify(state));
}

/** Drops both memo layers — used after a fatal primary error, and by tests. */
export function invalidateHealth(): void {
  cached = null;
  writeSessionRaw(HEALTH_SESSION_SUFFIX, '');
}

export interface ResolverClientOptions {
  /** Injected in tests; defaults to the global. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * §6.2 — the optional shared token travels as a header AND as `?token=`, because
 * the frozen contract allows either and a companion may only read one of them.
 * Returns an empty object rather than `undefined` so the spread below stays a
 * plain object literal.
 */
function headers(cfg: ResolverConfig): Record<string, string> {
  return cfg.token === '' ? {} : { [RESOLVER_TOKEN_HEADER]: cfg.token };
}

function withToken(url: URL, cfg: ResolverConfig): URL {
  if (cfg.token !== '') url.searchParams.set('token', cfg.token);
  return url;
}

/**
 * `/health`, memoized for 60 s in memory and in `sessionStorage`.
 *
 * Never throws. A companion that is not running is the *expected* case, and it
 * must cost one aborted fetch and nothing else.
 */
export async function checkHealth(
  cfg: ResolverConfig,
  opts: ResolverClientOptions = {},
): Promise<HealthState> {
  const now = opts.now ?? Date.now;
  const base = resolverBase(cfg.port);

  if (!isLoopbackBase(base)) {
    return {
      healthy: false,
      checkedAt: now(),
      base,
      health: null,
      reason:
        'The resolver address must be on 127.0.0.1 — a LAN address is blocked as mixed content.',
    };
  }

  const fresh = (state: HealthState | null): state is HealthState =>
    state !== null && state.base === base && now() - state.checkedAt < HEALTH_TTL_MS;

  if (fresh(cached)) return cached;
  const session = readSessionHealth(base);
  if (fresh(session)) {
    cached = session;
    return session;
  }

  /*
   * The probe runs OFF the main thread when it can — round 7's minors.
   *
   * Not running is the normal case, and the renderer logs every failed
   * subresource load as an error before our `catch` ever sees the rejection. So
   * a user with no companion — nearly all of them — collected a red
   * `net::ERR_CONNECTION_REFUSED` in their console for a feature behaving
   * exactly as §6.4 specifies. `loopbackProbe` asks the same question from a
   * dedicated worker, whose failures do not reach the page console; a caller
   * that injects `fetchImpl` (every unit test) and any environment without
   * workers still take the direct path.
   */
  const injected = opts.fetchImpl;
  let state: HealthState;
  try {
    let res: { ok: boolean; status: number; body: unknown };
    if (injected === undefined) {
      const probe = await probeLoopback(`${base}/health`, {
        headers: headers(cfg),
        timeoutMs: HEALTH_TIMEOUT_MS,
      });
      // `null` is "nothing answered", which is the `catch` below's case reached
      // without an exception. One shape, two routes.
      if (probe === null) throw new Error('no answer');
      res = { ok: probe.ok, status: probe.status, body: probe.ok ? JSON.parse(probe.body) : null };
    } else {
      const got = await injected(`${base}/health`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        headers: headers(cfg),
      });
      res = { ok: got.ok, status: got.status, body: got.ok ? await got.json() : null };
    }
    const health = res.ok ? parseHealth(res.body) : null;
    if (health === null) {
      state = {
        healthy: false,
        checkedAt: now(),
        base,
        health: null,
        reason: `The companion answered ${String(res.status)} but not a v1 /health body.`,
      };
    } else if (health.api !== RESOLVER_API_VERSION) {
      state = {
        healthy: false,
        checkedAt: now(),
        base,
        health,
        reason: `The companion speaks api ${String(health.api)}; this build speaks ${String(RESOLVER_API_VERSION)}.`,
      };
    } else {
      state = { healthy: true, checkedAt: now(), base, health, reason: '' };
    }
  } catch {
    // Not running is the normal case, so this is `debug`, not `warn`.
    log.debug('no resolver companion on', base);
    state = {
      healthy: false,
      checkedAt: now(),
      base,
      health: null,
      reason: 'No companion answered on 127.0.0.1.',
    };
  }

  cached = state;
  writeSessionHealth(state);
  return state;
}

/** The last known state without probing — for a config card's first paint. */
export function peekHealth(cfg: ResolverConfig): HealthState | null {
  const base = resolverBase(cfg.port);
  if (cached !== null && cached.base === base) return cached;
  return readSessionHealth(base);
}

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

export interface ResolveOptions extends ResolverClientOptions {
  maxHeight: number;
  audio?: boolean;
  prefer?: ResolveRequest['prefer'];
  signal?: AbortSignal;
}

function clampPoll(ms: number): number {
  return Math.min(JOB_POLL_MAX_MS, Math.max(JOB_POLL_MIN_MS, ms));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function getEnvelope(
  url: URL,
  cfg: ResolverConfig,
  opts: ResolveOptions,
): Promise<ResolverEnvelope> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const timeout = AbortSignal.timeout(RESOLVE_TIMEOUT_MS);
  const signal = opts.signal === undefined ? timeout : AbortSignal.any([timeout, opts.signal]);
  try {
    const res = await doFetch(url.toString(), {
      signal,
      headers: headers(cfg),
    });
    const body: unknown = await res.json().catch(() => null);
    if (body === null) {
      return {
        status: 'error',
        code: res.status === HTTP_TOO_MANY ? 'rate-limited' : 'internal',
        message: `The resolver answered ${String(res.status)} with no JSON body.`,
      };
    }
    return parseEnvelope(body);
  } catch (err) {
    return {
      status: 'error',
      code: 'internal',
      message: err instanceof Error ? err.message : 'The resolver did not answer.',
    };
  }
}

const HTTP_TOO_MANY = 429;

/**
 * `/resolve`, following a `202` through `/job/<id>` until it settles or the 60 s
 * budget runs out.
 *
 * Returns the envelope rather than throwing, because *every* caller's reaction
 * to a non-`ok` answer is the same silent downgrade.
 */
export async function resolve(
  rawUrl: string,
  cfg: ResolverConfig,
  opts: ResolveOptions,
): Promise<ResolverEnvelope> {
  const now = opts.now ?? Date.now;
  const base = resolverBase(cfg.port);
  if (!isLoopbackBase(base)) {
    return {
      status: 'error',
      code: 'forbidden',
      message: 'The resolver address must be loopback (127.0.0.1).',
    };
  }

  const url = withToken(new URL(`${base}/resolve`), cfg);
  url.searchParams.set('url', rawUrl);
  url.searchParams.set('maxHeight', String(opts.maxHeight));
  url.searchParams.set('prefer', opts.prefer ?? 'progressive');
  url.searchParams.set('audio', opts.audio === true ? '1' : '0');

  let envelope = await getEnvelope(url, cfg, opts);
  const deadline = now() + JOB_POLL_BUDGET_MS;

  while (envelope.status === 'pending') {
    if (now() >= deadline || (opts.signal?.aborted ?? false)) {
      return {
        status: 'error',
        code: 'upstream-failed',
        message: 'The resolver was still downloading after 60 s.',
      };
    }
    await sleep(clampPoll(envelope.retryAfterMs || DEFAULT_RETRY_AFTER_MS), opts.signal);
    if (opts.signal?.aborted ?? false) {
      return { status: 'error', code: 'internal', message: 'Cancelled.' };
    }
    const jobUrl = withToken(new URL(`${base}/job/${encodeURIComponent(envelope.jobId)}`), cfg);
    envelope = await getEnvelope(jobUrl, cfg, opts);
  }

  return envelope;
}

/**
 * §1.4 — the one line every caller actually wants: resolve, or tell me it did
 * not work and why, having already emitted `resolver-fallback` telemetry.
 */
export async function resolveOrFallback(
  rawUrl: string,
  cfg: ResolverConfig,
  opts: ResolveOptions,
): Promise<ResolverEnvelope> {
  const envelope = await resolve(rawUrl, cfg, opts);
  if (envelope.status !== 'ok') {
    publish(
      {
        code: 'resolver-fallback',
        severity: 'warn',
        provider: 'resolver',
        message:
          envelope.status === 'error'
            ? `${envelope.code}: ${envelope.message ?? ''}`
            : 'still pending',
      },
      { url: rawUrl },
    );
  }
  return envelope;
}
