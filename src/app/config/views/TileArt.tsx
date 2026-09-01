/**
 * What a tile shows, on every window that draws one — A4.
 *
 * ## Treated art is the shipping answer, not a degradation
 *
 * A shelf of treated cards, names and durations is a finished, coherent thing:
 * it is what an Apple TV remote does with a library it cannot see, and it is
 * already CAM's own fallback for a clip with no drawable frame. `TreatedArt` is
 * a deterministic pure function of the name, so **most tiles are pixel-identical
 * on the phone and in CAM for free** — same initial, same hue, same card — and
 * costs exactly zero bytes on the wire. That is the point: the two shelves match
 * because they are computed the same way, not because anybody shipped pictures.
 *
 * The alternative was bulk-pushing forty thumbnails: roughly fourteen seconds of
 * channel-saturating traffic per cold phone, through a free public broker with
 * no uptime promise, repeated on every unlock without a cache. That is refused.
 *
 * ## The one picture that IS free
 *
 * A YouTube source has a public poster at a public URL, and the phone has
 * internet. So the phone fetches `i.ytimg.com` itself rather than asking the
 * display to grab a frame, re-encode it and chunk it over a radio for an image
 * that already has an address. `maxresdefault` does not exist for every upload,
 * so a failed load walks down the candidate list exactly the way the display's
 * own mask controller and the home screen's halo already do — and when the list
 * runs out, the treated card was there the whole time.
 */

import { useState, type CSSProperties } from 'react';

import { ytPosterUrls } from '../../../config/knownHosts';
import { detect } from '../../../modules/video/routing/detect';
import { tileHue } from '../libraryItems';

/**
 * The treated card.
 *
 * Flat, quiet, derived from the name so two things never look identical: the
 * initial plus a hue rotation off a cheap string hash. It is not decoration — it
 * is the difference between "three grey squares" and "three things I can tell
 * apart".
 */
export function TreatedArt({ name }: { name: string }) {
  const trimmed = name.trim();
  // `codePointAt` rather than `[0]`, so a name that starts outside the BMP
  // renders one character instead of half a surrogate pair.
  const first = trimmed.codePointAt(0);
  const initial = first === undefined ? '?' : String.fromCodePoint(first).toUpperCase();
  return (
    <div
      className="kh-tile__thumb kh-tile__thumb--treated"
      data-testid="tile-treated"
      /*
        A cool hue, always (round 4, F5).

        The rotation used to be `hash % 360` — a full turn — so a name could put
        an ordinary clip in red or amber, which are this product's failure
        colours and nothing else. `libraryItems.tileHue` clamps the hash into
        blue → teal → violet; the warm end is spoken for by `data-tile-state`,
        in the stylesheet, and means exactly one thing.
      */
      style={{ '--kh-tile-hue': `${String(tileHue(trimmed))}deg` } as CSSProperties}
    >
      <span aria-hidden="true">{initial}</span>
    </div>
  );
}

/** The poster candidates for a source, best first. Empty means "no picture". */
function posterCandidates(sourceUrl: string | null): readonly string[] {
  if (sourceUrl === null || sourceUrl === '') return [];
  const match = detect(sourceUrl);
  if (match.provider === 'youtube-embed' && match.id !== null && match.id !== '') {
    return ytPosterUrls(match.id);
  }
  return [];
}

/**
 * A tile's picture on a window that cannot reach the bytes.
 *
 * The public poster when the source has one, the treated card otherwise — and
 * the treated card again the moment a poster fails to load, because a broken
 * image icon on a shelf is worse than the card that was always the design.
 */
export function RemoteTileArt({ name, sourceUrl }: { name: string; sourceUrl: string | null }) {
  const candidates = posterCandidates(sourceUrl);
  /**
   * Which candidate is being tried, stamped with the source it belongs to.
   *
   * Stamped rather than reset by an effect: a new source starts the chain over,
   * and "this state belongs to a different input" is something a render can
   * decide for itself. An effect resetting a counter would be a cascading render
   * for a value nothing outside React ever reads — and on a shelf, one per tile.
   */
  const [tried, setTried] = useState<{ src: string | null; n: number }>({ src: sourceUrl, n: 0 });
  const attempt = tried.src === sourceUrl ? tried.n : 0;
  const poster = candidates[attempt] ?? null;

  if (poster === null) return <TreatedArt name={name} />;
  return (
    <img
      className="kh-tile__thumb"
      data-testid="tile-poster"
      src={poster}
      alt=""
      onError={() => {
        setTried({ src: sourceUrl, n: attempt + 1 });
      }}
    />
  );
}
