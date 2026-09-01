/**
 * One track, three truths: where playback is, and where the loop starts and
 * ends.
 *
 * The prototype's note — "the loop is two draggable handles on the scrubber,
 * not number fields" — is the whole design here, and it is why the handles are
 * `role="slider"` buttons rather than styled `<input type="range">`s: two
 * ranges cannot share one track without one of them eating the other's pointer
 * events, and neither can express "A may not pass B".
 *
 * The seek control underneath IS a real `<input type="range">`, laid over the
 * track and under the handles. Tapping anywhere on the bar seeks; grabbing a
 * handle moves the loop. Keeping the native input is deliberate: it brings
 * touch behaviour, keyboard support and the platform's own accessibility for
 * the one control most people use, for free.
 *
 * It used to live inside `RemoteView`, on the phone, while the desktop asked
 * people to type "18" and "42" into two fields labelled *seconds* — the single
 * most anti-Apple control in the app (design audit, §2 and §3). So it moved
 * here, and the home screen's Loop op opens exactly this. Two callers, one
 * behaviour:
 *
 *  - **the remote** hands it `onSeek`, because it has a live command channel to
 *    a display and a tap on the rail can genuinely move playback;
 *  - **the home screen** does not, and the rail is then a read-only readout of
 *    the position telemetry publishes. A seek control that silently did nothing
 *    would be the ops row's old lie in a new place.
 */

import { clamp } from '../../../lib/clamp';
import { formatSeconds } from '../homeState';

import type { VideoModuleConfig } from '../../../modules/video/types';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

const PCT = 100;
export const SEEK_SLIDER_STEP_SEC = 0.5;
const LOOP_KEY_STEP_SEC = 0.5;
const LOOP_PAGE_STEPS = 10;

/** The fallback track length when nothing has reported a duration yet. */
export const LOOP_MAX_SEC = 3600;

