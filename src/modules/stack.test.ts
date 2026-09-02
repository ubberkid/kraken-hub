/**
 * The placement rules, enumerated (§10, W2).
 *
 * Every case here is a look somebody can genuinely end up holding: a look made
 * by a newer build, a look whose base was swapped for a kind that cannot be a
 * base, a phone that added one overlay too many while the display was asleep.
 * None of them may throw, none of them may edit the document, and each of them
 * has to produce a note somebody could be shown.
 *
 * The registry is a FAKE, on purpose. A test that read the real one would be
 * asserting facts about the video module rather than about `normalizeLook`, and
 * "the third effect is refused" has to stay true whatever `effect` ends up
 * declaring in W7.
 */

import { describe, expect, it } from 'vitest';

import { IDENTITY, type Layer, type Look } from '../state/look/types';

import { lookCost, normalizeLook, placementOf, stackMotionLevel } from './stack';

import type { AnyKrakenModule, LayerCost, LayerPlacement } from './types';

const OVERLAY_FRAME = { w: 1.6, h: 0.5, shape: 'square' } as const;

function placement(over: Partial<LayerPlacement> & Pick<LayerPlacement, 'cost'>): LayerPlacement {
  return {
    roles: ['base', 'overlay'],
    maxInstances: 8,
    resize: 'frame',
    minFrame: 0.3,
    overlayDefault: { frame: OVERLAY_FRAME, t: { ...IDENTITY, y: 0.6 } },
    ...over,
  };
}

const cost = (c: LayerCost) => (): LayerCost => c;

/** The four shipped placements plus W7's `effect`, as data. */
const PLACEMENTS: Readonly<Record<string, LayerPlacement>> = {
  video: placement({
    roles: ['base'],
    maxInstances: 1,
    resize: 'scale',
    minFrame: 0.5,
    cost: cost({ cadence: 'frame', coverage: 1, entropy: 'high', decoders: 1, gl: 0 }),
  }),
  stats: placement({
    cost: cost({ cadence: 'tick', coverage: 0.3, entropy: 'low', decoders: 0, gl: 0 }),
  }),
  clock: placement({
    cost: cost({ cadence: 'tick', coverage: 0.15, entropy: 'low', decoders: 0, gl: 0 }),
  }),
  image: placement({
    resize: 'scale',
    cost: cost({ cadence: 'static', coverage: 1, entropy: 'mid', decoders: 0, gl: 0 }),
  }),
  /** W7's placeholder: a tier-1 shader, two contexts allowed, `mid` entropy. */
  effect: placement({
    maxInstances: 2,
    resize: 'scale',
    minFrame: 0.5,
    cost: cost({ cadence: 'frame', coverage: 1, entropy: 'mid', decoders: 0, gl: 1 }),
  }),
};

function fakeModule(id: string): AnyKrakenModule {
  const layer = PLACEMENTS[id];
  const mod: AnyKrakenModule = {
    id,
    name: id,
    summary: id,
    icon: '',
    configVersion: 1,
    capabilities: {
      needsMonitoring: false,
      needsFrameLoop: false,
      usesMedia: false,
      hasTimeline: false,
      motionLevel: 'static',
      substrate: 'dom',
      audio: 'none',
      remoteCommands: [],
    },
    defaults: {},
    validate: (raw) => raw,
    loadDisplay: () => {
      throw new Error('not needed');
    },
    loadConfigPanel: () => {
      throw new Error('not needed');
    },
  };
  // `exactOptionalPropertyTypes`: absent and `undefined` are different things,
  // and "no placement declared" is the case `placementOf` exists for.
  return layer === undefined ? mod : { ...mod, layer };
}

const getModule = (id: string): AnyKrakenModule | null =>
  id in PLACEMENTS ? fakeModule(id) : null;

let n = 0;
function layer(kind: string, over: Partial<Layer> = {}): Layer {
  n += 1;
  return {
    id: `l${String(n).padStart(4, '0')}`,
    kind,
    on: true,
    frame: OVERLAY_FRAME,
    t: IDENTITY,
    ...over,
  };
}

function base(kind: string, over: Partial<Layer> = {}): Layer {
  return { id: 'base', kind, on: true, frame: 'panel', t: IDENTITY, ...over };
}

function look(...layers: Layer[]): Look {
  return { layers };
}

