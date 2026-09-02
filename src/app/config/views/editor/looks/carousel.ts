/**
 * The carousel — a Look rotates among a chosen set on an interval (§4).
 *
 * ## One window runs it, and it is never the display
 *
 * The set is a list of ids in `kraken-hub:v1:looks`, and the Looks those ids
 * name are in that store — not in the document. So the only window that can
 * turn "the next id" into "the next Look" is the window that owns the store:
 * CAM's configuration window. It commits the next Look into `look` on the tick,
 * and the display does what it has always done, which is render whatever `look`
 * says. The display has no timer, no knowledge of a rotation, and no way to
 * disagree with the window that has one.
 *
 * That is a deliberate architecture rather than an accident of where the code
 * landed, and the alternative was considered and rejected: putting the look
 * BODIES in the document so the display could rotate them itself. Five Looks in
 * `AppState` is five arrangements on an 8 kB wire envelope for four panels
 * nobody is currently looking at — `MAX_STATE_BYTES` would refuse the write, and
 * refusing it would be right.
 *
 * The consequence is stated plainly in the UI and in docs/looks.md: **the
 * rotation runs while CAM's window is open.** A Kraken left alone keeps showing
 * the Look it was last given, which is the honest behaviour of a panel whose
 * conductor went home, and is exactly what it does today.
 *
 * ## A rotation is not an edit
 *
 * The tick commits, and does NOT push an undo entry. Fifty rotations overnight
 * would otherwise bury the user's last real edit under an hour of automatic
 * ones, and "undo" would walk back through a clock rather than through work.
 * `history.ts` only records what a caller pushes, so this is achieved by not
 * pushing rather than by suppressing anything.
 *
 * Everything here is pure. The timer that drives it lives in `useCarousel`.
 */

import type { CarouselSettings } from '../../../../../state/schema';
import type { SavedLook, LooksDoc } from '../../../editor/looksStore';

/** Fewer than this many Looks is not a rotation. */
export const MIN_CAROUSEL_LOOKS = 2;

/**
 * The set, resolved against the shelf, in the order the settings name.
 *
 * Ids that no longer resolve are SKIPPED rather than treated as an error: a
 * Look can be deleted while a rotation names it, and the useful behaviour is to
 * rotate among what is left. When fewer than two survive, the rotation is over —
 * `carouselStep` returns nothing and the UI reads the same emptiness the user
 * would see.
 */
export function carouselLooks(settings: CarouselSettings | undefined, doc: LooksDoc): SavedLook[] {
  if (settings === undefined) return [];
  const byId = new Map(doc.looks.map((l) => [l.id, l]));
  return settings.lookIds.map((id) => byId.get(id)).filter((l): l is SavedLook => l !== undefined);
}

/** Is a rotation actually possible right now? */
export function carouselReady(settings: CarouselSettings | undefined, doc: LooksDoc): boolean {
  return carouselLooks(settings, doc).length >= MIN_CAROUSEL_LOOKS;
}

export interface CarouselStepInput {
  settings: CarouselSettings | undefined;
  doc: LooksDoc;
  /** The id of the Look this window put on the panel last, or `null` on the first tick. */
  showingId: string | null;
  /** When that happened, on this window's clock. `0` means "never". */
  shownAt: number;
  now: number;
  /**
   * Whether this window owns the store the ids name — `ownsBytes()`.
   *
   * An argument rather than a check inside, so the ownership rule is visible at
   * the call site and testable without a browser. A window that does not own the
   * bytes gets `null` on every tick, forever.
   */
  owns: boolean;
}

/** What to put on the panel next, or `null` for "not yet" / "not mine to decide". */
export function carouselStep(input: CarouselStepInput): SavedLook | null {
  if (!input.owns) return null;
  const order = carouselLooks(input.settings, input.doc);
  if (order.length < MIN_CAROUSEL_LOOKS || input.settings === undefined) return null;

  // The first tick after a rotation is switched on shows the first Look at once,
  // rather than making somebody watch an unchanged panel for the interval to
  // find out whether the setting took.
  if (input.showingId === null || input.shownAt === 0) return order[0] ?? null;

  if (input.now - input.shownAt < input.settings.intervalSec * 1000) return null;

  const at = order.findIndex((l) => l.id === input.showingId);
  // An id that has left the set — deleted, or removed from the rotation — starts
  // the set again from the top rather than guessing where it used to be.
  return order[at < 0 ? 0 : (at + 1) % order.length] ?? null;
}

/**
 * How often the timer wakes up.
 *
 * A second, regardless of the interval, because the interval is compared against
 * a wall clock: a `setTimeout` for an hour is a timer a sleeping laptop throws
 * away, and one that fires an hour late shows the next Look an hour late with no
 * way to tell. Waking once a second to compare two numbers costs nothing and is
 * correct across a suspend.
 */
export const CAROUSEL_TICK_MS = 1000;

/** The intervals the picker offers, in seconds. §4's "30 s … 1 h". */
export const CAROUSEL_INTERVALS: readonly number[] = [30, 60, 300, 900, 1800, 3600];

/** "5 min", "1 h" — the picker's own labels, so a number never appears bare. */
export function intervalLabel(sec: number): string {
  if (sec < 60) return `${String(sec)} s`;
  if (sec < 3600) return `${String(Math.round(sec / 60))} min`;
  return `${String(Math.round(sec / 3600))} h`;
}
