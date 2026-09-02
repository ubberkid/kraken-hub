/**
 * The stats module's settings panel. Config-only code (invariant I8).
 *
 * ## One set of options, and the ones you can see win
 *
 * Degrees and Show labels are not written here: the home screen's ops strip
 * carries both, on the same screen, above this panel. The round-2 audit's rule
 * is that a module has ONE set of options, and the set is the one already in
 * view.
 *
 * What IS here is everything the strip has no room for, and the face redesign
 * added most of it: the face itself (there are eight now, and choosing between
 * eight is a panel-sized decision), the metric in each meter slot, the
 * sparkline, and — behind the one Advanced door — the colour and the warm
 * points.
 *
 * The controls are `Segmented` and nothing else. `ui/index.tsx` documents why
 * there is no `<select>` on this surface, and the face picker is exactly the
 * case that rule was written for: a handful of exclusive choices, all of them
 * visible at once, one press to change.
 */

import { FLAT_COLOURS_WHY } from '../../config/vocabulary';
import { GroupField, ModuleOptions, RangeInput, Segmented, Switch } from '../../ui';

import {
  STATS_LAYOUTS,
  STATS_METRICS,
  STATS_SLOTS,
  STATS_THEMES,
  STATS_UNITS,
  THRESHOLD_MAX_C,
  THRESHOLD_MIN_C,
  THRESHOLD_STEP_C,
  metricLongLabel,
  validateStatsConfig,
  type StatsConfig,
  type StatsLayout,
  type StatsMetric,
  type StatsTheme,
  type StatsThreshold,
  type StatsUnit,
} from './schema';

import type { ModuleConfigProps } from '../types';

const THEME_LABELS: Readonly<Record<StatsTheme, string>> = {
  teal: 'Teal',
  mono: 'White',
  amber: 'Amber',
  cyan: 'Cyan',
  lime: 'Lime',
  magenta: 'Magenta',
};

/**
 * The face names, and what each one is FOR.
 *
 * The `title` is the closest this kit gets to a card's preview caption: a
 * segment is one word wide, and the sentence that would not fit beside it is
 * the sentence that tells you which face to pick.
 */
const FACE_LABELS: Readonly<Record<StatsLayout, { label: string; title: string }>> = {
  single: { label: 'One', title: 'One reading, as large as the panel allows.' },
  dual: { label: 'Two', title: 'Two readings on one ring, as mirrored half-arcs.' },
  triple: { label: 'Three', title: 'Three concentric rings around a centre reading.' },
  grid: { label: 'All', title: 'Every reading at once, as text.' },
  strip: { label: 'Strip', title: 'A compact band, built to sit over a video.' },
  bar: { label: 'Bars', title: 'Three linear gauges, stacked and easy to compare.' },
  vertical: { label: 'Columns', title: 'The same three gauges, stood on end.' },
  chart: { label: 'History', title: 'The last sixty seconds of each reading, as a line.' },
};

const UNIT_LABELS: Readonly<Record<StatsUnit, string>> = { c: '°C', f: '°F' };

/** Which faces read a given metric slot, so an unused chooser is not offered. */
const SLOTS_USED: Readonly<Record<StatsLayout, number>> = {
  single: 0,
  dual: 2,
  triple: STATS_SLOTS,
  strip: STATS_SLOTS,
  // The three parity faces read the very same slots the ring faces do, so
  // switching between them never changes which sensors are on the panel.
  bar: STATS_SLOTS,
  vertical: STATS_SLOTS,
  chart: STATS_SLOTS,
  // The text-first face shows everything, so it chooses nothing.
  grid: 0,
};

const SLOT_LABELS: readonly string[] = ['First meter', 'Second meter', 'Third meter'];

/** The three sensors a warm point means anything for. */
const THRESHOLD_ROWS: readonly { key: keyof StatsConfig['thresholds']; label: string }[] = [
  { key: 'cpu', label: 'CPU' },
  { key: 'gpu', label: 'GPU' },
  { key: 'liquid', label: 'Liquid' },
];

function asOneOf<T extends string>(raw: string, allowed: readonly T[], def: T): T {
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : def;
}

