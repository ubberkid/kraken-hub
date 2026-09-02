/**
 * The frame governor: what to do when a look is more than the panel can carry.
 *
 * It has exactly one lever and one prohibition. The lever is a TIER, handed to
 * every mounted renderer as `budget(tier)` and used by the compositor to decide
 * how often each layer's `frame()` is called at all:
 *
 *   full     every tick
 *   reduced  every 4th tick, phase-staggered by layer index
 *   hz1      once a second, staggered by index
 *
 * The prohibition is the important half: **the governor never hides, removes or
 * unmounts a layer.** A panel that silently drops the overlay you added is a
 * panel you cannot trust; a panel whose clock ticks once a second instead of
 * forty times is merely coarser, and the user can see exactly what happened.
 * Every renderer must therefore stay CORRECT at every tier — `budget()` is a
 * hint about detail, never about existence.
 *
 * Hysteresis is why this is a state machine rather than a comparison. An
 * `achievedFps` reading dips whenever a video seeks or a garbage collection
 * lands, and a governor that reacted to the dip would oscillate between tiers
 * once a second — which looks far worse than either tier does on its own. So:
 * demote only after the frame rate has been bad for a sustained ten seconds,
 * promote only after it has been good for thirty, one step at a time.
 *
 * Pure: no DOM, no clock of its own — the caller passes `t`, which is what makes
 * the ten-second and thirty-second thresholds testable with a fake clock.
 *
 * See docs/design/design-layers-architecture.md §7.5.
 */

import type { LookCost } from '../modules/stack';

export type Tier = 'full' | 'reduced' | 'hz1';

/** Cheapest last. `TIERS[i + 1]` is one step down. */
export const TIERS: readonly Tier[] = ['full', 'reduced', 'hz1'];

/** Sustained below `0.6 × targetFps` is "the panel is not keeping up". */
export const DEMOTE_RATIO = 0.6;
/** Back above `0.9 × targetFps` is "there is room again". */
export const PROMOTE_RATIO = 0.9;
export const DEMOTE_AFTER_MS = 10_000;
/** Three times slower to promote than to demote: flapping is worse than a tier. */
export const PROMOTE_AFTER_MS = 30_000;
/**
 * At or below this target the panel is already a slideshow, every frame is
 * precious, and a ten-second wait is a tenth of a minute of visible stutter —
 * so demotion is immediate (§7.5).
 */
export const IMMEDIATE_TARGET_FPS = 10;

export interface GovernorSample {
  /** `performance.now()`-style milliseconds. Monotonic; supplied by the caller. */
  t: number;
  achievedFps: number;
  targetFps: number;
}

export interface LayerGovernor {
  /** Feed one reading; returns the tier in force AFTER it. */
  sample(s: GovernorSample): Tier;
  tier(): Tier;
  /** Back to `full` with both timers cleared — used when the look changes wholesale. */
  reset(): void;
}

function step(tier: Tier, by: 1 | -1): Tier {
  const at = TIERS.indexOf(tier);
  const next = TIERS[Math.min(Math.max(at + by, 0), TIERS.length - 1)];
  return next ?? tier;
}

export function createLayerGovernor(initial: Tier = 'full'): LayerGovernor {
  let tier: Tier = initial;
  let badSince: number | null = null;
  let goodSince: number | null = null;

  return {
    sample({ t, achievedFps, targetFps }) {
      const target = Math.max(1, targetFps);
      const bad = achievedFps < DEMOTE_RATIO * target;
      const good = achievedFps >= PROMOTE_RATIO * target;

      if (bad) {
        goodSince = null;
        badSince ??= t;
        if (target <= IMMEDIATE_TARGET_FPS || t - badSince >= DEMOTE_AFTER_MS) {
          tier = step(tier, 1);
          badSince = t;
        }
      } else if (good) {
        badSince = null;
        goodSince ??= t;
        if (t - goodSince >= PROMOTE_AFTER_MS) {
          tier = step(tier, -1);
          goodSince = t;
        }
      } else {
        // Between the two ratios: neither bad enough to act nor good enough to
        // forgive. Both timers restart, which is the whole point of the band.
        badSince = null;
        goodSince = null;
      }
      return tier;
    },
    tier: () => tier,
    reset() {
      tier = 'full';
      badSince = null;
      goodSince = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

export interface GovernorAttribution {
  tier: Tier;
  /** The costliest ON layer, by the `lookCost` term — `null` for an empty look. */
  worst: LookCost['worst'];
  /**
   * One line, already in words a person could be shown. Empty at `full`: there
   * is nothing to explain when nothing has been reduced.
   */
  sentence: string;
}

/**
 * Which layer to name when the panel slows down.
 *
 * The governor measures the whole page and can only say "not keeping up". The
 * cost model (§7.2) is the only thing that can say WHICH layer to blame, so the
 * two are joined here rather than in either of them — and the answer is a
 * sentence, because "worst: l3f2a1c9" is not something anyone can act on.
 */
export function attribute(tier: Tier, cost: LookCost, targetFps: number): GovernorAttribution {
  const worst = cost.worst;
  if (tier === 'full' || worst === null) return { tier, worst, sentence: '' };
  return {
    tier,
    worst,
    sentence:
      `This look is too rich for ${String(Math.round(targetFps))} fps — ` +
      `the costliest layer is ${worst.kind}.`,
  };
}
