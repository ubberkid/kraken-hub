/**
 * Can the arrangement this phone just made actually reach the Kraken?
 *
 * ## The answer used to be "only if you are CAM". W1c changed it.
 *
 * A Look is state: `useEditor` commits it to the store, the store hands it to
 * `SyncService`, and the display picks it up. Until W1c the WIRE body did not
 * carry `look`, so that path existed only where two windows shared a storage
 * partition — CAM's configuration browser and the display page — and this module
 * demoted the claim on every other window with `delivers: ownsBytes(runtime)`.
 * The comment on that field predicted its own replacement: *"when the wire
 * carries looks this becomes 'paired', and the call site is the only thing that
 * changes."*
 *
 * The wire carries looks now (`SyncStateBody.look`, envelope `v: 2`, per-leaf
 * HLC last-writer-wins — see docs/remote-control.md). So a phone in a connected
 * room delivers, and `delivers` is that fact rather than a fact about storage.
 *
 * The rule itself is unchanged, and it is the reason this module still exists:
 * `panelPresence` answers *is a Kraken there*; it cannot answer *did this edit
 * get to it*, and a surface that used a live presence to claim a delivered
 * arrangement would be making round 7's mistake with a new noun. What moved is
 * which windows can answer yes.
 *
 * Pure, dependency-free apart from the presence type, so the rule is a unit
 * test rather than a screenshot.
 */

import { panelIsKnown, type PanelPresence } from '../../panelPresence';

export interface ArrangementReach {
  /** What this window knows about the panel — the ordinary spine's answer. */
  presence: PanelPresence;
  /**
   * Whether a look written here lands where the display reads it.
   *
   * Two ways to be true, and the caller supplies whichever applies:
   *
   *  - **PAIRED** — the room is joined and the transport is up. `look` rides the
   *    sync body like every other leaf, so a phone in a live room delivers.
   *  - **Shared storage** — CAM's configuration browser and the LCD page are one
   *    origin and one IndexedDB, which is a path that needs no room at all.
   *
   * Neither is `panelIsLive(presence)`, and that is the whole point: the panel
   * being heard from says nothing about whether this window's writes get to it.
   */
  delivers: boolean;
}

/**
 * The strongest tense the arrangement may be claimed in.
 *
 * `quiet` rather than `never-seen` for a window that has SEEN a Kraken and
 * cannot reach it: the panel is real and the edit is kept, which is precisely
 * the habitual-present case the spine documents — "kept here until your Kraken
 * is back" is true, "kept for a Kraken that has never existed" is not.
 */
export function arrangementPresence({ presence, delivers }: ArrangementReach): PanelPresence {
  if (delivers) return presence;
  return panelIsKnown(presence) ? 'quiet' : 'never-seen';
}
