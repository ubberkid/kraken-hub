import { describe, expect, it } from 'vitest';

import { defaultAppState } from './defaults';
import { mergeLeaf, resolveState } from './precedence';

describe('mergeLeaf', () => {
  it('merges per leaf, later wins', () => {
    expect(mergeLeaf({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 9 } })).toEqual({
      a: 1,
      b: { c: 9, d: 3 },
    });
  });

  it('treats undefined as absence and null as a value', () => {
    expect(mergeLeaf({ a: 1 }, { a: undefined })).toEqual({ a: 1 });
    expect(mergeLeaf({ a: 1 }, { a: null })).toEqual({ a: null });
  });

  it('replaces arrays wholesale rather than merging elementwise', () => {
    expect(mergeLeaf({ xs: [1, 2, 3] }, { xs: [9] })).toEqual({ xs: [9] });
  });

  it('does not mutate its inputs', () => {
    const base = { a: { b: 1 } };
    mergeLeaf(base, { a: { b: 2 } });
    expect(base).toEqual({ a: { b: 1 } });
  });
});

describe('resolveState', () => {
  it('applies defaults < persisted < remote < url, per key', () => {
    const { state } = resolveState({
      persisted: { activeModuleId: 'clock-lite', render: { fit: 'contain', zoom: 2 } },
      remote: { render: { fit: 'fill' } },
      url: { render: { zoom: 3 } },
    });
    // url wins on zoom, remote wins on fit, persisted supplies the rest
    expect(state.render.zoom).toBe(3);
    expect(state.render.fit).toBe('fill');
    expect(state.activeModuleId).toBe('clock-lite');
    expect(state.render.rotate).toBe(defaultAppState().render.rotate);
  });

  it('lets a URL parameter beat persisted state (the plan is authoritative)', () => {
    const { state } = resolveState({
      persisted: { activeModuleId: 'clock-lite' },
      url: { activeModuleId: 'other-module' },
    });
    expect(state.activeModuleId).toBe('other-module');
  });

  it('does not let a missing remote key clobber the persisted value', () => {
    const { state } = resolveState({
      persisted: { render: { zoom: 2 } },
      remote: { render: {} },
    });
    expect(state.render.zoom).toBe(2);
  });

  it('reports which dot paths were overridden above the persisted layer', () => {
    const { overridden } = resolveState({
      persisted: { render: { zoom: 2 } },
      url: { render: { fit: 'contain' }, activeModuleId: 'clock-lite' },
      remote: { platform: { fallbackTargetFps: 12 } },
    });
    expect(overridden).toEqual(['activeModuleId', 'platform.fallbackTargetFps', 'render.fit']);
  });

  it('returns valid defaults when every layer is empty', () => {
    expect(resolveState({}).state).toEqual(defaultAppState());
  });

  it('validates the merged result rather than trusting it', () => {
    const { state } = resolveState({ url: { render: { zoom: 1000 } } });
    expect(state.render.zoom).toBe(4);
  });
});
