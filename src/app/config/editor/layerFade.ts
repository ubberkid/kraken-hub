/**
 * A layer arriving and a layer leaving, animated — §7, and the audit's F9.
 *
 * The audit measured `document.getAnimations()` as EMPTY after adding a layer,
 * removing one and switching the base: three of the four transitions §7 names
 * were hard cuts. This module is two of them. The third — the Look switch's
 * 350 ms cross-fade — already exists in `views/editor/looks/crossFade.ts`, and
 * the base switch reuses it rather than growing a second mechanism.
 *
 * ## Three rules it keeps
 *
 *  - **WAAPI, not React** (invariant I4). One `element.animate()` call, driven
 *    by the compositor, visible to `document.getAnimations()` — which is how the
 *    e2e suite's `settle()` waits for the screen to stop moving instead of
 *    sleeping.
 *  - **`opacity` and `scale`, never `transform`.** The compositor owns the
 *    host's `transform` (it is where the layer's position lives), so animating
 *    it would fight `preview()` and `setLook()` for the same property. `scale`
 *    is a separate longhand that COMPOSES with `transform`, so the two never
 *    touch.
 *  - **Reduced motion skips it entirely**, and so does an environment with no
 *    `animate` at all (jsdom). Both return `null`, and every caller treats
 *    `null` as "it already happened" rather than waiting for a promise that
 *    will not resolve.
 */

import { prefersReducedMotion } from './spring';

import type { LayerId } from '../../../state/look/types';

/** §7: a layer arrives in 200–250 ms. `--kh-dur-fast` is the token's end of it. */
export const LAYER_IN_MS = 220;
/** …and leaves faster, because a departure the user asked for should not linger. */
export const LAYER_OUT_MS = 180;

/** How far a new layer scales up from. Small enough to read as "it landed". */
const IN_SCALE = 0.9;

/**
 * The host element the compositor built for a layer, on the editor's canvas.
 *
 * Scoped to `.kh-ed-stage` on purpose: the display page and the phone's replica
 * ring render the same `data-layer` attributes, and a query that found one of
 * those would animate a document this window does not own.
 */
function hostOf(id: LayerId, root: ParentNode = document): HTMLElement | null {
  return root.querySelector<HTMLElement>(`.kh-ed-stage [data-layer="${id}"]`);
}

function canAnimate(el: HTMLElement | null): el is HTMLElement {
  return el !== null && typeof el.animate === 'function' && !prefersReducedMotion();
}

/**
 * Fade and scale a freshly added layer in.
 *
 * Returns the animation, or `null` when there was nothing to animate — the
 * layer's host has not been composited yet, the environment has no WAAPI, or
 * the user asked for less movement.
 */
export function fadeLayerIn(id: LayerId, root: ParentNode = document): Animation | null {
  const el = hostOf(id, root);
  if (!canAnimate(el)) return null;
  return el.animate(
    [
      { opacity: 0, scale: String(IN_SCALE) },
      { opacity: 1, scale: '1' },
    ],
    { duration: LAYER_IN_MS, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' },
  );
}

/**
 * Fade a layer out, and resolve when it is gone.
 *
 * The caller commits the removal in the `then`, so the unmount happens after
 * the fade rather than instead of it. When there is nothing to animate the
 * promise is already resolved, which is what keeps `remove()` SYNCHRONOUS in
 * jsdom — several unit tests call it and read the document on the next line.
 */
export function fadeLayerOut(id: LayerId, root: ParentNode = document): Promise<void> | null {
  const el = hostOf(id, root);
  if (!canAnimate(el)) return null;
  const animation = el.animate([{ opacity: 1 }, { opacity: 0, scale: String(IN_SCALE) }], {
    duration: LAYER_OUT_MS,
    easing: 'cubic-bezier(0.32, 0.72, 0, 1)',
    fill: 'forwards',
  });
  return animation.finished.then(
    () => undefined,
    () => undefined,
  );
}
