/**
 * The library, as it goes on the wire.
 *
 * Pure, DOM-free and IDB-free so the budget arithmetic can be tested for what it
 * is — arithmetic — rather than observed as a packet that mysteriously did not
 * arrive.
 *
 * ## The silent cliff this replaces
 *
 * The display published `{kind:'library', clips, downloads}` straight through
 * `publishTele`, and `tele` is not trimmed the way `state` is: an envelope over
 * `MAX_ENVELOPE_BYTES` (8 KB) is DROPPED with a `log.warn` nobody is reading on
 * a hidden Kraken Browser window. A 40-row clip index was already ~8.2 KB
 * against that ceiling, so above roughly thirty-five clips the phone's library
 * went blank **forever, invisibly** — and wave 1 adds pictures to the same
 * packet (B2), which brings the cliff closer.
 *
 * ## The three rules
 *
 *  1. **One list, one budget, one order.** Clips and pictures are one shelf
 *     (fork 3: kind is a property, not a place), so wave 2 puts them in one
 *     `items` array carrying `kind` per row, ordered newest-first by the same
 *     comparator the store sorts with, and cut at one `LIBRARY_ITEM_MAX`. The
 *     wave-1 form — two arrays that a shared budget split apart and the reader
 *     merged back together — described the two stores that no longer exist (C2),
 *     and any packet whose shape has to be rejoined by its reader is a shelf
 *     that can be ordered differently at each end.
 *  2. **Over the byte budget PAGES, it does not drop.** `chunkedTele` is already
 *     generic over `kind` and already carries the two subtleties that matter
 *     (parts of one capture share a `ts`; the shape is uniform, so `part 1 of 1`
 *     is a normal packet). A library too big for one envelope goes out as
 *     `libraryPart` chunks and is reassembled on the far side.
 *  3. **The single-envelope case stays a single envelope.** The overwhelmingly
 *     common library fits, and paying two round trips and a reassembly buffer
 *     for it would be a tax on everybody to serve nobody.
 *
 * A LEAF, in `src/lib`, for the same reason `chunkedTele` is one: the display
 * writes this packet and the config/remote page reads it, so a home inside
 * either app directory would drag one page's graph into the other's. It reads
 * the merged store's row type from `src/platform`, which both pages already
 * have, and `DownloadEntry` `type`-only, which erases at build.
 */

import { newestFirst, type MediaKind, type MediaRecord } from '../platform/mediaStore';

import { toTeleChunks, type TeleChunk } from './chunkedTele';

import type { DownloadEntry } from '../modules/video/local/downloadManager';

/**
 * How many things the shelf announces, across BOTH kinds.
 *
 * Forty is inherited from `CLIP_INDEX_MAX` and is a product decision rather than
 * a byte one — a remote shelf is something you scroll on a sofa, not an archive
 * — but it is now shared, which is the change. The byte ceiling is enforced
 * separately, below, because a shorter list of longer names can still overflow.
 */
export const LIBRARY_ITEM_MAX = 40;

/** The chunked form's `kind`. A distinct name so old peers ignore it cleanly. */
export const LIBRARY_CHUNK_KIND = 'libraryPart';

/**
 * The byte ceiling for the one-envelope form.
 *
 * `MAX_ENVELOPE_BYTES` is 8192 and the envelope's own keys (`v`, `ch`, `ts`,
 * `src`, `role`, `seq`) cost about 120 bytes; the rest of the gap is slack for a
 * long `src` id and for the encryption framing, and it is deliberately generous
 * because the cost of guessing low is one extra round trip and the cost of
 * guessing high is a packet that vanishes.
 */
export const LIBRARY_BODY_BUDGET_BYTES = 7000;

/**
 * One row of the shelf, as it goes on the wire.
 *
 * `kind` is what a row costs to become one list instead of two — about fourteen
 * bytes — and it buys back most of that by letting the kind-specific fields be
 * OMITTED rather than sent as zero: a picture carries no `durationSec` and a
 * clip carries no `animated`. Every field here is paid for forty times over an
 * 8 KB envelope, which is why nothing that a tile does not render is on it.
 */
