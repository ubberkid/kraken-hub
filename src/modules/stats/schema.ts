/**
 * Config type, defaults and validator for the `stats` module.
 *
 * Eager (the registry imports it): no DOM, no monitoring feed, no storage.
 */

import { isPlainObject } from '../../lib/clamp';

/**
 * `single` — one metric, as a hero number inside one thin arc.
 * `dual`   — two readings on one ring, as mirrored half-arcs (the prototype's
 *            round-native pairing: two heroes, one circle).
 * `triple` — three concentric rings around a small centre hero.
 * `grid`   — every metric at once, compact, text-first.
 * `strip`  — the OVERLAY face: a scrim with three compact ring meters on it,
 *            built to sit along the bottom of a video without eating the frame
 *            rate. It is the default config of a stats overlay (§1.4), and the
 *            scrim is opaque on purpose: pixels that stop moving underneath it
 *            are pixels CAM's compressor stops paying for.
 *
 * The three faces below close the parity gap against CAM's own LCD modes. They
 * are not new *data* — every one reads the same three metric slots `triple` and
 * `strip` read — they are the three shapes a reader may already have in their
 * head from the software this replaces:
 *
 * `bar`      — three linear horizontal gauges, one per slot, stacked.
 * `vertical` — the same three, stood on end, as a small column chart.
 * `chart`    — the sparkline promoted from a garnish to a face: sixty seconds
 *              of history per slot, the endpoint emphasised, no axis chrome.
 *
 * Every one of them obeys the same dataviz rules as the rings: thin marks with
 * rounded ends, tabular numerals, ONE accent hue for magnitude, a threshold that
 * never travels without its word, and values that glide rather than chunk.
 */
export type StatsLayout =
  'single' | 'dual' | 'triple' | 'grid' | 'strip' | 'bar' | 'vertical' | 'chart';

/**
 * The metrics CAM actually exposes.
 *
 * There is NO pump RPM. The cooler reports `kraken.liquidTemperature` and
 * nothing else, and inventing a pump reading — even a plausible-looking one —
 * would be a lie on a device people use to decide whether their loop is
 * healthy. `cpuFanRpm` below is the CPU *fan*, which CAM does report.
 */
export type StatsMetric =
  'cpuTemp' | 'cpuLoad' | 'gpuTemp' | 'gpuLoad' | 'liquidTemp' | 'ramPct' | 'cpuFanRpm';

export type StatsUnit = 'c' | 'f';
export type StatsTheme = 'teal' | 'mono' | 'amber' | 'cyan' | 'lime' | 'magenta';

export const STATS_LAYOUTS: readonly StatsLayout[] = [
  'single',
  'dual',
  'triple',
  'grid',
  'strip',
  'bar',
  'vertical',
  'chart',
];

/**
 * The faces drawn with a circular meter, as opposed to a linear one.
 *
 * Exported because `ringFor()` only means anything for these: `bar` and
 * `vertical` draw a straight line and `chart` draws a history, and asking a
 * linear gauge for its radius is a question with no answer rather than an
 * answer nobody looked at.
 */
export const STATS_RING_LAYOUTS: readonly StatsLayout[] = [
  'single',
  'dual',
  'triple',
  'grid',
  'strip',
];

export const STATS_UNITS: readonly StatsUnit[] = ['c', 'f'];
export const STATS_THEMES: readonly StatsTheme[] = [
  'teal',
  'mono',
  'amber',
  'cyan',
  'lime',
  'magenta',
];
export const STATS_METRICS: readonly StatsMetric[] = [
  'cpuTemp',
  'cpuLoad',
  'gpuTemp',
  'gpuLoad',
  'liquidTemp',
  'ramPct',
  'cpuFanRpm',
];

/**
 * How many metric slots the multi-metric faces read from `metrics`.
 *
 * Three, because `triple` and `strip` are the widest faces and `dual` simply
 * takes the first two. One list, sliced — rather than three separate config
 * keys that would let the same choice disagree with itself between faces.
 */
export const STATS_SLOTS = 3;

/**
 * A metric's two warm points, always in **degrees Celsius**.
 *
 * Celsius even when the face is showing Fahrenheit: a threshold is a fact about
 * the hardware, and storing it in the display unit would move the alarm every
 * time somebody flipped the unit switch.
 */
