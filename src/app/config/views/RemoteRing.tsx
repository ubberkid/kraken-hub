import { useEffect, useRef } from 'react';

import { middleEllipsis } from '../../../lib/text';
import { startReplica, type ReplicaDisplayInfo, type ReplicaInput } from '../replica';

import { arcPath } from './arc';

import type { RenderSettings } from '../../../state/schema';
import type { MonitorSnapshot } from '../../../sync/monitorSnapshot';

/**
 * The remote's mini-halo, rendering what the LCD is actually rendering.
 *
 * The old surface was a coloured disc — a stand-in. This is the real thing:
 * `../replica.ts` mounts the display's own module renderer inside the ring and
 * feeds it synced state, so the clock ring is the clock module and the stats
 * ring is the stats module. Two rings cannot work that way, and both are
 * honest about it rather than faking a frame:
 *
 *  - **image** and **video** are pictures, and pixels are the one thing this
 *    design refuses to stream. So they show a still: a thumbnail the display
 *    shipped once over the chunked telemetry channel, or — for YouTube — the
 *    public `i.ytimg.com` poster, which the phone fetches for itself, because
 *    it has internet and asking the display to re-encode a frame it already
 *    has a public URL for would be absurd.
 *  - **video** additionally draws a position arc around the ring, from the
 *    re-anchored telemetry the scrubber below already uses, plus a hold dot.
 *    That arc is the part that makes the ring feel live between packets.
 *
 * The scale trick is the whole layout: the replica's host is sized to the
 * PANEL's pixel dimensions and scaled down with a transform. Sizing it to the
 * ring instead would produce a picture that looks plausible and is wrong —
 * every module scales its type and dials off `geometry()`, not off its box.
 *
 * ## …which is exactly why a replica needs a REPORTED panel — round 6's C4
 *
 * The scale trick has one input, and it was allowed to be missing. With no
 * monitor packet yet, `props.display` is `null` and this component fell back to
 * `RING_PX` for both dimensions and `scale(1)`, while `replica.ts` fell back to
 * `0 × 0` for the geometry the module lays itself out against. So a ring with
 * unknown geometry mounted a real renderer at 1:1 inside a 132 px box: a
 * 640 px stats dial cropped to its top-left corner, drawn confidently, on a
 * screen whose whole promise is *what you see is what the panel is showing*.
 * The fallback made a guess look like a report.
 *
 * A replica therefore requires geometry, full stop. Without it the ring shows
 * the treated placeholder card — the same fallback language the home screen's
 * halo uses for a source with no poster, and the same one the picture modules
 * get here. A card that says "nothing has been reported yet" is a true
 * statement; a clipped module is a false one.
 */

/** The ring's diameter in CSS px, matching `.kh-minihalo` in `ui.css`. */
const RING_PX = 132;
const ARC_STROKE = 3;
/**
 * How much of a name fits across the ring before it has to be shortened.
 *
 * The ring is 132 px with a 12 % inset and the card's type is 0.66 rem, which
 * is roughly sixteen characters. `text-overflow: ellipsis` was set on this
 * element and did nothing, because nothing stopped the text wrapping first —
 * see `middleEllipsis` for why the ellipsis goes in the MIDDLE.
 */
const RING_NAME_MAX = 16;

export interface RemoteRingProps {
  moduleId: string;
  config: unknown;
  render: RenderSettings;
  display: ReplicaDisplayInfo | null;
  monitor: MonitorSnapshot | null;
  monitorAt: number;
  /** A `data:image/webp` thumbnail the display shipped, or a public poster URL. */
  posterUrl: string | null;
  /**
   * What the card should be called, or `''` for "nothing to name".
   *
   * The ring used to print `NO PREVIEW` in uppercase machine type — an
   * engineering non-answer, in a place the home screen's halo solves with a
   * treated card and the source's own name (round 2, R4/R7). Same treatment
   * here: the surface, and the name only when there is one.
   *
   * The caller decides what the name IS, which is round 6's C3 arriving here:
   * this used to be gated on a `sourceUrl` prop — the VIDEO url — so a clock
   * ring with no geometry had nothing to print, because the thing it would have
   * been named after was a video the panel was not showing.
   */
  name: string;
  /** 0–1 through the clip, or `null` when there is no known duration. */
  progress: number | null;
  held: boolean;
  /**
   * The ring's diameter in CSS px. Defaults to the remote's own 132.
   *
   * The one prop W6 added, and it is the whole of what "the ring becomes the
   * canvas" costs this component: editing needs a target a thumb can hit, so
   * the phone editor mounts the SAME ring at ~300 px and draws its overlay on
   * top. Nothing else changes — the replica is still sized to the reported
   * panel and scaled to whatever this number is, which is exactly the rule that
   * made 132 px honest in the first place.
   */
  sizePx?: number;
}

