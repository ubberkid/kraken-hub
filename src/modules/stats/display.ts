/**
 * The stats module's display renderer.
 *
 * ## What the redesign changed, and why each change is cheap
 *
 *  - **It subscribes to the frame clock now.** It did not, and the reason it
 *    did not was sound: the feed is 1 Hz, so painting faster could not produce
 *    a different pixel. That is true only while the module paints the SAMPLE.
 *    It paints a glide toward the sample instead — every displayed value goes
 *    through one tween per metric (`tween.ts`) — so between samples there IS a
 *    different pixel to paint, and a step function has stopped being the
 *    module's idea of motion.
 *  - **The glide is cheaper than the step it replaced.** CAM re-compresses
 *    every captured frame and charges for change; a once-a-second jump moves
 *    every arc and every digit at once, which is the most expensive thing a
 *    static face can do. A glide spreads the same change over ~400 ms, and once
 *    it settles the renderer writes NOTHING — `frame()` returns on a boolean
 *    while no tween is moving, which is most frames.
 *  - **Low-entropy rendering, unchanged.** Flat fills, thin arcs, no gradient,
 *    no blur, no shadow, no CSS transition. The arcs move by `stroke-dasharray`
 *    against `pathLength="100"`, so no frame computes a circumference and no
 *    frame touches layout.
 *  - **Every reading may be `undefined`.** `format.ts` turns that into the
 *    placeholder and a `null` fraction, and a `null` fraction draws the TRACK
 *    ONLY. An empty arc would read as "0 °C", which is worse than saying
 *    nothing. Nothing here invents a pump RPM, because CAM has none.
 *  - **Colour never speaks alone.** A crossed threshold shifts the arc AND
 *    shows the word — `Warm`, `Hot` — in a chip beside the number. The digits
 *    themselves stay in ink at every state: text wears text colours.
 *
 * When no sample has arrived for `WAITING_AFTER_MS`, the module says so
 * explicitly rather than showing a wall of dashes: a stale feed is a different
 * problem from a missing sensor, and the user can act on it (CAM not running,
 * the integration reloaded, the watchdog mid-recovery).
 */

import { clamp } from '../../lib/clamp';

import {
  PLACEHOLDER,
  RING_VIEW,
  emptyHistory,
  formatMetric,
  isRingLayout,
  meterFill,
  meterKindFor,
  meterSweepDeg,
  metricRange,
  pushSample,
  readMetric,
  ringFor,
  ringSpan,
  sparkPath,
  stateLabel,
  statsPaintKey,
  subLineFor,
  tilesFor,
  type MeterKind,
  type StatsTile,
} from './format';
import {
  STATS_HOT,
  STATS_HOT_TRACK,
  STATS_INK,
  STATS_PALETTES,
  STATS_WARM,
  STATS_WARM_TRACK,
  type StatsConfig,
  type StatsLayout,
  type StatsMetric,
} from './schema';
import { approach, tierIntervalMs, tierTweens, unsettled, type BudgetTier } from './tween';

import type { FrameInfo } from '../../platform/fpsGovernor';
import type { Geometry } from '../../platform/geometry';
import type { NormalizedMonitoring } from '../../platform/monitoring';
import type { RenderSettings } from '../../state/schema';
import type { DisplayRenderer, ModuleContext } from '../types';

import './stats.css';

/**
 * No sample for this long and the module says "waiting for CAM data".
 *
 * Five seconds, not the platform's 8 s staleness threshold: the watchdog's job
 * is to decide when to RECOVER, and being conservative there is right. Telling
 * the user what is going on is cheap and should happen sooner.
 */
export const WAITING_AFTER_MS = 5000;
const TICK_MS = 1000;

/**
 * How recently a `frame()` must have arrived for the module to consider the
 * host's clock to be DRIVING it.
 *
 * This is the whole of the audit's F4, and the bug it fixes was invisible in
 * every unit test because it needed two real timers to collide. The renderer
 * keeps a 1 Hz `setInterval` so that a host which never calls `frame()` — the
 * config page's replica — still paints, and so a feed going away is noticed.
 * That interval called `step(TICK_MS)`, and a `dt` of a whole second settles
 * every glide in ONE step by design.
 *
 * On the display the interval was started at mount, a beat after the
 * simulator's own 1 Hz feed timer, so the two fired in the same millisecond in
 * that order: the sample arrived, re-targeted every tween — and the module's
 * own timer, a fraction of a millisecond later, snapped all of them straight to
 * the target before a single frame could glide. The 420 ms tween ran only when
 * something ELSE in the stack shifted the timer phase. The measured result was
 * one arc value per second on a face that was supposed to move through a dozen.
 *
 * So the interval now settles the glides only when nothing else is: if a frame
 * has arrived within this window, the frame clock owns the tween and the timer
 * confines itself to noticing new samples and stale feeds. A quarter of a
 * second is longer than a frame at CAM's slowest useful target (4 fps) and far
 * shorter than the interval itself, so the two can never both drive a step.
 */
