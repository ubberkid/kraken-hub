/**
 * The three laws the convergence argument rests on.
 *
 * `src/sync/merge.ts` claims that merging register maps is commutative,
 * associative and idempotent, and that convergence follows from those three as
 * a theorem rather than as a hope. The convergence suites prove the room
 * behaves; this proves the algebra, over random inputs, in a millisecond — so
 * when a room misbehaves there is an answer to "is the merge still a
 * semilattice, or is it the plumbing?".
 */

import { describe, expect, it } from 'vitest';

import { EPOCH, compareStamps, tick, type Stamp } from './hlc';
import { mergeInto, type Register, type Registers } from './merge';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const PATHS = ['activeModuleId', 'render.fit', 'render.rotate', 'look.order', 'look.layer.base'];
const SRCS = ['configpeer01', 'phonepeera01', 'phonepeerb01', 'displaypeer1'];

/**
 * A random register map from the domain the SYSTEM CAN ACTUALLY PRODUCE.
 *
 * One rule, and it is `tick`'s rule rather than a convenience: a stamp
 * IDENTIFIES a write, so two registers carrying the same non-EPOCH stamp are
 * two copies of the same write and therefore hold the same value. `tick` never
 * issues one writer two stamps at the same `(t, c)`, and `(t, c, s)` is total,
 * so no honest pair of peers can produce a counter-example.
 *
 * `EPOCH` is the exception, and the interesting case: nobody wrote those, so
 * two pages really can hold different values for one, and the laws still have
 * to hold across that pair. That is what the `canonical(value)` tie-break is
 * for, and these seeds are what prove it.
 *
 * The pair this generator deliberately cannot produce — a REAL stamp against
 * two different values — is corruption rather than concurrency, and the merge
 * answers it asymmetrically on purpose. It is pinned below, on its own.
 */
function randomRegisters(random: () => number): Registers {
  const out: Registers = new Map();
  for (const path of PATHS) {
    if (random() < 0.25) continue;
    // A quarter of the leaves are unstamped, which is the interesting case: two
    // pages that restored a document written before stamps existed.
    const unstamped = random() < 0.25;
    const stamp: Stamp = unstamped
      ? EPOCH
      : {
          t: 1_700_000_000_000 + Math.floor(random() * 5),
          c: Math.floor(random() * 3),
          s: SRCS[Math.floor(random() * SRCS.length)] ?? 'p',
        };
    const value: unknown = unstamped
      ? Math.floor(random() * 4)
      : `${stamp.s}@${String(stamp.t)}.${String(stamp.c)}`;
    out.set(path, { value, stamp });
  }
  return out;
}

function merged(...maps: ReadonlyMap<string, Register>[]): Registers {
  const target: Registers = new Map();
  for (const m of maps) mergeInto(target, m);
  return target;
}

