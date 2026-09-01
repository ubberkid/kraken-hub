/**
 * One library, one grid.
 *
 * The Library page used to be three lists stacked on top of each other — "Add a
 * video", "Downloading now", "Your clips", "Add a file by hand" — which meant a
 * clip you had just asked for lived in a *different section* from the clips you
 * already had, and jumped between them when it finished. That is the shape of
 * the code (a download manager and a clip store are two things) rather than the
 * shape of the shelf.
 *
 * This module folds all three inputs into one ordered list of tiles:
 *
 *  - stored clips (`clips`), stored pictures (`images`), and
 *  - the download jobs that have not become either yet.
 *
 * A job sorts on `startedAt` and the clip it becomes sorts on `createdAt`,
 * which are milliseconds apart, so the finished tile lands in the slot its
 * progress ring was occupying instead of jumping to a different section.
 *
 * Everything here is pure and synchronous so it can be tested without a DOM,
 * IndexedDB or a clock.
 */

import type { DownloadEntry } from '../../modules/video/local/downloadManager';

export type LibraryKind = 'clip' | 'image';

/**
 * `failed` is a real tile rather than an error banner: the user asked for this
 * thing, and the honest place to say "the copy could not be kept" is where the
 * copy was going to be. It never means the video did not play — see
 * `homeState.failureLine`, whose words this tile borrows.
 */
export type TileState = 'ready' | 'downloading' | 'failed';

export interface LibraryTile {
  /**
   * Stable across the download → clip transition for the same source, so React
   * keeps the DOM node and the tile does not remount when it completes.
   */
  key: string;
  kind: LibraryKind;
  state: TileState;
  /** The stored id, once there are bytes. `null` while a job is still running. */
  id: string | null;
  name: string;
  sizeBytes: number;
  /** `null` for a picture, which has no duration to report. */
  durationSec: number | null;
  width: number;
  height: number;
  pinned: boolean;
  /** GIF / APNG / animated WebP. Always false for a clip. */
  animated: boolean;
  /**
   * Where the bytes came from, when anybody knows.
   *
   * The one field a window that cannot reach the bytes can still DO something
   * with: a YouTube source has a public poster at a public URL, and a phone with
   * internet fetches that still itself rather than asking the display to grab a
   * frame, re-encode it and chunk it over a radio (A4).
   */
  sourceUrl: string | null;
  /** Newest first. `createdAt` for stored bytes, `startedAt` for a job. */
  sortAt: number;
  /**
   * The stored 320-edge thumbnail, for EITHER kind (C3).
   *
   * `null` on a window that does not own the bytes — a blob cannot go on the
   * wire — and on a row stored before its kind grew one, which the view
   * backfills on sight.
   */
  thumbBlob: Blob | null;
  /** The job this tile is showing, for progress, cancel, retry and dismiss. */
  download: DownloadEntry | null;
}

/**
 * The shape a stored clip has to have for a tile to be built from it.
 *
 * Structural rather than nominal, and that is the whole of A2: `ClipRecord` (the
 * IndexedDB row this window owns) and `ClipSummary` (the row that arrives over
 * the wire from the window that does) are both supersets of this, so the SAME
 * pure builder serves both sources and the phone's shelf cannot drift from
 * CAM's by construction. `width`/`height` are optional because the wire row
 * stopped carrying them (B1) and the tile's detail line stopped rendering them
 * two rounds before that.
 */
export interface ClipLike {
  id: string;
  name: string;
  size: number;
  durationSec: number;
  width?: number;
  height?: number;
  pinned: boolean;
  createdAt: number;
  thumbBlob?: Blob | null;
  sourceUrl?: string | null;
}

/** The same, for a picture. `ImageRecord` and `ImageSummary` both satisfy it. */
export interface ImageLike {
  id: string;
  name: string;
  size: number;
  width?: number;
  height?: number;
  animated: boolean;
  pinned: boolean;
  createdAt: number;
  sourceUrl?: string | null;
  /**
   * A picture's stored thumbnail (C3) — the same field, meaning the same thing,
   * that a clip has carried since M1.
   *
   * Optional for the same reason `ClipLike.thumbBlob` is: the wire row cannot
   * carry a blob, so a shelf seen from the sofa has none and draws treated art.
   */
  thumbBlob?: Blob | null;
}

export interface LibraryInput {
  clips: readonly ClipLike[];
  images: readonly ImageLike[];
  downloads: readonly DownloadEntry[];
  /** Failed jobs the user has waved away, by download id. */
  dismissed: ReadonlySet<string>;
}

