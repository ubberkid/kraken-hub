/**
 * The one library, flattened into what `resolveMedia` asks for.
 *
 * `MediaIndex` is a structural slice — id, kind, name, hash, sourceUrl — chosen
 * in `src/state/look/file.ts` precisely so core state never has to import a
 * module to know what is in somebody's library. This is the other end of that
 * seam: the two module stores, merged, in the four fields the resolver reads.
 *
 * ## Read from the STORES, not from the published index
 *
 * `readClipIndex()` is synchronous and right there, and it is the wrong source:
 * `ClipSummary` deliberately drops `sha256Prefix` because every field in it is
 * paid for forty times over an 8 kB envelope. A Look file prefers a content
 * hash for exactly the reason the wire drops it — a hash survives a link going
 * dead — so an index built from the summaries would resolve nothing that was
 * exported by hash and would report media as missing that is sitting in the
 * library. So this reads IndexedDB, once, when something that resolves media
 * actually needs it: a Looks sheet opening, or a rotation being switched on.
 * Never at mount for a feature that is off — `useCarousel` explains what that
 * cost, and the cost was two module chunks and a migration on CAM's boot path.
 *
 * Both stores are reached through `await import`, so the Looks sheet does not
 * drag `module-video` and `module-image` into its own static graph.
 */

import type { MediaIndex } from '../../../../../state/look/file';

/**
 * The merged library. Empty on any failure — which is a legal index, and means
 * every local reference resolves to a placeholder with an honest card, rather
 * than the sheet refusing to open because a database was busy.
 */
export async function readMediaIndex(): Promise<MediaIndex> {
  try {
    const [clips, images] = await Promise.all([
      import('../../../../../modules/video/local/clipStore').then(async (m) => m.listClips()),
      import('../../../../../modules/image/imageStore').then(async (m) => m.listImages()),
    ]);
    return [
      ...clips.map((c) => ({
        id: c.id,
        kind: 'clip' as const,
        name: c.name,
        hash: c.sha256Prefix,
        sourceUrl: c.sourceUrl,
      })),
      ...images.map((i) => ({
        id: i.id,
        kind: 'image' as const,
        name: i.name,
        // Pictures carry no content hash — the store has never made one — so a
        // picture is found again by the URL it came from, or not at all.
        hash: null,
        sourceUrl: i.sourceUrl,
      })),
    ];
  } catch {
    return [];
  }
}
