import { useEffect, useMemo, useRef, useState } from 'react';

import { NOTHING_KEPT, OFFLINE_PROMISE } from '../../../config/vocabulary';
import { Button, Notice } from '../../../ui';
import {
  NO_PENDING,
  RECONCILE_GRACE_MS,
  applyPending,
  reconcilePending,
  rejectionNotice,
  type Pending,
} from '../curationOptimistic';
import { buildLibraryTiles, tileDetail } from '../libraryItems';
import { nowShowingBadge } from '../panelClaims';
import { activeTileKey, showTile } from '../showTile';
import { libraryFromWire } from '../wireLibrary';

import { ConfirmSheet } from './ConfirmSheet';
import { RemoteTileArt } from './TileArt';

import type { Store } from '../../../state/store';
import type { CmdOp } from '../../../sync/types';
import type { LibraryTile } from '../libraryItems';
import type { PanelPresence } from '../panelPresence';
import type { ReactNode } from 'react';

/**
 * The Library, on the remote.
 *
 * ## What it is
 *
 * A **peer of the transport**: ring → what's playing → transport → *Library* →
 * pairing. Not a modal, not a drawer, and above all not a "picker". The feature
 * that was deleted from this product was called a clip picker and read as a
 * duplicate app; this is the same shelf as CAM's, seen from the sofa, sitting in
 * the flow of the page like the scrubber does.
 *
 * ## Why it costs almost nothing
 *
 * Every part of it already existed and was going to waste:
 *
 *  - the **shelf** arrives on the `tele` channel and has for two milestones —
 *    `RemoteView` latched the packet and rendered one string out of it;
 *  - the **tiles** come from `buildLibraryTiles`, the same pure builder CAM's
 *    grid uses, via `libraryFromWire`;
 *  - the **art** is `TreatedArt`, a deterministic function of the name, so most
 *    tiles are pixel-identical to CAM's for zero bytes on the wire;
 *  - **playing** is `showTile` — the ordinary state commit, which already
 *    travels, is already retained, and is already how CAM's Library plays
 *    something. There is no new command and no new machinery.
 *
 * ## Curation, and the two things that make it safe (wave 3)
 *
 * Pin, rename and delete are here now, and they are the first library ACTS on
 * the `cmd` channel. Two rules carry the whole design:
 *
 *  1. **Batched by id.** `sendCmd` throttles PER OP at 200 ms and DROPS what
 *     lands inside the window, so a five-item delete loop would send one command
 *     and the user would watch four tiles come back. So the shelf has a
 *     selection: you choose, and then one command carries every id.
 *  2. **Optimistic, then reconciled.** There is no ack on this channel and there
 *     is not going to be one. The tile goes the instant you confirm; the next
 *     library packet either agrees, in which case the overlay is forgotten, or it
 *     does not, in which case the tile comes back with a sentence saying so
 *     (`curationOptimistic.ts` is that arithmetic, tested as arithmetic).
 *
 * Delete is behind a confirm. It was behind one only HERE for a wave — CAM's
 * shelf deleted on the press, on the theory that in CAM the row and the finger
 * are in the same room — and round 6 retired that theory: there is no undo
 * anywhere in the product, the bytes go from the one database the LCD can read,
 * and it was the last unconfirmed destructive act in the app. The sheet is
 * `./ConfirmSheet` now and both shelves mount the same one, so the answer to
 * "does deleting ask?" stops depending on which window you are standing in.
 */

/**
 * Focus the rename input the moment it appears.
 *
 * A stable module-level callback ref rather than `autoFocus`: the prop is a
 * blunt instrument the a11y lint rightly refuses (it steals focus on page load,
 * where nobody asked for it), while this only ever runs when the input is
 * mounted — which happens exactly because somebody pressed **Rename**.
 */
function focusOnMount(el: HTMLInputElement | null): void {
  el?.focus();
}

