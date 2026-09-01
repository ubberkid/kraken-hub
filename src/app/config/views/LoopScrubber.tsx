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

import { LOOP_UNLOCKS_ON_LENGTH } from '../../../config/vocabulary';
import { clamp } from '../../../lib/clamp';
import { formatSeconds } from '../homeState';
import { nextLoop } from '../loopPoints';

import type { VideoModuleConfig } from '../../../modules/video/types';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

const PCT = 100;
export const SEEK_SLIDER_STEP_SEC = 0.5;
const LOOP_KEY_STEP_SEC = 0.5;
const LOOP_PAGE_STEPS = 10;

/**
 * The rail's nominal length when nothing has reported a duration yet.
 *
 * A LENGTH TO DRAW, never a duration. Round 2's R4 stopped it being printed as
 * a total; round 7's F1 found it still feeding the seek input's `max` and the
 * handles' range, which is the same invention doing more damage — a tap on the
 * bar printed a playhead somewhere inside a fabricated hour, and a drag on B
 * persisted `loop.end = 2177` for a video nobody had measured. `durationKnown`
 * is what narrows the control; see {@link nextLoop}.
 */
export const LOOP_MAX_SEC = 3600;

export function LoopScrubber({
  max,
  durationKnown = true,
  positionSec,
  loop,
  onLoopChange,
  onSeek,
  idPrefix = 'remote',
}: {
  max: number;
  /**
   * Whether `max` is a duration somebody REPORTED, or the fallback track length.
   *
   * Round 2's R4: with nothing playing, the remote's scrubber read `0:00 /
   * 60:00` — a total nobody had ever measured, invented by `LOOP_MAX_SEC`
   * standing in as the rail's length. An hour is a plausible-looking number,
   * which is what makes it worse than a blank: a user reads it as the length of
   * their video. The rail still needs a length to draw against; the readout
   * says nothing rather than saying that length out loud.
   */
  durationKnown?: boolean;
  positionSec: number;
  loop: VideoModuleConfig['loop'];
  onLoopChange: (next: VideoModuleConfig['loop']) => void;
  /**
   * Omit where there is no live display to seek — the rail becomes a readout.
   *
   * `undefined` is passed explicitly by the remote when the transport greys out
   * (F3), so the type admits it: one group, one answer, and the rail cannot be
   * live while the buttons beside it are not.
   */
  onSeek?: ((next: number) => void) | undefined;
  /** Distinguishes the two mount points, so the seek input's id stays unique. */
  idPrefix?: string;
}) {
  /**
   * Is there a real timeline here, or only a rail?
   *
   * `durationKnown` is the caller's answer to "did the display report a length",
   * and `max > 0` is the arithmetic one. Both, because a reported duration of
   * zero is a rail with no scale exactly as much as an absent one is.
   */
  const scaled = durationKnown && max > 0;
  const start = clamp(loop.start, 0, max);
  const end = clamp(loop.end ?? max, 0, max);

  const move = (which: 'a' | 'b', seconds: number): void => {
    const next = nextLoop(loop, which, seconds, { start, end, max, durationKnown: scaled });
    if (next === null) return;
    onLoopChange(next);
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
    <div className="kh-scrub" data-testid="scrubber" data-scale={scaled ? 'known' : 'unknown'}>
      <div className="kh-scrub__track">
        <div className="kh-scrub__rail" />
        {/*
          With no reported length the rail is DECORATION — round 7's F1.

          A loop band and a progress fill are both positions on a scale, and
          `LOOP_MAX_SEC` is not a scale, it is a number that draws. Rendering
          them against it puts a playhead and an A–B region at plausible-looking
          places inside a fabricated hour, which is worse than an empty rail for
          the same reason "0:00 / 60:00" was worse than a blank: the user reads
          it as their video.
        */}
        {scaled && (
          <>
            <div
              className="kh-scrub__loop"
              data-testid="scrub-loop"
              data-enabled={loop.enabled}
              style={{ left: pct(start), width: pct(Math.max(0, end - start)) }}
            />
            <div className="kh-scrub__fill" style={{ width: pct(positionSec) }} />
          </>
        )}
        {/*
          The seek control. Visually it is only its thumb — the rail, the loop
          band and the progress fill above are ours — but it is a real range
          input, so a tap anywhere on the bar seeks and every platform's touch
          and keyboard behaviour comes along with it.

          It exists only where there is a scale (F1). A range input's whole
          contract is `min`–`max`, and with `LOOP_MAX_SEC` standing in for `max`
          a tap two thirds along the bar reported a playhead at forty minutes of
          a video whose length nobody knows — the invented total the readout was
          taught not to print, arriving through the control instead.
        */}
        {scaled && (
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
            /*
            Not "Position on your Kraken" — round 6, the C2 family.

            The tooltip asserted the panel's current position on a control that
            is read-only precisely BECAUSE nothing has reported one. What is
            true is where the last packet said the player was.
          */
            title={onSeek === undefined ? 'Position, as last reported' : ''}
            onChange={(e) => {
              onSeek?.(Number(e.target.value));
            }}
          />
        )}
        {/*
          The handles are sliders only where a slider has a range — F1.

          With no reported length they are still drawn, at the two ends, because
          removing them would leave a bare rail that explains nothing about why
          the loop is unavailable. What they are NOT is `role="slider"` with an
          `aria-valuemax` of one invented hour: a disabled button has no value to
          publish, and every gesture that could write one is refused by
          `nextLoop` regardless. The hint under the track says what unlocks them.
        */}
        {scaled ? (
          <>
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
          </>
        ) : (
          <>
            <button
              type="button"
              className="kh-scrub__handle kh-scrub__handle--a"
              data-testid="loop-handle-a"
              disabled
              aria-label="Loop start"
              title={LOOP_UNLOCKS_ON_LENGTH}
              style={{ left: '0%' }}
            >
              <span className="kh-scrub__lab" aria-hidden="true">
                A
              </span>
            </button>
            <button
              type="button"
              className="kh-scrub__handle kh-scrub__handle--b"
              data-testid="loop-handle-b"
              disabled
              aria-label="Loop end"
              title={LOOP_UNLOCKS_ON_LENGTH}
              style={{ left: '100%' }}
            >
              <span className="kh-scrub__lab" aria-hidden="true">
                B
              </span>
            </button>
          </>
        )}
      </div>

      <div className="kh-scrub__times kh-tnum">
        <span data-testid="scrub-position">{scaled ? formatSeconds(positionSec) : ''}</span>
        {scaled && (
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
        )}
        <span data-testid="scrub-duration">{scaled ? formatSeconds(max) : ''}</span>
      </div>

      {/*
        …and the reason, named once.

        A control that is simply inert teaches the user that the app is broken;
        one that says what unlocks it is a control that is waiting. The sentence
        is `vocabulary.ts`'s, in the same shape as `PLAYS_WHEN_CONNECTED` — the
        promise the app can actually keep — and it names the ONE thing that has
        to happen, which is a display reporting a duration.
      */}
      {!scaled && (
        <p className="kh-scrub__locked" data-testid="scrub-locked">
          {LOOP_UNLOCKS_ON_LENGTH}
        </p>
      )}
    </div>
  );
}
