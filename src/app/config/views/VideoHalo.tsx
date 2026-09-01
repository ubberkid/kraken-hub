/**
 * The video halo — the one module whose mirror was a frozen gradient.
 *
 * Clock, Stats and Image get a real live iframe inside the bezel, and it is the
 * best thing in the product. Video got `background: radial-gradient(...)` before
 * you pasted, after you pasted, and while it played (design audit, F3), which
 * breaks the prototype's headline promise — *"the screen is the interface… you
 * never wonder what your cooler is showing"* — precisely where the product
 * lives.
 *
 * It still does not run a second player, and that part was never the bug: two
 * decoders on one origin is double the network, double the composite and, for a
 * YouTube embed, a second set of ads on a page whose whole job is to watch the
 * first one. What it shows instead is something TRUE:
 *
 *  - **YouTube** — the public `i.ytimg.com` poster. This window has internet and
 *    the still already has a URL; `maxresdefault` does not exist for every
 *    upload, so a failed load falls through to `hqdefault` exactly the way the
 *    display's own mask controller does.
 *  - **A stored clip** — the 320 px WebP thumbnail the ingest path already made
 *    and IndexedDB already holds. No network at all.
 *  - **Anything else** — a treated card carrying the source's name. A direct
 *    file has no poster and no cheap first frame (grabbing one means fetching
 *    the video through a CORS check the browser may refuse), and inventing a
 *    picture would be worse than naming the thing honestly.
 *
 * On top of whichever of those landed, the position arc from `RemoteRing`'s own
 * geometry (`./arc.ts`, shared rather than copied) is drawn while telemetry is
 * fresh — the part that makes the bezel feel alive between packets.
 */

import { useEffect, useState } from 'react';

import { ytPosterUrls } from '../../../config/knownHosts';
import { middleEllipsis } from '../../../lib/text';
import { getClip } from '../../../modules/video/local/clipStore';
import { detect } from '../../../modules/video/routing/detect';
import { LOCAL_CLIP_RE } from '../../../modules/video/routing/patterns';

import { arcPath } from './arc';

/** The arc is drawn in a unit box and scaled by the halo's own size. */
const BOX = 100;

/**
 * How much of a name the bezel holds, at each of the halo's two sizes.
 *
 * Round 6's minors, photographed: the card set its name with
 * `overflow-wrap: anywhere`, so at the compact size — 64 px of bezel, which the
 * options panel and the receipt both shrink the halo to — `demo.mp4` was drawn
 * as `dem / o.mp / 4`, three lines of broken word inside a circle. The rule is
 * right for a URL and wrong for a name somebody chose.
 *
 * The numbers are the box: ~128 px of text room at the full size and ~41 px at
 * the compact one, against a 0.8 rem and a 0.62 rem face. `middleEllipsis`
 * explains why the cut is in the middle rather than at the tail.
 */
const NAME_MAX = 18;
const NAME_MAX_COMPACT = 7;
const ARC_STROKE = 2.2;
const ARC_INSET = 1.6;

export interface VideoHaloProps {
  url: string;
  /** The name the status line is using, for the fallback card. */
  name: string;
  /**
   * Whether the halo has yielded the floor and is drawing at thumb size.
   *
   * The home screen already knows — it is the same `compact` that decides
   * whether the options panel, the loop scrubber or the receipt has the floor —
   * and the name's budget is a fact about how much room the bezel has, which
   * CSS cannot compute for a middle ellipsis.
   */
  compact?: boolean;
  /** 0–1 through the clip, or `null` when no duration is known. */
  progress: number | null;
  held: boolean;
}

/** The poster candidates for a URL, best first. Empty means "no picture". */
function posterCandidates(url: string): readonly string[] {
  const match = detect(url);
  if (match.provider === 'youtube-embed' && match.id !== null && match.id !== '') {
    return ytPosterUrls(match.id);
  }
  return [];
}

export function VideoHalo({ url, name, progress, held, compact }: VideoHaloProps) {
  const trimmed = url.trim();
  const candidates = posterCandidates(trimmed);
  const clipId = LOCAL_CLIP_RE.exec(trimmed)?.[1] ?? null;

  /**
   * Which poster candidate is being tried, and which link it belongs to.
   *
   * Stamped with the URL rather than reset by an effect: a new link starts the
   * chain over, and "the state belongs to a different input" is something a
   * render can decide for itself. An effect that reset a counter would be a
   * cascading render for a value nothing outside React ever reads.
   */
  const [tried, setTried] = useState<{ url: string; n: number }>({ url: trimmed, n: 0 });
  const attempt = tried.url === trimmed ? tried.n : 0;

  /** The stored clip's thumbnail, stamped with the clip it was made from. */
  const [clipThumb, setClipThumb] = useState<{ id: string; src: string } | null>(null);

  /**
   * Read the thumbnail straight out of IndexedDB.
   *
   * The object URL is revoked on cleanup, so switching clips does not leak one
   * blob URL per paste for the lifetime of the window. Nothing is cleared
   * synchronously — the `id` stamp above is what makes a stale thumbnail
   * unusable, so there is no cascading render on every URL change.
   */
  useEffect(() => {
    if (clipId === null) return undefined;
    let live = true;
    let objectUrl: string | null = null;
    void getClip(clipId).then((clip) => {
      if (!live || clip?.thumbBlob == null) return;
      objectUrl = URL.createObjectURL(clip.thumbBlob);
      setClipThumb({ id: clipId, src: objectUrl });
    });
    return () => {
      live = false;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [clipId]);

  const poster =
    (clipId !== null && clipThumb?.id === clipId ? clipThumb.src : null) ??
    candidates[attempt] ??
    null;
  const radius = BOX / 2 - ARC_INSET;

  return (
    <>
      <div className="kh-halo__surface" data-testid="halo-surface" />
      {poster !== null ? (
        <img
          className="kh-halo__still"
          data-testid="halo-poster"
          src={poster}
          alt=""
          onError={() => {
            setTried({ url: trimmed, n: attempt + 1 });
          }}
        />
      ) : (
        /*
          Nothing configured yet, so nothing to name.

          The card printed "the demo clip" inside the bezel while the status line
          one row below printed "Ready to play **the demo clip**" — the same four
          words twice, six pixels apart (round 2, R11). The status line owns the
          sentence; the halo shows the surface and gets out of its way.
        */
        <div className="kh-halo__card" data-testid="halo-card">
          {trimmed !== '' && (
            <span className="kh-halo__card-name">
              {middleEllipsis(name, compact === true ? NAME_MAX_COMPACT : NAME_MAX)}
            </span>
          )}
        </div>
      )}
      {progress !== null && (
        <svg
          className="kh-halo__arc"
          viewBox={`0 0 ${String(BOX)} ${String(BOX)}`}
          aria-hidden="true"
          data-testid="halo-arc"
          data-progress={progress.toFixed(4)}
          data-held={held}
        >
          <path
            d={arcPath(progress, radius, BOX / 2, BOX / 2)}
            fill="none"
            strokeWidth={ARC_STROKE}
            strokeLinecap="round"
          />
        </svg>
      )}
    </>
  );
}
