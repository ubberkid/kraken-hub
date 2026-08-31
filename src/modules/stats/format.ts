/**
 * Every decision the stats module makes that does not touch the DOM. Pure, and
 * unit-tested in `format.test.ts`.
 *
 * The whole file is written around one fact: **every numeric field in CAM's
 * monitoring feed is `number | undefined`.** CAM genuinely drops sensors — the
 * simulator's `?monitor=missing` profile rotates fields in and out of
 * `undefined` precisely so this is exercised — so a missing reading renders as
 * `--`, never as `NaN`, never as `0` pretending to be a measurement, and never
 * as a dial sitting at the bottom of its range as if the CPU were at 0 °C.
 *
 * The second fact: **there is no pump RPM.** `kraken.liquidTemperature` is the
 * only cooler field that exists.
 */

import { metricLabel, metricLongLabel } from './schema';

import type { StatsConfig, StatsMetric } from './schema';
import type { NormalizedMonitoring } from '../../platform/monitoring';

/** What a missing reading looks like. Two glyphs, legible after compression. */
export const PLACEHOLDER = '--';

const PCT = 100;
const F_OFFSET = 32;
/** °F = °C · 9/5 + 32. Spelled out so invariant 5's lint rule can see consts. */
const F_NUMERATOR = 9;
const F_DENOMINATOR = 5;
const F_RATIO = F_NUMERATOR / F_DENOMINATOR;

/** Dial ranges. Fixed, not auto-scaled: a moving axis is unreadable at a glance. */
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

export interface StatsTile {
  metric: StatsMetric;
  /** Short label — `CPU`, `GPU`, `LIQUID`. */
  label: string;
  /** Longer label used by the grid layout — `CPU temp`. */
  longLabel: string;
  /** The formatted reading, or `--`. */
  value: string;
  /** The unit glyph, already localised to the config (`°C` / `°F` / `%`). */
  unit: string;
  /**
   * 0..1 for a dial, or `null` when there is no reading. `null` means "draw the
   * track and nothing else" — never "draw an empty dial", which reads as zero.
   */
  fraction: number | null;
}

/**
 * A temperature, in the configured unit. Rounded to whole degrees: a tenth of a
 * degree is noise on a 240 px panel and costs a digit that could have been
 * twice as tall.
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

/** One tile for one metric, ready to paint. Never throws, never yields `NaN`. */
export function buildTile(
  metric: StatsMetric,
  monitoring: NormalizedMonitoring | null,
  cfg: StatsConfig,
): StatsTile {
  const m = monitoring;
  const base = { metric, label: metricLabel(metric), longLabel: metricLongLabel(metric) };

  switch (metric) {
    case 'cpuTemp':
      return {
        ...base,
        value: formatTemp(m?.cpu.tempC, cfg.unit),
        unit: tempUnitGlyph(cfg.unit),
        fraction: normalizeRange(m?.cpu.tempC, TEMP_MIN_C, TEMP_MAX_C),
      };
    case 'gpuTemp':
      return {
        ...base,
        value: formatTemp(m?.gpu.tempC, cfg.unit),
        unit: tempUnitGlyph(cfg.unit),
        fraction: normalizeRange(m?.gpu.tempC, TEMP_MIN_C, TEMP_MAX_C),
      };
    case 'liquidTemp':
      return {
        ...base,
        value: formatTemp(m?.kraken.liquidTempC, cfg.unit),
        unit: tempUnitGlyph(cfg.unit),
        fraction: normalizeRange(m?.kraken.liquidTempC, LIQUID_MIN_C, LIQUID_MAX_C),
      };
    case 'cpuLoad':
      return {
        ...base,
        value: formatLoad(m?.cpu.load),
        unit: '%',
        fraction: normalizeRange(m?.cpu.load, 0, 1),
      };
    case 'gpuLoad':
      return {
        ...base,
        value: formatLoad(m?.gpu.load),
        unit: '%',
        fraction: normalizeRange(m?.gpu.load, 0, 1),
      };
    case 'ramPct':
      return {
        ...base,
        value: formatLoad(m?.ram.pct),
        unit: '%',
        fraction: normalizeRange(m?.ram.pct, 0, 1),
      };
    case 'cpuFanRpm':
      return {
        ...base,
        value: formatRpm(m?.cpu.fanRpm),
        unit: 'RPM',
        fraction: normalizeRange(m?.cpu.fanRpm, 0, FAN_MAX_RPM),
      };
  }
}

/**
 * Which tiles a layout shows.
 *
 * `dual` is CPU and GPU **temperature** rather than load, because a temperature
 * is the reading a cooler's own display is for; the load appears underneath each
 * dial as a secondary line (see `secondaryFor`).
 */
export function tilesFor(cfg: StatsConfig, monitoring: NormalizedMonitoring | null): StatsTile[] {
  const build = (metric: StatsMetric): StatsTile => buildTile(metric, monitoring, cfg);
  switch (cfg.layout) {
    case 'single':
      return [build(cfg.primary)];
    case 'dual':
      return [build('cpuTemp'), build('gpuTemp')];
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

/** The small line under a dial, or `null` when the layout has no room for one. */
export function secondaryFor(
  tile: StatsTile,
  cfg: StatsConfig,
  monitoring: NormalizedMonitoring | null,
): StatsTile | null {
  if (cfg.layout === 'grid') return null;
  if (tile.metric === 'cpuTemp') return buildTile('cpuLoad', monitoring, cfg);
  if (tile.metric === 'gpuTemp') return buildTile('gpuLoad', monitoring, cfg);
  if (tile.metric === 'cpuLoad') return buildTile('cpuTemp', monitoring, cfg);
  if (tile.metric === 'gpuLoad') return buildTile('gpuTemp', monitoring, cfg);
  if (tile.metric === 'liquidTemp') return buildTile('cpuTemp', monitoring, cfg);
  return null;
}

/**
 * A string identifying everything the module would paint, for the repaint guard.
 *
 * The feed is 1 Hz and the frame clock may be 40 Hz; comparing this is what
 * keeps the other 39 ticks free. It is also why the module does not implement
 * `frame()` at all — but the guard still earns its keep against a `monitoring()`
 * callback that delivers an identical sample, which happens whenever a sensor
 * has not moved.
 */
export function statsPaintKey(tiles: readonly StatsTile[], waiting: boolean): string {
  return `${waiting ? 'wait' : 'live'}|${tiles
    .map(
      (t) =>
        `${t.metric}:${t.value}:${t.fraction === null ? 'x' : t.fraction.toFixed(FRACTION_DECIMALS)}`,
    )
    .join('|')}`;
}
