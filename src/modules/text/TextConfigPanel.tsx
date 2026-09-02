/**
 * STEP 4 (docs/modules.md §6) — the Text layer's settings panel.
 *
 * Config-only code: `.tsx` under `src/modules/` is chunked into `config-ui` and
 * can never reach the display graph (invariant I8), so this file is free to use
 * the UI kit and React.
 *
 * ## The first row is the editor's strip
 *
 * `docs/design/design-editor-ux.md` §2.3 fixes what a Text layer shows on the
 * selection strip: **text · size · colour · font · More**, five controls, the
 * last of which is the door. This panel is that row, in the same order, so the
 * two surfaces are one set of options rather than two that can drift — the same
 * rule `ClockConfigPanel` records for the home screen's ops strip.
 *
 * Everything one level down — weight, alignment, tracking, uppercase, shadow —
 * is behind the single `Advanced` disclosure `ModuleOptions` owns.
 *
 * The colour well is a native `<input type="color">` and it is the only native
 * control on this surface. That is not a hole in the round-2 rule: what round 2
 * deleted was every native *picker of sentences* — a `<select>` whose options
 * are prose — and its replacement is `Segmented`. A colour is not an
 * enumeration and cannot be one; the platform's own picker is better than any
 * grid of swatches at showing which of sixteen million a person actually wants.
 */

import {
  GroupField,
  Field,
  ModuleOptions,
  RangeInput,
  Segmented,
  Switch,
  TextInput,
} from '../../ui';

import {
  MAX_TEXT_LEN,
  SIZE_MAX,
  SIZE_MIN,
  TEXT_ALIGNS,
  TEXT_FACES,
  TEXT_FONTS,
  TEXT_WEIGHTS,
  TRACKING_MAX,
  TRACKING_MIN,
  normalizeHex,
  validateText,
  type TextAlign,
  type TextFontId,
  type TextWeight,
} from './schema';

import type { ModuleConfigProps } from '../types';

import './textPanel.css';

/** Fine enough to be worth dragging, coarse enough that every stop is different. */
const SIZE_STEP = 0.01;
const TRACKING_STEP = 0.01;

const ALIGN_LABELS: Readonly<Record<TextAlign, string>> = {
  left: 'Left',
  center: 'Centre',
  right: 'Right',
};

/**
 * Named, not numbered.
 *
 * "600" is a typographer's unit on a control read by somebody choosing how
 * loud their rig name should be.
 */
const WEIGHT_LABELS: Readonly<Record<TextWeight, string>> = {
  400: 'Regular',
  600: 'Medium',
  800: 'Heavy',
};

function asOneOf<T extends string | number>(raw: string, allowed: readonly T[], def: T): T {
  return (allowed as readonly unknown[]).map(String).includes(raw)
    ? (allowed.find((v) => String(v) === raw) ?? def)
    : def;
}

export function ConfigPanel({ config, onChange }: ModuleConfigProps) {
  // Always first: `config` arrives from localStorage as `unknown`.
  const cfg = validateText(config);

  return (
    <ModuleOptions
      advancedTestId="text-advanced"
      primary={
        <>
          <Field label="Text" htmlFor="text-body">
            <TextInput
              id="text-body"
              testId="text-body"
              value={cfg.text}
              onChange={(text) => {
                onChange({ ...cfg, text: text.slice(0, MAX_TEXT_LEN) });
              }}
            />
          </Field>

          <Field label="Size" htmlFor="text-size">
            <RangeInput
              id="text-size"
              value={cfg.size}
              min={SIZE_MIN}
              max={SIZE_MAX}
              step={SIZE_STEP}
              onChange={(size) => {
                onChange({ ...cfg, size });
              }}
            />
          </Field>

          <Field label="Colour" htmlFor="text-colour">
            <input
              className="kh-text-swatch"
              id="text-colour"
              type="color"
              value={cfg.color}
              data-testid="text-colour"
              onChange={(e) => {
                onChange({ ...cfg, color: normalizeHex(e.target.value, cfg.color) });
              }}
            />
          </Field>

          <GroupField
            label="Font"
            id="text-font"
            description="A curated face is fetched once, the first time a layer asks for it."
          >
            <Segmented
              id="text-font"
              wrap
              labelledBy="text-font-label"
              value={cfg.font}
              options={TEXT_FONTS.map((f) => ({ value: f, label: TEXT_FACES[f].label }))}
              onChange={(value) => {
                onChange({ ...cfg, font: asOneOf<TextFontId>(value, TEXT_FONTS, cfg.font) });
              }}
            />
          </GroupField>
        </>
      }
      advanced={
        <>
          <GroupField label="Weight" id="text-weight">
            <Segmented
              id="text-weight"
              labelledBy="text-weight-label"
              value={String(cfg.weight)}
              options={TEXT_WEIGHTS.map((w) => ({ value: String(w), label: WEIGHT_LABELS[w] }))}
              onChange={(value) => {
                onChange({ ...cfg, weight: asOneOf<TextWeight>(value, TEXT_WEIGHTS, cfg.weight) });
              }}
            />
          </GroupField>

          <GroupField label="Align" id="text-align">
            <Segmented
              id="text-align"
              labelledBy="text-align-label"
              value={cfg.align}
              options={TEXT_ALIGNS.map((a) => ({ value: a, label: ALIGN_LABELS[a] }))}
              onChange={(value) => {
                onChange({ ...cfg, align: asOneOf<TextAlign>(value, TEXT_ALIGNS, cfg.align) });
              }}
            />
          </GroupField>

          <Field label="Letter spacing" htmlFor="text-tracking">
            <RangeInput
              id="text-tracking"
              value={cfg.letterSpacing}
              min={TRACKING_MIN}
              max={TRACKING_MAX}
              step={TRACKING_STEP}
              onChange={(letterSpacing) => {
                onChange({ ...cfg, letterSpacing });
              }}
            />
          </Field>

          <GroupField label="Uppercase" id="text-upper">
            <Switch
              id="text-upper"
              labelledBy="text-upper-label"
              checked={cfg.uppercase}
              onChange={(uppercase) => {
                onChange({ ...cfg, uppercase });
              }}
            />
          </GroupField>

          <GroupField
            label="Shadow"
            id="text-shadow"
            description="One flat drop shadow, for words over a busy base."
          >
            <Switch
              id="text-shadow"
              labelledBy="text-shadow-label"
              checked={cfg.shadow}
              onChange={(shadow) => {
                onChange({ ...cfg, shadow });
              }}
            />
          </GroupField>
        </>
      }
    />
  );
}
