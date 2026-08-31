/**
 * The ONLY module allowed to touch `localStorage` (invariant I5, enforced by
 * `no-restricted-globals` in eslint.config.js).
 *
 * Why it matters: a GitHub Pages fork lives on `<user>.github.io`, an origin
 * shared with every other repo that user publishes. An unnamespaced key would
 * collide with somebody's unrelated project. Every key we write is therefore
 * prefixed `kraken-hub:v1:`.
 */

import { createLogger } from '../lib/log';

const log = createLogger('platform/storage');

/** Canonical namespace. Never change it — doing so strands every existing user. */
export const STORAGE_PREFIX = 'kraken-hub:v1:';

/** `'state'` → `'kraken-hub:v1:state'` */
export function nsKey(suffix: string): string {
  return STORAGE_PREFIX + suffix;
}

let available: boolean | null = null;
/** In-memory fallback used when localStorage is disabled or over quota. */
const memory = new Map<string, string>();
let degraded = false;

/** True when `localStorage` is usable at all (private modes and quota=0 exist). */
export function isStorageAvailable(): boolean {
  if (available !== null) return available;
  try {
    const probe = nsKey('probe');
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    available = true;
  } catch (err) {
    log.warn('localStorage unavailable — degrading to in-memory storage', err);
    available = false;
  }
  return available;
}

/** True once a write failed and the store fell back to memory. */
export function isDegraded(): boolean {
  return degraded;
}

export function readRaw(suffix: string): string | null {
  const key = nsKey(suffix);
  if (!isStorageAvailable()) return memory.get(key) ?? null;
  try {
    return localStorage.getItem(key);
  } catch (err) {
    log.warn(`read failed for ${suffix}`, err);
    return memory.get(key) ?? null;
  }
}

/** Returns false when the value could only be kept in memory. */
export function writeRaw(suffix: string, value: string): boolean {
  const key = nsKey(suffix);
  memory.set(key, value);
  if (!isStorageAvailable()) return false;
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    degraded = true;
    log.error(`write failed for ${suffix} (quota?) — kept in memory only`, err);
    return false;
  }
}

export function removeRaw(suffix: string): void {
  const key = nsKey(suffix);
  memory.delete(key);
  if (!isStorageAvailable()) return;
  try {
    localStorage.removeItem(key);
  } catch (err) {
    log.warn(`remove failed for ${suffix}`, err);
  }
}

/** Every `kraken-hub:v1:` key with its byte length — the storage inspector. */
export function namespacedKeys(): { key: string; bytes: number }[] {
  if (!isStorageAvailable()) {
    return [...memory].map(([key, value]) => ({ key, bytes: value.length }));
  }
  const out: { key: string; bytes: number }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(STORAGE_PREFIX)) continue;
      out.push({ key, bytes: (localStorage.getItem(key) ?? '').length });
    }
  } catch (err) {
    log.warn('enumeration failed', err);
  }
  return out;
}

/** Removes only our keys — foreign keys on the shared origin are left alone. */
export function resetNamespace(): void {
  for (const { key } of namespacedKeys()) {
    memory.delete(key);
    try {
      localStorage.removeItem(key);
    } catch {
      /* already degraded; memory copy is gone, which is what matters */
    }
  }
}

// ---------------------------------------------------------------------------
// Session storage
// ---------------------------------------------------------------------------

/**
 * `sessionStorage` is banned everywhere else by the same ESLint rule that bans
 * `localStorage`, and for the same reason: `<user>.github.io` is a shared
 * origin. It exists here for values that must NOT outlive the browser session —
 * today that is the YouTube ladder step (§2.7), which is a reaction to one
 * machine's current network and GPU conditions and would be actively wrong to
 * restore a month later.
 */
const sessionMemory = new Map<string, string>();
let sessionAvailable: boolean | null = null;

function isSessionAvailable(): boolean {
  if (sessionAvailable !== null) return sessionAvailable;
  try {
    const probe = nsKey('probe');
    sessionStorage.setItem(probe, '1');
    sessionStorage.removeItem(probe);
    sessionAvailable = true;
  } catch {
    sessionAvailable = false;
  }
  return sessionAvailable;
}

export function readSessionRaw(suffix: string): string | null {
  const key = nsKey(suffix);
  if (!isSessionAvailable()) return sessionMemory.get(key) ?? null;
  try {
    return sessionStorage.getItem(key);
  } catch {
    return sessionMemory.get(key) ?? null;
  }
}

export function writeSessionRaw(suffix: string, value: string): boolean {
  const key = nsKey(suffix);
  sessionMemory.set(key, value);
  if (!isSessionAvailable()) return false;
  try {
    sessionStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeSessionRaw(suffix: string): void {
  const key = nsKey(suffix);
  sessionMemory.delete(key);
  if (!isSessionAvailable()) return;
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* nothing to remove is not a failure worth logging */
  }
}

export interface NamespacedStorageEvent {
  /** Suffix without the namespace, or `null` for a whole-origin `clear()`. */
  suffix: string | null;
  newValue: string | null;
}

/**
 * Cross-document change notifications. `event.key === null` means somebody
 * called `localStorage.clear()`, which we must treat as "everything changed".
 */
export function onStorageEvent(cb: (e: NamespacedStorageEvent) => void): () => void {
  // The sync transports run in the `unit` (node) Vitest project as well as in a
  // browser, and there is no `window` there. Returning an inert unsubscribe is
  // correct rather than defensive: with no other document on the origin there
  // is nothing a cross-document event could ever tell us.
  if (typeof window === 'undefined') return () => undefined;

  const handler = (e: StorageEvent): void => {
    if (e.key === null) {
      cb({ suffix: null, newValue: null });
      return;
    }
    if (!e.key.startsWith(STORAGE_PREFIX)) return;
    cb({ suffix: e.key.slice(STORAGE_PREFIX.length), newValue: e.newValue });
  };
  window.addEventListener('storage', handler);
  return () => {
    window.removeEventListener('storage', handler);
  };
}
