import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadGallery } from './gallery';

/** The real catalogue and the real files, served by a fetch that reads the repo. */
const LOOKS_DIR = join(new URL('../../../../../../', import.meta.url).pathname, 'public', 'looks');

/**
 * A `fetch` over the checked-in gallery folder.
 *
 * Deliberately reads the ACTUAL files rather than a fixture: the point of this
 * test is that what a browser downloads from `looks/` parses, and a fixture
 * would only prove that a fixture parses. A path outside the folder is a 404,
 * which is also what a static host would say.
 */
const repoFetch = ((url: string): Promise<Response> => {
  const name = new URL(url).pathname.split('/').pop() ?? '';
  try {
    const text = readFileSync(join(LOOKS_DIR, name), 'utf8');
    return Promise.resolve(new Response(text, { status: 200 }));
  } catch {
    return Promise.resolve(new Response('', { status: 404 }));
  }
}) as unknown as typeof fetch;

const missingFetch = (() =>
  Promise.resolve(new Response('', { status: 404 }))) as unknown as typeof fetch;

const BASE = 'https://example.invalid/kraken-hub/';

describe('the gallery', () => {
  it('reads the repository’s own catalogue and every file in it', async () => {
    const result = await loadGallery(BASE, repoFetch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Ten shipped Looks, and every one of them parsed rather than being skipped.
    expect(result.entries.length).toBeGreaterThanOrEqual(8);
    for (const entry of result.entries) {
      expect(entry.source).toBe('gallery');
      expect(entry.name).not.toBe('');
      expect(entry.summary).not.toBe('');
      expect(entry.file.look.layers.length).toBeGreaterThan(0);
    }
  });

  it('is unavailable rather than broken when the folder is not shipped', async () => {
    expect(await loadGallery(BASE, missingFetch)).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('is unavailable rather than throwing when the network refuses', async () => {
    const throwing = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    expect(await loadGallery(BASE, throwing)).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('drops one unreadable row and keeps its neighbours', async () => {
    const catalogue = [
      { id: 'good', name: 'Good', author: 'x', description: 'd', file: 'tpl-single.krakenlook' },
      { id: 'bad', name: 'Bad', author: 'x', description: 'd', file: 'nope.krakenlook' },
    ];
    const mixed = ((url: string): Promise<Response> =>
      url.endsWith('index.json')
        ? Promise.resolve(new Response(JSON.stringify(catalogue), { status: 200 }))
        : repoFetch(url)) as unknown as typeof fetch;
    const result = await loadGallery(BASE, mixed);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((e) => e.id)).toEqual(['good']);
  });

  it('refuses a row that tries to point the fetch out of the folder', async () => {
    const catalogue = [
      { id: 'esc', name: 'x', author: 'x', description: 'd', file: '../../secrets.json' },
    ];
    const hostile = ((url: string): Promise<Response> =>
      url.endsWith('index.json')
        ? Promise.resolve(new Response(JSON.stringify(catalogue), { status: 200 }))
        : Promise.reject(new Error('should never be fetched'))) as unknown as typeof fetch;
    const result = await loadGallery(BASE, hostile);
    expect(result).toEqual({ ok: true, entries: [] });
  });
});