describe('normalizeLook', () => {
  it('is reference-stable when there is nothing to say', () => {
    const l = look(base('video'), layer('stats'));
    const plan = normalizeLook(l, getModule);
    expect(plan.layers).toBe(l.layers);
    expect(plan.look).toBe(l);
    expect(plan.notes).toEqual([]);
    // …and stable across calls, so a caller can memoise on it.
    expect(normalizeLook(l, getModule).layers).toBe(l.layers);
  });

  it('skips an unknown kind at render and keeps it in the document', () => {
    const alien = layer('aquarium');
    const l = look(base('video'), alien, layer('stats'));
    const plan = normalizeLook(l, getModule);

    expect(plan.layers.map((x) => x.kind)).toEqual(['video', 'stats']);
    expect(plan.notes).toHaveLength(1);
    expect(plan.notes[0]).toMatchObject({ id: alien.id, kind: 'aquarium', reason: 'unknown-kind' });
    expect(plan.notes[0]?.detail.length).toBeGreaterThan(0);
    // The document is untouched: a look made by a newer build survives a round
    // trip through this one.
    expect(l.layers).toHaveLength(3);
    expect(l.layers[1]).toBe(alien);
  });

  it('switches off a base-only kind that somebody put at index 2', () => {
    const stray = layer('video');
    const l = look(base('image'), layer('stats'), stray);
    const plan = normalizeLook(l, getModule);

    expect(plan.layers[2]?.on).toBe(false);
    expect(plan.layers[2]).not.toBe(stray);
    expect(stray.on).toBe(true);
    expect(plan.notes.map((note) => note.reason)).toEqual(['role']);
  });

  it('notes a base that cannot be a base, and draws it anyway', () => {
    // A kind with `roles: ['overlay']` only — W7's `text`, in advance.
    const registry = (id: string): AnyKrakenModule | null => {
      if (id !== 'text') return getModule(id);
      return {
        ...fakeModule('stats'),
        id: 'text',
        layer: placement({
          roles: ['overlay'],
          cost: cost({ cadence: 'static', coverage: 1, entropy: 'low', decoders: 0, gl: 0 }),
        }),
      };
    };
    const plan = normalizeLook(look(base('text')), registry);
    // Black panel is the worse answer: it renders where it is, over the stage.
    expect(plan.layers[0]?.on).toBe(true);
    expect(plan.notes.map((note) => note.reason)).toEqual(['base-not-base-capable']);
  });

  it('turns off the third effect and says why', () => {
    const third = layer('effect');
    const plan = normalizeLook(
      look(base('image'), layer('effect'), layer('effect'), third),
      getModule,
    );

    expect(plan.layers.map((x) => x.on)).toEqual([true, true, true, false]);
    expect(plan.notes).toHaveLength(1);
    expect(plan.notes[0]).toMatchObject({ id: third.id, kind: 'effect', reason: 'max-instances' });
    expect(plan.notes[0]?.detail.length).toBeGreaterThan(0);
  });

  it('counts instances in array order, so the one you added first wins', () => {
    const second = layer('video');
    // Two videos can only happen through a corrupt or foreign document, since
    // the base is index 0 — but Σ decoders ≤ 1 is a hardware fact either way.
    const plan = normalizeLook(look(base('video'), second), getModule);
    expect(plan.layers[0]?.on).toBe(true);
    expect(plan.layers[1]?.on).toBe(false);
  });

  it('still explains a rule an OFF layer breaks, without touching the plan', () => {
    // The note is about placement, not about the switch: the editor needs it to
    // explain why the switch cannot be turned back on.
    const l = look(base('image'), layer('video', { on: false }));
    const plan = normalizeLook(l, getModule);
    expect(plan.notes.map((note) => note.reason)).toEqual(['role']);
    expect(plan.layers[1]?.on).toBe(false);
    // Nothing had to change, so the array survives by reference.
    expect(plan.layers).toBe(l.layers);
  });

  it('derives a base-only placement for a module that predates the contract', () => {
    const legacy: AnyKrakenModule = fakeModule('legacy');
    const derived = placementOf(legacy);
    expect(derived.roles).toEqual(['base']);
    expect(derived.maxInstances).toBe(1);
    expect(derived.cost({}, { frame: 'panel', t: IDENTITY }).cadence).toBe('static');

    const plan = normalizeLook(look(base('image'), layer('legacy')), (id) =>
      id === 'legacy' ? legacy : getModule(id),
    );
    expect(plan.layers[1]?.on).toBe(false);
    expect(plan.notes.map((note) => note.reason)).toEqual(['role']);
  });
});

/**
 * The worked examples from §7.2. The formula is
 *
 *   w = C[cadence] × min(1, coverage × area(frame) × s²) × E[entropy]
 *       + (a < 1 ? 0.1 : 0) + (a video behind a surface ? 0.1 : 0)
 *
 * with `C = {static:0, tick:0.05, frame:1}`, `E = {low:.3, mid:.6, high:1}` and
 * `area({w,h}) = w·h/4` — normalised so one video base is exactly 1.0.
 */
