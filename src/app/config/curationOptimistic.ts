/**
 * Curating a shelf you can see but cannot touch.
 *
 * ## The problem this is the whole answer to
 *
 * A remote's shelf is not read from a database — it is the last `library` packet
 * the display happened to publish. So a pin, a rename or a delete sent from a
 * phone changes nothing on screen: the command goes out, the display applies it,
 * and the shelf redraws only when the next packet lands. Between those two
 * moments the tile sits there, unpinned, still called what it was called, still
 * present, and the honest reading of that is *"the button did nothing"*.
 *
 * The fix is not an ack protocol. There is no ack on this channel by design, and
 * inventing one would mean a retransmit protocol, a timeout policy and a second
 * definition of what the shelf is. What the remote does instead is what a good
 * remote has always done: **act as if it worked, and be told otherwise.** The
 * tile disappears the instant you confirm; the next library packet either agrees
 * — in which case the optimistic entry is simply forgotten — or it does not, and
 * the tile comes back with a sentence saying so.
 *
 * ## Why the grace period is not a fudge
 *
 * The library is re-announced every five minutes and on demand, so a packet that
 * was already in flight when the command went out will still describe the old
 * shelf. Reconciling against it would restore the tile a heartbeat after it was
 * deleted and then delete it again, which is worse than either outcome. So a
 * pending change is only ever judged by a packet that arrived at least
 * `RECONCILE_GRACE_MS` after it was sent — comfortably longer than the display's
 * apply-and-republish round trip, and short enough that a genuinely failed
 * delete is admitted while the person is still looking at the screen.
 *
 * Pure and synchronous, so all of this is tested as arithmetic rather than
 * observed as a shelf that occasionally flickers.
 */

import type { LibraryTile } from './libraryItems';

/**
 * How long a pending change is immune from reconciliation.
 *
 * Two and a half seconds: the display applies a curation command and republishes
 * IMMEDIATELY (`publishLibrary({ immediate: true })`), so the honest answer
 * normally lands inside a few hundred milliseconds. The rest is slack for a
 * transport that failed over mid-command and for a packet that was already on
 * the wire when the command left.
 */
export const RECONCILE_GRACE_MS = 2500;

export interface PendingDelete {
  kind: 'delete';
  ids: string[];
  /** For the sentence, when the Kraken disagrees. */
  names: Record<string, string>;
  at: number;
}

export interface PendingPin {
  kind: 'pin';
  ids: string[];
  /**
   * The MEDIA kind — `setPinned` names one, so a mixed selection is two
   * commands. Spelled differently from the discriminant above because a pending
   * entry is a fact about a command and a media kind is a fact about a row.
   */
  kindOf: 'clip' | 'image';
  names: Record<string, string>;
  pinned: boolean;
  at: number;
}

export interface PendingRename {
  kind: 'rename';
  id: string;
  name: string;
  at: number;
}

export type Pending = PendingDelete | PendingPin | PendingRename;

/** Nothing in flight. Exported so callers do not mint a fresh array per render. */
export const NO_PENDING: readonly Pending[] = [];

/**
 * The shelf as the user believes it to be: the wire's tiles, with everything
 * still in flight already applied.
 *
 * Order matters — a rename after a delete of the same row must not resurrect it
 * — so deletes are applied last, as a filter over the result.
 */
export function applyPending(
  tiles: readonly LibraryTile[],
  pending: readonly Pending[],
): LibraryTile[] {
  if (pending.length === 0) return [...tiles];

  const gone = new Set<string>();
  const pins = new Map<string, boolean>();
  const names = new Map<string, string>();
  for (const entry of pending) {
    if (entry.kind === 'delete') for (const id of entry.ids) gone.add(id);
    else if (entry.kind === 'pin') for (const id of entry.ids) pins.set(id, entry.pinned);
    else names.set(entry.id, entry.name);
  }

  const out: LibraryTile[] = [];
  for (const tile of tiles) {
    const id = tile.id;
    if (id !== null && gone.has(id)) continue;
    if (id === null) {
      out.push(tile);
      continue;
    }
    const pinned = pins.get(id);
    const name = names.get(id);
    out.push({
      ...tile,
      ...(pinned === undefined ? {} : { pinned }),
      ...(name === undefined ? {} : { name }),
    });
  }
  return out;
}

export interface Reconciliation {
  /** What is still in flight after this packet. */
  pending: Pending[];
  /**
   * The names the Kraken disagreed about, in the order they were asked for.
   *
   * Empty is the overwhelmingly common case and means "everything converged" —
   * which is deliberately indistinguishable, at this layer, from "nothing was in
   * flight". A caller only ever renders a notice for a non-empty list.
   */
  rejected: string[];
}

/**
 * Judge every pending change against a freshly-arrived library packet.
 *
 * Three outcomes per entry, and only three:
 *
 *  - **too soon** — the packet predates the grace window, so it cannot possibly
 *    reflect this command. Kept, untouched.
 *  - **converged** — the packet agrees. Dropped silently: the optimistic overlay
 *    has served its purpose and the wire is now the truth.
 *  - **rejected** — the packet is late enough to have known, and disagrees. The
 *    entry is dropped so the tile snaps back to what the Kraken actually has,
 *    and its name is reported so somebody can be told.
 *
 * `packetAt` is when the packet ARRIVED, not the `ts` the sender stamped on it:
 * the two clocks are different machines' and only one of them is the one that
 * measured `at`.
 */
export function reconcilePending(
  pending: readonly Pending[],
  tiles: readonly LibraryTile[],
  packetAt: number,
): Reconciliation {
  const byId = new Map<string, LibraryTile>();
  for (const tile of tiles) if (tile.id !== null) byId.set(tile.id, tile);

  const next: Pending[] = [];
  const rejected: string[] = [];

  for (const entry of pending) {
    if (packetAt - entry.at < RECONCILE_GRACE_MS) {
      next.push(entry);
      continue;
    }

    if (entry.kind === 'delete') {
      const survivors = entry.ids.filter((id) => byId.has(id));
      for (const id of survivors) rejected.push(entry.names[id] ?? id);
      continue;
    }
    if (entry.kind === 'pin') {
      // A row that has vanished entirely is not a disagreement about pinning:
      // it was deleted somewhere else, and there is nothing to argue about.
      const wrong = entry.ids.filter((id) => {
        const tile = byId.get(id);
        return tile !== undefined && tile.pinned !== entry.pinned;
      });
      for (const id of wrong) rejected.push(entry.names[id] ?? id);
      continue;
    }
    const tile = byId.get(entry.id);
    if (tile !== undefined && tile.name !== entry.name) rejected.push(tile.name);
  }

  return { pending: next, rejected };
}

/**
 * The one sentence a rejection is allowed to be.
 *
 * It names what did not change and stops. No apology, no topology, no advice to
 * "try again" — the button is still there and pressing it again is the obvious
 * thing; a sentence saying so is the app narrating its own UI.
 */
export function rejectionNotice(rejected: readonly string[]): string {
  const [first] = rejected;
  if (first === undefined) return '';
  if (rejected.length === 1) return `Your Kraken did not change “${first}”.`;
  return `Your Kraken did not change “${first}” or ${String(rejected.length - 1)} other item${
    rejected.length > 2 ? 's' : ''
  }.`;
}
