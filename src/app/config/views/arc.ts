/**
 * One ring, two places that draw on it.
 *
 * The remote's mini-halo (`RemoteRing`) and the home screen's video halo
 * (`VideoHalo`) both draw a position arc around a circular bezel, from the same
 * re-anchored telemetry. The maths is identical and there is no reason for two
 * copies of it: the audit's F3 asks the home halo to reuse the ring machinery
 * rather than grow a second one, so the geometry lives here and both callers
 * import it.
 */

const FULL_TURN = 360;
const HALF_TURN = 180;
const QUARTER_TURN = 90;
const RADIANS = Math.PI / HALF_TURN;

/** The SVG arc path for a fraction of a circle, starting at twelve o'clock. */
export function arcPath(fraction: number, radius: number, cx: number, cy: number): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  // A full turn cannot be drawn as one arc — start and end coincide and the
  // renderer draws nothing at all. Stopping a hair short is invisible and is
  // the standard fix.
  const sweep = Math.min(clamped, 0.9999) * FULL_TURN;
  const start = -QUARTER_TURN;
  const end = start + sweep;
  const x1 = cx + radius * Math.cos(start * RADIANS);
  const y1 = cy + radius * Math.sin(start * RADIANS);
  const x2 = cx + radius * Math.cos(end * RADIANS);
  const y2 = cy + radius * Math.sin(end * RADIANS);
  const large = sweep > HALF_TURN ? 1 : 0;
  return `M ${String(x1)} ${String(y1)} A ${String(radius)} ${String(radius)} 0 ${String(large)} 1 ${String(x2)} ${String(y2)}`;
}
