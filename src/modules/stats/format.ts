/**
 * Every decision the stats module makes that does not touch the DOM. Pure, and
 * unit-tested in `format.test.ts`, `thresholds.test.ts` and `tween.test.ts`.
 *
 * The whole file is written around one fact: **every numeric field in CAM's
 * monitoring feed is `number | undefined`.** CAM genuinely drops sensors — the
 * simulator's `?monitor=missing` profile rotates fields in and out of
 * `undefined` precisely so this is exercised — so a missing reading renders as
 * the placeholder, never as `NaN`, never as `0` pretending to be a measurement,
 * and never as an arc sitting at the bottom of its range as if the CPU were at
 * 0 °C.
 *
 * The second fact: **there is no pump RPM.** `kraken.liquidTemperature` is the
 * only cooler field that exists.
 *
 * The third, added by the face redesign: **a tile carries its raw reading as
 * well as its rendered one.** The renderer tweens the raw number toward the
 * next 1 Hz sample and formats the tweened value every frame, so the digits and
 * the arc glide rather than chunk; formatting on its own could only ever step.
 */

import { metricLabel, metricLongLabel, STATS_RING_LAYOUTS } from './schema';

import type { StatsConfig, StatsLayout, StatsMetric, StatsThreshold } from './schema';
import type { NormalizedMonitoring } from '../../platform/monitoring';

/**
 * What a missing reading looks like — the string `tests/e2e/modules.spec.ts`
 * looks for under `?monitor=missing`.
 *
 * An em dash rather than two hyphens (W5). `--` reads as a typo at panel size
 * and as a MINUS SIGN next to a temperature, which is the one misreading a
 * cooler's dial cannot afford; `—` is the typographic convention for "no value"
 * and it is one glyph, so CAM's compressor sees a smaller change when a field
 * comes and goes. The rest of the honesty rule is unchanged: a missing reading
 * is never `NaN`, and never `0` wearing a measurement's clothes.
 */
export const PLACEHOLDER = '—';

const PCT = 100;
const F_OFFSET = 32;
/** °F = °C · 9/5 + 32. Spelled out so invariant 5's lint rule can see consts. */
const F_NUMERATOR = 9;
const F_DENOMINATOR = 5;
const F_RATIO = F_NUMERATOR / F_DENOMINATOR;

/** Arc ranges. Fixed, not auto-scaled: a moving axis is unreadable at a glance. */
const TEMP_MIN_C = 20;
const TEMP_MAX_C = 100;
const LIQUID_MIN_C = 20;
const LIQUID_MAX_C = 60;
const FAN_MAX_RPM = 3000;
/** Enough to notice a real change, few enough that noise does not force a repaint. */
const FRACTION_DECIMALS = 3;

export function cToF(celsius: number): number {
  return celsius * F_RATIO + F_OFFSET;
}

/**
 * A reading's relationship to its warm points.
 *
 * Three states, and only the outer two ever change a colour — always in company
 * with {@link stateLabel}, because a hue on its own is not a message anybody
 * can read at a metre, in a photograph, or without colour vision.
 */
export type StatsState = 'normal' | 'warm' | 'hot';

export interface StatsTile {
  metric: StatsMetric;
  /** Short label — `CPU`, `GPU`, `LIQUID`. */
  label: string;
  /** Longer label used by the grid face — `CPU temp`. */
  longLabel: string;
  /** The formatted reading, or the placeholder. */
  value: string;
  /** The unit glyph, already localised to the config (`°C` / `°F` / `%`). */
  unit: string;
  /**
   * 0..1 for an arc, or `null` when there is no reading. `null` means "draw the
   * track and nothing else" — never "draw an empty arc", which reads as zero.
   */
  fraction: number | null;
  /**
   * The reading in its own native scale — °C, a 0..1 load, RPM — before any
   * unit conversion or rounding. `null` when the sensor is not reporting.
   *
   * This is what the renderer tweens. Tweening the *formatted* value could only
   * step, and tweening the fraction would make the digits and the arc disagree
   * for the length of the glide.
   */
  raw: number | null;
  /** The ends of this metric's fixed arc range, in the same native scale. */
  min: number;
  max: number;
  /** Warm/hot, decided from the SAMPLE — never from a value mid-glide. */
  state: StatsState;
}

