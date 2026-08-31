/**
 * Config type, defaults and validator for the `stats` module.
 *
 * Eager (the registry imports it): no DOM, no monitoring feed, no storage.
 */

import { isPlainObject } from '../../lib/clamp';

/**
 * `single` — one large dial, the most legible thing a 240 px panel can show.
 * `dual`   — CPU and GPU side by side, the layout people actually want.
 * `grid`   — every metric at once, compact, text-first.
 */
export type StatsLayout = 'single' | 'dual' | 'grid';

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
export type StatsTheme = 'mono' | 'amber' | 'cyan' | 'lime' | 'magenta';

export const STATS_LAYOUTS: readonly StatsLayout[] = ['single', 'dual', 'grid'];
export const STATS_UNITS: readonly StatsUnit[] = ['c', 'f'];
export const STATS_THEMES: readonly StatsTheme[] = ['mono', 'amber', 'cyan', 'lime', 'magenta'];
export const STATS_METRICS: readonly StatsMetric[] = [
  'cpuTemp',
  'cpuLoad',
  'gpuTemp',
  'gpuLoad',
  'liquidTemp',
  'ramPct',
  'cpuFanRpm',
];

export interface StatsConfig {
  layout: StatsLayout;
  /** The metric the `single` layout shows. Ignored by the other two. */
  primary: StatsMetric;
  unit: StatsUnit;
  theme: StatsTheme;
  showLabels: boolean;
}

export const STATS_DEFAULTS: StatsConfig = {
  layout: 'dual',
  primary: 'cpuTemp',
  unit: 'c',
  theme: 'mono',
  showLabels: true,
};

function pick<T extends string>(raw: unknown, allowed: readonly T[], def: T): T {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : def;
}

export function validateStatsConfig(raw: unknown): StatsConfig {
  const o = isPlainObject(raw) ? raw : {};
  return {
    layout: pick(o['layout'], STATS_LAYOUTS, STATS_DEFAULTS.layout),
    primary: pick(o['primary'], STATS_METRICS, STATS_DEFAULTS.primary),
    unit: pick(o['unit'], STATS_UNITS, STATS_DEFAULTS.unit),
    theme: pick(o['theme'], STATS_THEMES, STATS_DEFAULTS.theme),
    showLabels: typeof o['showLabels'] === 'boolean' ? o['showLabels'] : true,
  };
}

export interface StatsPalette {
  fg: string;
  dim: string;
  /** The unfilled part of a dial arc. Flat, never a gradient. */
  track: string;
}

export const STATS_PALETTES: Readonly<Record<StatsTheme, StatsPalette>> = {
  mono: { fg: '#f2f4f8', dim: '#7c8798', track: '#2a2f38' },
  amber: { fg: '#ffb648', dim: '#8a6222', track: '#33260f' },
  cyan: { fg: '#5ad8ff', dim: '#2b6d84', track: '#12303a' },
  lime: { fg: '#8ef07a', dim: '#487a3f', track: '#1b3018' },
  magenta: { fg: '#ff7ad9', dim: '#8a4275', track: '#331a2b' },
};

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
