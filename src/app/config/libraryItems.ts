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

import type { ImageRecord } from '../../modules/image/imageStore';
import type { ClipRecord } from '../../modules/video/local/clipStore';
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
  /** Newest first. `createdAt` for stored bytes, `startedAt` for a job. */
  sortAt: number;
  /** The clip's stored thumbnail. Pictures are thumbnailed from their own bytes. */
  thumbBlob: Blob | null;
  /** The job this tile is showing, for progress, cancel, retry and dismiss. */
  download: DownloadEntry | null;
}

export interface LibraryInput {
  clips: readonly ClipRecord[];
  images: readonly ImageRecord[];
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

function clipTile(clip: ClipRecord): LibraryTile {
  return {
    key: `clip:${clip.id}`,
    kind: 'clip',
    state: 'ready',
    id: clip.id,
    name: clip.name,
    sizeBytes: clip.size,
    durationSec: clip.durationSec,
    width: clip.width,
    height: clip.height,
    pinned: clip.pinned,
    animated: false,
    sortAt: clip.createdAt,
    thumbBlob: clip.thumbBlob,
    download: null,
  };
}

function imageTile(row: ImageRecord): LibraryTile {
  return {
    key: `image:${row.id}`,
    kind: 'image',
    state: 'ready',
    id: row.id,
    name: row.name,
    sizeBytes: row.size,
    durationSec: null,
    width: row.width,
    height: row.height,
    pinned: row.pinned,
    animated: row.animated,
    sortAt: row.createdAt,
    thumbBlob: null,
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
    input.clips.map((c) => c.sourceUrl).filter((u): u is string => u !== null && u !== ''),
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
