import { describe, expect, it } from 'vitest';

import {
  BASE_LAYER_ID,
  LAYER_ID_RE,
  MAX_LAYERS,
  MAX_LOOK_BYTES,
  baseLook,
  lookBytes,
  type Look,
} from '../../../state/look/types';

import { TEST_PLACEMENTS, testRegistry } from './__fixtures__/placements';
import {
  addLayer,
  bringForward,
  duplicateLayer,
  removeLayer,
  renameLayer,
  reorder,
  resize,
  sendBackward,
  setBase,
  setConfig,
  setFrame,
  setTransform,
  toggleLayer,
} from './ops';
import { fakeRegistry } from './registryPort';

/**
 * The refusals are the interesting half.
 *
 * Every limit in this file is a REFUSAL with a reason, never a silent drop:
 * the wire refuses to truncate `layers` (§6.2), so if an op quietly discarded
 * an overlay the user would lose work with nothing on screen to explain it.
 */

function ok(result: ReturnType<typeof addLayer>): Look {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.look;
}

function stack(kinds: readonly string[]): Look {
  let look = baseLook(kinds[0] ?? 'video');
  for (const kind of kinds.slice(1)) look = ok(addLayer(look, kind, testRegistry));
  return look;
}

describe('addLayer', () => {
  it('seeds from the kind’s overlayDefault', () => {
    const look = ok(addLayer(baseLook('video'), 'clock', testRegistry));
    const layer = look.layers[1];
    expect(layer?.frame).toEqual({ w: 1, h: 0.5, shape: 'square' });
    expect(layer?.t.y).toBe(0.55);
    expect(layer?.on).toBe(true);
    expect(LAYER_ID_RE.test(layer?.id ?? '')).toBe(true);
    expect(layer?.id).not.toBe(BASE_LAYER_ID);
  });

  it('returns the new id so the caller can select what it just made', () => {
    const result = addLayer(baseLook('video'), 'stats', testRegistry);
    expect(result.ok && result.id).toBe(result.ok ? result.look.layers[1]?.id : undefined);
  });

  it('refuses an unknown kind rather than writing a layer nothing can render', () => {
    expect(addLayer(baseLook('video'), 'lavalamp', testRegistry)).toEqual({
      ok: false,
      reason: 'unknown-kind',
    });
  });

  it('refuses a base-only kind as an overlay (video at index 1)', () => {
    expect(addLayer(baseLook('image'), 'video', testRegistry)).toEqual({
      ok: false,
      reason: 'role',
    });
  });

  it('refuses a ninth layer', () => {
    const full = stack(['video', 'clock', 'stats', 'clock', 'stats', 'clock', 'stats', 'clock']);
    expect(full.layers).toHaveLength(MAX_LAYERS);
    expect(addLayer(full, 'stats', testRegistry)).toEqual({ ok: false, reason: 'max-layers' });
  });

  it('refuses a third effect — maxInstances counts the base too', () => {
    const two = stack(['effect', 'effect']);
    expect(addLayer(two, 'effect', testRegistry)).toEqual({
      ok: false,
      reason: 'max-instances',
    });
  });

  it('refuses a look that would cross MAX_LOOK_BYTES', () => {
    const result = addLayer(baseLook('video'), 'stats', testRegistry, {
      cfg: { note: 'x'.repeat(MAX_LOOK_BYTES) },
    });
    expect(result).toEqual({ ok: false, reason: 'too-big' });
  });

  it('never writes a look over the cap', () => {
    let look = baseLook('video');
    for (let i = 0; i < MAX_LAYERS + 2; i++) {
      const next = addLayer(look, 'stats', testRegistry, { cfg: { pad: 'y'.repeat(300) } });
      if (next.ok) look = next.look;
    }
    expect(lookBytes(look)).toBeLessThanOrEqual(MAX_LOOK_BYTES);
  });

  it('leaves every op’s output structurally valid (the base keeps no cfg)', () => {
    const look = ok(addLayer(baseLook('video'), 'clock', testRegistry));
    expect(look.layers[0]).toEqual({
      id: 'base',
      kind: 'video',
      on: true,
      frame: 'panel',
      t: { x: 0, y: 0, s: 1, r: 0, a: 1 },
    });
  });
});

