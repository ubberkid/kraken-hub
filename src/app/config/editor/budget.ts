/**
 * The frame budget, as a meter — principle 8, "the frame budget is the limit".
 *
 * ESC caps you at forty elements. That number is arbitrary in both directions:
 * forty static text layers cost nothing and two video decoders are already too
 * many. This app's own cap — `MAX_LAYERS`, 8 — is a WIRE budget rather than a
 * performance one, and the rail shows it plainly as a count (round 10's F4);
 * what the meter shows is the other limit, the COST, which is how a person sees
 * a look getting heavy before the panel starts stuttering.
 *
 * ## Two voices, and they are different claims
 *
 * The meter reads a MEASURED frame rate when the display has published one
 * (`TelePacket.achievedFps`) — the panel is keeping up, or it is not. With no
 * telemetry it falls back to `lookCost()`, which is arithmetic over what each
 * module DECLARES it costs, and says the word *estimated* (§7.2, §11.1). The two
 * sentences go through the presence spine like every other claim about the
 * panel; this module chooses which one and never types either.
 *
 * The attribution — "Nebula is the heaviest layer" — is always from `lookCost`,
 * because the wire carries no per-layer timings. It is therefore always an
 * estimate, and `attributionIsEstimate` is `true` even when the headline is a
 * measurement: naming the wrong layer confidently would be worse than not
 * naming one.
 *
 * Pure. The caller supplies the telemetry it already polls.
 */

import { lookCost, type ConfigOf, type GetModule, type LookVerdict } from '../../../modules/stack';
import { DEMOTE_RATIO, PROMOTE_RATIO } from '../../../render/layerGovernor';
import {
  CLAIM_BUDGET_BEHIND,
  CLAIM_BUDGET_BEHIND_SHORT,
  CLAIM_BUDGET_ESTIMATE,
  CLAIM_BUDGET_ESTIMATE_SHORT,
  CLAIM_BUDGET_MEASURED,
  CLAIM_BUDGET_MEASURED_SHORT,
  panelClaimText,
} from '../panelClaims';

import type { Look } from '../../../state/look/types';
import type { PanelPresence } from '../panelPresence';

/**
 * Below this fraction of the target the panel is visibly behind.
 *
 * The governor's own `DEMOTE_RATIO` (§7.5) rather than a second 0.6 written
 * down here. One number, so the meter and the governor cannot disagree about
 * what "falling behind" means.
 */
export const BEHIND_RATIO = DEMOTE_RATIO;

/**
 * ── Where the bar's two marks are, and why they are the governor's ──────────
 *
 * Round 10's F3: the bar was `min(1, cost.total)` and `cost.total` is normalised
 * so ONE VIDEO BASE is exactly 1.0. So the commonest look in the product — a
 * clip on the panel — pinned the meter at 100 %, and the word beside it was
 * *calm*; a clock base read 0 %; and eight layers on top of the video read 100 %
 * as well, because the clamp had already been reached at one. A bar with three
 * distinct values, two of them the ends, is not a meter.
 *
 * What the number should be measured against is HEADROOM, and the only thing in
 * the build that knows where the headroom runs out is `layerGovernor.ts`: it
 * drops a look to `reduced` when the panel sustains under `DEMOTE_RATIO` of its
 * target and lets it back up above `PROMOTE_RATIO`. Those two ratios are the
 * bar's two marks, in both voices:
 *
 *   0 … 0.6   calm    — nothing the governor would act on
 *   0.6 … 0.9 busy    — inside the band where it is watching
 *   0.9 … 1   over    — where it demotes
 *
 * The MEASURED voice maps the shortfall (`1 - achieved/target`) onto them
 * directly, because that is literally the quantity the governor samples. The
 * ESTIMATE maps the declared cost onto the same marks through the cost model's
 * own verdict boundaries, so "calm" on the meter and `verdict: 'calm'` in
 * `lookCost` are the same statement rather than two that happen to agree at one
 * end.
 *
 * Three readings, three positions — and the numbers are MEASURED off the
 * shipped registry rather than reasoned about (round 11's M-e). Read from
 * `budget-meter`'s own `data-fill` in a browser, at the build in this tree:
 *
 *   clock base, nothing on it                                     0 %  calm
 *   video base, nothing on it                                    60 %  calm
 *   video base + seven overlays (the model's eight-layer cap:
 *     stats, text, icon, date, shape, clock, effect)             69 %  busy
 *
 * This header used to claim the last of those "run past 90 %", which was never
 * true of any look this build can hold: the eight-layer cap is a WIRE budget
 * and the seven kinds it can spend on a video base are cheap next to the
 * decoder underneath them, so a full look lands in the middle of the watching
 * band rather than at the demotion mark. A comment that names a number the app
 * cannot produce is worse than one that names none, because the next person to
 * touch the marks will tune them to it.
 *
 * Loading a look up to 90 % takes a second EXPENSIVE layer rather than seven
 * cheap ones, which is exactly the distinction the old clamp could not draw and
 * the reason the marks are the governor's — `budget.test.ts` pins that case.
 */
const CALM_MARK = DEMOTE_RATIO;
const BUSY_MARK = PROMOTE_RATIO;

/**
 * The cost model's own verdict boundaries, in `lookCost().total` units.
 *
 * `stack.ts` keeps these private (they exist there to compute `verdict`), and
 * this module is on the config side of invariant I8's line, so they are stated
 * again here for the BAR's positions only. Nothing reads the word off them: the
 * `verdict` this module returns is `cost.verdict`, straight from the model, so a
 * change to the boundaries there can move where the bar's marks sit but can
 * never make the meter say a different word than the model does.
 * `budget.test.ts` pins the agreement on a real look at each band.
 */
