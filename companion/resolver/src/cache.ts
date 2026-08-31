/**
 * The LRU disk cache, and the mint for `/stream/<opaque>` ids.
 *
 * Two jobs, deliberately in one file because they are the same invariant seen
 * from two sides:
 *
 *  - **Opaque ids are capabilities.** An id is 16 random bytes minted per
 *    resolve, and `/stream` serves *only* ids this cache minted. That is what
 *    stops the companion from being a general HTTP proxy (§5): there is no way
 *    to hand it a URL and have it fetch that URL for you.
 *  - **Bytes are evicted by atime, not by insertion order.** The clip the user
 *    is actually looping is touched on every Range request, so a week-old clip
 *    that is still playing outlives yesterday's experiment.
 *
 * The index is a plain JSON file rewritten atomically. It is small (one record
 * per cached clip) and losing it costs nothing but a re-download, so the extra
 * machinery a real database would bring is not worth its weight here.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface CacheEntry {
  /** 32 hex characters. The `/stream/<opaque>` token. */
  id: string;
  /** The resolve request this satisfies — url + maxHeight + prefer + audio. */
  key: string;
  file: string;
  mime: string;
  bytes: number;
  createdAt: number;
  /** Last read, in ms. Eviction order. */
  atime: number;
  /** Unix **seconds**, to match `ResolverOk.expiresAt`. */
  expiresAt: number;
  kind: 'progressive' | 'file';
  title?: string;
  width?: number;
  height?: number;
  fps?: number;
  durationSec?: number;
  thumbFile?: string;
}

export interface CacheOptions {
  dir: string;
  /** Eviction ceiling in bytes (`--max-cache-gb`). */
  maxBytes: number;
  /** How long a minted id stays valid. */
  ttlMs: number;
  now?: () => number;
}

const INDEX_FILE = 'index.json';
const MEDIA_DIR = 'media';
const ID_BYTES = 16;
export const OPAQUE_ID_RE = /^[0-9a-f]{32}$/;

/** Milliseconds → the unix **seconds** the contract's `expiresAt` is spelled in. */
function toUnixSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

export class ClipCache {
  readonly dir: string;
  readonly mediaDir: string;
  readonly maxBytes: number;
  readonly ttlMs: number;

  private readonly now: () => number;
  private entries = new Map<string, CacheEntry>();
  private writing: Promise<void> = Promise.resolve();

  constructor(opts: CacheOptions) {
    this.dir = opts.dir;
    this.mediaDir = join(opts.dir, MEDIA_DIR);
    this.maxBytes = opts.maxBytes;
    this.ttlMs = opts.ttlMs;
    this.now = opts.now ?? Date.now;
  }

  /** Creates the directories, reloads the index and drops anything stale. */
  async init(): Promise<void> {
    await mkdir(this.mediaDir, { recursive: true });
    try {
      const raw = await readFile(join(this.dir, INDEX_FILE), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed as CacheEntry[]) {
          if (typeof item.id === 'string' && OPAQUE_ID_RE.test(item.id)) {
            this.entries.set(item.id, item);
          }
        }
      }
    } catch {
      // A missing or corrupt index is a cold cache, not an error.
      this.entries.clear();
    }

    // Drop records whose file vanished (a user emptying the cache dir by hand)
    // and records that have already expired.
    for (const entry of [...this.entries.values()]) {
      const gone = await stat(entry.file).then(
        () => false,
        () => true,
      );
      if (gone || this.isExpired(entry)) this.entries.delete(entry.id);
    }
    await this.persist();
  }

  /** 16 random bytes. Not derived from the URL — that would leak it. */
  mintId(): string {
    return randomBytes(ID_BYTES).toString('hex');
  }

  /** The path a not-yet-downloaded clip should be written to. */
  pathFor(id: string, ext = '.mp4'): string {
    return join(this.mediaDir, `${id}${ext}`);
  }

  isExpired(entry: CacheEntry): boolean {
    return toUnixSeconds(this.now()) >= entry.expiresAt;
  }

  /** `null` for an unknown *or expired* id — `/stream` must not tell them apart. */
  get(id: string): CacheEntry | null {
    const entry = this.entries.get(id);
    if (entry === undefined) return null;
    if (this.isExpired(entry)) return null;
    return entry;
  }

  /** The freshest live entry for a resolve key, so a repeat resolve is free. */
  findByKey(key: string): CacheEntry | null {
    let best: CacheEntry | null = null;
    for (const entry of this.entries.values()) {
      if (entry.key !== key || this.isExpired(entry)) continue;
      if (best === null || entry.createdAt > best.createdAt) best = entry;
    }
    return best;
  }

  /** Records a read. Eviction is by atime, so this is what keeps a clip alive. */
  touch(id: string): void {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    entry.atime = this.now();
    void this.persist();
  }

  /** The TTL, as the contract's unix-seconds `expiresAt`. */
  expiryFromNow(): number {
    return toUnixSeconds(this.now() + this.ttlMs);
  }

  list(): CacheEntry[] {
    return [...this.entries.values()];
  }

  totalBytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.bytes;
    return total;
  }

  async add(entry: CacheEntry): Promise<void> {
    this.entries.set(entry.id, entry);
    await this.evict();
    await this.persist();
  }

  async remove(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    this.entries.delete(id);
    await rm(entry.file, { force: true });
    if (entry.thumbFile !== undefined) await rm(entry.thumbFile, { force: true });
    await this.persist();
  }

  /**
   * LRU down to `maxBytes`. Expired entries go first regardless of size —
   * they are unservable anyway, so keeping them would only shrink the cache.
   */
  async evict(): Promise<string[]> {
    const dropped: string[] = [];

    for (const entry of [...this.entries.values()]) {
      if (!this.isExpired(entry)) continue;
      this.entries.delete(entry.id);
      await rm(entry.file, { force: true });
      if (entry.thumbFile !== undefined) await rm(entry.thumbFile, { force: true });
      dropped.push(entry.id);
    }

    let total = this.totalBytes();
    if (total <= this.maxBytes) return dropped;

    const byAge = [...this.entries.values()].sort((a, b) => a.atime - b.atime);
    for (const entry of byAge) {
      if (total <= this.maxBytes) break;
      this.entries.delete(entry.id);
      await rm(entry.file, { force: true });
      if (entry.thumbFile !== undefined) await rm(entry.thumbFile, { force: true });
      total -= entry.bytes;
      dropped.push(entry.id);
    }
    return dropped;
  }

  /**
   * Atomic-ish: write a temp file and rename over the index.
   *
   * It never rejects. The index is a convenience — losing it costs a
   * re-download and nothing else — and a rejected promise here would take down
   * a `void this.persist()` call site in `touch()` for no gain at all.
   */
  private persist(): Promise<void> {
    this.writing = this.writing.then(async () => {
      try {
        const target = join(this.dir, INDEX_FILE);
        const tmp = `${target}.${String(process.pid)}.tmp`;
        await writeFile(tmp, JSON.stringify([...this.entries.values()], null, 2), 'utf8');
        await rename(tmp, target);
      } catch {
        // Cache dir deleted underneath us, disk full, read-only volume: all of
        // these mean "no index next boot", none of them mean "stop serving".
      }
    });
    return this.writing;
  }

  /** Flushes any pending index write — used on shutdown and by tests. */
  flush(): Promise<void> {
    return this.writing;
  }
}