const FRAME_DRIVEN_WITHIN_MS = 250;

const RING_VIEW_BOX = `${String(-RING_VIEW)} ${String(-RING_VIEW)} ${String(RING_VIEW * 2)} ${String(RING_VIEW * 2)}`;
const SPARK_VIEW_BOX = '0 0 100 100';

const HALF = 0.5;
const SQUARE_INSET_MAX = 0.16;

const GRID_COLUMNS = 2;
const GRID_ROWS = 3;
/**
 * The gap the stylesheet puts between the grid's tiles, as the fraction of the
 * box it writes there.
 *
 * Duplicated here on purpose, and it is the only number in this file that is: a
 * tile's own size is `(box − gaps) / count`, and a dial sized against the BOX
 * rather than against the tile it has to fit inside is how the `grid` face ended
 * up with six dials that were 0 px tall (audit 10, F6). One number, two places,
 * and the layout test asserts the dial actually fits the tile.
 */
const GRID_GAP = 0.04;
/**
 * The grid dial, against its tile's height and its share of the tile's width.
 *
 * Under the tile's height because the label lives BELOW the ring on this face,
 * exactly as it does on the strip; well under its width because six tiles of
 * text is still a text-first face — the arc is a thin hue-led meter behind the
 * number, not a gauge the number happens to sit in.
 */
const GRID_DIAL_H = 0.8;
const GRID_DIAL_W = 0.56;

/** One tile's share of a `span`, once the stylesheet's gaps are taken out. */
function gridTileShare(count: number): number {
  return (1 - GRID_GAP * (count - 1)) / count;
}

/**
 * The `grid` dial as a fraction of the box — the smaller of what a tile's
 * height and a tile's width will give it.
 *
 * Resolved once, here, rather than per frame: it is a constant of the face's
 * proportions, and the layout test asserts it against the tile it has to fit.
 */
const GRID_RING = Math.min(
  gridTileShare(GRID_ROWS) * GRID_DIAL_H,
  gridTileShare(GRID_COLUMNS) * GRID_DIAL_W,
);
/** Three meters in a row, each a ring with its reading inside and a label under it. */
const STRIP_COLUMNS = 3;
/** The ring against the strip's own height, and against its share of the width. */
const STRIP_DIAL_H = 0.62;
const STRIP_DIAL_W = 0.62;
/** The reading inside the ring, and the label under it, against the ring. */
const STRIP_VALUE_FILL = 0.42;
const STRIP_SMALL_FILL = 0.15;

/**
 * Each face's proportions, as fractions of the one box `statsBoxPx()` returns.
 *
 * Three type sizes per face and no more — hero, unit, small — because a fourth
 * is a hierarchy nobody can hold at a glance. `small` carries the label, the
 * sub-line and the state chip; on the triple face it also carries the two
 * outer readings, which is what makes one centre hero read as the hero.
 */
interface FaceScale {
  /** Ring box, as a fraction of the layout box. */
  ring: number;
  /** The hero number. */
  value: number;
  /** Labels, sub-lines and the state chip. */
  small: number;
}

const FACE_SCALES: Readonly<Record<Exclude<StatsLayout, 'strip'>, FaceScale>> = {
  single: { ring: 0.86, value: 0.3, small: 0.055 },
  dual: { ring: 0.86, value: 0.19, small: 0.05 },
  triple: { ring: 0.92, value: 0.13, small: 0.042 },
  /*
   * The text-first face has a meter now (audit 10, F6). It had `ring: 0`, which
   * wrote `--kh-stats-dial: 0px` and gave six `<svg>`s a box of 0 × 0 — and the
   * renderer then dutifully re-dashed the arcs inside them forty-two times a
   * minute, to elements nobody could see. Six numbers with no mark beside them
   * is a table, and a table is the one thing a hue-led face is not allowed to
   * be: a threshold could change a colour with nothing to change it ON.
   *
   * Its ring is a fraction of a TILE rather than of the box — see {@link
   * GRID_RING} — because six tiles are what the box is divided into, and that
   * division is exactly what the old `0` was standing in for.
   */
  grid: { ring: GRID_RING, value: 0.11, small: 0.04 },
  /*
   * The three linear faces draw no ring either — their mark's THICKNESS comes
   * out of `--kh-stats-label` in the stylesheet, so it is still a fraction of
   * the same box and still nothing anybody typed in pixels. Three readings
   * stacked (or stood side by side) leave each one a third of the box, which is
   * what holds these heroes well under the ring faces' own.
   */
  bar: { ring: 0, value: 0.12, small: 0.042 },
  vertical: { ring: 0, value: 0.1, small: 0.035 },
  chart: { ring: 0, value: 0.1, small: 0.035 },
};

