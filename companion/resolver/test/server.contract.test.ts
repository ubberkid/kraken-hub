import { statSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { CORS_HEADERS } from '../src/contract.js';
import { FIXTURE, SAMPLE_URL, settle, startHarness, type Harness } from './harness.js';

// The client's OWN parsers, imported across the workspace. Asserting that the
// server's bytes survive `parseEnvelope`/`parseHealth` is stronger than
// asserting on a shape this test invented: it is the actual code that will read
// them in the browser.
import {
  RESOLVER_API_VERSION,
  isResolverErrorCode,
  parseEnvelope,
  parseHealth,
} from '../../../src/modules/video/resolver/resolverTypes.js';

const FIXTURE_SIZE = statSync(FIXTURE).size;

let harness: Harness | null = null;

async function start(opts: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  harness = await startHarness(opts);
  return harness;
}

afterEach(async () => {
  await harness?.stop();
  harness = null;
});

/** §3 — every response, on every route, including the error ones. */
function expectCors(res: Response): void {
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    expect(res.headers.get(name), `${name} on ${res.url}`).toBe(value);
  }
}

describe('GET /health', () => {
  it('answers a body the app’s own parseHealth accepts', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/health`);

    expect(res.status).toBe(200);
    expectCors(res);

    const health = parseHealth(await res.json());
    expect(health).not.toBeNull();
    expect(health?.api).toBe(RESOLVER_API_VERSION);
    expect(health?.name).toBe('kraken-hub-resolver');
    expect(health?.capabilities).toContain('resolve');
    expect(health?.capabilities).toContain('stream');
    expect(health?.maxHeight).toBeGreaterThanOrEqual(1080);
  });
});

describe('OPTIONS preflight', () => {
  it('answers 204 with the full header set on every route', async () => {
    const { base } = await start();
    for (const path of ['/health', '/resolve', '/job/x', '/stream/abc.mp4', '/thumb/abc.jpg']) {
      const res = await fetch(`${base}${path}`, { method: 'OPTIONS' });
      expect(res.status, path).toBe(204);
      expectCors(res);
    }
  });

  it('is answered before the token check, because a preflight carries no header', async () => {
    const { base } = await start({ token: 'sekrit' });
    const res = await fetch(`${base}/resolve`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expectCors(res);
  });
});

describe('the 202 → /job → ok lifecycle', () => {
  it('never blocks the request, and settles into an ok envelope', async () => {
    const { base } = await start({ delayMs: 120, retryAfterMs: 250 });

    const first = await fetch(
      `${base}/resolve?url=${encodeURIComponent(SAMPLE_URL)}&maxHeight=1080`,
    );
    expect(first.status).toBe(202);
    expectCors(first);

    const pending = parseEnvelope(await first.json());
    expect(pending.status).toBe('pending');
    if (pending.status !== 'pending') throw new Error('unreachable');
    expect(pending.jobId).toMatch(/^[0-9a-f]{32}$/);
    expect(pending.retryAfterMs).toBe(250);

    // Polling the job while it is still working keeps answering 202.
    const again = await fetch(`${base}/job/${pending.jobId}`);
    expect([200, 202]).toContain(again.status);
    expectCors(again);

    const settled = await settle(base, `url=${encodeURIComponent(SAMPLE_URL)}&maxHeight=1080`);
    expect(settled.status).toBe(200);

    const ok = parseEnvelope(settled.body);
    expect(ok.status).toBe('ok');
    if (ok.status !== 'ok') throw new Error('unreachable');
    expect(ok.kind).toBe('progressive');
    expect(ok.mime).toBe('video/mp4');
    expect(ok.streamUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/stream\/[0-9a-f]{32}\.mp4$/);
    expect(ok.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(ok.title).toBe('stub-clip.mp4');
  });

  it('answers a second identical resolve straight from cache, with 200 and no job', async () => {
    const { base } = await start();
    const query = `url=${encodeURIComponent(SAMPLE_URL)}&maxHeight=1080`;
    await settle(base, query);

    const res = await fetch(`${base}/resolve?${query}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('ok');
  });

  it('404s an unknown job id with a closed-enum code', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/job/nope`);
    expect(res.status).toBe(404);
    expectCors(res);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('not-found');
    expect(isResolverErrorCode(body.code)).toBe(true);
  });

  it('runs at most two extractors at once', async () => {
    const { base, app } = await start({ delayMs: 200, concurrency: 2 });
    await Promise.all(
      ['a', 'b', 'c', 'd'].map((slug) =>
        fetch(`${base}/resolve?url=${encodeURIComponent(`https://example.com/${slug}`)}`),
      ),
    );
    expect(app.service.inFlight).toBeLessThanOrEqual(2);
    expect(app.service.pending).toBeGreaterThan(0);
  });
});

describe('GET /stream/<opaque>', () => {
  async function resolved(base: string): Promise<string> {
    const settled = await settle(base, `url=${encodeURIComponent(SAMPLE_URL)}&maxHeight=1080`);
    return String(settled.body['streamUrl']);
  }

  it('serves the whole file with 200 and the CORS header set', async () => {
    const { base } = await start();
    const res = await fetch(await resolved(base));

    expect(res.status).toBe(200);
    expectCors(res);
    expect(res.headers.get('Content-Type')).toBe('video/mp4');
    expect(Number(res.headers.get('Content-Length'))).toBe(FIXTURE_SIZE);
    expect((await res.arrayBuffer()).byteLength).toBe(FIXTURE_SIZE);
  });

  it('answers a Range request with 206 and the exact bytes', async () => {
    const { base } = await start();
    const url = await resolved(base);

    const res = await fetch(url, { headers: { Range: 'bytes=10-19' } });
    expect(res.status).toBe(206);
    expectCors(res);
    expect(res.headers.get('Content-Range')).toBe(`bytes 10-19/${String(FIXTURE_SIZE)}`);
    expect(res.headers.get('Content-Length')).toBe('10');
    expect((await res.arrayBuffer()).byteLength).toBe(10);
  });

  it('supports an open-ended range and a suffix range', async () => {
    const { base } = await start();
    const url = await resolved(base);

    const open = await fetch(url, { headers: { Range: 'bytes=100-' } });
    expect(open.status).toBe(206);
    expect(open.headers.get('Content-Range')).toBe(
      `bytes 100-${String(FIXTURE_SIZE - 1)}/${String(FIXTURE_SIZE)}`,
    );

    const suffix = await fetch(url, { headers: { Range: 'bytes=-64' } });
    expect(suffix.status).toBe(206);
    expect((await suffix.arrayBuffer()).byteLength).toBe(64);
  });

  it('416s an unsatisfiable range rather than lying with a 206', async () => {
    const { base } = await start();
    const res = await fetch(await resolved(base), {
      headers: { Range: `bytes=${String(FIXTURE_SIZE + 10)}-` },
    });
    expect(res.status).toBe(416);
    expectCors(res);
    expect(res.headers.get('Content-Range')).toBe(`bytes */${String(FIXTURE_SIZE)}`);
  });

  it('serves ONLY ids it minted — it is not a proxy', async () => {
    const { base } = await start();
    for (const path of [
      '/stream/deadbeefdeadbeefdeadbeefdeadbeef.mp4',
      '/stream/..%2F..%2Fetc%2Fpasswd',
      '/stream/index.json',
      `/stream/${encodeURIComponent('https://example.com/x.mp4')}`,
    ]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(404);
      expectCors(res);
      expect(((await res.json()) as { code: string }).code).toBe('not-found');
    }
  });

  it('404s a thumbnail this companion never produced, with CORS intact', async () => {
    const { base } = await start();
    const id = new URL(await resolved(base)).pathname.slice('/stream/'.length).replace('.mp4', '');
    const res = await fetch(`${base}/thumb/${id}.jpg`);
    expect(res.status).toBe(404);
    expectCors(res);
    expect(((await res.json()) as { code: string }).code).toBe('not-found');
  });
});

describe('cache eviction, seen from the wire', () => {
  it('expires the oldest clip’s stream id once the ceiling is crossed', async () => {
    // Room for one copy of the fixture and no more.
    const { base } = await start({ maxBytes: FIXTURE_SIZE + 1 });

    const first = await settle(base, `url=${encodeURIComponent('https://example.com/one')}`);
    const firstStream = String(first.body['streamUrl']);
    expect((await fetch(firstStream)).status).toBe(200);

    const second = await settle(base, `url=${encodeURIComponent('https://example.com/two')}`);
    const secondStream = String(second.body['streamUrl']);

    // The newest clip plays; the evicted one is gone, and says so in the
    // contract's own vocabulary rather than with a 500.
    expect((await fetch(secondStream)).status).toBe(200);
    const evicted = await fetch(firstStream);
    expect(evicted.status).toBe(404);
    expectCors(evicted);
    expect(((await evicted.json()) as { code: string }).code).toBe('not-found');
  });

  it('re-resolves a clip that was evicted instead of failing', async () => {
    const { base } = await start({ maxBytes: FIXTURE_SIZE + 1 });
    const query = `url=${encodeURIComponent('https://example.com/one')}`;
    const first = await settle(base, query);
    await settle(base, `url=${encodeURIComponent('https://example.com/two')}`);

    const again = await settle(base, query);
    expect(again.status).toBe(200);
    expect(again.body['streamUrl']).not.toBe(first.body['streamUrl']);
    expect((await fetch(String(again.body['streamUrl']))).status).toBe(200);
  });
});

describe('a TTL that has passed', () => {
  it('stops serving the stream id it minted', async () => {
    let clock = Date.now();
    const { base } = await start({ ttlMs: 1000, now: () => clock });
    const settled = await settle(base, `url=${encodeURIComponent(SAMPLE_URL)}`);
    const streamUrl = String(settled.body['streamUrl']);
    expect((await fetch(streamUrl)).status).toBe(200);

    clock += 2000;
    const res = await fetch(streamUrl);
    expect(res.status).toBe(404);
    expectCors(res);
  });
});

describe('URL policy (§5)', () => {
  const cases: [string, number, string][] = [
    ['file:///etc/passwd', 403, 'forbidden'],
    ['data:video/mp4;base64,AAAA', 403, 'forbidden'],
    ['blob:https://example.com/abc', 403, 'forbidden'],
    ['javascript:alert(1)', 403, 'forbidden'],
    ['ftp://example.com/x.mp4', 403, 'forbidden'],
    ['https://127.0.0.1:8976/health', 403, 'forbidden'],
    ['https://localhost/x', 403, 'forbidden'],
    ['https://192.168.1.20/cam', 403, 'forbidden'],
    ['https://10.0.0.5/x', 403, 'forbidden'],
    ['https://172.16.4.4/x', 403, 'forbidden'],
    ['https://169.254.169.254/latest/meta-data', 403, 'forbidden'],
    ['https://nas.local/movie', 403, 'forbidden'],
    ['http://example.com/video', 400, 'unsupported-url'],
    ['not a url at all', 400, 'unsupported-url'],
    ['https://example.com/setup.exe', 400, 'unsupported-url'],
    ['https://example.com/archive.zip', 400, 'unsupported-url'],
  ];

  it.each(cases)('refuses %s with %i %s', async (url, status, code) => {
    const { base } = await start();
    const res = await fetch(`${base}/resolve?url=${encodeURIComponent(url)}`);
    expect(res.status).toBe(status);
    expectCors(res);
    const body = (await res.json()) as { status: string; code: string };
    expect(body.status).toBe('error');
    expect(body.code).toBe(code);
    expect(isResolverErrorCode(body.code)).toBe(true);
  });

  it('refuses a missing url parameter', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/resolve`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('unsupported-url');
  });
});

