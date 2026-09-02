import { beforeEach, describe, expect, it } from 'vitest';

import { nsKey } from '../../../platform/storage';
import { LOOK_TEMPLATES } from '../../../state/look/templates';

import {
  addLook,
  EMPTY_DOC,
  LEGACY_LOOK_NAME_SUFFIX,
  LOOKS_SUFFIX,
  readLookName,
  readLooksDoc,
  updateLooksDoc,
  writeLooksDoc,
  type LooksDoc,
} from './looksStore';

import type { LookFile } from '../../../state/look/file';

/** A real template file, because a fixture that is not a Look proves nothing. */
const FILE: LookFile = LOOK_TEMPLATES[0]!.file;

function docWith(n: number): LooksDoc {
  let doc = EMPTY_DOC;
  for (let i = 0; i < n; i += 1) {
    const result = addLook(doc, { ...FILE, name: `Look ${String(i)}` }, i, `id${String(i)}`);
    if (result.ok) doc = result.doc;
  }
  return doc;
}

beforeEach(() => {
  localStorage.clear();
});

describe('persistence', () => {
  it('round-trips through the namespaced key', () => {
    writeLooksDoc(docWith(2));
    expect(localStorage.getItem(nsKey(LOOKS_SUFFIX))).not.toBeNull();
    expect(readLooksDoc().looks.map((l) => l.id)).toEqual(['id0', 'id1']);
  });

  it('survives a corrupt key without losing the app', () => {
    localStorage.setItem(nsKey(LOOKS_SUFFIX), '{{{');
    expect(readLooksDoc()).toEqual(EMPTY_DOC);
  });

  it('adopts the name W5 left in its own key, once', () => {
    localStorage.setItem(nsKey(LEGACY_LOOK_NAME_SUFFIX), 'Slow tide');
    expect(readLookName()).toBe('Slow tide');
    // The first write retires the old key, so the two can never disagree.
    updateLooksDoc((d) => d);
    expect(localStorage.getItem(nsKey(LEGACY_LOOK_NAME_SUFFIX))).toBeNull();
  });
});