/** The faces laid out as three stacked rows, and the ones as three columns. */
const ROW_FACES: readonly StatsLayout[] = ['bar', 'chart'];
const COLUMN_FACES: readonly StatsLayout[] = ['vertical', 'strip'];
const TRIPLE_SLOTS = 3;

/** The unit glyph, against the hero it sits beside. */
const UNIT_RATIO = 0.4;

/**
 * How much bigger the ring box may be than the inscribed square, and where that
 * growth starts and finishes.
 *
 * `safeSidePx()` returns the largest square inside the safe area, which is the
 * right bound for the text-first grid face — text needs corners. A **ring** is
 * a circle, and a circle does not need the corners of that square: on a round
 * panel it may use the whole visible disc, which is `√2` wider than the square
 * it contains. The fills were tuned on small panels, where the difference costs
 * a few pixels; on the largest panel it leaves the rings as an island in the
 * middle of the glass with a third of the diameter unused.
 *
 * So the box grows toward the disc as the panel gets bigger — smoothly, and
 * nowhere near the full `√2`, because the labels and the sub-readouts sit at the
 * box's top and bottom edges and those DO have to stay inside the circle. The
 * two thresholds are a ramp, not a device table: small panels are left exactly
 * as they were, and the largest gets the whole growth.
 */
const BOX_GROWTH_MAX = 1.28;
const GROWTH_START_PX = 336;
const GROWTH_FULL_PX = 600;

/** 0 on a small panel, 1 on the largest one, linear in between. */
function boxGrowth(shortSidePx: number): number {
  const span = GROWTH_FULL_PX - GROWTH_START_PX;
  return clamp((shortSidePx - GROWTH_START_PX) / span, 0, 1);
}

/**
 * The ring faces get the grown box; the grid face keeps the inscribed square,
 * because six tiles of text want the corners the rings do not.
 */
export function statsBoxPx(g: Geometry, render: RenderSettings, layout: string): number {
  /*
   * The strip is not a centred square at all: it spans its own layer box, edge
   * to edge, because the box IS the strip (§1.4 — a stats overlay is a
   * `1.6 × 0.5` frame). There is no safe-area inset to apply either: the frame
   * was already placed inside the panel by the editor, and insetting it again
   * would leave a scrim narrower than the readings on it.
   */
  if (layout === 'strip') return g.width;
  const side = safeSidePx(g, render);
  /*
   * The text-first and the linear faces keep the inscribed square. Six tiles of
   * text want the corners a ring never needed, and a horizontal bar wants its
   * ENDS to stay on the glass — growing the box toward the disc would push the
   * outer edge of the top and bottom rows off a round panel.
   */
  if (layout === 'grid' || !isRingLayout(layout)) return side;
  const scale = 1 + (BOX_GROWTH_MAX - 1) * boxGrowth(Math.min(g.width, g.height));
  // Never wider than the panel itself: a box that overflows would push the
  // labels off the glass, whatever the safe-area maths said.
  return Math.min(side * scale, Math.min(g.width, g.height));
}

/**
 * Every size a face needs, in pixels, derived from the frame it was given.
 *
 * Exported and pure so `layout.test.ts` can assert the proportions at three
 * device presets and at an overlay-sized frame without a document — and so the
 * renderer holds no arithmetic of its own. There is not a device dimension in
 * here: `g` is the only input that knows how big anything is (invariant I5).
 */
export interface StatsSizes {
  /** The layout box every other number is a fraction of. */
  box: number;
  /** The `<svg>` a ring is drawn into, edge to edge. */
  ring: number;
  /** The hero number. */
  value: number;
  /** Unit glyph — the second of the face's three type sizes. */
  unit: number;
  /** Labels, sub-lines and the state chip — the third and last. */
  small: number;
}

export function statsSizes(g: Geometry, render: RenderSettings, layout: StatsLayout): StatsSizes {
  const box = statsBoxPx(g, render, layout);
  // The strip's ring is bounded by the strip's HEIGHT as well as by its third
  // of the width — a 1.6 × 0.5 box is much wider than it is tall.
  const face = layout === 'strip' ? null : FACE_SCALES[layout];
  const ring =
    face === null
      ? Math.min(g.height * STRIP_DIAL_H, (box / STRIP_COLUMNS) * STRIP_DIAL_W)
      : box * face.ring;
  const value = Math.round(face === null ? ring * STRIP_VALUE_FILL : box * face.value);
  return {
    box,
    ring,
    value,
    unit: Math.round(value * UNIT_RATIO),
    small: Math.round(face === null ? ring * STRIP_SMALL_FILL : box * face.small),
  };
}

/** The largest square that is genuinely visible, per panel shape. */
function safeSidePx(g: Geometry, render: RenderSettings): number {
  const short = Math.min(g.width, g.height);
  if (g.shape === 'circle') {
    return short * clamp(render.safeRadiusPct, HALF, 1) * Math.SQRT1_2;
  }
  return short * (1 - 2 * clamp(render.safeAreaPct, 0, SQUARE_INSET_MAX));
}

