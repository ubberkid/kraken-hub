/**
 * STEP 4 (docs/modules.md §6) — the Date layer's settings panel.
 *
 * Config-only code: `.tsx` under `src/modules/` is chunked into `config-ui` and
 * can never reach the display graph (invariant I8).
 *
 * ## The first row is the editor's strip
 *
 * `docs/design/design-editor-ux.md` §2.3 fixes it: **format · size · colour ·
 * More**. This panel is that row, in that order, so the two surfaces are one
 * set of options rather than two that can drift. Weight, uppercase and the
 * locale override live one level down, behind the single `Advanced` disclosure
 * `ModuleOptions` owns.
 *
 * ## The preview is the format, not a picture of one
 *
 * Each preset is shown as TODAY, formatted by the very function the renderer
 * calls. A panel that printed a hand-written sample — "Wed 2 Sep" — would be a
 * second implementation of the format, and it would be wrong in every locale
 * that does not write dates the way this file's author does.
 *
 * The colour well is native, for the reason `TextConfigPanel` records: a colour
 * is not an enumeration and cannot be one.
 */

import { useState } from 'react';

import {
  Field,
  GroupField,
  ModuleOptions,
  RangeInput,
  Segmented,
  Switch,
  TextInput,
} from '../../ui';

import { AUTO_LOCALE, DATE_FORMATS, FORMAT_LABELS, formatDate } from './format';
import {
  DATE_WEIGHTS,
  MAX_LOCALE_LEN,
  SIZE_MAX,
  SIZE_MIN,
  normalizeHex,
  normalizeLocale,
  validateDate,
  type DateWeight,
} from './schema';

import type { ModuleConfigProps } from '../types';

import './datePanel.css';

const SIZE_STEP = 0.01;

/** Named, not numbered — "600" is a typographer's unit on a reader's control. */
const WEIGHT_LABELS: Readonly<Record<DateWeight, string>> = {
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
  const cfg = validateDate(config);
  const today = new Date();
  const [draft, setDraft] = useState(cfg.locale);

  return (
    <ModuleOptions
      advancedTestId="date-advanced"
      primary={
        <>
          <GroupField
            label="Format"
            id="date-format"
            description="Shown as today, by the same function the panel uses."
          >
            <Segmented
              id="date-format"
              wrap
              labelledBy="date-format-label"
              value={cfg.format}
              options={DATE_FORMATS.map((f) => ({
                value: f,
                label: FORMAT_LABELS[f],
                title: formatDate(today, f, cfg.locale),
              }))}
              onChange={(value) => {
                onChange({ ...cfg, format: asOneOf(value, DATE_FORMATS, cfg.format) });
              }}
            />
            <p className="kh-date-sample" data-testid="date-sample">
              {formatDate(today, cfg.format, cfg.locale)}
            </p>
          </GroupField>

          <Field label="Size" htmlFor="date-size">
            <RangeInput
              id="date-size"
              value={cfg.size}
              min={SIZE_MIN}
              max={SIZE_MAX}
              step={SIZE_STEP}
              onChange={(size) => {
                onChange({ ...cfg, size });
              }}
            />
          </Field>

          <Field label="Colour" htmlFor="date-colour">
            <input
              className="kh-date-swatch"
              id="date-colour"
              type="color"
              value={cfg.color}
              data-testid="date-colour"
              onChange={(e) => {
                onChange({ ...cfg, color: normalizeHex(e.target.value, cfg.color) });
              }}
            />
          </Field>
        </>
      }
      advanced={
        <>
          <GroupField label="Weight" id="date-weight">
            <Segmented
              id="date-weight"
              labelledBy="date-weight-label"
              value={String(cfg.weight)}
              options={DATE_WEIGHTS.map((w) => ({ value: String(w), label: WEIGHT_LABELS[w] }))}
              onChange={(value) => {
                onChange({ ...cfg, weight: asOneOf<DateWeight>(value, DATE_WEIGHTS, cfg.weight) });
              }}
            />
          </GroupField>

          <GroupField label="Uppercase" id="date-upper">
            <Switch
              id="date-upper"
              labelledBy="date-upper-label"
              checked={cfg.uppercase}
              onChange={(uppercase) => {
                onChange({ ...cfg, uppercase });
              }}
            />
          </GroupField>

          <Field
            label="Language"
            htmlFor="date-locale"
            description={`"${AUTO_LOCALE}" follows this machine. A tag like en-GB or de overrides it; one this browser does not know falls back to the machine's own.`}
          >
            {/*
              The field keeps its own draft.
              Committing `normalizeLocale()` on every keystroke would make the
              field untypeable: `e` is not a tag, so it would fall back to the
              stored value and the caret would fight the user. The draft is what
              is typed; the config takes the first spelling that is a tag, and
              an empty field is `auto` — the one value that means "unset".
            */}
            <TextInput
              id="date-locale"
              testId="date-locale"
              value={draft}
              placeholder={AUTO_LOCALE}
              onChange={(raw) => {
                const next = raw.slice(0, MAX_LOCALE_LEN);
                setDraft(next);
                const trimmed = next.trim();
                if (trimmed === '') {
                  onChange({ ...cfg, locale: AUTO_LOCALE });
                  return;
                }
                const tag = normalizeLocale(trimmed, '');
                if (tag !== '') onChange({ ...cfg, locale: tag });
              }}
            />
          </Field>
        </>
      }
    />
  );
}