export function LoopScrubber({
  max,
  positionSec,
  loop,
  onLoopChange,
  onSeek,
  idPrefix = 'remote',
}: {
  max: number;
  positionSec: number;
  loop: VideoModuleConfig['loop'];
  onLoopChange: (next: VideoModuleConfig['loop']) => void;
  /** Omit where there is no live display to seek — the rail becomes a readout. */
  onSeek?: (next: number) => void;
  /** Distinguishes the two mount points, so the seek input's id stays unique. */
  idPrefix?: string;
}) {
  const start = clamp(loop.start, 0, max);
  const end = clamp(loop.end ?? max, 0, max);

  /**
   * Moving a handle turns the loop on.
   *
   * A user dragging A and B and seeing nothing happen because a separate toggle
   * is off is the kind of correct-but-useless behaviour disclosure is supposed
   * to prevent. The toggle below still exists to turn it back off.
   */
  const move = (which: 'a' | 'b', seconds: number): void => {
    if (which === 'a') {
      onLoopChange({ ...loop, enabled: true, start: clamp(seconds, 0, end) });
    } else {
      onLoopChange({ ...loop, enabled: true, end: clamp(seconds, start, max) });
    }
  };

  /**
   * The drag.
   *
   * The track's geometry comes from the handle's own `parentElement` rather
   * than from a `useRef`: the handle IS a child of the track, so the DOM
   * already knows the answer, and reading it inside the event avoids holding a
   * ref that the React compiler would (rightly) refuse to see read during
   * render.
   *
   * `setPointerCapture` on the handle is what makes the whole gesture work on a
   * phone: every subsequent `pointermove` is retargeted to the handle even when
   * the thumb has travelled well outside its 18 px, so a drag never "falls off"
   * the control and never needs document-level listeners.
   */
  const drag = (which: 'a' | 'b', e: ReactPointerEvent<HTMLButtonElement>): void => {
    e.preventDefault();
    const handle = e.currentTarget;
    const track = handle.parentElement;
    if (track === null) return;
    handle.setPointerCapture(e.pointerId);

    const at = (clientX: number): number => {
      const rect = track.getBoundingClientRect();
      if (rect.width <= 0) return 0;
      return clamp((clientX - rect.left) / rect.width, 0, 1) * max;
    };

    move(which, at(e.clientX));
    const onMove = (ev: PointerEvent): void => {
      move(which, at(ev.clientX));
    };
    const onUp = (): void => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };

  /** Arrow keys nudge, Page Up/Down jump, Home/End go to the ends. */
  const key = (which: 'a' | 'b', e: ReactKeyboardEvent<HTMLButtonElement>): void => {
    const from = which === 'a' ? start : end;
    const page = LOOP_KEY_STEP_SEC * LOOP_PAGE_STEPS;
    let next: number | null = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = from - LOOP_KEY_STEP_SEC;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = from + LOOP_KEY_STEP_SEC;
    else if (e.key === 'PageDown') next = from - page;
    else if (e.key === 'PageUp') next = from + page;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = max;
    if (next === null) return;
    e.preventDefault();
    move(which, next);
  };

  const pct = (seconds: number): string => `${String((seconds / Math.max(max, 1)) * PCT)}%`;

  return (
    <div className="kh-scrub" data-testid="scrubber">
      <div className="kh-scrub__track">
        <div className="kh-scrub__rail" />
        <div
          className="kh-scrub__loop"
          data-testid="scrub-loop"
          data-enabled={loop.enabled}
          style={{ left: pct(start), width: pct(Math.max(0, end - start)) }}
        />
        <div className="kh-scrub__fill" style={{ width: pct(positionSec) }} />
        {/*
          The seek control. Visually it is only its thumb — the rail, the loop
          band and the progress fill above are ours — but it is a real range
          input, so a tap anywhere on the bar seeks and every platform's touch
          and keyboard behaviour comes along with it.
        */}
        <input
          id={`${idPrefix}-seek`}
          className="kh-scrub__seek"
          type="range"
          aria-label="Position"
          value={String(positionSec)}
          min={0}
          max={max}
          step={SEEK_SLIDER_STEP_SEC}
          disabled={onSeek === undefined}
          title={onSeek === undefined ? 'Position on your Kraken' : ''}
          onChange={(e) => {
            onSeek?.(Number(e.target.value));
          }}
        />
        <button
          type="button"
          className="kh-scrub__handle kh-scrub__handle--a"
          data-testid="loop-handle-a"
          role="slider"
          aria-label="Loop start"
          aria-valuemin={0}
          aria-valuemax={end}
          aria-valuenow={start}
          aria-valuetext={formatSeconds(start)}
          style={{ left: pct(start) }}
          onPointerDown={(e) => {
            drag('a', e);
          }}
          onKeyDown={(e) => {
            key('a', e);
          }}
        >
          <span className="kh-scrub__lab" aria-hidden="true">
            A
          </span>
        </button>
        <button
          type="button"
          className="kh-scrub__handle kh-scrub__handle--b"
          data-testid="loop-handle-b"
          role="slider"
          aria-label="Loop end"
          aria-valuemin={start}
          aria-valuemax={max}
          aria-valuenow={end}
          aria-valuetext={formatSeconds(end)}
          style={{ left: pct(end) }}
          onPointerDown={(e) => {
            drag('b', e);
          }}
          onKeyDown={(e) => {
            key('b', e);
          }}
        >
          <span className="kh-scrub__lab" aria-hidden="true">
            B
          </span>
        </button>
      </div>

      <div className="kh-scrub__times kh-tnum">
        <span data-testid="scrub-position">{formatSeconds(positionSec)}</span>
        <button
          type="button"
          className="kh-scrub__looptoggle"
          data-testid="loop-toggle"
          aria-pressed={loop.enabled}
          onClick={() => {
            onLoopChange({ ...loop, enabled: !loop.enabled });
          }}
        >
          Loop {formatSeconds(start)} – {loop.end === null ? 'end' : formatSeconds(end)}
        </button>
        <span data-testid="scrub-duration">{formatSeconds(max)}</span>
      </div>
    </div>
  );
}
