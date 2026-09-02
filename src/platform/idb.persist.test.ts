import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensurePersisted, isPersisted, requestPersistentStorage } from './idb';

/**
 * Persistence as a QUESTION asked every time, not a flag written down once.
 *
 * The old shape cached the grant in the app's own key/value store and
 * short-circuited on it forever. The bug that hides in that is invisible in
 * ordinary use and total when it bites: site data is cleared, or a profile is
 * copied, and the flag still says `true` — so the shelf goes on promising a
 * durability the browser has revoked, and nothing ever asks for it back.
 *
 * These are the four states the pair can be in. The one worth naming is the
 * last: a browser that refuses today may grant tomorrow, because Chromium reads
 * site engagement, so a refusal must never be recorded as a decision.
 */

interface FakeStorageManager {
  persisted: () => Promise<boolean>;
  persist: () => Promise<boolean>;
}

function withStorage(manager: FakeStorageManager | null): void {
  if (manager === null) {
    // `'storage' in navigator` has to be FALSE, not merely undefined-valued:
    // that is the guard both functions open with.
    Reflect.deleteProperty(navigator, 'storage');
    return;
  }
  Object.defineProperty(navigator, 'storage', {
    value: manager,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'storage');
  vi.restoreAllMocks();
});

describe('storage persistence', () => {
  it('does not ask again when the browser already says it is persisted', async () => {
    const persist = vi.fn(() => Promise.resolve(true));
    withStorage({ persisted: () => Promise.resolve(true), persist });

    await expect(isPersisted()).resolves.toBe(true);
    await expect(ensurePersisted()).resolves.toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it('asks — and reports the grant — when it is not persisted yet', async () => {
    const persist = vi.fn(() => Promise.resolve(true));
    withStorage({ persisted: () => Promise.resolve(false), persist });

    await expect(ensurePersisted()).resolves.toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('re-asks on EVERY call while the answer is still no', async () => {
    const persist = vi.fn(() => Promise.resolve(false));
    withStorage({ persisted: () => Promise.resolve(false), persist });

    await expect(ensurePersisted()).resolves.toBe(false);
    await expect(ensurePersisted()).resolves.toBe(false);
    await expect(ensurePersisted()).resolves.toBe(false);
    // Three adds, three requests. A refusal is a state of the origin today, not
    // a decision to be cached — which is the whole of this change.
    expect(persist).toHaveBeenCalledTimes(3);
  });

  it('answers "no", never a throw, when the browser will not say', async () => {
    withStorage({
      persisted: () => Promise.reject(new Error('nope')),
      persist: () => Promise.reject(new Error('nope')),
    });
    await expect(isPersisted()).resolves.toBe(false);
    await expect(ensurePersisted()).resolves.toBe(false);
    await expect(requestPersistentStorage()).resolves.toBe(false);

    withStorage(null);
    await expect(isPersisted()).resolves.toBe(false);
    await expect(ensurePersisted()).resolves.toBe(false);
    await expect(requestPersistentStorage()).resolves.toBe(false);
  });
});
