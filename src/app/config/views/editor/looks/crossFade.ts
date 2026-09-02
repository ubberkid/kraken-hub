/**
 * The 350 ms a Look switch takes (§4, principle 11).
 *
 * ## Why it is an animation and not two stacked canvases
 *
 * A textbook cross-fade needs the outgoing picture and the incoming one on
 * screen at the same time. On this surface that would mean a second
 * `LayerHost` — a second set of renderers, a second decoder for a video base,
 * a second WebGL context for an effect — alive for a third of a second, on the
 * window that is already running the halo and up to six card previews. The
 * cost is real and the difference is not: the compositor swaps in one frame, so
 * a dip through and back reads as a cross-fade and costs one composited layer.
 *
 * ## Why it is the Web Animations API and not React
 *
 * Invariant I4: nothing on this surface animates by re-rendering. This is one
 * call, on one element, driven by the compositor thread — and it is visible to
 * `document.getAnimations()`, which is how the e2e suite's `settle()` waits for
 * the screen to stop moving instead of sleeping.
 *
 * Reduced motion is honoured by skipping it entirely. The Look still changes;
 * it simply changes at once, which is what somebody who asked for less movement
 * asked for.
 */

import { prefersReducedMotion } from '../../../editor/spring';

/** §4's number. */
export const LOOK_FADE_MS = 350;

/**
 * The element a Look switch is visible in — the mirror, whichever composition
 * is drawing it. Reached by class rather than passed down a ref because the
 * canvas belongs to another component and a ref threaded through three props to
 * animate somebody else's element is worse than a query that fails quietly.
 */
export const MIRROR_SELECTOR = '.kh-home__mirror';

/**
 * Fade the mirror through and back. Returns the animation, or `null` when there
 * was nothing to animate — no mirror on this page, or reduced motion.
 */
export function crossFadeLookSwitch(
  root: ParentNode = document,
  ms: number = LOOK_FADE_MS,
): Animation | null {
  if (prefersReducedMotion()) return null;
  const el = root.querySelector(MIRROR_SELECTOR);
  if (el === null || typeof el.animate !== 'function') return null;
  return el.animate([{ opacity: 1 }, { opacity: 0.08, offset: 0.5 }, { opacity: 1 }], {
    duration: ms,
    easing: 'ease-in-out',
  });
}
