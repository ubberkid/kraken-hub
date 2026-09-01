/**
 * A health probe that does not shout into the user's console.
 *
 * ## The noise, and why catching it never helped
 *
 * `checkHealth` has always been careful: `AbortSignal.timeout`, a `try/catch`,
 * a `log.debug` that says "not running is the normal case". None of that is
 * visible to the thing doing the complaining. **Chrome logs a failed subresource
 * load from the renderer itself** — `Failed to load resource:
 * net::ERR_CONNECTION_REFUSED` — before the promise ever rejects, so no
 * `catch`, no `onLine` check and no amount of politeness in our own logging
 * removes it. The overwhelming majority of users never run the companion, and
 * every one of them got a red line in DevTools for a component that is working
 * exactly as designed (§6.4: a resolver miss is a silent downgrade).
 *
 * ## The fix, measured
 *
 * A failed `fetch` inside a **dedicated worker** is reported to the worker's own
 * context and does not reach the page console. Same request, same loopback
 * address, same timeout — a different console. Measured both ways against a
 * closed port before it was written down, because the whole point is that the
 * difference is observable.
 *
 * Deliberately not a service worker (that is a scope, a lifecycle and a cache
 * this app has no use for) and deliberately not a build-time worker entry point
 * (a separate chunk on a path that is already lazy). One blob, made once, reused
 * for every probe, torn down with the page.
 *
 * ## What it does NOT cover
 *
 * `/resolve` and `/stream` still go through the ordinary `fetch`: they run only
 * *after* health has answered, so a connection error there is a companion that
 * died mid-job — a real event, worth a real line in the console. Silence is for
 * the question we ask speculatively, not for the answer we were promised.
 */

/** What a probe learned. `null` is "nothing answered", which is the normal case. */
export interface ProbeResult {
  ok: boolean;
  status: number;
  /** The response body as text, for the caller to parse. Empty on a non-2xx. */
  body: string;
}

/**
 * The worker, as source.
 *
 * Kept as a string rather than a file so it ships inside the resolver chunk
 * that already had to be loaded to ask the question — a second network fetch to
 * find out whether a local program is running would be its own small joke.
 */
const WORKER_SOURCE = `
self.onmessage = async (e) => {
  const { id, url, headers, timeoutMs } = e.data;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers,
    });
    const body = res.ok ? await res.text() : '';
    self.postMessage({ id, ok: res.ok, status: res.status, body });
  } catch {
    self.postMessage({ id, failed: true });
  }
};
`;

let worker: Worker | null = null;
let workerUnavailable = false;
let nextId = 0;

/**
 * `null` when this environment has no worker to probe from.
 *
 * jsdom and any hardened embed fall through to the caller's own `fetch`, which
 * is noisier but correct — a probe that refuses to run because it cannot be
 * quiet would trade a console line for a broken feature.
 */
function ensureWorker(): Worker | null {
  if (worker !== null) return worker;
  if (workerUnavailable) return null;
  try {
    const blob = new Blob([WORKER_SOURCE], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    worker = new Worker(url);
    // The blob is captured by the worker at construction; the URL handle is not
    // needed again and holding it would leak one object per page.
    URL.revokeObjectURL(url);
    return worker;
  } catch {
    workerUnavailable = true;
    return null;
  }
}

/** True when a quiet probe is actually available, so callers can say why. */
export function canProbeQuietly(): boolean {
  return ensureWorker() !== null;
}

/**
 * GET `url`, off the main thread, and resolve to `null` on any failure.
 *
 * Never rejects — a companion that is not running is the expected answer, and a
 * probe that throws would put the noise back in a different shape.
 */
export async function probeLoopback(
  url: string,
  opts: { headers: Record<string, string>; timeoutMs: number },
): Promise<ProbeResult | null> {
  const w = ensureWorker();
  if (w === null) return null;
  const id = ++nextId;
  return new Promise<ProbeResult | null>((resolve) => {
    const done = (value: ProbeResult | null): void => {
      w.removeEventListener('message', onMessage);
      clearTimeout(guard);
      resolve(value);
    };
    const onMessage = (e: MessageEvent): void => {
      const data = e.data as { id?: number; ok?: boolean; status?: number; body?: string };
      if (data.id !== id) return;
      done(
        data.ok === undefined
          ? null
          : { ok: data.ok, status: data.status ?? 0, body: data.body ?? '' },
      );
    };
    /*
     * A guard on top of the worker's own `AbortSignal.timeout`.
     *
     * The signal lives inside the worker; if the worker itself never answers —
     * killed by the browser under memory pressure, or wedged — the caller would
     * await forever. This is the outer bound, and it is deliberately longer than
     * the inner one so the inner timeout is what normally fires.
     */
    const guard = setTimeout(() => {
      done(null);
    }, opts.timeoutMs * 2);
    w.addEventListener('message', onMessage);
    w.postMessage({ id, url, headers: opts.headers, timeoutMs: opts.timeoutMs });
  });
}