export function ConfigPanel({ config, onChange }: ModuleConfigProps) {
  // Always first: `config` arrives from localStorage as `unknown`.
  const cfg = validateStatsConfig(config);
  const slots = SLOTS_USED[cfg.layout];

  const setSlot = (index: number, metric: StatsMetric): void => {
    const next = cfg.metrics.slice();
    next[index] = metric;
    onChange({ ...cfg, metrics: next });
  };

  const setThreshold = (
    key: keyof StatsConfig['thresholds'],
    patch: Partial<StatsThreshold>,
  ): void => {
    onChange({
      ...cfg,
      thresholds: { ...cfg.thresholds, [key]: { ...cfg.thresholds[key], ...patch } },
    });
  };

  return (
    <ModuleOptions
      advancedTestId="stats-advanced"
      primary={
        <>
          <GroupField label="Face" id="stats-layout">
            <Segmented
              id="stats-layout"
              wrap
              labelledBy="stats-layout-label"
              value={cfg.layout}
              options={STATS_LAYOUTS.map((l: StatsLayout) => ({
                value: l,
                label: FACE_LABELS[l].label,
                title: FACE_LABELS[l].title,
              }))}
              onChange={(value) => {
                onChange({ ...cfg, layout: asOneOf(value, STATS_LAYOUTS, cfg.layout) });
              }}
            />
          </GroupField>

          {/* The one-meter face asks a different question, so it has its own answer. */}
          {cfg.layout === 'single' && (
            <GroupField label="Reading" id="stats-primary">
              <Segmented
                id="stats-primary"
                wrap
                labelledBy="stats-primary-label"
                value={cfg.primary}
                options={STATS_METRICS.map((m: StatsMetric) => ({
                  value: m,
                  label: metricLongLabel(m),
                }))}
                onChange={(value) => {
                  onChange({ ...cfg, primary: asOneOf(value, STATS_METRICS, cfg.primary) });
                }}
              />
            </GroupField>
          )}

          {SLOT_LABELS.slice(0, slots).map((label, i) => (
            <GroupField key={label} label={label} id={`stats-slot-${String(i)}`}>
              <Segmented
                id={`stats-slot-${String(i)}`}
                wrap
                labelledBy={`stats-slot-${String(i)}-label`}
                value={cfg.metrics[i] ?? 'cpuTemp'}
                options={STATS_METRICS.map((m: StatsMetric) => ({
                  value: m,
                  label: metricLongLabel(m),
                }))}
                onChange={(value) => {
                  setSlot(i, asOneOf(value, STATS_METRICS, cfg.metrics[i] ?? 'cpuTemp'));
                }}
              />
            </GroupField>
          ))}

          <GroupField
            label="Last minute"
            id="stats-sparkline"
            description="A thin line of the last 60 seconds under the reading."
          >
            <Switch
              id="stats-sparkline"
              labelledBy="stats-sparkline-label"
              checked={cfg.sparkline}
              onChange={(sparkline) => {
                onChange({ ...cfg, sparkline });
              }}
            />
          </GroupField>

          <GroupField label="Degrees" id="stats-unit">
            <Segmented
              id="stats-unit"
              labelledBy="stats-unit-label"
              value={cfg.unit}
              options={STATS_UNITS.map((u: StatsUnit) => ({ value: u, label: UNIT_LABELS[u] }))}
              onChange={(value) => {
                onChange({ ...cfg, unit: asOneOf(value, STATS_UNITS, cfg.unit) });
              }}
            />
          </GroupField>
        </>
      }
      advanced={
        <>
          <GroupField label="Colour" id="stats-theme" description={FLAT_COLOURS_WHY}>
            <Segmented
              id="stats-theme"
              wrap
              labelledBy="stats-theme-label"
              value={cfg.theme}
              options={STATS_THEMES.map((t) => ({ value: t, label: THEME_LABELS[t] }))}
              onChange={(value) => {
                onChange({ ...cfg, theme: asOneOf(value, STATS_THEMES, cfg.theme) });
              }}
            />
          </GroupField>

          {/*
            The warm points, in Celsius whichever unit the face is showing:
            a threshold is a fact about the hardware, and storing it in the
            display unit would move the alarm every time somebody flipped the
            switch above. Crossing one shows the WORD as well as the colour,
            which is why there is no option to turn the word off.
          */}
          {THRESHOLD_ROWS.map((row) => (
            <GroupField
              key={row.key}
              label={`${row.label} warm point`}
              id={`stats-warm-${row.key}`}
              description={`Warm at ${String(cfg.thresholds[row.key].warm)} °C, hot at ${String(cfg.thresholds[row.key].hot)} °C.`}
            >
              <RangeInput
                id={`stats-warm-${row.key}`}
                value={cfg.thresholds[row.key].warm}
                min={THRESHOLD_MIN_C}
                max={THRESHOLD_MAX_C}
                step={THRESHOLD_STEP_C}
                title={`${row.label} warm point`}
                onChange={(warm) => {
                  setThreshold(row.key, { warm });
                }}
              />
              <RangeInput
                id={`stats-hot-${row.key}`}
                value={cfg.thresholds[row.key].hot}
                min={THRESHOLD_MIN_C}
                max={THRESHOLD_MAX_C}
                step={THRESHOLD_STEP_C}
                title={`${row.label} hot point`}
                onChange={(hot) => {
                  setThreshold(row.key, { hot });
                }}
              />
            </GroupField>
          ))}
        </>
      }
    />
  );
}