/**
 * How often a remote with an unsettled change re-asks for the shelf.
 *
 * Long enough to be well clear of the 200 ms per-op command throttle (which
 * DROPS rather than queues), short enough that a rejected delete is admitted
 * while the person is still looking at the screen.
 */
export const PENDING_PULL_MS = 1200;

export interface RemoteLibraryProps {
  store: Store;
  /** `sync.library?.body` — `null` until the first packet lands. */
  wire: Record<string, unknown> | null;
  /**
   * When the last library packet ARRIVED, on this device's clock.
   *
   * Not the `ts` the display stamped on it: reconciliation compares it against
   * the moment a command was sent, and only one of those two clocks is ours.
   */
  packetAt: number | null;
  sendCmd: (op: CmdOp, arg?: unknown) => void;
  activeModuleId: string;
  videoUrl: string;
  /** The local-image id currently configured, or `null`. */
  imageId: string | null;
  /** The Add control, rendered by the surface that owns the layout. */
  add?: ReactNode;
  /**
   * What this window may claim about the panel — round 6, the C2 family.
   *
   * The highlighted tile's badge said **On screen** on the strength of the
   * configured module and source, which is what the panel *will* show. On a
   * phone paired into a room whose Kraken is switched off it is a caption on a
   * screen nobody has ever heard from.
   */
  presence: PanelPresence;
}