export function RemoteRing(props: RemoteRingProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<ReturnType<typeof startReplica> | null>(null);

  /**
   * Which rings run a real renderer.
   *
   * Two conditions, and both are about honesty rather than about capability:
   *
   *  - `image` and `video` are excluded deliberately: their renderers reach
   *    into IndexedDB for blobs that live in CAM's browser profile, which this
   *    phone can never read, so mounting them here would produce an empty box
   *    and a pointless database open. They get the still below instead.
   *  - **the panel's geometry must have been REPORTED** (C4). Every module
   *    scales its type and its dials off `geometry()`, so a renderer mounted
   *    before the first monitor packet is a module laid out for a panel nobody
   *    has described — and the old fallback laid it out at 1:1 in a 132 px box,
   *    which crops a 640 px dial to its corner. No report, no replica.
   */
  const replicated =
    (props.moduleId === 'clock' || props.moduleId === 'stats') && props.display !== null;

  // Everything the replica reads, in one object, so the update effect below has
  // a single dependency and cannot half-apply a change.
  const input: ReplicaInput = {
    moduleId: props.moduleId,
    config: props.config,
    display: props.display,
    render: props.render,
    monitor: props.monitor,
    monitorAt: props.monitorAt,
  };
  // Declared BEFORE the mount effect so the ref is current by the time that
  // effect first runs; writing a ref during render is not allowed. Same shape
  // as `ModuleHost`'s `latestConfigRef`, and for the same reason.
  const inputRef = useRef(input);
  useEffect(() => {
    inputRef.current = input;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (host === null || !replicated) return undefined;
    const handle = startReplica(host, inputRef.current);
    handleRef.current = handle;
    return () => {
      handleRef.current = null;
      handle.stop();
    };
    // A module switch is a REMOUNT: a renderer cannot become a different
    // module, so the id is a dependency and the cleanup above is the teardown.
  }, [props.moduleId, replicated]);

  useEffect(() => {
    handleRef.current?.update(input);
  });

  const ringPx = props.sizePx ?? RING_PX;
  const radius = ringPx / 2 - ARC_STROKE;
  const centre = ringPx / 2;

  return (
    <div
      className="kh-minihalo"
      data-testid="remote-mirror"
      data-module={props.moduleId}
      data-mode={replicated ? 'replica' : 'still'}
      /*
        Inline only when the caller asked for a different size, so the ordinary
        remote is styled entirely by `.kh-minihalo` and nothing in the DOM
        duplicates the stylesheet's 132.
      */
      style={
        ringPx === RING_PX
          ? undefined
          : { width: `${String(ringPx)}px`, height: `${String(ringPx)}px` }
      }
    >
      {replicated && props.display !== null ? (
        <div
          className="kh-minihalo__scale"
          data-testid="ring-replica"
          ref={hostRef}
          style={{
            /*
              The panel's own pixel box, scaled to the ring.

              No `??` fallback any more, and the narrowing above is what makes
              that safe: `replicated` already required a report, so there is no
              longer a branch in which this element has to invent a size. That
              fallback WAS the bug (C4) — `RING_PX` and `scale(1)` are a
              plausible-looking lie about a panel nobody has described.
            */
            width: `${String(props.display.w)}px`,
            height: `${String(props.display.h)}px`,
            transform: `scale(${String(ringPx / props.display.w)})`,
          }}
        />
      ) : props.posterUrl === null ? (
        <div className="kh-minihalo__card" data-testid="ring-empty">
          {props.name.trim() !== '' && (
            <span className="kh-minihalo__card-name">
              {middleEllipsis(props.name, RING_NAME_MAX)}
            </span>
          )}
        </div>
      ) : (
        <img className="kh-minihalo__still" data-testid="ring-still" src={props.posterUrl} alt="" />
      )}

      {props.moduleId === 'video' && props.progress !== null && (
        <svg
          className="kh-minihalo__arc"
          viewBox={`0 0 ${String(ringPx)} ${String(ringPx)}`}
          aria-hidden="true"
          data-testid="ring-arc"
          data-progress={props.progress.toFixed(4)}
          data-held={props.held}
        >
          <path
            d={arcPath(props.progress, radius, centre, centre)}
            fill="none"
            strokeWidth={ARC_STROKE}
            strokeLinecap="round"
          />
        </svg>
      )}
    </div>
  );
}
