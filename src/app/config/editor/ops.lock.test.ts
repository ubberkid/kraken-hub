import { describe, expect, it } from 'vitest';

import { baseLook, type Look } from '../../../state/look/types';

import { testRegistry } from './__fixtures__/placements';
import {
  addLayer,
  isLocked,
  resize,
  setFrame,
  setLocked,
  setTransform,
  setTransformOf,
  transformMany,
} from './ops';

/**
 * The lock (§2.2) and the group gesture (§2.1) — the two ops round 10 added.
 *
 * They are tested together because they share the same rule from two sides: a
 * locked layer refuses a transform with a TYPED reason, and a group gesture
 * refuses the whole batch rather than moving the members that happen to be
 * unlocked. A group that half-moved is a group the user has to reconstruct by
 * hand, which is worse than a group that did not move.
 */

function ok(result: ReturnType<typeof addLayer>): Look {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.look;
}

function twoOverlays(): Look {
  let look = ok(addLayer(baseLook('video'), 'clock', testRegistry));
  look = ok(addLayer(look, 'stats', testRegistry));
  return look;
}

function ids(look: Look): [string, string] {
  const a = look.layers[1]?.id ?? '';
  const b = look.layers[2]?.id ?? '';
  return [a, b];
}

describe('setLocked', () => {
  it('stores `true` and removes the field again on unlock', () => {
    const look = twoOverlays();
    const [a] = ids(look);

    const locked = setLocked(look, a, true);
    expect(locked.layers[1]?.locked).toBe(true);
    expect(isLocked(locked, a)).toBe(true);

    const unlocked = setLocked(locked, a, false);
    // Absent, not `false`: `validateLook` drops a `false`, so unlocking really
    // does return the document to the bytes it had.
    expect(Object.hasOwn(unlocked.layers[1] ?? {}, 'locked')).toBe(false);
    expect(isLocked(unlocked, a)).toBe(false);
  });

  it('refuses the base, which has nothing a lock could protect', () => {
    const look = baseLook('video');
    expect(setLocked(look, 'base', true)).toBe(look);
  });
});

describe('a locked layer refuses every transform', () => {
  it('says `locked`, rather than silently doing nothing', () => {
    const start = twoOverlays();
    const [a] = ids(start);
    const look = setLocked(start, a, true);
    const result = setTransformOf(look, a, { x: 0.4 });
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.reason).toBe('locked');
  });

  it('and the Look-shaped wrapper leaves the document untouched', () => {
    const start = twoOverlays();
    const [a] = ids(start);
    const look = setLocked(start, a, true);
    expect(setTransform(look, a, { x: 0.4 })).toBe(look);
  });

  it('covers the frame and the resize gesture too', () => {
    const start = twoOverlays();
    const [a] = ids(start);
    const look = setLocked(start, a, true);
    expect(setFrame(look, a, { w: 2, h: 2, shape: 'square' }, testRegistry)).toBe(look);
    expect(resize(look, a, 2, testRegistry)).toBe(look);
  });

  it('leaves an UNLOCKED sibling free to move', () => {
    const start = twoOverlays();
    const [a, b] = ids(start);
    const look = setLocked(start, a, true);
    const moved = setTransformOf(look, b, { x: 0.4 });
    expect(moved.ok).toBe(true);
    expect(moved.ok ? moved.look.layers[2]?.t.x : null).toBeCloseTo(0.4, 5);
  });
});

describe('transformMany', () => {
  it('moves every member in ONE document', () => {
    const look = twoOverlays();
    const [a, b] = ids(look);
    const result = transformMany(look, [
      { id: a, patch: { x: 0.1 } },
      { id: b, patch: { x: -0.1 } },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.look.layers[1]?.t.x).toBeCloseTo(0.1, 5);
    expect(result.look.layers[2]?.t.x).toBeCloseTo(-0.1, 5);
  });

  it('clamps like every other transform op', () => {
    const look = twoOverlays();
    const [a] = ids(look);
    const result = transformMany(look, [{ id: a, patch: { x: 99 } }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.look.layers[1]?.t.x).toBeLessThanOrEqual(2);
  });

  it('refuses the WHOLE batch when one member is locked', () => {
    const base = twoOverlays();
    const [a, b] = ids(base);
    const look = setLocked(base, b, true);
    const result = transformMany(look, [
      { id: a, patch: { x: 0.1 } },
      { id: b, patch: { x: 0.1 } },
    ]);
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.reason).toBe('locked');
  });

  it('ignores the base and an id that is not in the look', () => {
    const look = twoOverlays();
    const [a] = ids(look);
    const result = transformMany(look, [
      { id: 'base', patch: { x: 0.5 } },
      { id: 'lnothing', patch: { x: 0.5 } },
      { id: a, patch: { y: 0.2 } },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.look.layers[0]?.t).toEqual({ x: 0, y: 0, s: 1, r: 0, a: 1 });
    expect(result.look.layers[1]?.t.y).toBeCloseTo(0.2, 5);
  });

  it('is a no-op for an empty batch', () => {
    const look = twoOverlays();
    const result = transformMany(look, []);
    expect(result.ok).toBe(true);
    expect(result.ok ? result.look : null).toBe(look);
  });
});