const COST_CALM_MAX = 1;
const COST_BUSY_MAX = 1.5;

/**
 * A value with two thresholds on it → a fraction with the marks at 0.6 and 0.9.
 *
 * Piecewise linear, and beyond `busy` it approaches the top asymptotically
 * rather than clamping at it: a look at twice the busy limit and a look at ten
 * times it are both "over", and the bar should not claim to tell them apart.
 */
function bandFill(value: number, calmMax: number, busyMax: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value <= calmMax) return CALM_MARK * (value / calmMax);
  if (value <= busyMax) {
    return CALM_MARK + (BUSY_MARK - CALM_MARK) * ((value - calmMax) / (busyMax - calmMax));
  }
  const over = Math.min(1, (value - busyMax) / busyMax);
  return BUSY_MARK + (1 - BUSY_MARK) * over;
}

/** The same three bands, as the word the bar's colour is keyed off. */
function bandVerdict(value: number, calmMax: number, busyMax: number): LookVerdict {
  if (value <= calmMax) return 'calm';
  return value <= busyMax ? 'busy' : 'rich';
}

export interface BudgetInput {
  look: Look;
  registry: GetModule;
  configOf?: ConfigOf;
  presence: PanelPresence;
  /** What the display reported, when it has. */
  targetFps: number | null;
  achievedFps: number | null;
}

export interface BudgetReading {
  /**
   * `0..1`, for the bar, with the governor's two marks at 0.6 and 0.9.
   *
   * Measured where possible, declared otherwise — and on the SAME scale either
   * way, so switching voices moves the bar by what changed rather than by which
   * arithmetic ran.
   */
  fill: number;
  /**
   * The two or three words that fit beside a 120 px bar (F10).
   *
   * The label the meter prints. {@link BudgetReading.headline} is the same claim
   * at full length, for the tooltip.
   */
  label: string;
  /** The headline sentence, already tensed by the presence spine. */
  headline: string;
  /** The line under it. `null` when there is nothing worth naming. */
  detail: string | null;
  /** `true` when the FILL came from declared cost rather than a reading. */
  estimated: boolean;
  /** The heaviest layer's id, for the rail to mark. `null` on an empty look. */
  worstId: string | null;
  /** The number the meter prints, and its unit — `null` before any reading. */
  fps: number | null;
  verdict: LookVerdict;
}

/**
 * What the meter shows right now.
 *
 * `fill` is deliberately "how much of the budget is spent", so the bar fills up
 * as the look gets heavier in both voices — a measured bar that emptied as the
 * frame rate fell would read backwards next to an estimated one that filled.
 */
export function budgetReading(input: BudgetInput): BudgetReading {
  const { look, registry, presence, targetFps, achievedFps } = input;
  const cost = lookCost(look, registry, input.configOf);
  const worst = cost.worst;

  const measurable =
    achievedFps !== null &&
    Number.isFinite(achievedFps) &&
    achievedFps > 0 &&
    targetFps !== null &&
    Number.isFinite(targetFps) &&
    targetFps > 0;

  if (measurable) {
    const ratio = Math.min(1, achievedFps / targetFps);
    /*
     * Spent, not achieved — 1.0 would mean the panel is delivering nothing of
     * what it was asked for — mapped onto the governor's own two marks: the
     * band opens where it starts watching (`1 - PROMOTE_RATIO`) and the bar is
     * full where it demotes (`1 - DEMOTE_RATIO`).
     */
    const shortfall = 1 - ratio;
    const verdict = bandVerdict(shortfall, 1 - BUSY_MARK, 1 - CALM_MARK);
    const behind = ratio < BEHIND_RATIO;
    return {
      fill: bandFill(shortfall, 1 - BUSY_MARK, 1 - CALM_MARK),
      label: panelClaimText(
        behind ? CLAIM_BUDGET_BEHIND_SHORT : CLAIM_BUDGET_MEASURED_SHORT,
        presence,
      ),
      headline: panelClaimText(behind ? CLAIM_BUDGET_BEHIND : CLAIM_BUDGET_MEASURED, presence),
      // The attribution appears whenever the reading is not calm, in both
      // voices — it is the only thing on the meter that says what to DO.
      detail: verdict === 'calm' || worst === null ? null : heaviest(worst.kind),
      estimated: false,
      worstId: worst?.id ?? null,
      fps: Math.round(achievedFps),
      verdict,
    };
  }

  /*
   * No reading, so the declared sum — mapped onto the same two marks through
   * the cost model's own verdict boundaries. A look past the top is not refused
   * and is not an error; it is a look the meter is full for.
   *
   * `verdict` is `cost.verdict`, not a word derived here: the bar's positions
   * are this module's business and the WORD is the model's.
   */
  return {
    fill: bandFill(cost.total, COST_CALM_MAX, COST_BUSY_MAX),
    label: panelClaimText(CLAIM_BUDGET_ESTIMATE_SHORT, presence),
    headline: panelClaimText(CLAIM_BUDGET_ESTIMATE, presence),
    detail: cost.verdict === 'calm' || worst === null ? null : heaviest(worst.kind),
    estimated: true,
    worstId: worst?.id ?? null,
    fps: null,
    verdict: cost.verdict,
  };
}

/**
 * The attribution sentence — §6's "Nebula is the heaviest layer".
 *
 * By KIND rather than by the layer's name, because a name is the user's and a
 * kind is the app's: "the video is the heaviest layer" is useful advice whatever
 * the user called it, and printing a custom name here would put user text in a
 * sentence the app is asserting.
 */
function heaviest(kind: string): string {
  return `The ${kind} layer is the heaviest thing in this look.`;
}
