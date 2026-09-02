import { describe, expect, it } from 'vitest';

import { baseLook, type Look } from '../../../state/look/types';

import { testRegistry } from './__fixtures__/placements';
import { applyGesture, beginGesture, endGesture, type GestureContext } from './gesture';
import { HISTORY_LIMIT, createLookHistory, type LookChangeOrigin } from './history';
import { addLayer, setTransform } from './ops';

/**
 * Undo is a property of this window, not of the document.
 *
 * The remote case is the one worth staring at: somebody else's edit becomes an
 * ENTRY rather than an interruption, because the document is last-writer-wins
 * and pretending otherwise would be a merge nobody asked for (§11.9).
 */

function fakeStore(initial: Look): {
  store: Parameters<typeof createLookHistory>[0];
  emit: (look: Look, origin: LookChangeOrigin) => void;
  current: () => Look;
  writes: () => number;
} {
  let look = initial;
  let writes = 0;
  const listeners = new Set<(l: Look, o: LookChangeOrigin) => void>();
  return {
    store: {
      getLook: () => look,
      setLook: (next) => {
        look = next;
        writes++;
        for (const cb of listeners) cb(next, 'local');
      },
      subscribe: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    },
    emit: (next, origin) => {
      look = next;
      for (const cb of listeners) cb(next, origin);
    },
    current: () => look,
    writes: () => writes,
  };
}

function withStats(look: Look, y: number): Look {
  const added = addLayer(look, 'stats', testRegistry, { t: { y } });
  if (!added.ok) throw new Error(added.reason);
  return added.look;
}

describe('the ring', () => {
  it('keeps 50 of 51 pushes', () => {
    const initial = baseLook('video');
    const fake = fakeStore(initial);
    const history = createLookHistory(fake.store);

    let look = initial;
    for (let i = 0; i < HISTORY_LIMIT + 1; i++) {
      look = withStats(baseLook('video'), 0.1 + i / 1000);
      history.push(look);
    }
    expect(history.depth()).toBe(HISTORY_LIMIT);

    for (let i = 0; i < HISTORY_LIMIT; i++) expect(history.undo()).toBe(true);
    expect(history.undo()).toBe(false);
    expect(history.canUndo()).toBe(false);
  });

  it('honours a smaller limit', () => {
    const fake = fakeStore(baseLook('video'));
    const history = createLookHistory(fake.store, { limit: 2 });
    for (const y of [0.1, 0.2, 0.3]) history.push(withStats(baseLook('video'), y));
    expect(history.depth()).toBe(2);
  });

  it('ignores a push that changes nothing', () => {
    const initial = baseLook('video');
    const fake = fakeStore(initial);
    const history = createLookHistory(fake.store);
    history.push({ layers: [...initial.layers] });
    expect(history.canUndo()).toBe(false);
  });
});

describe('undo / redo', () => {
  it('writes the previous look back through the store', () => {
    const initial = baseLook('video');
    const fake = fakeStore(initial);
    const history = createLookHistory(fake.store);
    const one = withStats(initial, 0.6);
    history.push(one);

    expect(history.undo()).toBe(true);
    expect(fake.current()).toEqual(initial);
    expect(history.canRedo()).toBe(true);

    expect(history.redo()).toBe(true);
    expect(fake.current()).toEqual(one);
    expect(fake.writes()).toBe(2);
  });

  it('does not re-enter itself: its own write echoes back as a no-op', () => {
    const initial = baseLook('video');
    const fake = fakeStore(initial);
    const history = createLookHistory(fake.store);
    history.push(withStats(initial, 0.6));
    history.undo();
    expect(history.depth()).toBe(0);
    expect(history.canRedo()).toBe(true);
  });

  it('clears redo once a new edit lands', () => {
    const initial = baseLook('video');
    const fake = fakeStore(initial);
    const history = createLookHistory(fake.store);
    history.push(withStats(initial, 0.6));
    history.undo();
    expect(history.canRedo()).toBe(true);
    history.push(withStats(initial, 0.2));
    expect(history.canRedo()).toBe(false);
  });
});

describe('a gesture is one entry', () => {
  it('records the drag once, however many frames it took', () => {
    const seeded = withStats(baseLook('video'), 0.6);
    const fake = fakeStore(seeded);
    const history = createLookHistory(fake.store);
    const layer = seeded.layers[1];
    if (layer === undefined) throw new Error('no layer');

    const ctx: GestureContext = {
      look: seeded,
      registry: testRegistry,
      panel: { shape: 'circle' },
      render: { safeRadiusPct: 0.88 },
    };
    const gs = beginGesture(layer, 'move', { x: 0, y: 0.6 }, ctx);
    for (const x of [0.1, 0.2, 0.3, 0.4]) applyGesture(gs, { x, y: 0.6 }, { snap: false });
    history.push(endGesture(gs, seeded));

    expect(history.depth()).toBe(1);
    history.undo();
    expect(fake.current().layers[1]?.t.x).toBe(0);
  });
});

describe('a remote change', () => {
  it('becomes an entry and clears redo — undoing it is just last-writer-wins', () => {
    const initial = baseLook('video');
    const fake = fakeStore(initial);
    const history = createLookHistory(fake.store);
    history.push(withStats(initial, 0.6));
    history.undo();
    expect(history.canRedo()).toBe(true);

    fake.emit(withStats(initial, 0.9), 'sync');
    expect(history.canRedo()).toBe(false);
    expect(history.depth()).toBe(1);

    history.undo();
    expect(fake.current()).toEqual(initial);
  });

  it('ignores a local commit — the caller pushes those itself, once per edit', () => {
    const seeded = withStats(baseLook('video'), 0.6);
    const fake = fakeStore(seeded);
    const history = createLookHistory(fake.store);
    const id = seeded.layers[1]?.id ?? '';
    fake.emit(setTransform(seeded, id, { x: 0.2 }), 'local');
    expect(history.canUndo()).toBe(false);
  });

  it('stops listening once disposed', () => {
    const initial = baseLook('video');
    const fake = fakeStore(initial);
    const history = createLookHistory(fake.store);
    history.dispose();
    fake.emit(withStats(initial, 0.9), 'storage');
    expect(history.canUndo()).toBe(false);
  });
});
