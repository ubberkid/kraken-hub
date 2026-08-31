/**
 * The cold-restore resume decision.
 *
 * The storage round trip is deliberately exercised through the real
 * `platform/storage` helpers (which fall back to an in-memory map outside a
 * browser), so the namespaced key is asserted rather than assumed: the whole
 * point of `kraken-hub:v1:` is that a fork on a shared `github.io` origin does
 * not collide with somebody else's project.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { namespacedKeys, readRaw, writeRaw } from '../../../platform/storage';

import {
  CHECKPOINT_END_MARGIN_SEC,
  CHECKPOINT_MIN_SEC,
  CHECKPOINT_SUFFIX,
  checkpointKey,
  clearCheckpoint,
  readCheckpoint,
  resumeTarget,
  writeCheckpoint,
  type PositionCheckpoint,
} from './positionCheckpoint';

const HASH = async (value: string): Promise<string | null> =>
  Promise.resolve(`h${String(value.length)}`);
const NO_HASH = async (): Promise<string | null> => Promise.resolve(null);

const CP: PositionCheckpoint = { key: 'url:h20', posSec: 42, durationSec: 300, atMs: 1 };

afterEach(() => {
  clearCheckpoint();
});

describe('checkpointKey', () => {
  it('uses the clip id directly for a local clip, so a blob URL never keys it', async () => {
    await expect(checkpointKey('kraken-hub-clip:abc123', HASH)).resolves.toBe('clip:abc123');
  });

  it('hashes anything else — a raw URL never lands in localStorage', async () => {
    const key = await checkpointKey('https://example.com/a.mp4', HASH);
    expect(key).toBe('url:h25');
    expect(key).not.toContain('example.com');
  });

  it('is null when there is no hash and when the URL is empty', async () => {
    await expect(checkpointKey('https://example.com/a.mp4', NO_HASH)).resolves.toBeNull();
    await expect(checkpointKey('   ', HASH)).resolves.toBeNull();
  });
});

describe('storage round trip', () => {
  it('writes under the namespaced key and reads back what it wrote', () => {
    writeCheckpoint(CP);
    expect(readCheckpoint()).toEqual(CP);
    expect(namespacedKeys().some((k) => k.key === `kraken-hub:v1:${CHECKPOINT_SUFFIX}`)).toBe(true);
  });

  it('treats corrupt or half-written JSON as no checkpoint at all', () => {
    writeRaw(CHECKPOINT_SUFFIX, '{ not json');
    expect(readCheckpoint()).toBeNull();
    writeRaw(CHECKPOINT_SUFFIX, JSON.stringify({ key: 'url:h1' }));
    expect(readCheckpoint()).toBeNull();
    writeRaw(CHECKPOINT_SUFFIX, JSON.stringify([1, 2, 3]));
    expect(readCheckpoint()).toBeNull();
  });

  it('clears', () => {
    writeCheckpoint(CP);
    clearCheckpoint();
    expect(readRaw(CHECKPOINT_SUFFIX)).toBeNull();
  });
});

describe('resumeTarget', () => {
  const base = { key: 'url:h20', durationSec: 300, loopEnabled: false };

  it('resumes the same source', () => {
    expect(resumeTarget(CP, base)).toBe(42);
  });

  it('refuses a different source — a new URL starts at the beginning', () => {
    expect(resumeTarget(CP, { ...base, key: 'url:other' })).toBeNull();
    expect(resumeTarget(CP, { ...base, key: null })).toBeNull();
    expect(resumeTarget(null, base)).toBeNull();
  });

  it('stands down for an A-B loop, whose own start is the resume point', () => {
    expect(resumeTarget(CP, { ...base, loopEnabled: true })).toBeNull();
  });

  it('stands down for a live source, which has no meaningful position', () => {
    expect(resumeTarget(CP, { ...base, durationSec: null })).toBeNull();
    expect(resumeTarget(CP, { ...base, durationSec: Number.POSITIVE_INFINITY })).toBeNull();
    expect(resumeTarget(CP, { ...base, durationSec: 0 })).toBeNull();
  });

  it('ignores a position at the very start, which is not worth restoring', () => {
    expect(resumeTarget({ ...CP, posSec: CHECKPOINT_MIN_SEC - 0.01 }, base)).toBeNull();
    expect(resumeTarget({ ...CP, posSec: CHECKPOINT_MIN_SEC }, base)).toBe(CHECKPOINT_MIN_SEC);
  });

  it('ignores a position at the very end, which would resume into a loop', () => {
    const nearEnd = 300 - CHECKPOINT_END_MARGIN_SEC;
    expect(resumeTarget({ ...CP, posSec: nearEnd }, base)).toBeNull();
    expect(resumeTarget({ ...CP, posSec: nearEnd - 1 }, base)).toBe(nearEnd - 1);
  });
});