describe('setBase', () => {
  it('replaces layers[0] and keeps every overlay', () => {
    const look = stack(['video', 'clock', 'stats']);
    const next = setBase(look, 'effect');
    expect(next.layers[0]?.kind).toBe('effect');
    expect(next.layers[0]?.id).toBe(BASE_LAYER_ID);
    expect(next.layers.map((l) => l.kind)).toEqual(['effect', 'clock', 'stats']);
  });

  it('is a no-op when the base is already that kind', () => {
    const look = stack(['video', 'clock']);
    expect(setBase(look, 'video')).toBe(look);
  });
});

describe('removeLayer / toggleLayer / renameLayer', () => {
  it('never removes the base', () => {
    const look = stack(['video', 'clock']);
    expect(removeLayer(look, BASE_LAYER_ID)).toBe(look);
  });

  it('removes an overlay by id', () => {
    const look = stack(['video', 'clock', 'stats']);
    const id = look.layers[1]?.id ?? '';
    expect(removeLayer(look, id).layers.map((l) => l.kind)).toEqual(['video', 'stats']);
  });

  it('turns a layer off without losing its config', () => {
    const look = ok(
      addLayer(baseLook('video'), 'clock', testRegistry, { cfg: { face: 'analog' } }),
    );
    const id = look.layers[1]?.id ?? '';
    const off = toggleLayer(look, id, false);
    expect(off.layers[1]?.on).toBe(false);
    expect(off.layers[1]?.cfg).toEqual({ face: 'analog' });
  });

  it('treats an empty name as absence, not as ""', () => {
    const look = stack(['video', 'clock']);
    const id = look.layers[1]?.id ?? '';
    const named = renameLayer(look, id, '  Kitchen clock  ');
    expect(named.layers[1]?.name).toBe('Kitchen clock');
    expect(renameLayer(named, id, '   ').layers[1]).not.toHaveProperty('name');
  });
});

describe('duplicateLayer', () => {
  it('inserts the copy directly above the original with a fresh id and a nudge', () => {
    const look = stack(['video', 'clock', 'stats']);
    const id = look.layers[1]?.id ?? '';
    const result = duplicateLayer(look, id, testRegistry);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.look.layers.map((l) => l.kind)).toEqual(['video', 'clock', 'clock', 'stats']);
    expect(result.look.layers[2]?.id).not.toBe(id);
    expect(result.look.layers[2]?.t.y).toBeCloseTo(0.61, 6);
  });

  it('refuses to duplicate the base — a look has exactly one', () => {
    expect(duplicateLayer(stack(['video', 'clock']), BASE_LAYER_ID, testRegistry)).toEqual({
      ok: false,
      reason: 'role',
    });
  });

  it('refuses when the copy would be the third effect', () => {
    const look = stack(['effect', 'effect']);
    const id = look.layers[1]?.id ?? '';
    expect(duplicateLayer(look, id, testRegistry)).toEqual({
      ok: false,
      reason: 'max-instances',
    });
  });
});

describe('reorder', () => {
  it('moves an overlay and never the base', () => {
    const look = stack(['video', 'clock', 'stats']);
    const clock = look.layers[1]?.id ?? '';
    expect(reorder(look, clock, 2).layers.map((l) => l.kind)).toEqual(['video', 'stats', 'clock']);
    expect(reorder(look, BASE_LAYER_ID, 2)).toBe(look);
  });

  it('clamps to [1, length-1] — index 0 belongs to the base', () => {
    const look = stack(['video', 'clock', 'stats']);
    const stats = look.layers[2]?.id ?? '';
    expect(reorder(look, stats, 0).layers.map((l) => l.kind)).toEqual(['video', 'stats', 'clock']);
    expect(reorder(look, stats, 99)).toBe(look);
  });

  it('bringForward / sendBackward are ±1', () => {
    const look = stack(['video', 'clock', 'stats']);
    const clock = look.layers[1]?.id ?? '';
    expect(bringForward(look, clock).layers.map((l) => l.kind)).toEqual([
      'video',
      'stats',
      'clock',
    ]);
    expect(sendBackward(look, clock)).toBe(look);
  });
});