export interface StatsThreshold {
  warm: number;
  hot: number;
}

/**
 * The three sensors a threshold means anything for.
 *
 * Load and RAM deliberately have none: 100 % CPU is what a CPU is *for*, and
 * colouring it as an alarm would teach the reader to ignore the one colour the
 * face reserves for a real problem.
 */
export interface StatsThresholds {
  cpu: StatsThreshold;
  gpu: StatsThreshold;
  liquid: StatsThreshold;
}

export interface StatsConfig {
  layout: StatsLayout;
  /** The metric the `single` face shows. Ignored by every other face. */
  primary: StatsMetric;
  /** One slot per meter, for the faces that have more than one. */
  metrics: readonly StatsMetric[];
  unit: StatsUnit;
  theme: StatsTheme;
  showLabels: boolean;
  /** Last 60 s of each reading, drawn as a thin line under the hero number. */
  sparkline: boolean;
  thresholds: StatsThresholds;
}

/** Sane starting points, and the numbers the panel resets to. */
export const STATS_THRESHOLD_DEFAULTS: StatsThresholds = {
  cpu: { warm: 80, hot: 90 },
  gpu: { warm: 80, hot: 90 },
  liquid: { warm: 40, hot: 45 },
};

export const STATS_DEFAULTS: StatsConfig = {
  layout: 'dual',
  primary: 'cpuTemp',
  metrics: ['cpuTemp', 'gpuTemp', 'liquidTemp'],
  unit: 'c',
  /*
   * TEAL, not white, and this is the one line that makes the module hue-led.
   *
   * The prototype's stats screen has never been monochrome: the meter is the
   * app's accent and the track is a lighter step of the SAME hue, so the state
   * of a reading is legible from the ring alone at a metre. `mono` shipped as
   * the default and the faces read as grey dials on a grey panel — the audit's
   * M7. `mono` is still on the list for anybody who wants it.
   */
  theme: 'teal',
  showLabels: true,
  sparkline: false,
  thresholds: STATS_THRESHOLD_DEFAULTS,
};

/** The range a threshold may be dragged to. Below freezing is not a warning. */
export const THRESHOLD_MIN_C = 30;
export const THRESHOLD_MAX_C = 110;
export const THRESHOLD_STEP_C = 1;

function pick<T extends string>(raw: unknown, allowed: readonly T[], def: T): T {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : def;
}

function clampDeg(raw: unknown, def: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def;
  return Math.min(Math.max(Math.round(raw), THRESHOLD_MIN_C), THRESHOLD_MAX_C);
}

/**
 * One threshold pair, coerced.
 *
 * `hot` is pulled up to `warm` rather than the pair being rejected: a stored
 * config with the two crossed over is a slider that was dragged past its
 * neighbour, not corruption, and the honest reading of it is "there is no warm
 * band" rather than "fall back to the factory numbers".
 */
function readThreshold(raw: unknown, def: StatsThreshold): StatsThreshold {
  const o = isPlainObject(raw) ? raw : {};
  const warm = clampDeg(o['warm'], def.warm);
  const hot = clampDeg(o['hot'], def.hot);
  return { warm, hot: Math.max(warm, hot) };
}

/** Exactly `STATS_SLOTS` known metrics, however short or junk-filled the input. */
function readMetrics(raw: unknown): readonly StatsMetric[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: StatsMetric[] = [];
  for (let i = 0; i < STATS_SLOTS; i += 1) {
    out.push(pick(list[i], STATS_METRICS, STATS_DEFAULTS.metrics[i] ?? 'cpuTemp'));
  }
  return out;
}

export function validateStatsConfig(raw: unknown): StatsConfig {
  const o = isPlainObject(raw) ? raw : {};
  const t = isPlainObject(o['thresholds']) ? o['thresholds'] : {};
  return {
    layout: pick(o['layout'], STATS_LAYOUTS, STATS_DEFAULTS.layout),
    primary: pick(o['primary'], STATS_METRICS, STATS_DEFAULTS.primary),
    metrics: readMetrics(o['metrics']),
    unit: pick(o['unit'], STATS_UNITS, STATS_DEFAULTS.unit),
    theme: pick(o['theme'], STATS_THEMES, STATS_DEFAULTS.theme),
    showLabels: typeof o['showLabels'] === 'boolean' ? o['showLabels'] : true,
    sparkline: typeof o['sparkline'] === 'boolean' ? o['sparkline'] : false,
    thresholds: {
      cpu: readThreshold(t['cpu'], STATS_THRESHOLD_DEFAULTS.cpu),
      gpu: readThreshold(t['gpu'], STATS_THRESHOLD_DEFAULTS.gpu),
      liquid: readThreshold(t['liquid'], STATS_THRESHOLD_DEFAULTS.liquid),
    },
  };
}

