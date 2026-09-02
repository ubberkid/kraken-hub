/**
 * The merge, and the reason it cannot be argued with.
 *
 * ## The model
 *
 * The synced document is a map from LEAF PATH to a last-writer-wins register:
 * a value and the hybrid-logical-clock stamp of the write that put it there
 * (`src/sync/leaves.ts` defines what a leaf is; `src/sync/hlc.ts` defines the
 * clock). Merging two documents is done leaf by leaf, and each leaf keeps the
 * register that ranks higher in the total order below.
 *
 * ```
 * merge(A, B)[k] = A[k]                    if k ∉ B
 *                = B[k]                    if k ∉ A
 *                = max(A[k], B[k])         by rank(register)
 *
 * rank(r) = (r.stamp.t, r.stamp.c, r.stamp.s, canonical(r.value) IF EPOCH)
 * ```
 *
 * The value is the LAST component of the rank and it is reached only when two
 * registers carry the same stamp AND that stamp is `EPOCH` — two leaves NOBODY
 * has ever written. Those exist: a page that has been running since before this
 * design shipped restores its document with no stamps at all (`appSync` migrates
 * a missing stamp to `EPOCH`), and two such pages can hold different values for
 * a leaf no live peer has ever written. Without the last component that pair is
 * a genuine tie, both sides keep what they have, and the room is split on a leaf
 * no human can unstick except by touching it. With it, the tie is broken
 * identically everywhere, from data both peers hold. It is arbitrary — the
 * larger canonical JSON wins — and it is arbitrary in the only place where
 * nobody has expressed a preference.
 *
 * The guard on that fallback is not decoration. `tick` never issues one writer
 * two stamps at the same `(t, c)`, so a REAL stamp shared by two different
 * values is not a tie at all: it is proof that one side is holding a value its
 * stamp never described. Settling that by string order is exactly how a
 * superseded value once laundered itself across an entire room. It is handled
 * separately, and asymmetrically — see `compareRegisters`.
 *
 * ## Why convergence is a theorem rather than a hope
 *
 * `compareStamps` is a TOTAL order on stamps: `t`, then `c`, then the writer's
 * id, and a writer never issues two stamps with the same `(t, c)` because
 * `tick` increments `c` whenever the millisecond has not moved. So per leaf,
 * `merge` is `max` over a totally ordered set, which is:
 *
 *  - **commutative** — `max(a, b) = max(b, a)`, so the order two frames arrive
 *    in cannot change the result;
 *  - **associative** — `max(max(a, b), c) = max(a, max(b, c))`, so it does not
 *    matter how frames are batched, relayed or re-relayed;
 *  - **idempotent** — `max(a, a) = a`, so a duplicate, a keepalive republish
 *    and a retained replay are all no-ops.
 *
 * A map of such registers, merged key-wise, inherits all three. That is the
 * definition of a state-based CRDT (a join-semilattice), and its convergence
 * property is standard: any two replicas that have received the same SET of
 * writes — in any order, any number of times, batched any way — hold the same
 * value for every leaf. No peer needs to know what any other peer has seen, so
 * there is nothing to acknowledge, nothing to refuse, and no state in which two
 * peers can be waiting for each other. That last clause is the whole point: the
 * design this replaced was correct about causality and had two distinct
 * permanent deadlocks and a laundering path, all of them consequences of the
 * merge being a NEGOTIATION between peers rather than a function of the data.
 *
 * `src/sync/mergeLaws.test.ts` asserts the three laws over random register
 * sets, and the convergence property itself is asserted end-to-end by the
 * random-interleaving seeds in `threePeerConvergence.dom.test.ts`.
 *
 * The one deliberate exception is the corruption case above, where the merge
 * prefers the INCOMING register rather than a deterministic function of both.
 * That set of inputs is unreachable from honest writers, so the theorem's
 * domain is untouched; what it buys is that a page which somehow got there can
 * relearn the room instead of defending its lie forever.
 *
 * ## What the theorem does NOT promise
 *
 * That everyone ends up with the value the person who tapped LAST intended.
 * Two writes ordered by the wall clock within the devices' skew of each other
 * resolve by whichever clock reads later. See the note in `hlc.ts`.
 */

