/**
 * The stats module's settings panel. Config-only code (invariant I8).
 *
 * Layout, Degrees and Show labels are not written here any more: the home
 * screen's ops strip carries all three, on the same screen, above this panel.
 * The round-2 audit's rule is that a module has ONE set of options, and the set
 * is the one already in view. What is left is the reading the single-dial layout
 * needs a name for, and the one Advanced door.
 *
 * Which, on the DEFAULT layout, is nothing at all — and round 3 measured what
 * that produced: a deliberate second tap on the active chip opened a panel
 * containing one sentence about a strip four inches above it and a closed door
 * (F5). `ui/ModuleOptions` promotes the door's contents to the panel when there
 * is no room to open, so the gesture always lands on a control.
 */

import { FLAT_COLOURS_WHY } from '../../config/vocabulary';
import { GroupField, ModuleOptions, Segmented } from '../../ui';

import {
  STATS_METRICS,
  STATS_THEMES,
  metricLongLabel,
  validateStatsConfig,
  type StatsMetric,
  type StatsTheme,
} from './schema';

import type { ModuleConfigProps } from '../types';

const THEME_LABELS: Readonly<Record<StatsTheme, string>> = {
  mono: 'White',
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
    <ModuleOptions
      advancedTestId="stats-advanced"
      /*
        Stats is the module the empty-room rule was written for.
        `Reading` only means anything to the one-dial layout, so on the default
        two-dial layout this panel had NOTHING in it but a sentence pointing at
        the strip and a closed door. With `primary` null, `ModuleOptions` skips
        both: the second tap on the chip opens the colours directly.
      */
      primary={
        cfg.layout === 'single' ? (
          <GroupField
            label="Reading"
            id="stats-primary"
            description="Only the one-dial layout uses this."
          >
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
        ) : null
      }
      advanced={
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
      }
    />
  );
}