/**
 * Which download states are still a story worth telling on the shelf.
 *
 * `aborted` is not: the user pressed Cancel, and a tile explaining what they
 * just did to themselves is noise. `done` is not either — the clip row IS the
 * outcome, and showing both would double the tile for one video.
 */
function isLiveJob(entry: DownloadEntry): boolean {
  return (
    entry.state === 'queued' ||
    entry.state === 'downloading' ||
    entry.state === 'storing' ||
    entry.state === 'error'
  );
}

function clipTile(clip: ClipLike): LibraryTile {
  return {
    key: `clip:${clip.id}`,
    kind: 'clip',
    state: 'ready',
    id: clip.id,
    name: clip.name,
    sizeBytes: clip.size,
    durationSec: clip.durationSec,
    width: clip.width ?? 0,
    height: clip.height ?? 0,
    pinned: clip.pinned,
    animated: false,
    sourceUrl: clip.sourceUrl ?? null,
    sortAt: clip.createdAt,
    thumbBlob: clip.thumbBlob ?? null,
    download: null,
  };
}

function imageTile(row: ImageLike): LibraryTile {
  return {
    key: `image:${row.id}`,
    kind: 'image',
    state: 'ready',
    id: row.id,
    name: row.name,
    sizeBytes: row.size,
    durationSec: null,
    width: row.width ?? 0,
    height: row.height ?? 0,
    pinned: row.pinned,
    animated: row.animated,
    sourceUrl: row.sourceUrl ?? null,
    sortAt: row.createdAt,
    thumbBlob: row.thumbBlob ?? null,
    download: null,
  };
}

function jobTile(entry: DownloadEntry): LibraryTile {
  return {
    // Keyed on the SOURCE, not the job id: the display and this window each
    // mint their own ids for the same link, and a retry mints a third. The
    // link is what the user thinks they added.
    key: `job:${entry.sourceUrl === '' ? entry.id : entry.sourceUrl}`,
    kind: 'clip',
    state: entry.state === 'error' ? 'failed' : 'downloading',
    id: entry.clipId,
    name: entry.name,
    sizeBytes: entry.totalBytes ?? entry.receivedBytes,
    durationSec: null,
    width: 0,
    height: 0,
    pinned: false,
    animated: false,
    sourceUrl: entry.sourceUrl === '' ? null : entry.sourceUrl,
    sortAt: entry.startedAt,
    thumbBlob: null,
    download: entry,
  };
}

/**
 * The whole grid, newest first.
 *
 * A job is dropped the moment its bytes exist — by `clipId`, and also by
 * `sourceUrl`, because a download that finished in the OTHER window is mirrored
 * back here with the id that window minted while the clip row is the one this
 * window can see. Matching on both is what makes the ring turn into a
 * thumbnail in place rather than briefly showing two tiles for one video.
 */
export function buildLibraryTiles(input: LibraryInput): LibraryTile[] {
  const clipIds = new Set(input.clips.map((c) => c.id));
  const clipSources = new Set(
    input.clips
      .map((c) => c.sourceUrl)
      .filter((u): u is string => u !== null && u !== undefined && u !== ''),
  );

  const seenSources = new Set<string>();
  const jobs: LibraryTile[] = [];
  // Newest first, so the first entry for a source is the current attempt.
  for (const entry of [...input.downloads].sort((a, b) => b.startedAt - a.startedAt)) {
    if (input.dismissed.has(entry.id)) continue;
    if (!isLiveJob(entry)) continue;
    if (entry.clipId !== null && clipIds.has(entry.clipId)) continue;
    if (clipSources.has(entry.sourceUrl) || clipSources.has(entry.url)) continue;
    const source = entry.sourceUrl === '' ? entry.id : entry.sourceUrl;
    if (seenSources.has(source)) continue;
    seenSources.add(source);
    jobs.push(jobTile(entry));
  }

  return [...input.clips.map(clipTile), ...input.images.map(imageTile), ...jobs].sort(
    (a, b) => b.sortAt - a.sortAt,
  );
}

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = 1_048_576;
const MB_DECIMALS = 1;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const PAD_BELOW = 10;