describe('rate limiting (§5 — about 10 resolves a minute)', () => {
  it('answers 429 rate-limited with a retryAfterMs the client can obey', async () => {
    const { base } = await start({ rateLimit: { max: 3, windowMs: 60_000 }, delayMs: 50 });

    for (let i = 0; i < 3; i += 1) {
      const res = await fetch(`${base}/resolve?url=https%3A%2F%2Fexample.com%2F${String(i)}`);
      expect(res.status).toBe(202);
    }

    const res = await fetch(`${base}/resolve?url=https%3A%2F%2Fexample.com%2Fover`);
    expect(res.status).toBe(429);
    expectCors(res);
    const body = parseEnvelope(await res.json());
    expect(body.status).toBe('error');
    if (body.status !== 'error') throw new Error('unreachable');
    expect(body.code).toBe('rate-limited');
    expect(body.retryAfterMs).toBeGreaterThan(0);
  });
});

describe('the optional shared token (§5)', () => {
  it('401s with the forbidden code when it is configured and missing', async () => {
    const { base } = await start({ token: 'sekrit' });
    for (const path of ['/health', '/resolve?url=https%3A%2F%2Fexample.com%2Fa', '/job/x']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(401);
      expectCors(res);
      expect(((await res.json()) as { code: string }).code).toBe('forbidden');
    }
  });

  it('401s a wrong token, of any length', async () => {
    const { base } = await start({ token: 'sekrit' });
    for (const bad of ['nope', 'sekri7', 'sekritsekrit']) {
      const res = await fetch(`${base}/health?token=${bad}`);
      expect(res.status, bad).toBe(401);
    }
  });

  it('accepts it as a header or as a query parameter', async () => {
    const { base } = await start({ token: 'sekrit' });

    const viaHeader = await fetch(`${base}/health`, { headers: { 'X-Krakenhub-Token': 'sekrit' } });
    expect(viaHeader.status).toBe(200);

    const viaQuery = await fetch(`${base}/health?token=sekrit`);
    expect(viaQuery.status).toBe(200);
  });

  it('mints a streamUrl that already carries the token, so the app can fetch it', async () => {
    const { base } = await start({ token: 'sekrit' });
    const settled = await settle(base, `url=${encodeURIComponent(SAMPLE_URL)}&token=sekrit`);
    const streamUrl = String(settled.body['streamUrl']);
    expect(streamUrl).toContain('token=sekrit');

    // …and the same URL, verbatim, plays. Without the token it is a 401.
    const res = await fetch(streamUrl);
    expect(res.status).toBe(200);
    const bare = await fetch(streamUrl.split('?')[0] ?? '');
    expect(bare.status).toBe(401);
  });
});

describe('unknown routes and methods', () => {
  it('404s an unknown path with CORS and a closed-enum code', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/anything`);
    expect(res.status).toBe(404);
    expectCors(res);
    expect(((await res.json()) as { code: string }).code).toBe('not-found');
  });

  it('405s a POST rather than treating it as a GET', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/resolve`, { method: 'POST' });
    expect(res.status).toBe(405);
    expectCors(res);
  });
});