describe('setTransform / setFrame', () => {
  it('clamps to TRANSFORM_LIMITS', () => {
    const look = stack(['video', 'clock']);
    const id = look.layers[1]?.id ?? '';
    const next = setTransform(look, id, { x: 99, s: 0, r: 999, a: 2 });
    expect(next.layers[1]?.t).toEqual({ x: 1.5, y: 0.55, s: 0.1, r: 180, a: 1 });
  });

  it('refuses to move the base — layers[0].t is IDENTITY by definition', () => {
    const look = stack(['video', 'clock']);
    expect(setTransform(look, BASE_LAYER_ID, { x: 0.5 })).toBe(look);
  });

  it('clamps a frame to the kind’s minFrame', () => {
    const look = stack(['video', 'clock']);
    const id = look.layers[1]?.id ?? '';
    const next = setFrame(look, id, { w: 0.01, h: 9, shape: 'circle' }, testRegistry);
    expect(next.layers[1]?.frame).toEqual({ w: 0.4, h: 3, shape: 'circle' });
  });
});

describe('setConfig', () => {
  it('versions an overlay’s config', () => {
    const look = stack(['video', 'clock']);
    const id = look.layers[1]?.id ?? '';
    const result = setConfig(look, id, 3, { face: 'analog' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.look.layers[1]?.v).toBe(3);
    expect(result.look.layers[1]?.cfg).toEqual({ face: 'analog' });
  });

  it('refuses the base: its config lives in the modules bank', () => {
    expect(setConfig(stack(['video', 'clock']), BASE_LAYER_ID, 1, {})).toEqual({
      ok: false,
      reason: 'role',
    });
  });

  it('refuses a config that would blow the byte cap', () => {
    const look = stack(['video', 'clock']);
    const id = look.layers[1]?.id ?? '';
    expect(setConfig(look, id, 1, { blob: 'z'.repeat(MAX_LOOK_BYTES) })).toEqual({
      ok: false,
      reason: 'too-big',
    });
  });
});

describe('resize', () => {
  it('grows the BOX for a resize:"frame" kind and leaves t.s alone', () => {
    const look = stack(['video', 'clock']);
    const id = look.layers[1]?.id ?? '';
    const next = resize(look, id, 2, testRegistry);
    expect(next.layers[1]?.frame).toEqual({ w: 2, h: 1, shape: 'square' });
    expect(next.layers[1]?.t.s).toBe(1);
  });

  it('grows the SCALE for a resize:"scale" kind and leaves the frame alone', () => {
    const look = stack(['video', 'image']);
    const id = look.layers[1]?.id ?? '';
    const next = resize(look, id, 2, testRegistry);
    expect(next.layers[1]?.frame).toEqual({ w: 0.8, h: 0.8, shape: 'circle' });
    expect(next.layers[1]?.t.s).toBe(2);
  });

  it('ignores a nonsense factor and the base', () => {
    const look = stack(['video', 'clock']);
    const id = look.layers[1]?.id ?? '';
    expect(resize(look, id, 0, testRegistry)).toBe(look);
    expect(resize(look, BASE_LAYER_ID, 2, testRegistry)).toBe(look);
  });

  it('falls back to scale for a kind the registry has never heard of', () => {
    const orphan = fakeRegistry({});
    const look = stack(['video', 'clock']);
    const id = look.layers[1]?.id ?? '';
    expect(resize(look, id, 2, orphan).layers[1]?.t.s).toBe(2);
  });
});

describe('the placement table the tests are written against', () => {
  it('is the §1.4 table, so a refusal is about the op and not about a module', () => {
    expect(TEST_PLACEMENTS['video']?.roles).toEqual(['base']);
    expect(TEST_PLACEMENTS['effect']?.maxInstances).toBe(2);
    expect(TEST_PLACEMENTS['clock']?.resize).toBe('frame');
  });
});
