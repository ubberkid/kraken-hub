/**
 * STEP 4 (docs/modules.md §6) — the Icon layer's settings panel.
 *
 * Config-only code: `.tsx` under `src/modules/` is chunked into `config-ui` and
 * can never reach the display graph (invariant I8), so this file is free to use
 * the UI kit and React.
 *
 * ## The first row is the editor's strip
 *
 * `docs/design/design-editor-ux.md` §2.3's row for this kind is **icon · colour
 * · size · weight · More**, and the strip's `icon` control opens THIS panel, so
 * the glyph grid is the first thing on it. The two surfaces are one set of
 * options rather than two that can drift.
 *
 * ## Why the grid has a search field and five drawers
 *
 * Forty-eight glyphs is more than a person scans. The category row narrows it
 * to a drawer and the search field narrows it to a word; both are house
 * controls (`Segmented`, `TextInput`), so the "no native controls" rule holds.
 * The one native element on this surface is the colour well, for the reason
 * `TextConfigPanel` writes down: a colour is not an enumeration and cannot be
 * one, and the platform's own picker beats any grid of swatches at showing
 * which of sixteen million somebody actually wants.
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

import { CATEGORY_LABELS, GLYPHS, GLYPH_CATEGORIES, type GlyphCategory } from './glyphs';
import {
  ICON_WEIGHTS,
  SIZE_MAX,
  SIZE_MIN,
  WEIGHT_STROKE,
  normalizeHex,
  validateIcon,
  type IconWeight,
} from './schema';

import type { ModuleConfigProps } from '../types';

import './iconPanel.css';

const SIZE_STEP = 0.01;

/** The drawer that means "do not narrow it", first because it is the way in. */
const ALL = 'all';

const WEIGHT_LABELS: Readonly<Record<IconWeight, string>> = {
  thin: 'Thin',
  regular: 'Regular',
  bold: 'Bold',
};

function asWeight(raw: string, def: IconWeight): IconWeight {
  return (ICON_WEIGHTS as readonly string[]).includes(raw) ? (raw as IconWeight) : def;
}

function asCategory(raw: string): GlyphCategory | typeof ALL {
  return (GLYPH_CATEGORIES as readonly string[]).includes(raw) ? (raw as GlyphCategory) : ALL;
}

export function ConfigPanel({ config, onChange }: ModuleConfigProps) {
  // Always first: `config` arrives from localStorage as `unknown`.
  const cfg = validateIcon(config);

  const [drawer, setDrawer] = useState<GlyphCategory | typeof ALL>(ALL);
  const [query, setQuery] = useState('');

  const needle = query.trim().toLowerCase();
  const shown = GLYPHS.filter(
    (g) =>
      (drawer === ALL || g.category === drawer) &&
      (needle === '' ||
        g.label.toLowerCase().includes(needle) ||
        g.id.includes(needle) ||
        CATEGORY_LABELS[g.category].toLowerCase().includes(needle)),
  );

  return (
    <ModuleOptions
      advancedTestId="icon-advanced"
      primary={
        <>
          <GroupField label="Category" id="icon-category">
            <Segmented
              id="icon-category"
              wrap
              labelledBy="icon-category-label"
              value={drawer}
              options={[
                { value: ALL, label: 'All' },
                ...GLYPH_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] })),
              ]}
              onChange={(value) => {
                setDrawer(asCategory(value));
              }}
            />
          </GroupField>

          <Field label="Search" htmlFor="icon-search">
            <TextInput id="icon-search" testId="icon-search" value={query} onChange={setQuery} />
          </Field>

          <GroupField
            label="Icon"
            id="icon-grid"
            description="Forty-eight glyphs, drawn here — nothing is fetched."
          >
            <div
              className="kh-icon-grid"
              role="radiogroup"
              aria-labelledby="icon-grid-label"
              data-testid="icon-grid"
            >
              {shown.map((glyph) => {
                const chosen = glyph.id === cfg.icon;
                return (
                  <button
                    key={glyph.id}
                    type="button"
                    role="radio"
                    aria-checked={chosen}
                    className="kh-icon-cell"
                    data-chosen={chosen ? 'true' : 'false'}
                    data-testid={`icon-cell-${glyph.id}`}
                    title={glyph.label}
                    aria-label={glyph.label}
                    onClick={() => {
                      onChange({ ...cfg, icon: glyph.id });
                    }}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      {glyph.paint === 'fill' ? (
                        <path d={glyph.d} fill="currentColor" />
                      ) : (
                        <path
                          d={glyph.d}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={WEIGHT_STROKE[cfg.weight]}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      )}
                    </svg>
                  </button>
                );
              })}
              {shown.length === 0 && (
                <p className="kh-icon-grid__none" data-testid="icon-grid-none">
                  No glyph matches that word.
                </p>
              )}
            </div>
          </GroupField>

          <Field label="Colour" htmlFor="icon-colour">
            <input
              className="kh-icon-swatch"
              id="icon-colour"
              type="color"
              value={cfg.color}
              data-testid="icon-colour"
              onChange={(e) => {
                onChange({ ...cfg, color: normalizeHex(e.target.value, cfg.color) });
              }}
            />
          </Field>

          <Field label="Size" htmlFor="icon-size">
            <RangeInput
              id="icon-size"
              value={cfg.size}
              min={SIZE_MIN}
              max={SIZE_MAX}
              step={SIZE_STEP}
              onChange={(size) => {
                onChange({ ...cfg, size });
              }}
            />
          </Field>
        </>
      }
      advanced={
        <>
          <GroupField
            label="Weight"
            id="icon-weight"
            description="Stroke width. The solid glyphs — a heart, a flame — are unaffected."
          >
            <Segmented
              id="icon-weight"
              labelledBy="icon-weight-label"
              value={cfg.weight}
              options={ICON_WEIGHTS.map((w) => ({ value: w, label: WEIGHT_LABELS[w] }))}
              onChange={(value) => {
                onChange({ ...cfg, weight: asWeight(value, cfg.weight) });
              }}
            />
          </GroupField>

          <GroupField
            label="Glow"
            id="icon-glow"
            description="One soft halo, for a glyph over a busy base."
          >
            <Switch
              id="icon-glow"
              labelledBy="icon-glow-label"
              checked={cfg.glow}
              onChange={(glow) => {
                onChange({ ...cfg, glow });
              }}
            />
          </GroupField>
        </>
      }
    />
  );
}
