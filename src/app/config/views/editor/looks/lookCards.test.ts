import { describe, expect, it } from 'vitest';

import { MAX_LOOK_FILE_BYTES } from '../../../../../state/look/file';

import {
  CHOOSE_FROM_LIBRARY,
  GALLERY_UNAVAILABLE,
  placeholderCard,
  refusalCard,
  SEND_FROM_PHONE,
  SHELF_FULL,
} from './lookCards';

import type { LookFileRefusal, LookPlaceholder } from '../../../../../state/look/file';

/**
 * Every refusal the importer can produce, enumerated HERE rather than derived
 * from the code under test — the point is that a sixth refusal added to
 * `file.ts` fails this file until somebody writes its words, and a table
 * generated from the union would happily pass with a missing sentence.
 */
const EVERY_REFUSAL: readonly LookFileRefusal[] = [
  { code: 'not-json', detail: 'SyntaxError: Unexpected token' },
  { code: 'not-an-object' },
  { code: 'wrong-format', got: 'somebody-elses-app' },
  { code: 'too-big', bytes: 200_000, max: MAX_LOOK_FILE_BYTES },
  { code: 'future-version', got: 99, max: 7 },
];

describe('a refused file gets words, never a code', () => {
  for (const reason of EVERY_REFUSAL) {
    it(`${reason.code} has a card`, () => {
      const card = refusalCard(reason);
      expect(card.title).not.toBe('');
      expect(card.detail.length).toBeGreaterThan(20);
      // The one thing a card may never contain is the value the program uses.
      expect(`${card.title} ${card.detail}`).not.toContain(reason.code);
    });
  }

  it('says how big is too big, in the units a person reads', () => {
    const card = refusalCard({ code: 'too-big', bytes: 200_000, max: MAX_LOOK_FILE_BYTES });
    expect(card.detail).toContain('64 kB');
    expect(card.detail).toContain('195 kB');
  });

  it('promises the user’s own copy is untouched by a future-version refusal', () => {
    expect(refusalCard({ code: 'future-version', got: 9, max: 7 }).detail).toContain('untouched');
  });
});

describe('a hole in an applied Look', () => {
  const named: LookPlaceholder = {
    layerId: 'base',
    ref: { role: 'base', kind: 'hash', value: 'abc', name: 'Nebula.mp4' },
    reason: 'not-in-library',
  };
  const anonymous: LookPlaceholder = {
    layerId: 'l1',
    ref: { role: 'l1', kind: 'hash', value: 'abc' },
    reason: 'not-in-library',
  };

  it('names the file, because that is the whole value of the card', () => {
    expect(placeholderCard(named, 'cam').title).toContain('Nebula.mp4');
  });

  it('does not claim to know a name it was not given', () => {
    expect(placeholderCard(anonymous, 'cam').title).not.toContain('undefined');
  });

  it('offers the move the SURFACE can actually make', () => {
    expect(placeholderCard(named, 'cam').action).toBe(CHOOSE_FROM_LIBRARY);
    expect(placeholderCard(named, 'phone').action).toBe(SEND_FROM_PHONE);
  });

  it('says the rest of the Look was applied, on both surfaces', () => {
    for (const surface of ['cam', 'phone'] as const) {
      expect(placeholderCard(named, surface).detail).toContain('rest of the Look was applied');
    }
  });
});

describe('the two standing cards', () => {
  it('names the way out of a full shelf', () => {
    expect(SHELF_FULL.detail).toContain('Export');
  });

  it('says where the gallery Looks are when the folder is not shipped', () => {
    expect(GALLERY_UNAVAILABLE.detail).toContain('looks/');
  });
});
