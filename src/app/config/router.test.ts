import { describe, expect, it } from 'vitest';

import { parseRoute } from './router';

describe('parseRoute', () => {
  it('maps every documented hash route', () => {
    expect(parseRoute('#/')).toEqual({ name: 'home' });
    expect(parseRoute('')).toEqual({ name: 'home' });
    expect(parseRoute('#/library')).toEqual({ name: 'library' });
    // Renamed, not removed: an old bookmark must resolve, and `ConfigApp`
    // rewrites the hash to `#/library` in place.
    expect(parseRoute('#/sources')).toEqual({ name: 'sources' });
    expect(parseRoute('#/remote')).toEqual({ name: 'remote' });
    expect(parseRoute('#/preview')).toEqual({ name: 'preview' });
    expect(parseRoute('#/diag')).toEqual({ name: 'diag' });
    expect(parseRoute('#/about')).toEqual({ name: 'about' });
    expect(parseRoute('#/module/clock-lite')).toEqual({ name: 'module', id: 'clock-lite' });
  });

  it('tolerates trailing slashes and missing leading slash', () => {
    expect(parseRoute('#/diag/')).toEqual({ name: 'diag' });
    expect(parseRoute('#diag')).toEqual({ name: 'diag' });
  });

  it('falls back to home rather than rendering nothing', () => {
    expect(parseRoute('#/nope')).toEqual({ name: 'home' });
    expect(parseRoute('#/module/')).toEqual({ name: 'home' });
  });
});