export function RemoteLibrary({
  store,
  wire,
  packetAt,
  sendCmd,
  activeModuleId,
  videoUrl,
  imageId,
  add,
  presence,
}: RemoteLibraryProps) {
  const [pending, setPending] = useState<readonly Pending[]>(NO_PENDING);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [confirming, setConfirming] = useState<{ ids: string[]; names: string[] } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const wireTiles = useMemo(() => buildLibraryTiles(libraryFromWire(wire)), [wire]);

  /*
   * Reconciliation, driven by the ARRIVAL of a packet rather than by a timer.
   *
   * A pending change is only ever judged by a packet that landed at least
   * `RECONCILE_GRACE_MS` after the command went out — otherwise a packet that
   * was already in flight would restore the tile a heartbeat after it was
   * deleted, and the display's own immediate republish would then delete it
   * again. `reconcilePending` is pure; this effect is the only thing that knows
   * about time.
   */
  const lastReconciled = useRef<number | null>(null);
  useEffect(() => {
    if (packetAt === null || packetAt === lastReconciled.current) return;
    lastReconciled.current = packetAt;
    setPending((current) => {
      if (current.length === 0) return current;
      const result = reconcilePending(current, wireTiles, packetAt);
      if (result.rejected.length > 0) setNotice(rejectionNotice(result.rejected));
      return result.pending;
    });
  }, [packetAt, wireTiles]);

  /*
   * While anything is in flight, ASK.
   *
   * Reconciliation is driven by packets, and `tele` publishes unretained on a
   * five-minute keepalive — so a change the Kraken silently did not make would
   * otherwise stay optimistically applied for up to five minutes, which is a
   * tile that is gone from the shelf and present in the library. The display
   * republishes immediately when it DOES apply something, so this beat normally
   * fires once or twice and stops; it is the case where nothing was applied that
   * it exists for. Well clear of the 200 ms per-op command throttle, which drops
   * rather than queues.
   */
  const havePending = pending.length > 0;
  const pendingRef = useRef<readonly Pending[]>(NO_PENDING);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  useEffect(() => {
    if (!havePending) return undefined;
    const timer = setInterval(() => {
      const now = Date.now();
      /*
       * ONE message per beat, and the newest unsettled command first.
       *
       * Both zero-network transports are a LAST-VALUE SLOT rather than a queue:
       * two writes to the `cmd` channel inside one tick and only the second one
       * is delivered. So a beat that sent a retry AND a pull would reliably lose
       * the retry, which is the exact failure this loop exists to prevent.
       *
       * Within the grace window the command is repeated — every one of them is
       * absolute and idempotent by id, so a repeat is the same sentence said
       * again, never a second edit. Past the window it stops, and the beat turns
       * into a pull instead: at that point the question is no longer "did it
       * arrive" but "what does the Kraken actually have", and the answer to that
       * is a library packet.
       */
      const retry = [...pendingRef.current]
        .reverse()
        .find((entry) => now - entry.at < RECONCILE_GRACE_MS);
      if (retry === undefined) {
        sendCmd('requestLibrary');
        return;
      }
      if (retry.kind === 'delete') sendCmd('deleteMedia', { ids: retry.ids });
      else if (retry.kind === 'rename') sendCmd('renameMedia', { id: retry.id, name: retry.name });
      else sendCmd('setPinned', { ids: retry.ids, kind: retry.kindOf, pinned: retry.pinned });
    }, PENDING_PULL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [havePending, sendCmd]);

  const tiles = useMemo(() => applyPending(wireTiles, pending), [wireTiles, pending]);
  const activeKey = activeTileKey(activeModuleId, videoUrl, imageId);

  /*
   * The tap is acknowledged by THIS device, immediately — round 9's phone bug.
   *
   * *"I had to click things from my library twice for it to show that library
   * item."* Pressing a tile commits `activeModuleId` + the module's `url`, which
   * is a synchronous local write, so the badge normally moves on the same frame.
   * Normally. The state channel is last-writer-wins and the display republishes
   * what it resolved, so a frame that was already in flight when the press
   * landed can put the previous tile back for a beat — and a badge that flicks
   * on and off is read as "that did nothing", which is answered by pressing
   * again.
   *
   * This is the same answer `curationOptimistic` gives for pin/rename/delete,
   * and deliberately the same grace: the surface acts as if it worked and is
   * told otherwise. It is bounded, so a press that genuinely did not take still
   * ends up telling the truth — after `RECONCILE_GRACE_MS`, the state wins.
   *
   * A second press on the tile that is already showing is harmless by
   * construction: `showTile` writes an absolute value rather than toggling, so
   * pressing twice says the same sentence twice.
   */
  const [justShown, setJustShown] = useState<{ key: string; at: number } | null>(null);
  /*
   * The grace expires on a TIMER rather than by comparing clocks at render time:
   * render has to be pure (the React compiler enforces it), and "how long ago
   * was that press" is not. One timeout per press, cleared on unmount.
   *
   * There is no early clear when the wire agrees, because there is nothing to
   * clear: an override that names the same tile the state does is invisible.
   */
  useEffect(() => {
    if (justShown === null) return undefined;
    const left = Math.max(0, RECONCILE_GRACE_MS - (Date.now() - justShown.at));
    const timer = setTimeout(() => {
      setJustShown(null);
    }, left);
    return () => {
      clearTimeout(timer);
    };
  }, [justShown]);

  /** What the shelf HIGHLIGHTS: this device's own last press, then the wire. */
  const shownKey = justShown?.key ?? activeKey;

  const byId = useMemo(() => {
    const map = new Map<string, LibraryTile>();
    for (const tile of tiles) if (tile.id !== null) map.set(tile.id, tile);
    return map;
  }, [tiles]);

  /** A selection can outlive the rows it names — a packet may drop one. */
  const chosen = useMemo(() => [...selected].filter((id) => byId.has(id)), [selected, byId]);

  const nameMap = (ids: readonly string[]): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const id of ids) {
      const tile = byId.get(id);
      if (tile !== undefined) out[id] = tile.name;
    }
    return out;
  };

  const clearSelection = (): void => {
    setSelecting(false);
    setSelected(new Set());
  };

  const pin = (ids: readonly string[], kind: 'clip' | 'image', pinned: boolean): void => {
    if (ids.length === 0) return;
    setNotice(null);
    // Absolute, never a toggle: the `cmd` channel is redelivered by a replaying
    // transport, and a toggle applied twice is the `seekBy` hazard wearing a
    // different name.
    sendCmd('setPinned', { ids: [...ids], kind, pinned });
    setPending((current) => [
      ...current,
      { kind: 'pin', ids: [...ids], kindOf: kind, names: nameMap(ids), pinned, at: Date.now() },
    ]);
  };

  const rename = (id: string, name: string): void => {
    const clean = name.trim();
    const tile = byId.get(id);
    if (clean.length === 0 || tile === undefined || clean === tile.name) {
      setRenaming(null);
      return;
    }
    setNotice(null);
    sendCmd('renameMedia', { id, name: clean });
    setPending((current) => [...current, { kind: 'rename', id, name: clean, at: Date.now() }]);
    setRenaming(null);
  };

  const remove = (ids: readonly string[]): void => {
    if (ids.length === 0) return;
    setNotice(null);
    // ONE command for the whole batch. This is the entire reason the shelf has a
    // selection mode rather than a Delete on every tile and a loop behind it.
    sendCmd('deleteMedia', { ids: [...ids] });
    setPending((current) => [
      ...current,
      { kind: 'delete', ids: [...ids], names: nameMap(ids), at: Date.now() },
    ]);
    setConfirming(null);
    clearSelection();
  };

  const askDelete = (ids: readonly string[]): void => {
    const list = ids.filter((id) => byId.has(id));
    if (list.length === 0) return;
    setConfirming({ ids: list, names: list.map((id) => byId.get(id)?.name ?? id) });
  };

  const toggleSelected = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allPinned = chosen.length > 0 && chosen.every((id) => byId.get(id)?.pinned === true);
  /** A mixed-kind selection pins per kind, because `setPinned` names one. */
  const chosenClips = chosen.filter((id) => byId.get(id)?.kind === 'clip');
  const chosenImages = chosen.filter((id) => byId.get(id)?.kind === 'image');

  return (
    <section className="kh-remote__lib" data-testid="remote-library" aria-label="Library">
      <div className="kh-remote__libhead">
        {add}
        {tiles.length > 0 && (
          <Button
            testId="remote-select"
            title={selecting ? 'Stop choosing' : 'Choose several things at once'}
            onClick={() => {
              if (selecting) clearSelection();
              else setSelecting(true);
              setNotice(null);
            }}
          >
            {selecting ? 'Done' : 'Select'}
          </Button>
        )}
      </div>

      {notice !== null && <Notice tone="warn">{notice}</Notice>}

      {tiles.length === 0 ? (
        <div className="kh-empty" data-testid="remote-library-empty">
          {/*
            The same sentence CAM's empty shelf uses, in the same FRAME — round
            7's minors.

            "Nothing kept here" is true on a phone for exactly the same reason it
            is true in CAM: there is one library and it holds nothing. Round 5
            unified the words and left the shape alone, and the audit's
            screenshots show what that is worth — CAM draws a bordered card with
            a title and the offline promise inside it, and the phone drew one
            grey line of body text flush against the Add button, reading as a
            caption for the control above rather than as the state of the shelf
            below. One library, one empty state.
          */}
          <p className="kh-empty__title">{NOTHING_KEPT}</p>
          <p className="kh-hint">{OFFLINE_PROMISE}</p>
        </div>
      ) : (
        <ul className="kh-grid kh-grid--remote" data-testid="remote-library-grid">
          {tiles.map((tile) => (
            <RemoteTile
              key={tile.key}
              tile={tile}
              active={tile.key === shownKey}
              activeLabel={nowShowingBadge(presence)}
              selecting={selecting}
              selected={tile.id !== null && selected.has(tile.id)}
              renamingDraft={renaming !== null && renaming.id === tile.id ? renaming.draft : null}
              onPress={() => {
                if (tile.id === null) return;
                if (selecting) {
                  toggleSelected(tile.id);
                  return;
                }
                showTile(store, tile);
                setJustShown({ key: tile.key, at: Date.now() });
              }}
              onPin={() => {
                if (tile.id !== null) pin([tile.id], tile.kind, !tile.pinned);
              }}
              onRenameStart={() => {
                if (tile.id !== null) setRenaming({ id: tile.id, draft: tile.name });
              }}
              onRenameDraft={(draft) => {
                setRenaming((current) => (current === null ? null : { ...current, draft }));
              }}
              onRenameCommit={() => {
                if (renaming !== null) rename(renaming.id, renaming.draft);
              }}
              onRenameCancel={() => {
                setRenaming(null);
              }}
              onDelete={() => {
                if (tile.id !== null) askDelete([tile.id]);
              }}
            />
          ))}
        </ul>
      )}

      {selecting && chosen.length > 0 && (
        <div className="kh-remote__bulk" data-testid="remote-bulk" role="group" aria-label="Chosen">
          <span className="kh-hint">{`${String(chosen.length)} chosen`}</span>
          <Button
            testId="remote-bulk-pin"
            title={allPinned ? 'Allow these to be cleared' : 'Never clear these automatically'}
            onClick={() => {
              if (chosenClips.length > 0) pin(chosenClips, 'clip', !allPinned);
              if (chosenImages.length > 0) pin(chosenImages, 'image', !allPinned);
              clearSelection();
            }}
          >
            {allPinned ? 'Unpin' : 'Pin'}
          </Button>
          <Button
            testId="remote-bulk-delete"
            title="Delete everything chosen"
            onClick={() => {
              askDelete(chosen);
            }}
          >
            {`Delete ${String(chosen.length)}`}
          </Button>
        </div>
      )}

      {/*
        The confirm — the SAME sheet CAM's shelf mounts (round 6, CAM parity).

        From a sofa the shelf is the last packet that happened to arrive and the
        delete is a command with no acknowledgement, which is why this surface
        got one first. What round 6 established is that the reason was never
        specific to this surface: there is no undo on either side.
      */}
      {confirming !== null && (
        <ConfirmSheet
          testId="remote-confirm-delete"
          question={
            confirming.ids.length === 1
              ? `Delete “${confirming.names[0] ?? ''}” from your library?`
              : `Delete ${String(confirming.ids.length)} things from your library?`
          }
          confirmLabel="Delete"
          confirmTitle="Delete it from your Kraken"
          keepTitle="Leave it alone"
          onConfirm={() => {
            remove(confirming.ids);
          }}
          onCancel={() => {
            setConfirming(null);
          }}
        />
      )}
    </section>
  );
}

