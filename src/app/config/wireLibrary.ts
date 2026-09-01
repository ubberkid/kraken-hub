/**
 * The shelf, as it arrives from the Kraken — A2.
 *
 * ## The gap this closes
 *
 * The display has published `{kind:'library', clips, downloads}` for two
 * milestones, and the remote **latched it and threw it away**: `RemoteView`
 * used the packet to build a `name → title` lookup and rendered exactly one
 * string out of it. A full shelf arrived on the phone, every packet, and one
 * filename was drawn from it. Meanwhile the only reachable "library" on a phone
 * was `#/library` reading the PHONE's IndexedDB — a second, real, empty one.
 *
 * ## Why this file is nearly a type-cast
 *
 * `buildLibraryTiles` was already pure, DOM-free, IDB-free and already spanned
 * both kinds, and `ClipSummary` / `ImageSummary` are structural supersets of
 * `ClipLike` / `ImageLike`. So the second data source needs no second builder
 * and no second tile type — which is the point: a shelf built by a different
 * function is a shelf that drifts, and "the library is different" is the
 * complaint this whole wave answers. All that is genuinely needed is to narrow
 * `unknown` honestly, because the packet was written by a peer that may be a
 * different build of this app, or a fork.
 *
 * Pure and synchronous, so it is tested without a DOM, a database or a network.
 */

import type { LibraryInput, ClipLike, ImageLike } from './libraryItems';
import type { DownloadEntry } from '../../modules/video/local/downloadManager';

function rows(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (row): row is Record<string, unknown> => typeof row === 'object' && row !== null,
  );
}

function str(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(row: Record<string, unknown>, key: string, fallback: number): number {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * A clip row from the wire.
 *
 * `null` for anything without an id and a name: a tile with no id cannot be
 * played and a tile with no name cannot be recognised, so it is not a tile — and
 * a half-read row is worse than a missing one, because it looks like something
 * you own and then does nothing when you press it.
 */
function wireClip(row: Record<string, unknown>): ClipLike | null {
  const id = str(row, 'id');
  const name = str(row, 'name');
  if (id === null || name === null) return null;
  return {
    id,
    name,
    size: num(row, 'size', 0),
    durationSec: num(row, 'durationSec', 0),
    pinned: row['pinned'] === true,
    createdAt: num(row, 'createdAt', 0),
    sourceUrl: str(row, 'sourceUrl'),
  };
}

function wireImage(row: Record<string, unknown>): ImageLike | null {
  const id = str(row, 'id');
  const name = str(row, 'name');
  if (id === null || name === null) return null;
  return {
    id,
    name,
    size: num(row, 'size', 0),
    animated: row['animated'] === true,
    pinned: row['pinned'] === true,
    createdAt: num(row, 'createdAt', 0),
    sourceUrl: str(row, 'sourceUrl'),
  };
}

/**
 * A download job from the wire.
 *
 * `DownloadEntry` is the one shape here that is not a superset — it is the other
 * window's live record — but every field the tile reads is on it, and the tile
 * only ever reads it to draw a ring, a failure line and the buttons that act on
 * it. The buttons are gated on owning the bytes, so a remote's job tile is a
 * progress ring and a name, which is exactly what it should be.
 */
function wireDownload(row: Record<string, unknown>): DownloadEntry | null {
  const id = str(row, 'id');
  if (id === null) return null;
  return row as unknown as DownloadEntry;
}

/**
 * `sync.library.body` → the input `buildLibraryTiles` already takes.
 *
 * `null` in — no packet has arrived yet — gives an empty shelf, which is a
 * different thing from a shelf that is genuinely empty and is why the callers
 * distinguish "nothing yet" from "nothing here".
 */
export function libraryFromWire(body: Record<string, unknown> | null): LibraryInput {
  if (body === null) return { clips: [], images: [], downloads: [], dismissed: new Set() };
  /*
   * ONE list on the wire, split back out by `kind` (wave 2, C2).
   *
   * `buildLibraryTiles` still takes two arrays because a clip row and a picture
   * row make different tiles, and that is a fact about tiles rather than about
   * storage. What matters is that the SPLIT happens here, after one ordering and
   * one budget have already been applied to the whole shelf — a packet with two
   * arrays let the sender cut per kind and the reader re-join in a second order,
   * which is two shelves wearing one name.
   *
   * A row with no `kind` is read as a clip: that is what every row on this
   * channel was before this wave, so an older display still fills the shelf.
   */
  const items = rows(body['items']);
  return {
    clips: items
      .filter((row) => row['kind'] !== 'image')
      .map(wireClip)
      .filter((c): c is ClipLike => c !== null),
    images: items
      .filter((row) => row['kind'] === 'image')
      .map(wireImage)
      .filter((i): i is ImageLike => i !== null),
    downloads: rows(body['downloads'])
      .map(wireDownload)
      .filter((d): d is DownloadEntry => d !== null),
    // Dismissing a failed job is a local gesture on the surface that owns it;
    // a remote has nothing to dismiss because it started nothing.
    dismissed: new Set(),
  };
}