export interface MediaSummary {
  id: string;
  kind: MediaKind;
  name: string;
  size: number;
  pinned: boolean;
  createdAt: number;
  /** Clips only, omitted otherwise. */
  durationSec?: number;
  /** Pictures only, and only when true. */
  animated?: boolean;
  /** Where the bytes came from, when they were fetched. Absent when unknown. */
  sourceUrl?: string;
}

export interface LibraryPacketInput {
  items: readonly MediaSummary[];
  downloads: readonly DownloadEntry[];
  ts: number;
}

/** The body of a one-envelope library packet. */
export interface LibraryBody {
  ts: number;
  kind: 'library';
  items: MediaSummary[];
  downloads: DownloadEntry[];
}

/**
 * The one store's rows → the one wire row.
 *
 * It reads `MediaRecord`s — what `listMedia()` hands back — rather than the two
 * localStorage index shapes it used to take, and that is the whole of the
 * second-source-of-truth fix. The display built this packet out of
 * `readClipIndex()` + `readImageIndex()` while CAM's grid built its shelf out of
 * the merged store; two readers, two sources, nothing reconciling them, and a
 * mirror write that silently degraded to memory (see `publishImageIndex`) left a
 * row that existed in IndexedDB and could never reach the phone. One reader now,
 * of the store the bytes are actually in.
 *
 * The kind-specific fields are still OMITTED rather than sent as zero — a
 * picture carries no `durationSec` and a clip carries no `animated` — because
 * every field here is paid for forty times inside an 8 KB envelope.
 */
export function toMediaSummaries(rows: readonly MediaRecord[]): MediaSummary[] {
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    size: row.size,
    pinned: row.pinned,
    createdAt: row.createdAt,
    ...(row.kind === 'clip' ? { durationSec: row.durationSec } : {}),
    ...(row.kind === 'image' && row.animated ? { animated: true } : {}),
    // Spread rather than an explicit `undefined`: the latter still costs
    // `"sourceUrl":null` once this is stringified for the wire.
    ...(row.sourceUrl === null || row.sourceUrl === '' ? {} : { sourceUrl: row.sourceUrl }),
  }));
}

export interface LibraryPacket {
  /** The trimmed body. Always produced — it is what the chunks carry, too. */
  body: LibraryBody;
  /**
   * `null` when the body fits one envelope. Otherwise the parts to publish, in
   * order, spaced by `CHUNK_SPACING_MS` — `publishTele` throttles and DROPS
   * inside its window, so a loop would send exactly one of them.
   */
  chunks: TeleChunk[] | null;
}

/**
 * The shelf, newest first, cut at the shared budget.
 *
 * One list and one comparator — `mediaStore.newestFirst`, the same one the store
 * sorts with — so the phone's order is the Kraken's order by construction rather
 * than by two sorts agreeing. Cutting AFTER the merge is the point: a shelf shows
 * what you added most recently, not a quota per file type, so a library of 30
 * clips and 30 pictures publishes the 40 newest things rather than 40 clips.
 */
export function trimLibrary(
  items: readonly MediaSummary[],
  max = LIBRARY_ITEM_MAX,
): MediaSummary[] {
  return [...items].sort(newestFirst).slice(0, Math.max(0, max));
}

/** UTF-8 length, because the budget is bytes and a name can be emoji. */
export function bodyBytes(body: unknown): number {
  return new TextEncoder().encode(JSON.stringify(body)).length;
}

/**
 * Build the packet the display should publish.
 *
 * Downloads ride along untouched: there are at most a handful in flight, they
 * are the reason the shelf feels live, and trimming them would make a running
 * job disappear from the phone while it was running.
 */
export function buildLibraryPacket(input: LibraryPacketInput): LibraryPacket {
  const body: LibraryBody = {
    ts: input.ts,
    kind: 'library',
    items: trimLibrary(input.items),
    downloads: [...input.downloads],
  };

  if (bodyBytes(body) <= LIBRARY_BODY_BUDGET_BYTES) return { body, chunks: null };

  /*
   * Too big for one envelope — so it pages, rather than being dropped.
   *
   * The payload is the SAME body, stringified: the receiver parses it back into
   * exactly the object the one-envelope form would have delivered, so there is
   * one shape downstream and no "was it chunked?" branch to get wrong.
   */
  return {
    body,
    chunks: toTeleChunks({
      kind: LIBRARY_CHUNK_KIND,
      ts: input.ts,
      payload: JSON.stringify(body),
    }),
  };
}