describe('lookCost', () => {
  const STATS_STRIP_W = 0.05 * (0.3 * ((1.6 * 0.5) / 4)) * 0.3;

  it('makes one video base the unit', () => {
    const c = lookCost(look(base('video')), getModule);
    expect(c.total).toBe(1);
    expect(c.verdict).toBe('calm');
    expect(c.decoders).toBe(1);
    expect(c.gl).toBe(0);
    expect(c.surfaces).toBe(0);
    expect(c.worst).toEqual({ id: 'base', kind: 'video', w: 1 });
  });

  it('charges a stats strip over video barely anything (§7.2: ≈ 1.01)', () => {
    const c = lookCost(look(base('video'), layer('stats')), getModule);
    expect(c.total).toBeCloseTo(1 + STATS_STRIP_W, 10);
    // The spec's figure is a rounded one; what matters is that a 1 Hz strip on
    // a fifth of the panel is a hundredth of a video, not a tenth of one.
    expect(Math.abs(c.total - 1.01)).toBeLessThanOrEqual(0.01);
    expect(c.total).toBeGreaterThan(1);
    expect(c.worst?.kind).toBe('video');
  });

  it('charges an effect base plus the same strip about 0.61', () => {
    const c = lookCost(look(base('effect'), layer('stats')), getModule);
    expect(c.total).toBeCloseTo(0.6 + STATS_STRIP_W, 10);
    expect(Math.abs(c.total - 0.61)).toBeLessThanOrEqual(0.01);
    expect(c.verdict).toBe('calm');
    expect(c.gl).toBe(1);
  });

  it('charges 0.1 for the surface a translucent overlay forces', () => {
    const opaque = lookCost(look(base('video'), layer('stats')), getModule);
    const faded = lookCost(
      look(base('video'), layer('stats', { t: { ...IDENTITY, a: 0.5 } })),
      getModule,
    );
    expect(faded.total - opaque.total).toBeCloseTo(0.1, 10);
    expect(faded.surfaces).toBe(1);
  });

  it('charges a translucent VIDEO twice: the surface, and the path it lost', () => {
    const faded = lookCost(look(base('video', { t: { ...IDENTITY, a: 0.5 } })), getModule);
    expect(faded.total).toBeCloseTo(1.2, 10);
  });

  it('scales a pixel layer by s², because that is what gets painted', () => {
    const small = lookCost(look(base('image'), layer('effect', { t: IDENTITY })), getModule);
    const big = lookCost(
      look(base('image'), layer('effect', { t: { ...IDENTITY, s: 2 } })),
      getModule,
    );
    expect(big.total).toBeGreaterThan(small.total);
  });

  it('grades a stack of moving layers as rich', () => {
    const full = { w: 2, h: 2, shape: 'square' } as const;
    const c = lookCost(
      look(base('video'), layer('effect', { frame: full }), layer('effect', { frame: full })),
      getModule,
    );
    expect(c.total).toBeGreaterThan(1.5);
    expect(c.verdict).toBe('rich');
  });

  it('costs nothing for layers that are off, unknown, or refused', () => {
    const c = lookCost(
      look(base('video'), layer('stats', { on: false }), layer('aquarium'), layer('video')),
      getModule,
    );
    expect(c.total).toBe(1);
    expect(c.decoders).toBe(1);
  });

  it('reads the config it is given, not the one on the layer', () => {
    const registry = (id: string): AnyKrakenModule | null =>
      id !== 'slides'
        ? getModule(id)
        : {
            ...fakeModule('image'),
            id: 'slides',
            layer: placement({
              cost: (cfg) => ({
                cadence: (cfg as { on?: boolean } | null)?.on === true ? 'tick' : 'static',
                coverage: 1,
                entropy: 'mid',
                decoders: 0,
                gl: 0,
              }),
            }),
          };
    const l = look(base('slides'));
    expect(lookCost(l, registry, () => ({ on: false })).total).toBe(0);
    expect(lookCost(l, registry, () => ({ on: true })).total).toBeGreaterThan(0);
  });
});

describe('stackMotionLevel', () => {
  it('is decided by the busiest layer that is on', () => {
    expect(stackMotionLevel(look(base('image')), getModule)).toBe('static');
    expect(stackMotionLevel(look(base('image'), layer('clock')), getModule)).toBe('low');
    expect(stackMotionLevel(look(base('image'), layer('effect')), getModule)).toBe('full');
    expect(stackMotionLevel(look(base('image'), layer('effect', { on: false })), getModule)).toBe(
      'static',
    );
  });
});
