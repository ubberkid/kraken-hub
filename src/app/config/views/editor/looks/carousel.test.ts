import { describe, expect, it } from 'vitest';

import { LOOK_TEMPLATES } from '../../../../../state/look/templates';
import { addLook, EMPTY_DOC, type LooksDoc } from '../../../editor/looksStore';

import {
  CAROUSEL_INTERVALS,
  carouselLooks,
  carouselReady,
  carouselStep,
  intervalLabel,
  MIN_CAROUSEL_LOOKS,
} from './carousel';

import type { CarouselSettings } from '../../../../../state/schema';

const FILE = LOOK_TEMPLATES[0]!.file;

function shelf(ids: readonly string[]): LooksDoc {
  let doc = EMPTY_DOC;
  ids.forEach((id, i) => {
    const result = addLook(doc, { ...FILE, name: id }, i, id);
    if (result.ok) doc = result.doc;
  });
  return doc;
}

const DOC = shelf(['a', 'b', 'c']);
const SETTINGS: CarouselSettings = { lookIds: ['a', 'b'], intervalSec: 30 };

describe('the set', () => {
  it('is the ids that still resolve, in the order the settings name', () => {
    expect(carouselLooks({ lookIds: ['b', 'a'], intervalSec: 30 }, DOC).map((l) => l.id)).toEqual([
      'b',
      'a',
    ]);
  });

  it('skips an id whose Look was deleted rather than failing', () => {
    const gone: CarouselSettings = { lookIds: ['a', 'gone', 'b'], intervalSec: 30 };
    expect(carouselLooks(gone, DOC).map((l) => l.id)).toEqual(['a', 'b']);
    expect(carouselReady(gone, DOC)).toBe(true);
  });

  it('is not a rotation below two', () => {
    expect(carouselReady({ lookIds: ['a'], intervalSec: 30 }, DOC)).toBe(false);
    expect(carouselReady(undefined, DOC)).toBe(false);
    expect(MIN_CAROUSEL_LOOKS).toBe(2);
  });
});

describe('the tick', () => {
  const base = { settings: SETTINGS, doc: DOC, owns: true };

  it('belongs to the window that owns the shelf, and to no other', () => {
    expect(
      carouselStep({ ...base, owns: false, showingId: null, shownAt: 0, now: 1_000 }),
    ).toBeNull();
  });

  it('shows the first Look at once rather than making somebody wait an interval', () => {
    expect(carouselStep({ ...base, showingId: null, shownAt: 0, now: 1_000 })?.id).toBe('a');
  });

  it('holds until the interval has actually elapsed', () => {
    expect(carouselStep({ ...base, showingId: 'a', shownAt: 1_000, now: 20_000 })).toBeNull();
    expect(carouselStep({ ...base, showingId: 'a', shownAt: 1_000, now: 31_001 })?.id).toBe('b');
  });

  it('wraps', () => {
    expect(carouselStep({ ...base, showingId: 'b', shownAt: 0, now: 60_000 })?.id).toBe('a');
  });

  it('starts again from the top when the Look it was on left the set', () => {
    expect(carouselStep({ ...base, showingId: 'c', shownAt: 1, now: 60_000 })?.id).toBe('a');
  });

  it('does nothing at all with no settings, or with a set that shrank to one', () => {
    expect(
      carouselStep({ ...base, settings: undefined, showingId: null, shownAt: 0, now: 1 }),
    ).toBeNull();
    expect(
      carouselStep({
        ...base,
        settings: { lookIds: ['a', 'gone'], intervalSec: 30 },
        showingId: null,
        shownAt: 0,
        now: 1,
      }),
    ).toBeNull();
  });
});

describe('the interval picker', () => {
  it('runs from half a minute to an hour, as §4 asks', () => {
    expect(CAROUSEL_INTERVALS[0]).toBe(30);
    expect(CAROUSEL_INTERVALS[CAROUSEL_INTERVALS.length - 1]).toBe(3600);
  });

  it('never shows a bare number', () => {
    for (const sec of CAROUSEL_INTERVALS) expect(intervalLabel(sec)).toMatch(/\d+ (s|min|h)$/);
    expect(intervalLabel(300)).toBe('5 min');
    expect(intervalLabel(3600)).toBe('1 h');
  });
});
