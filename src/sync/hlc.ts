/**
 * The hybrid logical clock every merge decision in this layer is made with.
 *
 * ## Why a clock at all, after three attempts that were not one
 *
 * The first design ordered writes by ARRIVAL, and lost every edit a stale
 * snapshot happened to land on top of. The second ordered them by the Lamport
 * `rev` in the storage document, which two devices keep separately and which
 * therefore compares nothing. The third — the acknowledgement map — ordered
 * them by "has the sender seen my frame?", which is a real causal question and
 * a genuinely correct answer for the writes it can order. Its problem was the
 * writes it CANNOT order: two people touching the same setting at the same
 * moment have seen nothing of each other, by definition, and a rule made only
 * of causality has nothing to say about them. Every patch for that produced a
 * deadlock, a laundered acknowledgement, or a room that split in two.
 *
 * A hybrid logical clock (Kulkarni et al., *Logical Physical Clocks and
 * Consistent Snapshotting in Globally Distributed Databases*, 2014) answers
 * both questions with one number. It is a wall-clock reading that is dragged
 * forward by everything the page has heard, so:
 *
 *  - **sequential edits order correctly regardless of clock skew** — a page
 *    that has seen your write stamps its own reply strictly after it, because
 *    `t = max(now, seen.t)` and the counter breaks the tie when `now` has not
 *    moved;
 *  - **concurrent edits order arbitrarily but IDENTICALLY on every peer** —
 *    `(t, c, s)` is a total order computed from the stamp alone, so no peer
 *    needs to ask another anything. That is what makes the merge a function
 *    rather than a negotiation, and it is why nothing here can deadlock.
 *
 * ## The honest limit
 *
 * Two edits made within the two devices' clock SKEW of each other, with neither
 * device having heard the other, resolve by whichever clock reads later — not
 * by which finger moved first. That is a real limitation and it is stated in
 * `docs/remote-control.md`.
 *
 * The bound on it used to be stated as "the wall-clock floor `t = max(now,
 * seen.t)` means skew can only decide a genuine tie, never overturn a write
 * somebody has already seen". **That was true only for a device that stayed
 * connected**, and the gap it left was not small: every write made during an
 * outage is a write the offline device has not heard, so `seen.t` is still its
 * own pre-outage stamp and its first tap back stamps in the past. Measured on
 * the shipped screen-lock script: a phone ten seconds behind lost its first tap
 * after a 6.5 s gap; ninety seconds behind, the same. The failure appeared
 * exactly when the skew exceeded the length of the gap.
 *
 * `appSync.ts` closes that by stamping in ROOM time — `Date.now()` plus a
 * monotone offset folded from the clock readings on inbound frames — so the
 * floor is now "later than everything the ROOM has done", not merely "later
 * than everything I happened to receive". What remains, and is genuinely
 * irreducible without a consensus round, is the first clause: two edits made
 * inside the residual skew of two devices that have heard nothing of each other
 * resolve by clock rather than by finger.
 */

/**
 * `t` physical ms, `c` a counter for writes inside one millisecond, `s` the
 * writer. Compared in exactly that order, which makes the order TOTAL: no two
 * distinct writes by distinct peers can compare equal.
 */
export interface Stamp {
  t: number;
  c: number;
  s: string;
}

/** How a stamp rides the wire: three fields, no keys. About 24 bytes. */
export type StampTuple = [t: number, c: number, s: string];

/**
 * The stamp a leaf nobody has ever written carries.
 *
 * A full snapshot re-states every key, including the ones its sender has never
 * touched, so most leaves on most frames are unstamped. Reading "unstamped" as
 * the beginning of time is what stops an echo of a default from outranking a
 * value somebody chose.
 */
export const EPOCH: Stamp = Object.freeze({ t: 0, c: 0, s: '' });

/** The total order. Negative when `a` is earlier. */
export function compareStamps(a: Stamp, b: Stamp): number {
  if (a.t !== b.t) return a.t < b.t ? -1 : 1;
  if (a.c !== b.c) return a.c < b.c ? -1 : 1;
  if (a.s === b.s) return 0;
  return a.s < b.s ? -1 : 1;
}

/** The later of two stamps. */
export function maxStamp(a: Stamp, b: Stamp): Stamp {
  return compareStamps(a, b) >= 0 ? a : b;
}

/**
 * A stamp for a write happening NOW, given everything this page has seen.
 *
 * `t = max(now, seen.t)` is the wall-clock floor: a page whose clock is behind
 * the room still stamps after what it has received, so it can never write a
 * value that silently loses to something it was looking at. `c` only moves when
 * the millisecond has not, which keeps `t` a real timestamp rather than a
 * counter that has drifted away from any clock.
 */
export function tick(seen: Stamp, now: number, src: string): Stamp {
  const t = Math.max(now, seen.t);
  const c = t === seen.t ? seen.c + 1 : 0;
  return { t, c, s: src };
}

export function encodeStamp(s: Stamp): StampTuple {
  return [s.t, s.c, s.s];
}

/** `null` for anything that is not a stamp — a malformed entry is an absent one. */
export function decodeStamp(raw: unknown, maxSrcLen: number): Stamp | null {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const [t, c, s] = raw as [unknown, unknown, unknown];
  if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) return null;
  if (typeof c !== 'number' || !Number.isFinite(c) || c < 0) return null;
  if (typeof s !== 'string' || s.length === 0 || s.length > maxSrcLen) return null;
  return { t, c, s };
}
