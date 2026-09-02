import { describe, expect, it } from 'vitest';

import { IDENTITY, type Layer } from '../../../state/look/types';

import {
  MAX_STRIP_CONTROLS,
  configWith,
  isValueControl,
  readPath,
  stripIsWellFormed,
  stripValue,
  transformPatchOf,
  writePath,
} from './strip';

import type { StripControl } from '../../../modules/types';

const overlay: Layer = {
  id: 'labc1234',
  kind: 'text',
  on: true,
  frame: { w: 1, h: 0.3, shape: 'square' },
  t: { ...IDENTITY, a: 0.5 },
  cfg: { text: 'hi', size: 0.2 },
};

const fit: StripControl = {
  id: 'fill',
  label: 'Fit',
  control: 'fit',
  target: 'cfg',
  path: 'render.fit',
};

const opacity: StripControl = {
  id: 'opacity',
  label: 'Opacity',
  control: 'range',
  target: 'layer',
  path: 't.a',
  min: 0,
  max: 1,
  step: 0.05,
};

describe('reading a dot path', () => {
  it('walks nested objects', () => {
    expect(readPath({ render: { fit: 'cover' } }, 'render.fit')).toBe('cover');
  });

  it('answers undefined rather than throwing for anything that does not resolve', () => {
    expect(readPath(null, 'render.fit')).toBeUndefined();
    expect(readPath({ render: 7 }, 'render.fit')).toBeUndefined();
    expect(readPath(undefined, 'a')).toBeUndefined();
    // A config that arrives from storage as a string is a config, as far as
    // this is concerned: it simply resolves nothing.
    expect(readPath('not an object', 'a.b')).toBeUndefined();
  });
});

describe('writing a dot path', () => {
  it('creates the objects on the way down', () => {
    expect(writePath({}, 'render.fit', 'cover')).toEqual({ render: { fit: 'cover' } });
  });

  it('copies only the spine it touches', () => {
    const slideshow = { enabled: false };
    const before = { render: { fit: 'cover', zoom: 1 }, slideshow };
    const after = writePath(before, 'render.fit', 'contain') as typeof before;

    expect(after.render.fit).toBe('contain');
    // Untouched branches are shared, which is what keeps `diffPaths` reporting
    // one changed path for one control press.
    expect(after.slideshow).toBe(slideshow);
    expect(after.render.zoom).toBe(1);
    // …and the original is untouched.
    expect(before.render.fit).toBe('cover');
  });

  it('replaces a non-object on the way down rather than throwing', () => {
    expect(writePath({ render: 7 }, 'render.fit', 'cover')).toEqual({ render: { fit: 'cover' } });
  });
});

describe('reading a control', () => {
  it('reads a config control from the config', () => {
    expect(stripValue(fit, overlay, { render: { fit: 'contain' } })).toBe('contain');
  });

  it('reads a layer control from the layer', () => {
    expect(stripValue(opacity, overlay, {})).toBe(0.5);
  });

  it('coerces a toggle whose field predates the config', () => {
    const toggle: StripControl = {
      id: 'seconds',
      label: 'Seconds',
      control: 'toggle',
      target: 'cfg',
      path: 'showSeconds',
    };
    expect(stripValue(toggle, overlay, {})).toBe(false);
    expect(stripValue(toggle, overlay, { showSeconds: true })).toBe(true);
  });

  it('has no value for a control that only opens something', () => {
    const more: StripControl = { id: 'more', label: 'More', control: 'more' };
    expect(isValueControl(more)).toBe(false);
    expect(stripValue(more, overlay, {})).toBeUndefined();
  });
});

describe('writing through a control', () => {
  it('produces a config for a cfg-target control and nothing for a layer one', () => {
    expect(configWith(fit, { render: { fit: 'cover' } }, 'contain')).toEqual({
      render: { fit: 'contain' },
    });
    expect(configWith(opacity, {}, 0.4)).toBeNull();
  });

  it('produces a transform patch for a layer-target control and nothing for a cfg one', () => {
    expect(transformPatchOf(opacity, 0.4)).toEqual({ a: 0.4 });
    expect(transformPatchOf(fit, 'cover')).toBeNull();
  });

  /**
   * The rule that keeps "Opacity" from being a way to change what a layer IS.
   *
   * Only `t.<key>` is addressable, and only with a number: a control declaring
   * `path: 't'`, `path: 't.frame.w'` or handing over a string writes nothing at
   * all rather than something surprising.
   */
  it('refuses anything that is not a single numeric transform field', () => {
    const bad = (path: string): StripControl => ({ ...opacity, path });
    expect(transformPatchOf(bad('t'), 1)).toBeNull();
    expect(transformPatchOf(bad('frame.w'), 1)).toBeNull();
    expect(transformPatchOf(bad('t.frame.w'), 1)).toBeNull();
    expect(transformPatchOf(opacity, 'half')).toBeNull();
    expect(transformPatchOf(opacity, Number.NaN)).toBeNull();
  });
});

describe('a well-formed strip', () => {
  const more: StripControl = { id: 'more', label: 'More', control: 'more' };
  const toggle = (id: string): StripControl => ({
    id,
    label: id,
    control: 'toggle',
    target: 'cfg',
    path: id,
  });

  it('is one to five controls with More last', () => {
    expect(stripIsWellFormed([more])).toBe(true);
    expect(stripIsWellFormed([toggle('a'), toggle('b'), more])).toBe(true);
  });

  it('is not six', () => {
    const six = [toggle('a'), toggle('b'), toggle('c'), toggle('d'), toggle('e'), more];
    expect(six).toHaveLength(MAX_STRIP_CONTROLS + 1);
    expect(stripIsWellFormed(six)).toBe(false);
  });

  it('is not empty, does not end anywhere else, and does not repeat an id', () => {
    expect(stripIsWellFormed([])).toBe(false);
    expect(stripIsWellFormed([more, toggle('a')])).toBe(false);
    expect(stripIsWellFormed([toggle('a'), toggle('a'), more])).toBe(false);
    // `More` is the last control and only the last control.
    expect(stripIsWellFormed([{ ...more, id: 'more2' }, more])).toBe(false);
  });
});