/**
 * Kilobytes below a megabyte, megabytes above it.
 *
 * A fixed `MB` unit renders a 32 kB clip and an empty one identically as
 * "0.0 MB", which is the tile telling the user their file has no size.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < BYTES_PER_MB) return `${String(Math.round(bytes / BYTES_PER_KB))} kB`;
  return `${(bytes / BYTES_PER_MB).toFixed(MB_DECIMALS)} MB`;
}

/**
 * `94` → `1:34`, `5400` → `1:30:00`. An unknown or zero duration is an em dash.
 *
 * The hour case is round 2's R7: a 96-minute film read `96:00`, which is not a
 * duration anybody writes — every player, every file browser and every clock in
 * the world rolls over at sixty. Minutes past 59 are the one place this format
 * could be misread as *seconds past the hour*, which is exactly the reading
 * that makes a two-hour film look like a ninety-second clip.
 */
export function formatDuration(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec) || sec <= 0) return '—';
  const total = Math.round(sec);
  const h = Math.floor(total / SECONDS_PER_HOUR);
  const m = Math.floor((total % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const s = total % SECONDS_PER_MINUTE;
  const ss = `${s < PAD_BELOW ? '0' : ''}${String(s)}`;
  if (h === 0) return `${String(m)}:${ss}`;
  return `${String(h)}:${m < PAD_BELOW ? '0' : ''}${String(m)}:${ss}`;
}

/**
 * The one line under a tile's name: how long it runs, and how much room it takes.
 *
 * **No pixel dimensions.** `640×640` was on every tile in the library, and it is
 * a number that changes nothing a person can do: they cannot re-encode from
 * here, the panel scales whatever it gets, and the fit control is two screens
 * away. It is still in the report and still in the clip row — it is simply not
 * what a shelf is for (round 2, R7). The stored dimensions remain on
 * `LibraryTile` for the diagnostics that genuinely need them.
 */
export function tileDetail(tile: LibraryTile): string {
  const parts: string[] = [];
  if (tile.kind === 'clip' && tile.durationSec !== null)
    parts.push(formatDuration(tile.durationSec));
  if (tile.sizeBytes > 0) parts.push(formatBytes(tile.sizeBytes));
  if (tile.animated) parts.push('animated');
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// The identity hue (round 4, F5)
// ---------------------------------------------------------------------------

/**
 * The treated card's base colour, in degrees.
 *
 * `.kh-tile__thumb--treated` paints `linear-gradient(160deg, #24334a, #141a24)`
 * and then rotates it. `#24334a` sits at ~216° — a deep blue — and the rotation
 * below is measured against that, which is the only reason a *rotation* can be
 * reasoned about as a *band* at all.
 */
export const TILE_BASE_HUE_DEG = 216;

/**
 * The cool band the identity hue is allowed to land in, as an absolute hue.
 *
 * Round 4's F5: the hue was `hash % 360`, a full turn, so six of twenty sample
 * filenames landed in red or amber — and red and amber are not decoration in
 * this product, they are the failure colours. A tile that had merely been
 * *named* something looked like a tile that had gone wrong, next to a tile that
 * genuinely had. Identity and status cannot share a channel.
 *
 * So identity gets the cool half of the wheel — blue through teal to violet —
 * and warmth is reserved for the one thing warmth means. 176° is a green-teal
 * and 286° is a violet; nothing in between reads as an alarm.
 */
export const TILE_HUE_MIN_DEG = 176;
export const TILE_HUE_MAX_DEG = 286;

/** Small odd multiplier: cheap, stable, and no collisions that matter. */
const HUE_MIX = 31;

/**
 * A stable hue ROTATION for a name, guaranteed inside the cool band.
 *
 * The return value is what `--kh-tile-hue` takes: degrees to rotate the base
 * gradient by, so `TILE_BASE_HUE_DEG + tileHue(name)` is always within
 * `[TILE_HUE_MIN_DEG, TILE_HUE_MAX_DEG]`. `libraryItems.test.ts` asserts that
 * for a large corpus of names rather than for the ones somebody thought of.
 *
 * A failed tile does not use this at all: it is given the warm treatment by
 * `data-tile-state`, in the stylesheet, so the two channels cannot be confused
 * by a hash that happens to land somewhere unlucky.
 */
export function tileHue(name: string): number {
  const span = TILE_HUE_MAX_DEG - TILE_HUE_MIN_DEG + 1;
  let hash = 0;
  for (const ch of name.trim()) hash = (hash * HUE_MIX + (ch.codePointAt(0) ?? 0)) % span;
  return TILE_HUE_MIN_DEG + hash - TILE_BASE_HUE_DEG;
}