/** Order-independent, so two maps that agree compare equal however they were built. */
function snapshot(m: Registers): string {
  return [...m.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(
      ([path, r]) =>
        `${path}=${JSON.stringify(r.value)}@${String(r.stamp.t)}.${String(r.stamp.c)}.${r.stamp.s}`,
    )
    .join('|');
}

describe('the merge is a join-semilattice', () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    it(`commutes, associates and is idempotent (seed ${String(seed)})`, () => {
      const random = mulberry32(seed);
      const a = randomRegisters(random);
      const b = randomRegisters(random);
      const c = randomRegisters(random);

      // Commutative: the ORDER two frames arrive in cannot change the result.
      expect(snapshot(merged(a, b))).toBe(snapshot(merged(b, a)));

      // Associative: nor can the way they are batched, relayed or re-relayed.
      expect(snapshot(merged(merged(a, b), c))).toBe(snapshot(merged(a, merged(b, c))));

      // Idempotent: a duplicate, a keepalive republish and a retained replay are
      // all no-ops — which is why none of them needs a special case any more.
      expect(snapshot(merged(a, b, b, a, b))).toBe(snapshot(merged(a, b)));
      expect(mergeInto(merged(a, b), merged(a, b))).toBe(false);
    });
  }

  it('reports "nothing moved" for a frame it already holds', () => {
    const a = randomRegisters(mulberry32(9));
    expect(mergeInto(new Map(a), a)).toBe(false);
  });

  it('breaks a tie between two unstamped values identically on both sides', () => {
    /*
     * Two pages restoring documents written before stamps existed can hold
     * different values for a leaf no live peer has ever written. Without a
     * deterministic tie-break they would both keep what they have and the room
     * would be split on a leaf nobody can unstick except by touching it.
     */
    const left: Registers = new Map([['render.fit', { value: 'cover', stamp: EPOCH }]]);
    const right: Registers = new Map([['render.fit', { value: 'contain', stamp: EPOCH }]]);
    const l = merged(left, right);
    const r = merged(right, left);
    expect(snapshot(l)).toBe(snapshot(r));
    expect(l.get('render.fit')?.value).toBe('cover');
  });

  it('takes the INCOMING value when a real stamp collides with a different one', () => {
    /*
     * Not a tie: `tick` cannot issue one writer two stamps at the same `(t, c)`,
     * so this pair is proof that one side is holding a value its stamp never
     * described. It happened for real — a page persisted its stamps and its
     * values through two unsynchronised writes and reloaded in the gap — and
     * settling it by JSON string order laundered the superseded value across the
     * whole room, permanently, because the mispaired page won the same tie on
     * every subsequent frame.
     *
     * Taking the incoming register instead means the page that got there can
     * relearn the room from the very next bootstrap. Both string orders are
     * asserted, because the bug was invisible in one of them.
     */
    const stamp: Stamp = { t: 1_700_000_000_000, c: 0, s: 'configpeer01' };
    for (const [held, incoming] of [
      ['cover', 'contain'],
      ['contain', 'cover'],
    ]) {
      const target: Registers = new Map([['render.fit', { value: held, stamp }]]);
      expect(mergeInto(target, new Map([['render.fit', { value: incoming, stamp }]]))).toBe(true);
      expect(target.get('render.fit')?.value).toBe(incoming);
    }
  });

  it('still reports "nothing moved" when a real stamp collides with the SAME value', () => {
    // The ordinary case by far: two peers holding one settled write. It has to
    // stay free of both the warning and the re-render.
    const stamp: Stamp = { t: 1_700_000_000_000, c: 4, s: 'phonepeera01' };
    const target: Registers = new Map([['render.fit', { value: 'cover', stamp }]]);
    expect(mergeInto(target, new Map([['render.fit', { value: 'cover', stamp }]]))).toBe(false);
  });
});

describe('the clock', () => {
  it('orders a reply strictly after the write it has seen, at the same millisecond', () => {
    const theirs = tick(EPOCH, 1_700_000_000_000, 'phonepeera01');
    // A page that receives it folds it in and then writes, with `now` unchanged.
    const mine = tick(theirs, 1_700_000_000_000, 'configpeer01');
    expect(compareStamps(mine, theirs)).toBeGreaterThan(0);
    expect(mine.c).toBe(theirs.c + 1);
  });

  it('orders a reply after the write it has seen even when the local clock is BEHIND', () => {
    const theirs: Stamp = { t: 1_700_000_060_000, c: 0, s: 'phonepeera01' };
    // A minute behind: `t = max(now, seen.t)` is the wall-clock floor.
    const mine = tick(theirs, 1_700_000_000_000, 'configpeer01');
    expect(compareStamps(mine, theirs)).toBeGreaterThan(0);
    expect(mine.t).toBe(theirs.t);
  });

  it('keeps `t` a real timestamp when the millisecond does move', () => {
    const first = tick(EPOCH, 1_700_000_000_000, 'p');
    const second = tick(first, 1_700_000_000_001, 'p');
    expect(second.t).toBe(1_700_000_000_001);
    expect(second.c).toBe(0);
  });

  it('never issues the same (t, c) twice for one writer', () => {
    let clock = EPOCH;
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      clock = tick(clock, 1_700_000_000_000, 'p');
      seen.add(`${String(clock.t)}.${String(clock.c)}`);
    }
    expect(seen.size).toBe(200);
  });

  it('puts EPOCH below every real write', () => {
    expect(compareStamps(EPOCH, tick(EPOCH, 1, 'p'))).toBeLessThan(0);
  });
});
