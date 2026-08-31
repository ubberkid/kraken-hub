/**
 * Position over the wire is NEVER a bare `posSec`.
 *
 * A phone and a PC do not share a clock, and a display can be asleep for hours.
 * So the sender transmits the sample AND the moment it sampled it
 * (`posSec + posAtTs`), and the receiver re-anchors:
 *
 *   effective = paused ? posSec : posSec + clamp((now - posAtTs)/1000, 0, 30)
 *
 * The 30-second clamp is the whole point. Without it, clock skew between two
 * machines, or a display waking from a three-hour sleep and applying a retained
 * snapshot, both produce a seek to a position that never existed. Clamping
 * turns "resume roughly where we were" into a bounded, always-sane number, and
 * `staleSec` lets the caller decide to ignore the position entirely.
 */

/** Beyond this, extrapolation is guesswork and stops accumulating. */
export const MAX_EXTRAPOLATION_SEC = 30;

/** Older than this, the caller should treat the position as unusable. */
export const POSITION_STALE_SEC = 300;

const MS_PER_SEC = 1000;

export interface WirePosition {
  posSec: number;
  /** Epoch ms on the SENDER's clock when `posSec` was sampled. */
  posAtTs: number;
  paused: boolean;
  /**
   * Playback rate at the moment of sampling. Optional, and absent means `1`.
   *
   * It multiplies the extrapolation, not the clamp: half-speed playback must
   * advance half as far per wall-clock second, but a sample from an hour ago is
   * still guesswork whatever the rate was, so `MAX_EXTRAPOLATION_SEC` still
   * bounds the elapsed time rather than the distance travelled.
   */
  rate?: number;
}

export interface AnchoredPosition {
  /** Where the media should be right now, in seconds. */
  posSec: number;
  /** Age of the sample, in seconds. Negative skew is reported as 0. */
  staleSec: number;
  /** True when the sample is older than `POSITION_STALE_SEC`. */
  stale: boolean;
}

export function anchorPosition(
  p: WirePosition,
  now: number = Date.now(),
  durationSec: number | null = null,
): AnchoredPosition {
  const ageSec = Math.max(0, (now - p.posAtTs) / MS_PER_SEC);
  const rate = p.rate === undefined || !Number.isFinite(p.rate) || p.rate <= 0 ? 1 : p.rate;
  const advance = p.paused ? 0 : Math.min(ageSec, MAX_EXTRAPOLATION_SEC) * rate;
  let posSec = Math.max(0, p.posSec + advance);
  if (durationSec !== null && durationSec > 0) posSec = Math.min(posSec, durationSec);
  return { posSec, staleSec: ageSec, stale: ageSec > POSITION_STALE_SEC };
}

/** The sender's half: stamp a sampled position for transmission. */
export function samplePosition(posSec: number, paused: boolean, now = Date.now()): WirePosition {
  return { posSec, posAtTs: now, paused };
}
