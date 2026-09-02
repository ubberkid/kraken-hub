import { describe, expect, it } from 'vitest';

import { parseUrlParams } from './urlParams';

describe('parseUrlParams', () => {
  it('parses the display boot parameters', () => {
    const { flags } = parseUrlParams('?kraken=1&sim=elite&diag=1&fps=40&monitor=spike&inject=late');
    expect(flags.kraken).toBe(true);
    expect(flags.sim).toBe('elite');
    expect(flags.diag).toBe(true);
    expect(flags.fps).toBe(40);
    expect(flags.monitor).toBe('spike');
    expect(flags.inject).toBe('late');
  });

  it('maps global parameters onto a state patch', () => {
    const { patch } = parseUrlParams('?module=clock-lite&fit=contain&transport=ntfy&fps=25');
    expect(patch.activeModuleId).toBe('clock-lite');
    expect(patch.render?.fit).toBe('contain');
    expect(patch.sync?.transport).toBe('ntfy');
    expect(patch.platform?.fallbackTargetFps).toBe(25);
  });

  it('keeps module-scoped parameters raw for the active module', () => {
    const { moduleParams } = parseUrlParams(
      '?src=https%3A%2F%2Fexample.test%2Fa.mp4&loop=1&mute=0',
    );
    expect(moduleParams['src']).toBe('https://example.test/a.mp4');
    expect(moduleParams['loop']).toBe('1');
    expect(moduleParams['mute']).toBe('0');
  });

  it.each(['text', 'shape', 'effect'])('selects the W7 layer kind %s as the base', (kind) => {
    const { patch, notes } = parseUrlParams(`?kraken=1&sim=elite&module=${kind}`);
    expect(patch.activeModuleId).toBe(kind);
    expect(notes).toEqual([]);
  });

  it('keeps ?effect= raw for the effect module, like ?face= and ?layout=', () => {
    const { moduleParams, notes } = parseUrlParams('?module=effect&effect=voronoi');
    expect(moduleParams['effect']).toBe('voronoi');
    expect(notes).toEqual([]);
  });

  it('does not judge an effect id — only the module knows the twelve', () => {
    // Same contract as `face` and `layout` (docs/modules.md §9): an id this
    // table has never heard of is handed over raw, dropped by `validate()`, and
    // is NOT a note here.
    const { moduleParams, notes } = parseUrlParams('?effect=not-an-effect');
    expect(moduleParams['effect']).toBe('not-an-effect');
    expect(notes).toEqual([]);
  });

  it('rejects an empty ?effect=', () => {
    const { moduleParams, notes } = parseUrlParams('?effect=');
    expect(moduleParams['effect']).toBeUndefined();
    expect(notes.map((n) => n.key)).toEqual(['effect']);
  });

  it('reports ?preset= as unknown rather than accepting one it cannot honour', () => {
    // The palette table is lazy on purpose, so the eager manifest could record
    // the label and never paint the colours. Better an honest "unknown".
    const { moduleParams, notes } = parseUrlParams('?module=effect&preset=ember');
    expect(moduleParams['preset']).toBeUndefined();
    expect(notes.map((n) => n.key)).toEqual(['preset']);
    expect(notes[0]?.reason).toContain('unknown');
  });

  it('normalises a room code and enables sync', () => {
    const { patch } = parseUrlParams('?room=ab12cd34');
    expect(patch.sync?.roomCode).toBe('AB12CD34');
    expect(patch.sync?.enabled).toBe(true);
  });

  it('ignores an unparseable value instead of crashing, and says why', () => {
    const { patch, flags, notes } = parseUrlParams('?fit=diagonal&fps=999&sim=toaster&loop=maybe');
    expect(patch.render?.fit).toBeUndefined();
    expect(flags.fps).toBeNull();
    expect(flags.sim).toBeNull();
    expect(notes.map((n) => n.key).sort()).toEqual(['fit', 'fps', 'loop', 'sim']);
    for (const note of notes) expect(note.reason.length).toBeGreaterThan(0);
  });

  it('ignores unknown parameters but records them (fork friendliness)', () => {
    const { notes, seen } = parseUrlParams('?somethingNew=7');
    expect(seen).toEqual(['somethingNew']);
    expect(notes[0]?.reason).toContain('unknown');
  });

  it('accepts an empty query string', () => {
    const result = parseUrlParams('');
    expect(result.notes).toEqual([]);
    expect(result.flags.kraken).toBe(false);
    expect(result.patch).toEqual({});
  });

  /**
   * The two surface simulators, and the tri-state that makes them honest.
   *
   * `cam` and `phone` both answer a question about the BROWSER, and both gate
   * whole screens — which is exactly why neither may default to a boolean.
   * `null` means "measure it", and it is what every real visitor gets; the
   * override exists so a run with no CAM and no touchscreen can still exercise
   * both sides of a gate that decides which app you are looking at.
   */
  it('carries the CAM and phone overrides as a tri-state', () => {
    expect(parseUrlParams('').flags).toMatchObject({ cam: null, phone: null });
    expect(parseUrlParams('?cam=1&phone=1').flags).toMatchObject({ cam: true, phone: true });
    expect(parseUrlParams('?cam=0&phone=0').flags).toMatchObject({ cam: false, phone: false });
    expect(parseUrlParams('?phone=true').flags.phone).toBe(true);

    // An unparseable override is IGNORED and explained, never guessed at: a
    // guess here would silently serve somebody the wrong app.
    const bad = parseUrlParams('?phone=maybe');
    expect(bad.flags.phone).toBeNull();
    expect(bad.notes.map((n) => n.key)).toEqual(['phone']);
    expect(bad.notes[0]?.reason).toContain('0|1');
  });

  it('accepts the diagnostic test patterns', () => {
    expect(parseUrlParams('?pattern=rings&page=2').flags).toMatchObject({
      pattern: 'rings',
      page: 2,
    });
    expect(parseUrlParams('?pattern=spiral').flags.pattern).toBeNull();
  });

  // W0 spike (throwaway): removed with `src/render/compositor.spike.ts`.
  it('carries the layer-stack selector, and refuses one it cannot compose', () => {
    expect(parseUrlParams('?pattern=stack&stack=d').flags).toMatchObject({
      pattern: 'stack',
      stack: 'd',
    });
    expect(parseUrlParams('?stack=z').flags.stack).toBeNull();
    expect(parseUrlParams('?stack=z').notes[0]?.reason).toContain('a|b|c|d|e');
  });
});