/** Is the viewer asking for less motion? Then there is no glide, only the value. */
function prefersReducedMotion(): boolean {
  // jsdom has no `matchMedia`, and neither does a stripped webview. No answer
  // means "no preference expressed", which is not the same as "reduce".
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

interface TileNodes {
  root: HTMLElement;
  /** Which shape this tile's mark is, so a frame knows how to write to it. */
  kind: MeterKind;
  /**
   * The mark whose fill is written per frame — an arc, or a bar's fill box, or
   * `null` on the `chart` face, whose only mark is the history itself.
   */
  arc: SVGElement | HTMLElement | null;
  value: HTMLElement;
  unit: HTMLElement;
  label: HTMLElement;
  sub: HTMLElement;
  chip: HTMLElement;
  sparkWrap: SVGSVGElement;
  sparkLine: SVGPathElement;
  sparkDot: SVGCircleElement;
}

/**
 * One tile's static markup.
 *
 * `innerHTML` rather than `createElementNS`, for the same reason as the clock's
 * dial: the HTML parser puts `<svg>` in the SVG namespace by itself, so nothing
 * here has to name the namespace URI — which invariant 4's "no hardcoded
 * origins" rule cannot distinguish from a real origin, and rightly refuses to
 * special-case.
 *
 * `pathLength="100"` is the trick that makes the arc a percentage: the dash
 * array is then literally "how much of the ring is filled", with no
 * circumference arithmetic and nothing to get wrong when the radius changes.
 * `rotate()` puts the arc's start where the face wants it, and the TRACK is
 * dashed to exactly the same sweep so it recedes behind the arc rather than
 * closing the gap the face was designed around.
 */
function ringMarkup(layout: StatsLayout, index: number): string {
  const ring = ringFor(layout, index);
  const r = String(ring.r);
  const w = String(ring.stroke);
  const rot = `rotate(${String(ring.startDeg)})`;
  const trackDash = `${ringSpan(ring.sweepDeg).toFixed(2)} ${String(100)}`;
  return [
    `<svg class="kh-stats__dial" viewBox="${RING_VIEW_BOX}" aria-hidden="true">`,
    `<circle class="kh-stats__track" cx="0" cy="0" r="${r}" fill="none" stroke-width="${w}" stroke-linecap="round" pathLength="100" stroke-dasharray="${trackDash}" transform="${rot}" />`,
    `<circle class="kh-stats__arc" data-arc cx="0" cy="0" r="${r}" fill="none" stroke-width="${w}" stroke-linecap="round" pathLength="100" stroke-dasharray="0 100" transform="${rot}" />`,
    '</svg>',
  ].join('');
}

/**
 * A straight gauge — two divs, not an `<svg>`.
 *
 * The arcs are SVG because a circle has no DOM equivalent. A straight bar does:
 * a rounded track with a rounded fill inside it is two boxes and a border
 * radius, and it is the cheaper of the two to composite besides.
 *
 * It is also the only version that is CORRECT. The obvious symmetry — one
 * `<line>` with `pathLength="100"` so the same `stroke-dasharray` the rings use
 * would drive it — cannot work: a gauge has to stretch to its row, which means
 * `preserveAspectRatio="none"`, which means a non-uniform scale, which distorts
 * both the round cap and the stroke width; and `vector-effect="non-scaling-
 * stroke"` (the usual answer to that) moves the DASH into viewport units too,
 * so a `100 100` array repeats every hundred pixels and paints a row of ticks
 * instead of one bar. That was not a theory — it is what the face rendered.
 *
 * So the fill is a percentage of the track's own length, written to `width` (or
 * `height`, for the face that stands them on end). One number per frame either
 * way, and {@link meterFill} is the one place that decides which string a face
 * writes.
 */
function lineMarkup(): string {
  return [
    '<div class="kh-stats__bar">',
    '<div class="kh-stats__bar-track"></div>',
    '<div class="kh-stats__bar-fill" data-arc></div>',
    '</div>',
  ].join('');
}

function tileMarkup(layout: StatsLayout, index: number): string {
  const kind = meterKindFor(layout);
  const meter =
    kind === 'ring'
      ? ringMarkup(layout, index)
      : kind === 'chart'
        ? // The history IS the mark on this face; a gauge beside it would be the
          // same number said twice. The `<svg>` below is the whole meter.
          ''
        : lineMarkup();
  return [
    /*
     * The strip's ring gets a box of its own, and the reading moves inside it
     * (see {@link buildTileNode}). A ring and the number drawn on top of it are
     * one object, so they get one element: the wrapper is `position: relative`,
     * which makes it the readout's containing block by CONSTRUCTION rather than
     * by a claim about what an absolutely-positioned grid child does. Every
     * other face keeps the flat tile it had — this is not a general change to
     * the markup, it is the strip's ring becoming a thing that can be centred
     * on.
     */
    layout === 'strip' ? `<div class="kh-stats__ring">${meter}</div>` : meter,
    `<svg class="kh-stats__spark" viewBox="${SPARK_VIEW_BOX}" preserveAspectRatio="none" aria-hidden="true" hidden>`,
    '<path class="kh-stats__spark-line" data-spark fill="none" vector-effect="non-scaling-stroke" />',
    '<circle class="kh-stats__spark-dot" data-spark-dot r="2" vector-effect="non-scaling-stroke" />',
    '</svg>',
  ].join('');
}

/**
 * Write one tile's fill — the only DOM write a settled frame ever skips.
 *
 * An arc carries it on `stroke-dasharray`; a bar carries it on a custom
 * property the stylesheet turns into a `width` or a `height`, so which AXIS a
 * gauge grows along stays a CSS decision and no face needs its own branch here.
 */
function paintMark(node: TileNodes, value: string): void {
  const el = node.arc;
  if (el === null) return;
  if (node.kind === 'ring') el.setAttribute('stroke-dasharray', value);
  else (el as HTMLElement).style.setProperty('--kh-stats-fill', value);
}

/** A missing reading draws the track alone — never a mark sitting at zero. */
function showMark(node: TileNodes, visible: boolean): void {
  const el = node.arc;
  if (el === null) return;
  if (node.kind === 'ring') el.setAttribute('visibility', visible ? 'visible' : 'hidden');
  else (el as HTMLElement).style.visibility = visible ? '' : 'hidden';
}

function buildTileNode(layout: StatsLayout, index: number): TileNodes | null {
  const root = document.createElement('div');
  root.className = 'kh-stats__tile';
  root.dataset['slot'] = String(index);
  root.dataset['state'] = 'normal';
  root.innerHTML = tileMarkup(layout, index);

  const arc = root.querySelector<SVGElement | HTMLElement>('[data-arc]');
  const sparkWrap = root.querySelector<SVGSVGElement>('.kh-stats__spark');
  const sparkLine = root.querySelector<SVGPathElement>('[data-spark]');
  const sparkDot = root.querySelector<SVGCircleElement>('[data-spark-dot]');
  if (sparkWrap === null || sparkLine === null || sparkDot === null) return null;

  const stack = document.createElement('div');
  stack.className = 'kh-stats__stack';

  const readout = document.createElement('div');
  readout.className = 'kh-stats__readout';
  const value = document.createElement('span');
  value.className = 'kh-stats__value';
  const unit = document.createElement('span');
  unit.className = 'kh-stats__unit';
  readout.append(value, unit);

  // The word that a colour shift is never allowed to travel without.
  const chip = document.createElement('div');
  chip.className = 'kh-stats__chip';
  chip.hidden = true;

  const label = document.createElement('div');
  label.className = 'kh-stats__label';
  const sub = document.createElement('div');
  sub.className = 'kh-stats__sub';

  /*
   * The strip hangs its reading off the ring's own box; every other face keeps
   * the reading in the stack, where the block-positioning rules move all four
   * pieces together. The ring wrapper only exists on the strip, so the branch
   * is a lookup rather than a layout test.
   */
  const ringBox = root.querySelector<HTMLElement>('.kh-stats__ring');
  if (ringBox === null) stack.append(readout, chip, label, sub);
  else {
    ringBox.append(readout);
    stack.append(chip, label, sub);
  }
  root.append(stack);
  return {
    root,
    kind: meterKindFor(layout),
    arc,
    value,
    unit,
    label,
    sub,
    chip,
    sparkWrap,
    sparkLine,
    sparkDot,
  };
}

export function createRenderer(): DisplayRenderer<StatsConfig> {
  let root: HTMLElement | null = null;
  let grid: HTMLElement | null = null;
  let waitingNode: HTMLElement | null = null;
  let ctxRef: ModuleContext | null = null;
  let cfg: StatsConfig | null = null;

  let tiles: TileNodes[] = [];
  let latest: NormalizedMonitoring | null = null;
  let lastSampleAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastKey = '';
  let tier: BudgetTier = 'full';
  let sinceUpdateMs = 0;
  let reducedMotion = false;
  /**
   * `performance.now()` at the last `frame()`, or `0` for "never".
   *
   * The one piece of state the F4 fix needs: it is what lets the 1 Hz timer
   * tell a host that drives frames from one that does not, without either of
   * them having to be told which it is.
   */
  let lastFrameAt = 0;

  /*
   * The tween bank: one glide per tile, held in flat arrays indexed alongside
   * `tiles`. Arrays rather than a map of objects so a frame reads and writes
   * numbers in place and allocates nothing to advance them.
   */
  let metrics: StatsMetric[] = [];
  let targets: (number | null)[] = [];
  let shown: number[] = [];
  let ranges: { min: number; max: number }[] = [];
  /** Each tile's arc sweep, resolved once at build so no frame allocates one. */
  let sweeps: number[] = [];
  let histories: (number | null)[][] = [];
  let lastText: string[] = [];
  let lastDash: string[] = [];
  let lastVisible: boolean[] = [];
  let moving = false;

  const isWaiting = (): boolean =>
    lastSampleAt === 0 || Date.now() - lastSampleAt > WAITING_AFTER_MS;

  /** Is the host's frame clock advancing the glides for us? */
  const frameDriven = (): boolean =>
    lastFrameAt !== 0 && performance.now() - lastFrameAt < FRAME_DRIVEN_WITHIN_MS;

  const layout = (): void => {
    if (root === null || ctxRef === null || cfg === null) return;
    const g = ctxRef.geometry();
    // Every size below is a fraction of this one number, so the whole module
    // scales with whatever frame it was given — a full panel, a 0.6 overlay, or
    // the smallest device preset — and nothing here is a pixel anybody typed.
    const size = statsSizes(g, ctxRef.render(), cfg.layout);

    root.style.setProperty('--kh-stats-box', `${String(Math.round(size.box))}px`);
    root.style.setProperty('--kh-stats-dial', `${String(Math.round(size.ring))}px`);
    root.style.setProperty('--kh-stats-value', `${String(size.value)}px`);
    root.style.setProperty('--kh-stats-unit', `${String(size.unit)}px`);
    root.style.setProperty('--kh-stats-label', `${String(size.small)}px`);
    // Kept in step with `--kh-stats-label`: labels, sub-lines and the state
    // chip are ONE size, which is what holds the face to three of them.
    root.style.setProperty('--kh-stats-sub', `${String(size.small)}px`);
    const columns =
      cfg.layout === 'grid' ? GRID_COLUMNS : COLUMN_FACES.includes(cfg.layout) ? STRIP_COLUMNS : 1;
    const rows =
      cfg.layout === 'grid' ? GRID_ROWS : ROW_FACES.includes(cfg.layout) ? TRIPLE_SLOTS : 1;
    root.style.setProperty('--kh-stats-cols', String(columns));
    root.style.setProperty('--kh-stats-rows', String(rows));
  };

  const paintTheme = (): void => {
    if (root === null || cfg === null) return;
    const palette = STATS_PALETTES[cfg.theme];
    root.style.setProperty('--kh-stats-fg', palette.fg);
    root.style.setProperty('--kh-stats-dim', palette.dim);
    root.style.setProperty('--kh-stats-track', palette.track);
    // Ink and the two semantic colours are the same in every palette: a warning
    // that changes hue with the user's taste is not a warning.
    root.style.setProperty('--kh-stats-ink', STATS_INK);
    root.style.setProperty('--kh-stats-warm', STATS_WARM);
    root.style.setProperty('--kh-stats-warm-track', STATS_WARM_TRACK);
    root.style.setProperty('--kh-stats-hot', STATS_HOT);
    root.style.setProperty('--kh-stats-hot-track', STATS_HOT_TRACK);
    root.dataset['labels'] = cfg.showLabels ? 'on' : 'off';
    root.dataset['spark'] = cfg.sparkline ? 'on' : 'off';
  };

  const build = (): void => {
    if (grid === null || cfg === null) return;
    const wanted = tilesFor(cfg, latest);
    grid.replaceChildren();
    tiles = [];
    metrics = [];
    targets = [];
    shown = [];
    ranges = [];
    sweeps = [];
    histories = [];
    lastText = [];
    lastDash = [];
    lastVisible = [];

    const face = cfg.layout;
    wanted.forEach((tile: StatsTile, i: number) => {
      const node = buildTileNode(face, i);
      if (node === null) return;
      tiles.push(node);
      grid?.append(node.root);
      metrics.push(tile.metric);
      targets.push(tile.raw);
      // Nothing to glide from on the first sample: start where the value is.
      shown.push(tile.raw ?? tile.min);
      ranges.push(metricRange(tile.metric));
      sweeps.push(meterSweepDeg(face, i));
      histories.push(emptyHistory());
      lastText.push('');
      lastDash.push('');
      // The markup starts visible, so the first hidden state is a real write.
      lastVisible.push(true);
    });

    if (root !== null) {
      root.dataset['layout'] = cfg.layout;
      paintTheme();
    }
    lastKey = '';
    moving = true;
  };

  /** Redraw one sparkline. Once a second at most — never from a frame. */
  const paintSpark = (i: number): void => {
    const node = tiles[i];
    const history = histories[i];
    const range = ranges[i];
    if (node === undefined || history === undefined || range === undefined || cfg === null) return;
    /*
     * On the `chart` face the history is not a garnish under a number — it IS
     * the face, so the switch that turns the little line on and off has nothing
     * to say about it. Everywhere else the rule is unchanged: only if asked
     * for, and never on the two faces with no room.
     */
    const on =
      cfg.layout === 'chart' ||
      (cfg.sparkline &&
        cfg.layout !== 'grid' &&
        cfg.layout !== 'strip' &&
        cfg.layout !== 'bar' &&
        cfg.layout !== 'vertical');
    const path = on ? sparkPath(history, range.min, range.max) : null;
    // `hidden` as an attribute rather than the property: the DOM lib types the
    // property on `HTMLElement` only, and this is an `<svg>`.
    if (path === null) {
      node.sparkWrap.setAttribute('hidden', '');
      return;
    }
    node.sparkWrap.removeAttribute('hidden');
    node.sparkLine.setAttribute('d', path.d);
    node.sparkDot.setAttribute('cx', path.endX.toFixed(1));
    node.sparkDot.setAttribute('cy', path.endY.toFixed(1));
  };

  /**
   * Everything a NEW SAMPLE changes: the tween targets, the words, the state.
   *
   * The threshold state is decided here, from the sample, and never from a
   * value mid-glide — otherwise crossing a warm point would flicker the chip
   * on and off for the length of the tween.
   */
  const paintSample = (fresh: boolean): void => {
    if (cfg === null || waitingNode === null || grid === null) return;
    const waiting = isWaiting();
    const data = tilesFor(cfg, waiting ? null : latest);
    const key = statsPaintKey(data, waiting);
    if (key === lastKey && !fresh) return;
    lastKey = key;

    waitingNode.hidden = !waiting;
    grid.hidden = waiting;

    data.forEach((tile: StatsTile, i: number) => {
      const node = tiles[i];
      if (node === undefined || cfg === null) return;

      targets[i] = tile.raw;
      if (tile.raw === null || !tierTweens(tier) || reducedMotion) shown[i] = tile.raw ?? tile.min;

      // A missing reading has no unit either: `-- °C` implies we know it is a
      // temperature reading that happens to be absent, which is a stronger claim
      // than we can make when the sensor is simply not there.
      node.unit.textContent = tile.raw === null ? '' : tile.unit;

      /*
       * Every meter is labelled with the metric it is showing, and with nothing
       * else — the audit's M8. The label used to be suppressed when the old
       * sub-line opened with the same component's name ("CPU 17%" under a
       * meter already called CPU); the sub-line is the prototype's second
       * DIMENSION now ("48% load · 4.8 GHz"), so the name appears once and the
       * slot the reader is looking at always says what it is.
       */
      node.label.textContent = cfg.layout === 'grid' ? tile.longLabel : tile.label;
      node.label.hidden = false;

      const sub = subLineFor(tile, cfg, waiting ? null : latest);
      node.sub.textContent = sub ?? '';
      node.sub.hidden = sub === null;

      // The colour and the word move together, always, in both directions.
      const word = stateLabel(tile.state);
      node.root.dataset['state'] = tile.state;
      node.chip.textContent = word;
      node.chip.hidden = word === '';

      if (fresh) {
        const history = histories[i];
        if (history !== undefined) pushSample(history, readMetric(tile.metric, latest));
        paintSpark(i);
      }
    });

    moving = true;
  };

  /**
   * One step of every glide, and the only place a frame writes to the DOM.
   *
   * Returns early on a boolean while nothing is moving, which is the common
   * case: between one settled sample and the next there is genuinely nothing to
   * paint, and the compressor is handed an unchanged frame.
   */
  const step = (dtMs: number): void => {
    if (cfg === null || !moving) return;
    const kind = meterKindFor(cfg.layout);
    let stillMoving = false;

    for (let i = 0; i < tiles.length; i += 1) {
      const node = tiles[i];
      const metric = metrics[i];
      const range = ranges[i];
      const target = targets[i] ?? null;
      const current = shown[i];
      if (node === undefined || metric === undefined || range === undefined) continue;
      if (current === undefined) continue;

      const glides = target !== null && tierTweens(tier) && !reducedMotion;
      const stepped = glides ? approach(current, target, dtMs) : (target ?? current);
      /*
       * Settle EXPLICITLY rather than waiting for float equality (see
       * `unsettled`). Two things depend on this: `moving` must be able to reach
       * `false`, or the renderer never goes quiet; and `frame()` must be able
       * to answer "is a glide still running?" honestly, which is what keeps the
       * clock hot for exactly as long as the tween needs it and no longer.
       */
      const running = target !== null && unsettled(stepped, target, range.max - range.min);
      const next = running ? stepped : (target ?? stepped);
      shown[i] = next;
      if (running) stillMoving = true;

      // Guarded so the DOM — and therefore the compressor — sees a write only
      // when the rendered digits or the arc's length actually differ.
      const text = target === null ? PLACEHOLDER : formatMetric(metric, next, cfg);
      if (text !== lastText[i]) {
        lastText[i] = text;
        node.value.textContent = text;
      }

      const fraction =
        target === null ? null : clamp((next - range.min) / (range.max - range.min), 0, 1);
      const dash = meterFill(kind, sweeps[i] ?? 0, fraction);
      if (dash !== lastDash[i]) {
        lastDash[i] = dash;
        paintMark(node, dash);
      }
      /*
       * `null` draws the track alone. An empty arc would read as zero — and a
       * sensor sitting exactly at the bottom of its range produces the same
       * dash as a missing one, which is why visibility is tracked separately
       * rather than inferred from the dash having changed.
       */
      const visible = fraction !== null;
      if (visible !== lastVisible[i]) {
        lastVisible[i] = visible;
        showMark(node, visible);
      }
    }

    moving = stillMoving;
  };

  return {
    mount(host: HTMLElement, ctx: ModuleContext, config: StatsConfig) {
      ctxRef = ctx;
      cfg = config;
      reducedMotion = prefersReducedMotion();

      root = document.createElement('div');
      root.className = 'kh-stats';

      grid = document.createElement('div');
      grid.className = 'kh-stats__grid';

      waitingNode = document.createElement('div');
      waitingNode.className = 'kh-stats__waiting';
      waitingNode.textContent = 'Waiting for CAM data…';
      waitingNode.hidden = true;

      root.append(grid, waitingNode);
      host.append(root);

      // A sample may already be in hand — `ModuleHost` subscribes us AFTER
      // mount, so without this the first second on screen is a false "waiting".
      const already = ctx.monitoring.latest();
      if (already !== null) {
        latest = already.norm;
        lastSampleAt = ctx.monitoring.lastUpdateAt();
      }

      build();
      layout();
      paintSample(true);
      // Straight to the first reading: there is nothing behind us to glide from.
      step(TICK_MS);

      /*
       * The one timer, and it is not the renderer.
       *
       * It exists so the feed going AWAY is noticed, and so the module is still
       * correct in a host that never calls `frame()` — the config page's
       * replica drives one at 1 Hz, and a `dt` of a second settles every glide
       * in a single step. Where frames ARE flowing this costs one comparison a
       * second and writes nothing.
       */
      timer = setInterval(() => {
        paintSample(false);
        // Only where nothing else is stepping — see `FRAME_DRIVEN_WITHIN_MS`.
        if (!frameDriven()) step(TICK_MS);
      }, TICK_MS);
    },

    update(config: StatsConfig) {
      const rebuild =
        cfg?.layout !== config.layout ||
        cfg.primary !== config.primary ||
        cfg.metrics.join() !== config.metrics.join();
      cfg = config;
      if (rebuild) build();
      else paintTheme();
      lastKey = '';
      layout();
      paintSample(false);
      for (let i = 0; i < tiles.length; i += 1) paintSpark(i);
      step(TICK_MS);
    },

    monitoring(norm: NormalizedMonitoring) {
      latest = norm;
      lastSampleAt = Date.now();
      paintSample(true);
      /*
       * Where there is no glide there is nothing to wait for: at `hz1`, and for
       * a viewer who asked for less motion, the sample goes onto the glass in
       * the callback that delivered it rather than on whichever frame happens
       * to come next — which at `hz1` could be a second away.
       */
      if (!tierTweens(tier) || reducedMotion) step(TICK_MS);
    },

    frame(f: FrameInfo) {
      lastFrameAt = performance.now();
      // The governor's tiers, as a rate limit rather than as a different
      // renderer: `reduced` updates ten times a second, `hz1` once — and `hz1`
      // stops gliding entirely, because a glide sampled once per second is a
      // step with extra arithmetic.
      const interval = tierIntervalMs(tier);
      sinceUpdateMs += f.dt;
      if (sinceUpdateMs < interval) return;
      const dt = sinceUpdateMs;
      sinceUpdateMs = 0;
      step(dt);
    },

    budget(next: BudgetTier) {
      tier = next;
      sinceUpdateMs = 0;
      // Dropping to `hz1` must land on the truth immediately rather than
      // freezing whatever half-glided value happened to be on screen.
      if (!tierTweens(next)) {
        moving = true;
        step(TICK_MS);
      }
    },

    geometry() {
      layout();
    },

    reinit() {
      lastKey = '';
      reducedMotion = prefersReducedMotion();
      paintSample(false);
      moving = true;
      step(TICK_MS);
    },

    unmount() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      root?.remove();
      root = null;
      grid = null;
      waitingNode = null;
      ctxRef = null;
      cfg = null;
      tiles = [];
      metrics = [];
      targets = [];
      shown = [];
      ranges = [];
      sweeps = [];
      histories = [];
      lastText = [];
      lastDash = [];
      lastVisible = [];
      latest = null;
      lastSampleAt = 0;
      lastKey = '';
      moving = false;
      sinceUpdateMs = 0;
      lastFrameAt = 0;
      tier = 'full';
    },
  };
}
