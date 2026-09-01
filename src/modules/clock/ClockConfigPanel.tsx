/**
 * STEP 4 (docs/modules.md §6) — the Clock settings panel.
 *
 * Config-only code: `.tsx` under `src/modules/` is chunked into `config-ui` and
 * can never reach the display graph (invariant I8), so this file is free to use
 * the UI kit and React.
 *
 * ## One set of options, and they are the ones you can see
 *
 * This panel used to render Face, Hours and Show seconds — all three of which
 * the home screen's ops strip *also* renders, four inches higher, on the same
 * screen, at the same time. The round-2 audit's first finding is that the app
 * therefore had two settings surfaces for one module and no rule for which one
 * to use, and that they could disagree in wording ("24" against "24-hour").
 *
 * The strip won, because it is the one you can see without opening anything.
 * What is left here is what the strip has no room for: the date line, and the
 * one Advanced door.
 *
 * Round 3 took the sentence that said so. "Face, hours and seconds are on the
 * strip above" was a signpost pointing at something already on the screen, four
 * inches up, in the direction the reader was already looking — and it was the
 * first thing a deliberate second tap produced (F5). The panel opens with the
 * control in it now; `ui/ModuleOptions` is what makes that the rule rather than
 * this file's good behaviour.
 */

import { GroupField, ModuleOptions, Segmented, Switch } from '../../ui';

import { CLOCK_THEMES, validateClock, type ClockTheme } from './schema';

import type { ModuleConfigProps } from '../types';

const THEME_LABELS: Readonly<Record<ClockTheme, string>> = {
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
  // Always first: `config` arrives from localStorage as `unknown`.
  const cfg = validateClock(config);

  return (
    <ModuleOptions
      advancedTestId="clock-advanced"
      primary={
        <GroupField label="Show date" id="clock-date">
          <Switch
            id="clock-date"
            labelledBy="clock-date-label"
            checked={cfg.showDate}
            onChange={(showDate) => {
              onChange({ ...cfg, showDate });
            }}
          />
        </GroupField>
      }
      advanced={
        <GroupField
          label="Colour"
          id="clock-theme"
          description="Flat colours only. A gradient repaints every pixel of the face every second, and CAM charges for that in the frame rate you actually get."
        >
          <Segmented
            id="clock-theme"
            wrap
            labelledBy="clock-theme-label"
            value={cfg.theme}
            options={CLOCK_THEMES.map((t) => ({ value: t, label: THEME_LABELS[t] }))}
            onChange={(value) => {
              onChange({ ...cfg, theme: asOneOf(value, CLOCK_THEMES, cfg.theme) });
            }}
          />
        </GroupField>
      }
    />
  );
}
