/**
 * The stats module's settings panel. Config-only code (invariant I8).
 */

import { Disclosure, Field, GroupField, Panel, Segmented, Select, Toggle } from '../../ui';

import {
  STATS_LAYOUTS,
  STATS_METRICS,
  STATS_THEMES,
  STATS_UNITS,
  metricLongLabel,
  validateStatsConfig,
  type StatsLayout,
  type StatsMetric,
  type StatsTheme,
  type StatsUnit,
} from './schema';

import type { ModuleConfigProps } from '../types';

/**
 * One word each, with the sentence moved to the segment's tooltip — the design
 * audit's F9 rule. A choice between three layouts does not need three clauses.
 */
const LAYOUT_LABELS: Readonly<Record<StatsLayout, string>> = {
  single: 'One dial',
  dual: 'Two dials',
  grid: 'Everything',
};

const LAYOUT_TITLES: Readonly<Record<StatsLayout, string>> = {
  single: 'One metric, as large as the panel allows.',
  dual: 'CPU and GPU side by side.',
  grid: 'Every reading at once, text only.',
};

const UNIT_LABELS: Readonly<Record<StatsUnit, string>> = {
  c: '°C',
  f: '°F',
};

const THEME_LABELS: Readonly<Record<StatsTheme, string>> = {
  mono: 'Mono (white)',
  amber: 'Amber',
  cyan: 'Cyan',
  lime: 'Lime',
  magenta: 'Magenta',
};

function asOneOf<T extends string>(raw: string, allowed: readonly T[], def: T): T {
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : def;
}

export function ConfigPanel({ config, onChange }: ModuleConfigProps) {
  const cfg = validateStatsConfig(config);

  return (
    <Panel
      title="System stats"
      hint="Readings come from NZXT CAM, once a second. Anything CAM does not report shows as “--” rather than as a zero — including pump speed, which CAM does not report at all."
    >
      <GroupField label="Layout" id="stats-layout">
        <Segmented
          id="stats-layout"
          labelledBy="stats-layout-label"
          value={cfg.layout}
          options={STATS_LAYOUTS.map((l) => ({
            value: l,
            label: LAYOUT_LABELS[l],
            title: LAYOUT_TITLES[l],
          }))}
          onChange={(value) => {
            onChange({ ...cfg, layout: asOneOf(value, STATS_LAYOUTS, cfg.layout) });
          }}
        />
      </GroupField>

      {cfg.layout === 'single' && (
        <Field
          label="Metric"
          htmlFor="stats-primary"
          description="Only the single-dial layout uses this."
        >
          <Select
            id="stats-primary"
            value={cfg.primary}
            options={STATS_METRICS.map((m: StatsMetric) => ({
              value: m,
              label: metricLongLabel(m),
            }))}
            onChange={(value) => {
              onChange({ ...cfg, primary: asOneOf(value, STATS_METRICS, cfg.primary) });
            }}
          />
        </Field>
      )}

      <GroupField label="Degrees" id="stats-unit">
        <Segmented
          id="stats-unit"
          labelledBy="stats-unit-label"
          value={cfg.unit}
          options={STATS_UNITS.map((u) => ({ value: u, label: UNIT_LABELS[u] }))}
          onChange={(value) => {
            onChange({ ...cfg, unit: asOneOf(value, STATS_UNITS, cfg.unit) });
          }}
        />
      </GroupField>

      <Field label="Show labels" htmlFor="stats-labels">
        <Toggle
          id="stats-labels"
          checked={cfg.showLabels}
          onChange={(checked) => {
            onChange({ ...cfg, showLabels: checked });
          }}
        />
      </Field>

      <Disclosure summary="Advanced" testId="stats-advanced">
        <Field
          label="Colour"
          htmlFor="stats-theme"
          description="Flat fills only — the dial arc is a single stroke. A glowing gauge would repaint the whole tile every second, and CAM charges for that in the frame rate you actually get."
        >
          <Select
            id="stats-theme"
            value={cfg.theme}
            options={STATS_THEMES.map((t) => ({ value: t, label: THEME_LABELS[t] }))}
            onChange={(value) => {
              onChange({ ...cfg, theme: asOneOf(value, STATS_THEMES, cfg.theme) });
            }}
          />
        </Field>
      </Disclosure>
    </Panel>
  );
}