import { createLogger } from '../lib/log';

import { compareStamps, type Stamp } from './hlc';

const log = createLogger('sync/merge');

/** One leaf's value and the write that put it there. */
export interface Register {
  value: unknown;
  stamp: Stamp;
}

export type Registers = Map<string, Register>;

/**
 * Key-sorted JSON, so two peers that built the same object in a different order
 * produce the same string. Only ever computed on a stamp tie.
 */
function canonical(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/**
 * A non-EPOCH stamp collision between two DIFFERENT values, logged once.
 *
 * `tick` never issues one writer two stamps at the same `(t, c)`, so this
 * cannot happen between two honest live writers. It happened once for real:
 * a page persisted its stamps and its values through two unsynchronised
 * writes, reloaded inside the gap, and paired the room's newest stamp with the
 * value it held BEFORE that write. See `src/sync/appSync.ts`'s `StoredClock`,
 * which is now a self-contained register table precisely so this cannot recur.
 */
let warnedCollision = false;

/**
 * The order registers are merged by. Negative when `a` is earlier.
 *
 * `compareStamps` decides everything a human ever did. Below it there are two
 * cases, and telling them apart is the whole point:
 *
 *  - **Both stamps are `EPOCH`.** Two leaves nobody has ever written, holding
 *    different values — a real situation for two pages that restored documents
 *    written before stamps existed. `canonical(value)` breaks it identically on
 *    both sides, arbitrarily, in the only place where nobody expressed a
 *    preference. This is the ONLY case that fallback is for.
 *  - **A real stamp, two different values.** Not a tie: evidence that one side
 *    is holding a value its stamp never described. Deciding it by string order
 *    is what laundered a superseded value across a whole room. So the INCOMING
 *    register wins — `mergeInto` reads a negative as "take theirs" — which lets
 *    a page carrying a mispaired register relearn the room from the very next
 *    frame instead of defending a lie forever.
 *
 * That second rule is deliberately ASYMMETRIC, and it is the one place this
 * file is not a lattice join. It is a considered trade: the algebra is intact
 * over every register set the system can actually produce (distinct writes
 * carry distinct stamps — see `hlc.ts`), and outside that domain a self-healing
 * answer beats a deterministic wrong one. `mergeLaws.test.ts` states the law
 * over the honest domain and pins this case separately.
 */
export function compareRegisters(a: Register, b: Register): number {
  const byStamp = compareStamps(a.stamp, b.stamp);
  if (byStamp !== 0) return byStamp;
  const av = canonical(a.value);
  const bv = canonical(b.value);
  if (av === bv) return 0;
  if (a.stamp.t === 0 && a.stamp.c === 0 && a.stamp.s === '') return av < bv ? -1 : 1;
  if (!warnedCollision) {
    warnedCollision = true;
    log.warn(
      'kraken-hub: two registers share a stamp but differ in value — one side is ' +
        'holding a value its stamp never described; taking the incoming one.',
    );
  }
  return -1;
}

/**
 * Merge `incoming` into `target`, in place, and answer whether anything moved.
 *
 * In place because the caller holds one document for the life of the page and
 * copying it per frame would allocate the whole state five times a second; the
 * function is still the pure `max` above, applied leaf by leaf. "Nothing moved"
 * is the answer for a duplicate, a keepalive and a retained replay of something
 * this page already has, which is what lets the caller skip a re-resolve and a
 * React render for the overwhelming majority of frames.
 */
export function mergeInto(target: Registers, incoming: ReadonlyMap<string, Register>): boolean {
  let changed = false;
  for (const [path, next] of incoming) {
    const held = target.get(path);
    if (held === undefined) {
      target.set(path, next);
      changed = true;
      continue;
    }
    // `>= 0` keeps the incumbent on an exact tie, which by the totality of the
    // order can only mean the SAME value written at the SAME stamp.
    if (compareRegisters(held, next) >= 0) continue;
    target.set(path, next);
    changed = true;
  }
  return changed;
}
