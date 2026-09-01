import { useEffect, useRef } from 'react';

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
 */

/** The ring's diameter in CSS px, matching `.kh-minihalo` in `ui.css`. */
const RING_PX = 132;
const ARC_STROKE = 3;

export interface RemoteRingProps {
  moduleId: string;
  config: unknown;
  render: RenderSettings;
  display: ReplicaDisplayInfo | null;
  monitor: MonitorSnapshot | null;
  monitorAt: number;
  /** A `data:image/webp` thumbnail the display shipped, or a public poster URL. */
  posterUrl: string | null;
  /** The video source, so the ring can tell a local clip from a stream. */
  sourceUrl: string;
  /**
   * What the status line above calls this source, or `''` for nothing chosen.
   *
   * The ring used to print `NO PREVIEW` in uppercase machine type — an
   * engineering non-answer, in a place the home screen's halo solves with a
   * treated card and the source's own name (round 2, R4/R7). Same treatment
   * here: the surface, and the name only when there is one.
   */
  name: string;
  /** 0–1 through the clip, or `null` when there is no known duration. */
  progress: number | null;
  held: boolean;
}

export function RemoteRing(props: RemoteRingProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<ReturnType<typeof startReplica> | null>(null);

  /**
   * Which rings run a real renderer.
   *
   * `image` and `video` are excluded deliberately: their renderers reach into
   * IndexedDB for blobs that live in CAM's browser profile, which this phone
   * can never read, so mounting them here would produce an empty box and a
   * pointless database open. They get the still below instead.
   */
  const replicated = props.moduleId === 'clock' || props.moduleId === 'stats';

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

  const radius = RING_PX / 2 - ARC_STROKE;
  const centre = RING_PX / 2;

  return (
    <div
      className="kh-minihalo"
      data-testid="remote-mirror"
      data-module={props.moduleId}
      data-mode={replicated ? 'replica' : 'still'}
    >
      {replicated ? (
        <div
          className="kh-minihalo__scale"
          data-testid="ring-replica"
          ref={hostRef}
          style={{
            // The panel's own pixel box, scaled to the ring. `null` geometry
            // means no packet has arrived yet; the fallback keeps the element
            // square rather than collapsing it to nothing.
            width: `${String(props.display?.w ?? RING_PX)}px`,
            height: `${String(props.display?.h ?? RING_PX)}px`,
            transform: `scale(${String(RING_PX / (props.display?.w ?? RING_PX))})`,
          }}
        />
      ) : props.posterUrl === null ? (
        <div className="kh-minihalo__card" data-testid="ring-empty">
          {props.sourceUrl.trim() !== '' && (
            <span className="kh-minihalo__card-name">{props.name}</span>
          )}
        </div>
      ) : (
        <img className="kh-minihalo__still" data-testid="ring-still" src={props.posterUrl} alt="" />
      )}

      {props.moduleId === 'video' && props.progress !== null && (
        <svg
          className="kh-minihalo__arc"
          viewBox={`0 0 ${String(RING_PX)} ${String(RING_PX)}`}
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
