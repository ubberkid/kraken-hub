import { describe, expect, it } from 'vitest';

import { LOOK_TEMPLATES } from '../../../state/look/templates';

import {
  addLook,
  copyName,
  deleteSaved,
  duplicateSaved,
  EMPTY_DOC,
  MAX_SAVED_LOOKS,
  mintLookId,
  parseLooksDoc,
  renameSaved,
  reorderSaved,
  sortLooks,
  toggleFavourite,
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

describe('parseLooksDoc', () => {
  it('turns anything at all into a usable document', () => {
    for (const junk of [null, undefined, 0, 'not json', '{', [], { looks: 'no' }]) {
      expect(parseLooksDoc(junk).looks).toEqual([]);
    }
  });

  it('keeps the good rows in a shelf with a corrupt one', () => {
    const doc = docWith(3);
    const wire = JSON.parse(JSON.stringify(doc)) as { looks: unknown[] };
    // One row's file is replaced by something that is not a Look at all.
    (wire.looks[1] as { file: unknown }).file = { format: 'somebody-elses-app' };
    const back = parseLooksDoc(wire);
    expect(back.looks.map((l) => l.id)).toEqual(['id0', 'id2']);
  });

  it('drops a row with no usable id rather than minting one', () => {
    const back = parseLooksDoc({ looks: [{ id: 'has spaces', file: FILE }] });
    expect(back.looks).toEqual([]);
  });

  it('drops a duplicate id, keeping the first', () => {
    const back = parseLooksDoc({
      looks: [
        { id: 'a', file: { ...FILE, name: 'first' } },
        { id: 'a', file: { ...FILE, name: 'second' } },
      ],
    });
    expect(back.looks.map((l) => l.file.name)).toEqual(['first']);
  });

  it('never reads past the cap, however long the stored array is', () => {
    const rows = Array.from({ length: MAX_SAVED_LOOKS + 20 }, (_, i) => ({
      id: `id${String(i)}`,
      file: FILE,
      order: i,
    }));
    expect(parseLooksDoc({ looks: rows }).looks).toHaveLength(MAX_SAVED_LOOKS);
  });
});

describe('the shelf', () => {
  it('refuses at the cap instead of evicting somebody’s work', () => {
    const full = docWith(MAX_SAVED_LOOKS);
    expect(full.looks).toHaveLength(MAX_SAVED_LOOKS);
    const result = addLook(full, FILE, 1);
    expect(result).toEqual({ ok: false, reason: 'full' });
    // …and nothing was lost proving it.
    expect(full.looks).toHaveLength(MAX_SAVED_LOOKS);
  });

  it('sorts favourites first and is total on every tie', () => {
    const rows = [
      { id: 'b', file: FILE, favourite: false, order: 1, updatedAt: 0 },
      { id: 'a', file: FILE, favourite: false, order: 1, updatedAt: 0 },
      { id: 'c', file: FILE, favourite: true, order: 9, updatedAt: 0 },
    ];
    expect(sortLooks(rows).map((l) => l.id)).toEqual(['c', 'a', 'b']);
    // Stable: the same input gives the same answer, which is what makes a
    // reorder look the same in two windows.
    expect(sortLooks([...rows].reverse()).map((l) => l.id)).toEqual(['c', 'a', 'b']);
  });

  it('renames the FILE, because that is what travels', () => {
    const doc = renameSaved(docWith(1), 'id0', '  Slow tide  ', 5);
    expect(doc.looks[0]?.file.name).toBe('Slow tide');
    expect(doc.looks[0]?.updatedAt).toBe(5);
  });

  it('lands a duplicate immediately after its original', () => {
    const doc = docWith(3);
    const result = duplicateSaved(doc, 'id1', 9, 'copy');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.looks.map((l) => l.id)).toEqual(['id0', 'id1', 'copy', 'id2']);
  });

  it('numbers repeated copies rather than making two of one name', () => {
    expect(copyName('Slow tide')).toBe('Slow tide copy');
    expect(copyName('Slow tide copy')).toBe('Slow tide copy 2');
    expect(copyName('Slow tide copy 2')).toBe('Slow tide copy 3');
  });

  it('reorders by renumbering, so orders never drift', () => {
    const moved = reorderSaved(docWith(4), 'id3', 0);
    expect(moved.looks.map((l) => l.id)).toEqual(['id3', 'id0', 'id1', 'id2']);
    expect(moved.looks.map((l) => l.order)).toEqual([0, 1, 2, 3]);
  });

  it('favourites and deletes exactly one row', () => {
    const doc = toggleFavourite(docWith(2), 'id1', 1);
    expect(doc.looks.find((l) => l.id === 'id1')?.favourite).toBe(true);
    expect(deleteSaved(doc, 'id1').looks.map((l) => l.id)).toEqual(['id0']);
  });

  it('mints ids the document validator will accept', () => {
    expect(mintLookId(() => 0.5)).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
  });
});