export interface StatsPalette {
  /** The ONE accent hue. It is the series colour — arcs and sparklines wear it. */
  fg: string;
  /** Secondary text: labels, units, sub-lines. */
  dim: string;
  /** The unfilled part of an arc. Flat, never a gradient, always recessive. */
  track: string;
}

/**
 * The resting hue, and it is the app's own accent.
 *
 * `#4fd8d2` is the value of `--kh-accent` in `src/ui/ui.css` — the token the
 * whole product is drawn in, and the teal the layers prototype's stats screen
 * uses for every meter. It is repeated here rather than read through
 * `var(--kh-accent)` for one reason: `ui.css` rides the **config** chunk, and
 * the display page (invariant I8's byte budget) never loads it. A custom
 * property that resolves to nothing would paint the arcs `currentColor`, so the
 * display half of the app carries the value and this comment carries the link.
 *
 * The track is that same hue at ~18 % over the panel's black — the prototype's
 * `rgba(79,216,210,.18)`, flattened, because a translucent stroke over a video
 * base would tint whatever is behind it instead of receding behind the arc.
 */
export const STATS_ACCENT = '#4fd8d2';

export const STATS_PALETTES: Readonly<Record<StatsTheme, StatsPalette>> = {
  teal: { fg: STATS_ACCENT, dim: '#7b8798', track: '#16403e' },
  mono: { fg: '#f2f4f8', dim: '#7c8798', track: '#2a2f38' },
  amber: { fg: '#ffb648', dim: '#8a6222', track: '#33260f' },
  cyan: { fg: '#5ad8ff', dim: '#2b6d84', track: '#12303a' },
  lime: { fg: '#8ef07a', dim: '#487a3f', track: '#1b3018' },
  magenta: { fg: '#ff7ad9', dim: '#8a4275', track: '#331a2b' },
};

/**
 * Ink, and only ink, for type.
 *
 * The dataviz rule the redesign is built on: **text wears text colours, never
 * the series colour.** A number painted in the accent is a number claiming to
 * be part of the chart, and when the accent shifts at a threshold every digit
 * on the panel shifts with it — which is how a face ends up saying "hot" in
 * four places and meaning it in none. The arc carries the hue; the digits stay
 * legible.
 */
export const STATS_INK = '#eaf4ff';

/**
 * The two semantic colours, and they are the SAME in every palette.
 *
 * A warning that changes hue with the user's taste is not a warning. These are
 * never used for magnitude — only for a crossed threshold, and never without
 * the word that names it.
 */
export const STATS_WARM = '#e0a93e';
export const STATS_WARM_TRACK = '#33280f';
export const STATS_HOT = '#ff8a8a';
export const STATS_HOT_TRACK = '#3a1d1d';

/**
 * Metric labels live here, not in `format.ts`, so the configuration panel can
 * name a metric without importing the display chunk. `schema.ts` is eager and
 * tiny by design; `format.ts` is display-side.
 */
const LABELS: Readonly<Record<StatsMetric, { short: string; long: string }>> = {
  cpuTemp: { short: 'CPU', long: 'CPU temp' },
  cpuLoad: { short: 'CPU', long: 'CPU load' },
  gpuTemp: { short: 'GPU', long: 'GPU temp' },
  gpuLoad: { short: 'GPU', long: 'GPU load' },
  liquidTemp: { short: 'LIQUID', long: 'Liquid temp' },
  ramPct: { short: 'RAM', long: 'RAM used' },
  cpuFanRpm: { short: 'FAN', long: 'CPU fan' },
};

export function metricLabel(metric: StatsMetric): string {
  return LABELS[metric].short;
}

export function metricLongLabel(metric: StatsMetric): string {
  return LABELS[metric].long;
}
