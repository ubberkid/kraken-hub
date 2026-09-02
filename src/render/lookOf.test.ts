/**
 * `lookOf` is TOTAL, and that is the only interesting property it has.
 *
 * The display calls it on every document it is ever handed — a v6 snapshot with
 * no `look` at all, a v7 one, a blob a peer wrote, whatever survived a corrupt
 * localStorage write — and whatever comes back is composited. So the test is an
 * enumeration of garbage, and the assertion is always the same: a valid look,
 * with a base, that renders something.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_MODULE_ID } from '../state/defaults';
import { IDENTITY } from '../state/look/types';
import { validateAppState } from '../state/validate';

import { configsOf, lookOf } from './lookOf';

import type { GetModule } from '../modules/stack';
import type { AnyKrakenModule } from '../modules/types';

function fakeModule(id: string, over: Partial<AnyKrakenModule> = {}): AnyKrakenModule {
  return {
    id,
    name: id,
    summary: '',
    icon: '',
    configVersion: 2,
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
    defaults: { face: 'digital' },
    validate: (raw) => ({
      face: 'digital',
      ...(typeof raw === 'object' && raw !== null ? raw : {}),
    }),
    loadDisplay: () => Promise.reject(new Error('not used')),
    loadConfigPanel: () => Promise.reject(new Error('not used')),
    ...over,
  };
}

describe('lookOf', () => {
  it('projects a document with no look at all through activeModuleId', () => {
    expect(lookOf({ activeModuleId: 'stats' })).toEqual({
      layers: [{ id: 'base', kind: 'stats', on: true, frame: 'panel', t: IDENTITY }],
    });
  });

  it('uses a real look when the document has one', () => {
    const look = lookOf({
      activeModuleId: 'video',
      look: {
        layers: [
          { id: 'base', kind: 'clock', on: true, frame: 'panel', t: IDENTITY },
          {
            id: 'ovra',
            kind: 'stats',
            on: true,
            frame: { w: 1, h: 0.5, shape: 'square' },
            t: IDENTITY,
            cfg: { a: 1 },
          },
        ],
      },
    });
    expect(look.layers).toHaveLength(2);
    // The legacy field is ignored the moment a look is present (§6.1).
    expect(look.layers[0]?.kind).toBe('clock');
    expect(look.layers[1]?.cfg).toEqual({ a: 1 });
  });

  it('reads the field a validated schema-7 document actually carries', () => {
    // Not a projection any more: the document HAS a look, and this is it. The
    // `?module=` path lands on `activeModuleId`, which `validateAppState` has
    // already mapped onto the base — so by the time the display reads it, the
    // field says what the URL asked for and the overlays are still standing.
    const { state } = validateAppState({
      activeModuleId: 'clock',
      look: {
        layers: [
          { id: 'base', kind: 'video', on: true, frame: 'panel', t: IDENTITY },
          {
            id: 'lstats01',
            kind: 'stats',
            on: true,
            frame: { w: 1.6, h: 0.5, shape: 'square' },
            t: IDENTITY,
            cfg: {},
          },
        ],
      },
    });
    expect(lookOf(state)).toEqual(state.look);
    expect(state.look.layers[0]?.kind).toBe('clock');
    expect(state.look.layers).toHaveLength(2);
  });

  it('validates the look it finds rather than trusting it', () => {
    const look = lookOf({
      look: { layers: [{ id: 'nope', kind: 'clock', on: 'yes', frame: { w: 9 }, t: null }] },
    });
    // Positional rules applied: index 0 is the base whatever it claimed to be.
    expect(look.layers[0]?.id).toBe('base');
    expect(look.layers[0]?.frame).toBe('panel');
    expect(look.layers[0]?.t).toEqual(IDENTITY);
    expect(look.layers[0]?.on).toBe(true);
  });

  const garbage: [string, unknown][] = [
    ['undefined', undefined],
    ['null', null],
    ['a number', 7],
    ['a string', 'look'],
    ['an array', []],
    ['an empty object', {}],
    ['an empty look', { look: { layers: [] } }],
    ['a look that is not an object', { look: 'yes' }],
    ['layers that are not an array', { look: { layers: 'nope' } }],
    ['an unusable activeModuleId', { activeModuleId: 'NOT AN ID' }],
    ['a null activeModuleId', { activeModuleId: null }],
  ];

  it.each(garbage)('falls back to a base-only default look for %s', (_label, input) => {
    const look = lookOf(input);
    expect(look.layers).toHaveLength(1);
    expect(look.layers[0]).toEqual({
      id: 'base',
      kind: DEFAULT_MODULE_ID,
      on: true,
      frame: 'panel',
      t: IDENTITY,
    });
  });

  it('never returns a look without a base', () => {
    for (const [, input] of garbage) {
      expect(lookOf(input).layers[0]?.frame).toBe('panel');
    }
  });
});

describe('configsOf', () => {
  const registry: GetModule = (id) => (id === 'clock' || id === 'stats' ? fakeModule(id) : null);

  it('gives the base the bank, and the overlay its own cfg', () => {
    const look = lookOf({
      look: {
        layers: [
          { id: 'base', kind: 'clock', on: true, frame: 'panel', t: IDENTITY },
          {
            id: 'ovra',
            kind: 'stats',
            on: true,
            frame: { w: 1, h: 0.5, shape: 'square' },
            t: IDENTITY,
            cfg: { face: 'analog' },
          },
        ],
      },
    });
    const cfgs = configsOf(
      look,
      { modules: { clock: { v: 2, cfg: { face: 'roman' } } } },
      registry,
    );
    expect(cfgs['base']).toEqual({ face: 'roman' });
    expect(cfgs['ovra']).toEqual({ face: 'analog' });
  });

  it('applies URL params to the base only', () => {
    const withParams: GetModule = (id) =>
      id === 'clock'
        ? fakeModule('clock', {
            applyUrlParams: (config, params) => ({ ...(config as object), face: params['face'] }),
          })
        : registry(id);
    const look = lookOf({ activeModuleId: 'clock' });
    const cfgs = configsOf(look, { modules: {} }, withParams, { face: 'analog' });
    expect(cfgs['base']).toEqual({ face: 'analog' });
  });

  it('migrates an overlay config at the point of use', () => {
    const migrating: GetModule = (id) =>
      id === 'stats'
        ? fakeModule('stats', { migrateConfig: (from, raw) => ({ ...(raw as object), from }) })
        : registry(id);
    const look = lookOf({
      look: {
        layers: [
          { id: 'base', kind: 'clock', on: true, frame: 'panel', t: IDENTITY },
          {
            id: 'ovra',
            kind: 'stats',
            on: true,
            frame: { w: 1, h: 0.5, shape: 'square' },
            t: IDENTITY,
            cfg: { face: 'analog' },
            v: 1,
          },
        ],
      },
    });
    expect(configsOf(look, { modules: {} }, migrating)['ovra']).toEqual({
      face: 'analog',
      from: 1,
    });
  });

  it('keeps an unknown kind config verbatim rather than destroying it', () => {
    const look = lookOf({
      look: {
        layers: [
          { id: 'base', kind: 'clock', on: true, frame: 'panel', t: IDENTITY },
          {
            id: 'ovra',
            kind: 'lava',
            on: true,
            frame: { w: 1, h: 0.5, shape: 'square' },
            t: IDENTITY,
            cfg: { heat: 11 },
          },
        ],
      },
    });
    expect(configsOf(look, { modules: {} }, registry)['ovra']).toEqual({ heat: 11 });
  });
});
