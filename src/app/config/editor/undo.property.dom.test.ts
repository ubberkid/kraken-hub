import { describe, expect, it } from 'vitest';

import { defaultAppState } from '../../../state/defaults';
import { baseLook, IDENTITY, type Look, type Transform } from '../../../state/look/types';
import { createStore } from '../../../state/store';

import { createLookHistory } from './history';
import { createStoreLookHistory } from './lookHistoryStore';
import {
  addLayer,
  bringForward,
  duplicateLayer,
  removeLayer,
  renameLayer,
  sendBackward,
  setTransform,
  toggleLayer,
} from './ops';
import { fakeRegistry, type EditorRegistry } from './registryPort';

/**
 * §11's ✓: **undo across 10 random ops restores exactly**.
 *
 * A property test rather than a scripted one, because the failure mode this
 * guards against is not "undo is broken" — that would show up in the first
 * example — it is "undo is broken for one SEQUENCE", which is what an inverse-op
 * stack gets wrong and what a snapshot stack is right about by construction.
 * Running a hundred random walks over the real ops is the cheapest way to say
 * that the construction actually holds for the ops that exist.
 *
 * It runs twice over the same generator: once against the pure model, and once
 * against the model BOUND to a real store, because the binding is where the
 * origin mapping lives and an origin mapped wrong makes the caller's own edit
 * arrive twice.
 */

const REGISTRY: EditorRegistry = fakeRegistry({
  video: {
    roles: ['base'],
    maxInstances: 1,
    resize: 'scale',
    minFrame: 0.5,
    overlayDefault: { frame: { w: 1, h: 1, shape: 'square' }, t: IDENTITY },
  },
  clock: {
    roles: ['base', 'overlay'],
    maxInstances: 8,
    resize: 'frame',
    minFrame: 0.4,
    overlayDefault: { frame: { w: 1, h: 0.5, shape: 'square' }, t: { ...IDENTITY, y: 0.55 } },
  },
  text: {
    roles: ['overlay'],
    maxInstances: 8,
    resize: 'frame',
    minFrame: 0.2,
    overlayDefault: { frame: { w: 1.2, h: 0.3, shape: 'square' }, t: { ...IDENTITY, y: -0.6 } },
  },
});

/** A deterministic PRNG, so a failing seed is a failing seed forever. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const KINDS = ['clock', 'text'] as const;

/**
 * One random op. Every op that can change a look is reachable; the ones that
 * cannot apply (removing the base, reordering with one layer) return the look
 * unchanged, which is itself a case worth generating.
 */
function randomOp(look: Look, next: () => number): Look {
  const overlays = look.layers.slice(1);
  const pick = <T>(list: readonly T[]): T | undefined =>
    list[Math.floor(next() * list.length)] ?? undefined;
  const target = pick(overlays);
  const roll = Math.floor(next() * 8);

  if (roll === 0 || target === undefined) {
    const kind = pick(KINDS) ?? 'clock';
    const result = addLayer(look, kind, REGISTRY);
    return result.ok ? result.look : look;
  }
  if (roll === 1) return removeLayer(look, target.id);
  if (roll === 2) return toggleLayer(look, target.id, !target.on);
  if (roll === 3) return renameLayer(look, target.id, `L${String(Math.floor(next() * 100))}`);
  if (roll === 4) {
    const patch: Partial<Transform> = {
      x: Math.round((next() * 2 - 1) * 1000) / 1000,
      y: Math.round((next() * 2 - 1) * 1000) / 1000,
      r: Math.round((next() * 360 - 180) * 10) / 10,
    };
    return setTransform(look, target.id, patch);
  }
  if (roll === 5) return bringForward(look, target.id);
  if (roll === 6) return sendBackward(look, target.id);
  const dup = duplicateLayer(look, target.id, REGISTRY);
  return dup.ok ? dup.look : look;
}

const OPS = 10;
const SEEDS = 120;

describe('undo restores exactly, across ten random ops', () => {
  it('on the pure model', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const next = rng(seed);
      let look = baseLook('video');
      const start = JSON.stringify(look);

      const history = createLookHistory({
        getLook: () => look,
        setLook: (l) => {
          look = l;
        },
      });

      const seen: string[] = [start];
      for (let i = 0; i < OPS; i++) {
        look = randomOp(look, next);
        history.push(look);
        seen.push(JSON.stringify(look));
      }

      // Walk all the way back. Each step must land on the state that produced
      // it — not merely on *a* previous state.
      for (let i = seen.length - 1; i > 0; i--) {
        expect(JSON.stringify(look), `seed ${String(seed)}, step ${String(i)}`).toBe(seen[i]);
        // A push that changed nothing is not an entry, so `undo()` may have
        // nothing to do at a step where the op was a no-op.
        // A push that changed nothing is not an entry, so a no-op step has
        // nothing to undo. Asserted as a value rather than a conditional
        // `expect`, so the walk is one assertion per step either way.
        const stepped = seen[i] === seen[i - 1] ? true : history.undo();
        expect(stepped, `seed ${String(seed)}, undo at step ${String(i)}`).toBe(true);
      }
      expect(JSON.stringify(look), `seed ${String(seed)} did not return to the start`).toBe(start);
      expect(history.canUndo()).toBe(false);

      // …and redo walks forward to exactly where it was.
      while (history.redo()) {
        /* to the end */
      }
      expect(JSON.stringify(look)).toBe(seen.at(-1));
    }
  });

  /**
   * The same property, through the real store.
   *
   * `createStoreLookHistory` maps `onCommit`'s `'local'` to the model's
   * `'local'`, which is what stops the caller's own edit being recorded twice —
   * once by `push` and once by the subscription. If that mapping is wrong this
   * test fails on the first seed, because one undo would then walk back half a
   * step.
   */
  it('through the store binding', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const nextRandom = rng(seed);
      const store = createStore({ ...defaultAppState(), look: baseLook('video') }, 'config', {
        commitBase: 'snapshot',
      });

      const history = createStoreLookHistory(store);
      const lookNow = (): Look => store.getSnapshot().look;
      const seen: string[] = [JSON.stringify(lookNow())];

      for (let i = 0; i < OPS; i++) {
        const nextLook = randomOp(lookNow(), nextRandom);
        store.commit((s) => ({ ...s, look: nextLook }));
        history.push(store.getSnapshot().look);
        seen.push(JSON.stringify(store.getSnapshot().look));
      }

      for (let i = seen.length - 1; i > 0; i--) {
        expect(JSON.stringify(lookNow()), `seed ${String(seed)}, step ${String(i)}`).toBe(seen[i]);
        // A push that changed nothing is not an entry, so a no-op step has
        // nothing to undo. Asserted as a value rather than a conditional
        // `expect`, so the walk is one assertion per step either way.
        const stepped = seen[i] === seen[i - 1] ? true : history.undo();
        expect(stepped, `seed ${String(seed)}, undo at step ${String(i)}`).toBe(true);
      }
      expect(JSON.stringify(lookNow())).toBe(seen[0]);
      history.dispose();
    }
  });
});
