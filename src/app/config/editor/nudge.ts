/**
 * The arrow keys' step, in the units the person can actually see (§2.1, M4).
 *
 * The editor's keyboard nudge shipped as `0.01` of a unit, which is a number
 * with no meaning anywhere outside the document: on a 640 px Elite it is 3.2 px
 * and on a 240 px square it is 1.2, so the same press moved a layer a different
 * visible distance on two panels, and neither distance was a pixel.
 *
 * §2.1 asks for **one panel pixel**, ten with Shift. A panel pixel is a pixel of
 * the LCD — the 640-space the look is composited in — and NOT a pixel of the
 * halo on screen, which is a scaled-down mirror whose size depends on the
 * window. So the conversion is through the panel's own radius and nothing else,
 * and the halo's `k` never enters it: a nudge must move the same distance on the
 * Kraken whether the CAM window is 866 px wide or 1400.
 *
 * Pure, DOM-free, unit-tested.
 */

/** One press. §2.1's "1 px, 10 with Shift", in PANEL pixels. */
export const NUDGE_PX = 1;
export const NUDGE_SHIFT_PX = 10;

/**
 * Panel pixels → look units.
 *
 * `1.0` unit is `Geometry.radiusPx`, so a pixel is its reciprocal. A degenerate
 * radius (a panel that has not been measured yet) yields `0` rather than
 * `Infinity`: a press that does nothing is recoverable, and one that throws the
 * layer to the clamp is not.
 */
export function nudgeUnits(px: number, radiusPx: number): number {
  if (!Number.isFinite(px) || !Number.isFinite(radiusPx) || radiusPx <= 0) return 0;
  return px / radiusPx;
}

/** The step one arrow press takes, in units, given the modifier and the panel. */
export function nudgeStep(shift: boolean, radiusPx: number): number {
  return nudgeUnits(shift ? NUDGE_SHIFT_PX : NUDGE_PX, radiusPx);
}