/**
 * One thing on the shelf, from a window that can show it but not hold it.
 *
 * The same markup and the same class names as CAM's tile, so the two shelves are
 * the same object in the stylesheet as well as in the builder. A tile with no
 * bytes yet (a download in flight) is not pressable and carries no actions: its
 * ring is the information, and there is nothing yet to pin, rename or delete.
 */
function RemoteTile({
  tile,
  active,
  activeLabel,
  selecting,
  selected,
  renamingDraft,
  onPress,
  onPin,
  onRenameStart,
  onRenameDraft,
  onRenameCommit,
  onRenameCancel,
  onDelete,
}: {
  tile: LibraryTile;
  active: boolean;
  /** What the badge says — see `RemoteLibraryProps.presence`. */
  activeLabel: string;
  selecting: boolean;
  selected: boolean;
  /** The in-progress new name, or `null` when this tile is not being renamed. */
  renamingDraft: string | null;
  onPress: () => void;
  onPin: () => void;
  onRenameStart: () => void;
  onRenameDraft: (draft: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onDelete: () => void;
}) {
  const ready = tile.state === 'ready' && tile.id !== null;

  return (
    <li
      className={active ? 'kh-tile kh-tile--active' : 'kh-tile'}
      data-testid="library-tile"
      data-tile-kind={tile.kind}
      data-tile-state={tile.state}
      data-tile-selected={selected ? 'true' : 'false'}
      {...(tile.kind === 'clip' && tile.state === 'ready' && tile.id !== null
        ? { 'data-clip-id': tile.id }
        : {})}
      {...(tile.kind === 'image' && tile.id !== null ? { 'data-image-id': tile.id } : {})}
    >
      <div className="kh-tile__art">
        <RemoteTileArt name={tile.name} sourceUrl={tile.sourceUrl} />
        {ready && (
          <button
            type="button"
            className="kh-tile__hit"
            data-testid={selecting ? 'tile-select' : 'tile-show'}
            aria-pressed={selecting ? selected : undefined}
            onClick={onPress}
          >
            <span className="kh-sr">
              {selecting
                ? `${selected ? 'Deselect' : 'Select'} “${tile.name}”`
                : /* The same words CAM's shelf uses for the same button — it is
                     an instruction, not a claim, and "on the display" says what
                     it does without asserting that anything is there. */
                  `Show “${tile.name}” on the display`}
            </span>
          </button>
        )}
        {selecting && selected && (
          <span className="kh-tile__on" data-testid="tile-selected">
            Chosen
          </span>
        )}
        {!selecting && active && (
          <span className="kh-tile__on" data-testid="tile-active">
            {activeLabel}
          </span>
        )}
      </div>
      <div className="kh-tile__meta">
        {renamingDraft === null ? (
          <div className="kh-tile__name" title={tile.name}>
            {tile.name}
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onRenameCommit();
            }}
          >
            <input
              className="kh-input"
              data-testid="tile-rename-input"
              aria-label={`New name for “${tile.name}”`}
              value={renamingDraft}
              ref={focusOnMount}
              onChange={(e) => {
                onRenameDraft(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') onRenameCancel();
              }}
            />
          </form>
        )}
        <div className="kh-tile__detail">
          {tileDetail(tile)}
          {tile.pinned ? ' · pinned' : ''}
        </div>
      </div>

      {/*
        Curation on the surface that cannot reach the bytes — which is the point.

        Wave 1 left these off because "a button that silently writes to the wrong
        database is worse than no button". They are here now because they no
        longer write to a database at all: they ask the window that owns one, by
        id, in a batch, absolutely rather than as a toggle. Visibility is a
        property of the Kraken; capability is a property of the window — and the
        capability the window genuinely has is to ASK.
      */}
      {ready && !selecting && (
        <div className="kh-tile__actions">
          {renamingDraft === null ? (
            <>
              {/*
                The tooltip says what the act does, not which disk it happens on.

                It read *"Allow this to be cleared when the disk fills up"* —
                CAM's own wording, on a phone, where "the disk" names a thing the
                reader is not holding and cannot check. Exactly the failure A5's
                second axis exists to prevent, and it slipped the grep because
                `OWNER_ONLY_TERMS` pins IMPORTS and this was typed inline.
                `vocabulary.test.ts` reads the remote-rendered files for machine
                nouns now, so the next one is a failing test.
              */}
              <Button
                testId="tile-pin"
                title={
                  tile.pinned
                    ? 'Allow this to be cleared when your library needs room'
                    : 'Never clear this automatically'
                }
                onClick={onPin}
              >
                {tile.pinned ? 'Unpin' : 'Pin'}
              </Button>
              <Button testId="tile-rename" title={`Rename “${tile.name}”`} onClick={onRenameStart}>
                Rename
              </Button>
              <Button testId="tile-delete" title={`Delete “${tile.name}”`} onClick={onDelete}>
                Delete
              </Button>
            </>
          ) : (
            <>
              <Button testId="tile-rename-save" title="Save the new name" onClick={onRenameCommit}>
                Save
              </Button>
              <Button
                testId="tile-rename-cancel"
                title="Keep the old name"
                onClick={onRenameCancel}
              >
                Cancel
              </Button>
            </>
          )}
        </div>
      )}
    </li>
  );
}