/**
 * A temperature, in the configured unit. Rounded to whole degrees: a tenth of a
 * degree is noise at arm's length and costs a digit that could have been twice
 * as tall.
 */
export function formatTemp(celsius: number | undefined, unit: StatsConfig['unit']): string {
  if (celsius === undefined || !Number.isFinite(celsius)) return PLACEHOLDER;
  return String(Math.round(unit === 'f' ? cToF(celsius) : celsius));
}

/** A 0..1 load as whole percent. CAM reports fractions, not percentages. */
export function formatLoad(load: number | undefined): string {
  if (load === undefined || !Number.isFinite(load)) return PLACEHOLDER;
  return String(Math.round(clamp01(load) * PCT));
}

export function formatRpm(rpm: number | undefined): string {
  if (rpm === undefined || !Number.isFinite(rpm)) return PLACEHOLDER;
  return String(Math.round(rpm));
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** `null` in, `null` out — the caller must not be able to accidentally get 0. */
export function normalizeRange(value: number | undefined, min: number, max: number): number | null {
  if (value === undefined || !Number.isFinite(value) || max <= min) return null;
  return clamp01((value - min) / (max - min));
}

export function tempUnitGlyph(unit: StatsConfig['unit']): string {
  return unit === 'f' ? '°F' : '°C';
}

/** Whether a metric is a temperature, which is what unit conversion turns on. */
function isTemp(metric: StatsMetric): boolean {
  return metric === 'cpuTemp' || metric === 'gpuTemp' || metric === 'liquidTemp';
}

/** The fixed arc range for a metric, in its own native scale. */
export function metricRange(metric: StatsMetric): { min: number; max: number } {
  switch (metric) {
    case 'cpuTemp':
    case 'gpuTemp':
      return { min: TEMP_MIN_C, max: TEMP_MAX_C };
    case 'liquidTemp':
      return { min: LIQUID_MIN_C, max: LIQUID_MAX_C };
    case 'cpuFanRpm':
      return { min: 0, max: FAN_MAX_RPM };
    case 'cpuLoad':
    case 'gpuLoad':
    case 'ramPct':
      return { min: 0, max: 1 };
  }
}

/** The one place a metric name is turned into a field of the feed. */
export function readMetric(
  metric: StatsMetric,
  monitoring: NormalizedMonitoring | null,
): number | undefined {
  const m = monitoring;
  switch (metric) {
    case 'cpuTemp':
      return m?.cpu.tempC;
    case 'gpuTemp':
      return m?.gpu.tempC;
    case 'liquidTemp':
      return m?.kraken.liquidTempC;
    case 'cpuLoad':
      return m?.cpu.load;
    case 'gpuLoad':
      return m?.gpu.load;
    case 'ramPct':
      return m?.ram.pct;
    case 'cpuFanRpm':
      return m?.cpu.fanRpm;
  }
}

export function metricUnit(metric: StatsMetric, cfg: StatsConfig): string {
  if (isTemp(metric)) return tempUnitGlyph(cfg.unit);
  return metric === 'cpuFanRpm' ? 'RPM' : '%';
}

/**
 * A raw reading, rendered.
 *
 * Called every frame with the TWEENED value, which is the whole point: the
 * glide happens in the number's own scale and the digits are re-derived from
 * it, so an integer readout advances one step at a time in a tabular face and
 * never jitters its width.
 */
export function formatMetric(
  metric: StatsMetric,
  raw: number | undefined | null,
  cfg: StatsConfig,
): string {
  const v = raw ?? undefined;
  if (isTemp(metric)) return formatTemp(v, cfg.unit);
  if (metric === 'cpuFanRpm') return formatRpm(v);
  return formatLoad(v);
}

// ---------------------------------------------------------------------------
// Thresholds — a colour never travels without its word
// ---------------------------------------------------------------------------

/**
 * The warm points for a metric, or `null` when the metric has none.
 *
 * Load, RAM and fan speed have none on purpose. A CPU at 100 % is a CPU doing
 * its job; painting that amber would spend the one alarming colour the face has
 * on the least alarming thing it shows, and a reader who learns to ignore amber
 * on the load meter will ignore it on the liquid meter too.
 */
export function thresholdFor(metric: StatsMetric, cfg: StatsConfig): StatsThreshold | null {
  if (metric === 'cpuTemp') return cfg.thresholds.cpu;
  if (metric === 'gpuTemp') return cfg.thresholds.gpu;
  if (metric === 'liquidTemp') return cfg.thresholds.liquid;
  return null;
}

/**
 * Which state a °C reading is in.
 *
 * Always Celsius in, whatever the face is displaying: the thresholds are stored
 * in Celsius so that flipping the unit switch cannot move the alarm.
 */
export function stateFor(
  metric: StatsMetric,
  celsius: number | undefined,
  cfg: StatsConfig,
): StatsState {
  const t = thresholdFor(metric, cfg);
  if (t === null || celsius === undefined || !Number.isFinite(celsius)) return 'normal';
  if (celsius >= t.hot) return 'hot';
  if (celsius >= t.warm) return 'warm';
  return 'normal';
}

/**
 * The word that MUST accompany the colour.
 *
 * Empty for `normal`, which is the state that does not change any colour and so
 * has nothing to explain.
 */
export function stateLabel(state: StatsState): string {
  if (state === 'hot') return 'Hot';
  if (state === 'warm') return 'Warm';
  return '';
}

/** One tile for one metric, ready to paint. Never throws, never yields `NaN`. */
export function buildTile(
  metric: StatsMetric,
  monitoring: NormalizedMonitoring | null,
  cfg: StatsConfig,
): StatsTile {
  const value = readMetric(metric, monitoring);
  const { min, max } = metricRange(metric);
  return {
    metric,
    label: metricLabel(metric),
    longLabel: metricLongLabel(metric),
    value: formatMetric(metric, value, cfg),
    unit: metricUnit(metric, cfg),
    fraction: normalizeRange(value, min, max),
    raw: value === undefined || !Number.isFinite(value) ? null : value,
    min,
    max,
    state: stateFor(metric, value, cfg),
  };
}

/**
 * Which tiles a face shows.
 *
 * `dual`, `triple` and `strip` read their meters from `cfg.metrics` — one list,
 * sliced, so the same slot cannot mean two different things on two faces.
 * `single` keeps its own `cfg.primary`, because the one-meter face is asking a
 * different question ("which single reading is worth the whole panel?") and had
 * its own answer long before the other faces had any choice at all.
 */
export function tilesFor(cfg: StatsConfig, monitoring: NormalizedMonitoring | null): StatsTile[] {
  const build = (metric: StatsMetric): StatsTile => buildTile(metric, monitoring, cfg);
  const slot = (i: number): StatsTile => build(cfg.metrics[i] ?? 'cpuTemp');
  switch (cfg.layout) {
    case 'single':
      return [build(cfg.primary)];
    case 'dual':
      return [slot(0), slot(1)];
    /*
     * Three readings and no more, on every three-meter face. The strip is half
     * a unit tall and sits over somebody's video; the triple face stacks
     * concentric rings, and a fourth would thin all of them past the point
     * where the innermost still reads. `bar`, `vertical` and `chart` read the
     * SAME three slots rather than inventing a list of their own, so switching
     * face never silently changes which sensors are on the panel.
     */
    case 'triple':
    case 'strip':
    case 'bar':
    case 'vertical':
    case 'chart':
      return [slot(0), slot(1), slot(2)];
    case 'grid':
      return [
        build('cpuTemp'),
        build('cpuLoad'),
        build('gpuTemp'),
        build('gpuLoad'),
        build('liquidTemp'),
        build('ramPct'),
      ];
  }
}

// ---------------------------------------------------------------------------
// The sub-line — the prototype's "48% load · 4.8 GHz", and not one field more
// ---------------------------------------------------------------------------

/** How many facts a face has room for under its hero. `0` means "no sub-line". */
const SUB_FACTS: Readonly<Partial<Record<StatsLayout, number>>> = {
  single: 2,
  dual: 1,
};

/** Whole GHz from CAM's MHz. One decimal, because 4.85 GHz is not a claim. */
const MHZ_PER_GHZ = 1000;
const GHZ_DECIMALS = 1;
/** RAM is reported in MiB; a person reads GiB. */
const MIB_PER_GIB = 1024;
const GIB_DECIMALS = 1;

function ghz(mhz: number | undefined): string {
  if (mhz === undefined || !Number.isFinite(mhz)) return `${PLACEHOLDER} GHz`;
  return `${(mhz / MHZ_PER_GHZ).toFixed(GHZ_DECIMALS)} GHz`;
}

function pctFact(load: number | undefined, noun: string): string {
  const v = formatLoad(load);
  return v === PLACEHOLDER ? `${PLACEHOLDER} ${noun}` : `${v}% ${noun}`;
}

function tempFact(celsius: number | undefined, cfg: StatsConfig, noun: string): string {
  const v = formatTemp(celsius, cfg.unit);
  const body = v === PLACEHOLDER ? PLACEHOLDER : `${v}${tempUnitGlyph(cfg.unit)}`;
  return noun === '' ? body : `${body} ${noun}`;
}

function ramFact(m: NormalizedMonitoring | null): string {
  const used = m?.ram.usedMiB;
  const total = m?.ram.totalMiB;
  if (used === undefined || !Number.isFinite(used)) return `${PLACEHOLDER} GiB`;
  const u = (used / MIB_PER_GIB).toFixed(GIB_DECIMALS);
  if (total === undefined || !Number.isFinite(total)) return `${u} GiB`;
  return `${u} of ${(total / MIB_PER_GIB).toFixed(GIB_DECIMALS)} GiB`;
}

/**
 * The facts a metric's own sub-line may draw on, most telling first.
 *
 * **Every entry is a field CAM actually publishes** (`NormalizedMonitoring`):
 * load, temperature, core clock, RAM used and total. There is no pump RPM here
 * and no power figure invented to fill a line — a face that made one up would
 * be lying on the device people use to judge whether their loop is healthy. A
 * field that is absent renders as {@link PLACEHOLDER} inside its own fact, so
 * the reader learns "the clock is not reported" rather than seeing the line
 * quietly shrink.
 */
function factsFor(
  metric: StatsMetric,
  cfg: StatsConfig,
  m: NormalizedMonitoring | null,
): readonly string[] {
  switch (metric) {
    case 'cpuTemp':
      return [pctFact(m?.cpu.load, 'load'), ghz(m?.cpu.freqMhz)];
    case 'gpuTemp':
      return [pctFact(m?.gpu.load, 'load'), ghz(m?.gpu.freqMhz)];
    case 'cpuLoad':
      return [tempFact(m?.cpu.tempC, cfg, ''), ghz(m?.cpu.freqMhz)];
    case 'gpuLoad':
      return [tempFact(m?.gpu.tempC, cfg, ''), ghz(m?.gpu.freqMhz)];
    case 'liquidTemp':
      return [tempFact(m?.cpu.tempC, cfg, 'CPU'), tempFact(m?.gpu.tempC, cfg, 'GPU')];
    case 'ramPct':
      return [ramFact(m)];
    case 'cpuFanRpm':
      return [tempFact(m?.cpu.tempC, cfg, 'CPU')];
  }
}

/**
 * The small line under a hero, or `null` when the face has no room for one.
 *
 * Prototype-shaped — `48% load · 4.8 GHz` — rather than the second meter's name
 * and number it used to be. Two things fall out of that. The reader gets a
 * SECOND dimension of the same component (how hard it is working, how fast it
 * is clocked) instead of a reading they could already see on the other half of
 * the ring; and the hero's own label stops being a word printed twice, which is
 * what `dialLabelRepeats` used to exist to suppress.
 */
export function subLineFor(
  tile: StatsTile,
  cfg: StatsConfig,
  monitoring: NormalizedMonitoring | null,
): string | null {
  const room = SUB_FACTS[cfg.layout] ?? 0;
  if (room === 0) return null;
  const facts = factsFor(tile.metric, cfg, monitoring).slice(0, room);
  return facts.length === 0 ? null : facts.join(' · ');
}

/**
 * A string identifying everything a SAMPLE would change.
 *
 * Not a per-frame guard any more — the tween moves the digits and the arc
 * between samples, so a frame comparing this would find it unchanged 39 times
 * out of 40 and paint nothing. What it still does, and what it was always
 * really for, is decide whether a `monitoring()` callback carried any news:
 * an identical sample (a sensor that has not moved) re-targets nothing, and the
 * threshold state is in the key so a crossing is never missed.
 */
export function statsPaintKey(tiles: readonly StatsTile[], waiting: boolean): string {
  return `${waiting ? 'wait' : 'live'}|${tiles
    .map(
      (t) =>
        `${t.metric}:${t.value}:${t.state}:${t.fraction === null ? 'x' : t.fraction.toFixed(FRACTION_DECIMALS)}`,
    )
    .join('|')}`;
}

// ---------------------------------------------------------------------------
// Ring geometry — the shape of each face, as numbers rather than as markup
// ---------------------------------------------------------------------------

/**
 * The arc's user-space box, `-VIEW … +VIEW` on both axes with the origin at the
 * centre. Everything below is in these units, and the renderer scales the whole
 * `<svg>` with one CSS length read from `Geometry` — so a face is identical at
 * every panel size and at every overlay scale, and nothing here is a pixel.
 */
export const RING_VIEW = 50;

/** `pathLength="100"`, so a dash length is literally a percentage of the ring. */
export const RING_PATH_LENGTH = 100;

export interface RingGeometry {
  /** Radius, in view units. */
  r: number;
  /** Where the arc begins, degrees clockwise from three o'clock. */
  startDeg: number;
  /** How far it sweeps. 270 leaves the prototype's gap at the bottom. */
  sweepDeg: number;
  /** Stroke width in view units — 2–3 % of this ring's own diameter. */
  stroke: number;
}

/** A generous, round-native sweep with the gap at the bottom of the circle. */
const OPEN_START_DEG = 135;
const OPEN_SWEEP_DEG = 270;
/** The dual face's two mirrored halves, meeting at top and bottom. */
const HALF_LEFT_START_DEG = 100;
const HALF_RIGHT_START_DEG = 280;
const HALF_SWEEP_DEG = 160;

/** As close to the edge of the view box as the stroke's own width allows. */
const OUTER_R = 46;
/** ≈ 2.6 % of the ring's 92-unit diameter. */
const OUTER_STROKE = 2.4;

/**
 * Concentric radii for the triple face, outermost first, and their one stroke.
 *
 * The step between them is more than four times the stroke, which is what keeps
 * three rings reading as three rather than as one thick band; the stroke is
 * thinner than the outer faces' so that even the innermost stays inside the
 * 2–3 % of its OWN diameter that a meter arc is allowed.
 */
const TRIPLE_R_OUTER = 46;
const TRIPLE_R_MIDDLE = 38;
const TRIPLE_R_INNER = 30;
const TRIPLE_RADII: readonly number[] = [TRIPLE_R_OUTER, TRIPLE_R_MIDDLE, TRIPLE_R_INNER];
const TRIPLE_STROKE = 1.8;

/**
 * What SHAPE a face's meter is.
 *
 * One switch, so the renderer builds one kind of markup per face and every
 * other decision — the dash, the tween, the threshold state — is shared. The
 * dash arithmetic is identical for all three: a mark's fill is a percentage of
 * its own `pathLength`, whether that path is an arc or a straight line.
 *
 *  - `ring`  — an arc on a circle. Every original face.
 *  - `bar`   — a horizontal line, filling left to right.
 *  - `vbar`  — a vertical line, filling bottom to top.
 *  - `chart` — no gauge at all: sixty seconds of history is the mark.
 */
export type MeterKind = 'ring' | 'bar' | 'vbar' | 'chart';

export function meterKindFor(layout: StatsLayout): MeterKind {
  if (layout === 'bar') return 'bar';
  if (layout === 'vertical') return 'vbar';
  if (layout === 'chart') return 'chart';
  return 'ring';
}

/**
 * Is this a face `ringFor()` can answer for at all?
 *
 * Takes a `string` rather than a `StatsLayout` because `statsBoxPx()` does: the
 * box is asked for by URL-parameter code that has not been through the
 * validator yet, and an unknown face has to fall out of this as "not a ring"
 * rather than as a type error nobody can see at runtime.
 */
export function isRingLayout(layout: string): boolean {
  return (STATS_RING_LAYOUTS as readonly string[]).includes(layout);
}

/**
 * A linear gauge is a "sweep" of the whole path, so {@link ringSpan} returns
 * the full `pathLength` and {@link ringDash} needs no second implementation.
 */
export const LINE_SWEEP_DEG = 360;

/** The sweep a face's mark is dashed against, ring or line alike. */
export function meterSweepDeg(layout: StatsLayout, index: number): number {
  return isRingLayout(layout) ? ringFor(layout, index).sweepDeg : LINE_SWEEP_DEG;
}

/**
 * The ring one tile draws.
 *
 * Pure and indexed rather than baked into the markup, so `faces.dom.test.ts`
 * can assert that each face's rings are the ones the prototype shows without a
 * layout engine, and so the renderer holds no geometry of its own.
 *
 * Only meaningful for {@link isRingLayout} faces; the linear ones go through
 * {@link meterSweepDeg} instead.
 */
export function ringFor(layout: StatsLayout, index: number): RingGeometry {
  if (layout === 'dual') {
    const left = index === 0;
    return {
      r: OUTER_R,
      startDeg: left ? HALF_LEFT_START_DEG : HALF_RIGHT_START_DEG,
      sweepDeg: HALF_SWEEP_DEG,
      stroke: OUTER_STROKE,
    };
  }
  if (layout === 'triple') {
    return {
      r: TRIPLE_RADII[index] ?? OUTER_R,
      startDeg: OPEN_START_DEG,
      sweepDeg: OPEN_SWEEP_DEG,
      stroke: TRIPLE_STROKE,
    };
  }
  return {
    r: OUTER_R,
    startDeg: OPEN_START_DEG,
    sweepDeg: OPEN_SWEEP_DEG,
    stroke: OUTER_STROKE,
  };
}

/** How much of the `pathLength` an arc of this sweep occupies. */
export function ringSpan(sweepDeg: number): number {
  return (sweepDeg / 360) * RING_PATH_LENGTH;
}

const DASH_DECIMALS = 2;

/**
 * The `stroke-dasharray` for a ring filled to `fraction`.
 *
 * The `pathLength` trick, and the reason no frame ever computes a
 * circumference: the dash is a percentage of the path, so the same string is
 * correct at every radius and at every panel size. `null` yields an empty dash,
 * which the renderer pairs with `visibility: hidden` — an arc at zero would
 * read as a measurement of zero.
 */
export function ringDash(sweepDeg: number, fraction: number | null): string {
  const span = ringSpan(sweepDeg) * (fraction === null ? 0 : clamp01(fraction));
  return `${span.toFixed(DASH_DECIMALS)} ${String(RING_PATH_LENGTH)}`;
}

/** A linear gauge's fill, as a percentage of its track. */
export function barPercent(fraction: number | null): string {
  return `${(RING_PATH_LENGTH * (fraction === null ? 0 : clamp01(fraction))).toFixed(DASH_DECIMALS)}%`;
}

/**
 * The ONE string a frame writes for a tile's mark, whatever shape it is.
 *
 * Both forms are a percentage of the mark's own length, which is what lets the
 * tween, the settle test and the write-guard above them be shared: the renderer
 * compares this string with the last one and writes only when it differs, and
 * it neither knows nor cares whether the difference will end up on a
 * `stroke-dasharray` or on a `width`.
 */
export function meterFill(kind: MeterKind, sweepDeg: number, fraction: number | null): string {
  return kind === 'ring' ? ringDash(sweepDeg, fraction) : barPercent(fraction);
}

// ---------------------------------------------------------------------------
// Sparkline — sixty seconds, no axis, no chrome
// ---------------------------------------------------------------------------

/** One minute at the feed's 1 Hz. Older than that is not the last minute. */
export const SPARK_SAMPLES = 60;
/** The sparkline's own square user space, stretched to its box by the `<svg>`. */
export const SPARK_VIEW = 100;
/** Room for the round cap and the endpoint dot at the extremes of the range. */
const SPARK_PAD = 10;
const SPARK_DECIMALS = 1;

export interface SparkPath {
  /** The polyline, with a gap wherever the sensor was not reporting. */
  d: string;
  /** The last known point, drawn as a dot — the value you are reading NOW. */
  endX: number;
  endY: number;
}

/**
 * Push one sample into a fixed-length history, oldest first.
 *
 * Fixed length and pre-filled with `null` so the line grows in from the right
 * on a fresh mount instead of stretching a two-second history across the whole
 * width, which would draw a shape the data does not support. Mutates in place:
 * it runs once a second, and the array is the only allocation the sparkline
 * ever makes.
 */
export function pushSample(history: (number | null)[], value: number | undefined): void {
  history.shift();
  history.push(value === undefined || !Number.isFinite(value) ? null : value);
}

export function emptyHistory(): (number | null)[] {
  return Array.from({ length: SPARK_SAMPLES }, () => null);
}

/**
 * The last minute as a path, or `null` when there is not yet a line to draw.
 *
 * No axis, no gridlines, no labels: the sparkline's whole job is the SHAPE of
 * the last minute next to a number that already says where it ended up. One
 * point is not a shape, so it draws nothing rather than drawing a dot that
 * implies a trend.
 */
export function sparkPath(
  history: readonly (number | null)[],
  min: number,
  max: number,
): SparkPath | null {
  if (history.length < 2 || max <= min) return null;
  const span = SPARK_VIEW - SPARK_PAD * 2;
  const stepX = SPARK_VIEW / (history.length - 1);
  let d = '';
  let drawn = 0;
  let endX = 0;
  let endY = 0;
  let penDown = false;

  for (let i = 0; i < history.length; i += 1) {
    const v = history[i];
    if (v === undefined || v === null) {
      penDown = false;
      continue;
    }
    const x = i * stepX;
    const y = SPARK_PAD + (1 - clamp01((v - min) / (max - min))) * span;
    d += `${penDown ? 'L' : 'M'}${x.toFixed(SPARK_DECIMALS)} ${y.toFixed(SPARK_DECIMALS)}`;
    penDown = true;
    drawn += 1;
    endX = x;
    endY = y;
  }

  return drawn < 2 ? null : { d, endX, endY };
}
