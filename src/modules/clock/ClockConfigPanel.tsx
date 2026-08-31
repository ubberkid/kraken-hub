/**
 * STEP 4 (docs/modules.md §6) — the Clock settings panel.
 *
 * Config-only code: `.tsx` under `src/modules/` is chunked into `config-ui` and
 * can never reach the display graph (invariant I8), so this file is free to use
 * the UI kit and React.
 */

import { Field, Panel, Select, Toggle } from '../../ui';

import {
  CLOCK_FACES,
  CLOCK_HOUR_FORMATS,
  CLOCK_THEMES,
  validateClock,
  type ClockFace,
  type ClockHourFormat,
  type ClockTheme,
} from './schema';

import type { ModuleConfigProps } from '../types';

const FACE_LABELS: Readonly<Record<ClockFace, string>> = {
  digital: 'Digital',
  analog: 'Analog',
};

const THEME_LABELS: Readonly<Record<ClockTheme, string>> = {
  mono: 'Mono (white)',
  amber: 'Amber',
  cyan: 'Cyan',
  lime: 'Lime',
  magenta: 'Magenta',
};

const HOUR_LABELS: Readonly<Record<ClockHourFormat, string>> = {
  '24': '24-hour',
  '12': '12-hour',
};

function asOneOf<T extends string>(raw: string, allowed: readonly T[], def: T): T {
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : def;
}

export function ConfigPanel({ config, onChange }: ModuleConfigProps) {
  // Always first: `config` arrives from localStorage as `unknown`.
  const cfg = validateClock(config);

  return (
    <Panel
      title="Clock"
      hint="Digital or analog, with an optional date line. No network, no media — and the only module that is genuinely correct at CAM's 1 FPS default."
    >
      <Field label="Face" htmlFor="clock-face">
        <Select
          id="clock-face"
          value={cfg.face}
          options={CLOCK_FACES.map((f) => ({ value: f, label: FACE_LABELS[f] }))}
          onChange={(value) => {
            onChange({ ...cfg, face: asOneOf(value, CLOCK_FACES, cfg.face) });
          }}
        />
      </Field>

      <Field label="Hour format" htmlFor="clock-hour-format">
        <Select
          id="clock-hour-format"
          value={cfg.hourFormat}
          options={CLOCK_HOUR_FORMATS.map((f) => ({ value: f, label: HOUR_LABELS[f] }))}
          onChange={(value) => {
            onChange({
              ...cfg,
              hourFormat: asOneOf(value, CLOCK_HOUR_FORMATS, cfg.hourFormat),
            });
          }}
        />
      </Field>

      <Field
        label="Show seconds"
        htmlFor="clock-seconds"
        description="The second hand ticks once per second — it never sweeps, so the face is identical at 1 FPS and at 40."
      >
        <Toggle
          id="clock-seconds"
          checked={cfg.showSeconds}
          onChange={(checked) => {
            onChange({ ...cfg, showSeconds: checked });
          }}
        />
      </Field>

      <Field label="Show date" htmlFor="clock-date">
        <Toggle
          id="clock-date"
          checked={cfg.showDate}
          onChange={(checked) => {
            onChange({ ...cfg, showDate: checked });
          }}
        />
      </Field>

      <Field
        label="Colour"
        htmlFor="clock-theme"
        description="Flat colours only. A gradient repaints every pixel of the face each second, which CAM's frame compressor charges for in achieved FPS."
      >
        <Select
          id="clock-theme"
          value={cfg.theme}
          options={CLOCK_THEMES.map((t) => ({ value: t, label: THEME_LABELS[t] }))}
          onChange={(value) => {
            onChange({ ...cfg, theme: asOneOf(value, CLOCK_THEMES, cfg.theme) });
          }}
        />
      </Field>
    </Panel>
  );
}
