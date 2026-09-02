import { fpsAdvisoryBody } from '../../config/camPaths';

import { el } from './dom';

import type { Slot } from './dom';

/**
 * The highest-leverage piece of UX in the whole app.
 *
 * CAM's frame-rate slider defaults to **1 FPS**. A user who never touches it
 * sees a slideshow and blames us, not the slider. So when the panel reports
 * `targetFps <= lowFpsThreshold` and the active module actually animates, we
 * say exactly where the slider is — as a full card for 20 s, then as a small
 * persistent badge that costs almost nothing to encode.
 *
 * It clears itself the moment a higher `targetFps` is observed.
 *
 * W9 keeps every rule the React version had, including the two that were
 * expressed as hooks rather than as copy:
 *
 *  - the card was `key`ed by `targetFps`, so a NEW frame rate re-shows the full
 *    advisory: `targetFps` changing resets `expanded` and restarts the 20 s
 *    timer, exactly as a remount did;
 *  - the timer ran in an effect gated on `low`, so it starts when the advisory
 *    becomes applicable and is cleared when it stops being — a look that goes
 *    static mid-session does not silently collapse the card behind itself.
 *
 * Round 12, F12-1: and it is silent on a panel that is ALREADY at its ceiling.
 * CAM's slider tops out at 1 FPS on a Kraken Z, which is also the threshold — so
 * a stock Z was told, permanently, to drag a slider that is already at maximum
 * to maximum. `maxTargetFps` is the ceiling for the panel actually attached
 * (`devicePresets.maxTargetFpsForPanel`); `null` — a panel nobody here
 * recognises — still advises, because a ceiling we cannot name is not a ceiling
 * we can claim the user has reached.
 *
 * F12-3: every word of the card comes from `config/camPaths.ts`, which owns the
 * instruction app-wide, including the per-panel *"(40 FPS on this panel)"* this
 * file used to drop by re-concatenating the pieces itself.
 */
const ADVISORY_MS = 20_000;

/**
 * Round 13, F1: below this inscribed square the footer line is dropped, not
 * shrunk — the same rule and the same number as the video module's route footer
 * (`modules/video/display.ts`, `FOOTER_MIN_INSCRIBED`). The number is repeated
 * rather than imported because the display shell may not reach into a module
 * (invariant I8 / `budgets.json`'s `displayGraph.forbidden`).
 *
 * A 240 Kraken's safe box is 202 px across and 202 px tall. Title, body and
 * footer together do not fit in it at type anyone can read at a metre; the
 * footer is the sentence a user needs least — it says the notice will go away
 * on its own, which it does whether or not they were told.
 */
const FOOTER_MIN_INSCRIBED = 300;

export interface LowFpsBanner {
  update(
    targetFps: number,
    threshold: number,
    motionLevel: 'static' | 'low' | 'full',
    maxTargetFps: number | null,
    inscribedSquarePx: number,
  ): void;
  /** The equivalent of not rendering the component at all: state resets. */
  clear(): void;
  destroy(): void;
}

export function createLowFpsBanner(host: Slot): LowFpsBanner {
  let fpsKey: number | null = null;
  let expanded = true;
  let low = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** What `node` currently says, so an unchanged advisory is not rebuilt. */
  let painted = '';

  function stopTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function paint(targetFps: number, maxTargetFps: number | null, inscribedPx: number): void {
    const shape = expanded ? 'card' : 'badge';
    const want = low
      ? `${shape}:${String(targetFps)}:${String(maxTargetFps)}:${String(inscribedPx)}`
      : '';
    if (want === painted) return;
    painted = want;
    if (!low) {
      host.set(null);
      return;
    }
    const node = expanded
      ? el('div', { class: 'kh-overlay kh-lowfps' }, [
          el('div', { class: 'kh-card' }, [
            el('p', { class: 'kh-card__title' }, `${String(targetFps)} FPS`),
            // One grammar AND one ceiling for this instruction, app-wide — see
            // `camPaths.fpsAdvisoryBody()`. Never re-concatenated here.
            // `leadIn` is the whole of round 13's M2: this paragraph starts a
            // sentence, so it starts on a capital.
            el('p', { class: 'kh-card__body' }, fpsAdvisoryBody(maxTargetFps, { leadIn: true })),
            // Dropped, not shrunk, on a panel too small to carry three lines.
            ...(inscribedPx >= FOOTER_MIN_INSCRIBED
              ? [
                  el(
                    'p',
                    { class: 'kh-card__footer' },
                    'This notice disappears once a higher frame rate is set.',
                  ),
                ]
              : []),
          ]),
        ])
      : // The same badge the video module's own advisory shrinks to
        // (`modules/video/ui/FpsAdvisory.renderFpsBadge`): one panel, one
        // vocabulary, whichever surface happens to be showing it.
        el('div', { class: 'kh-lowfps__badge' }, `${String(targetFps)} FPS ⚠`);
    host.set(node);
  }

  return {
    update(targetFps, threshold, motionLevel, maxTargetFps, inscribedSquarePx) {
      // `key={targetFps}` — a new frame rate is a new advisory, from the top.
      if (targetFps !== fpsKey) {
        fpsKey = targetFps;
        expanded = true;
        low = false;
        stopTimer();
      }
      /*
       * F12-1: there is nothing to raise on a panel already at its maximum. A
       * stock Kraken Z reports 1 FPS *because that is all CAM offers it*, so the
       * advisory there is a permanent instruction to perform an impossible
       * action. An unknown panel (`null`) keeps the advisory: we cannot claim a
       * ceiling has been reached when we do not know where it is.
       */
      const raisable = maxTargetFps === null || targetFps < maxTargetFps;
      const nextLow = raisable && targetFps <= threshold && motionLevel !== 'static';
      if (nextLow !== low) {
        low = nextLow;
        stopTimer();
        if (low) {
          timer = setTimeout(() => {
            timer = null;
            expanded = false;
            paint(targetFps, maxTargetFps, inscribedSquarePx);
          }, ADVISORY_MS);
        }
      }
      paint(targetFps, maxTargetFps, inscribedSquarePx);
    },
    clear() {
      stopTimer();
      fpsKey = null;
      expanded = true;
      low = false;
      painted = '';
      host.set(null);
    },
    destroy() {
      stopTimer();
      host.set(null);
    },
  };
}
