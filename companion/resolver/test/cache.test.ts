import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ClipCache, OPAQUE_ID_RE, type CacheEntry } from '../src/cache.js';

let dir = '';
let clock = 1_700_000_000_000;
const now = (): number => clock;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kh-cache-'));
  clock = 1_700_000_000_000;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function makeCache(maxBytes = 1000, ttlMs = 60_000): Promise<ClipCache> {
  const cache = new ClipCache({ dir, maxBytes, ttlMs, now });
  await cache.init();
  return cache;
}

async function addClip(cache: ClipCache, bytes: number, atime = clock): Promise<CacheEntry> {
  const id = cache.mintId();
  const file = cache.pathFor(id);
  await writeFile(file, Buffer.alloc(bytes));
  const entry: CacheEntry = {
    id,
    key: `key-${id}`,
    file,
    mime: 'video/mp4',
    bytes,
    createdAt: clock,
    atime,
    expiresAt: cache.expiryFromNow(),
    kind: 'progressive',
  };
  await cache.add(entry);
  return entry;
}

describe('opaque ids', () => {
  it('are 16 random bytes, and never repeat', async () => {
    const cache = await makeCache();
    const ids = new Set(Array.from({ length: 500 }, () => cache.mintId()));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(OPAQUE_ID_RE);
  });
});

describe('lookup', () => {
  it('finds a live entry by its resolve key and by its id', async () => {
    const cache = await makeCache();
    const entry = await addClip(cache, 100);

    expect(cache.get(entry.id)?.id).toBe(entry.id);
    expect(cache.findByKey(entry.key)?.id).toBe(entry.id);
    expect(cache.get('deadbeefdeadbeefdeadbeefdeadbeef')).toBeNull();
  });

  it('stops serving an entry the moment its TTL passes', async () => {
    const cache = await makeCache(1000, 5_000);
    const entry = await addClip(cache, 100);
    expect(cache.get(entry.id)).not.toBeNull();

    clock += 6_000;
    expect(cache.get(entry.id)).toBeNull();
    expect(cache.findByKey(entry.key)).toBeNull();
  });
});

describe('eviction', () => {
  it('evicts by atime, so the clip being looped outlives the newer one', async () => {
    const cache = await makeCache(250);

    const old = await addClip(cache, 100, clock - 10_000);
    const looping = await addClip(cache, 100, clock - 1_000);
    // Adding this pushes the total to 300 over a 250-byte ceiling.
    const fresh = await addClip(cache, 100, clock);

    expect(cache.get(old.id)).toBeNull();
    expect(cache.get(looping.id)).not.toBeNull();
    expect(cache.get(fresh.id)).not.toBeNull();
    expect(cache.totalBytes()).toBeLessThanOrEqual(250);
  });

  it('deletes the evicted file from disk, not just the record', async () => {
    const cache = await makeCache(150);
    const first = await addClip(cache, 100, clock - 10_000);
    await addClip(cache, 100, clock);

    expect(cache.get(first.id)).toBeNull();
    await expect(stat(first.file)).rejects.toThrow();
  });

  it('a touch is what saves a clip from the next eviction', async () => {
    const cache = await makeCache(250);
    const a = await addClip(cache, 100, clock - 10_000);
    await addClip(cache, 100, clock - 5_000);

    clock += 1;
    cache.touch(a.id);
    await addClip(cache, 100, clock);

    expect(cache.get(a.id), 'the touched clip survived').not.toBeNull();
  });

  it('drops expired entries before it starts on size', async () => {
    const cache = await makeCache(10_000, 5_000);
    const entry = await addClip(cache, 100);
    clock += 6_000;

    const dropped = await cache.evict();
    expect(dropped).toContain(entry.id);
    expect(cache.totalBytes()).toBe(0);
  });
});

describe('the index', () => {
  it('survives a restart, and forgets clips whose files are gone', async () => {
    const first = await makeCache();
    const kept = await addClip(first, 100);
    const deleted = await addClip(first, 100);
    await first.flush();
    await rm(deleted.file);

    const second = await makeCache();
    expect(second.get(kept.id)?.id).toBe(kept.id);
    expect(second.get(deleted.id)).toBeNull();
  });

  it('treats a corrupt index as a cold cache rather than crashing', async () => {
    await writeFile(join(dir, 'index.json'), '{not json');
    const cache = await makeCache();
    expect(cache.list()).toEqual([]);
  });

  it('never leaves a temp file behind', async () => {
    const cache = await makeCache();
    await addClip(cache, 100);
    await cache.flush();
    const names = await readdir(dir);
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});
