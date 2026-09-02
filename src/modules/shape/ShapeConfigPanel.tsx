/**
 * STEP 4 (docs/modules.md §6) — the Shape layer's settings panel.
 *
 * Config-only code: `.tsx` under `src/modules/` is chunked into `config-ui` and
 * can never reach the display graph (invariant I8).
 *
 * ## The first row is the editor's strip
 *
 * `docs/design/design-editor-ux.md` §2.3 fixes it: **shape · fill · stroke ·
 * More**. Three controls and the door, in that order, so the panel and the
 * selection strip are one set of options rather than two that can drift.
 *
 * A paint is one control, not two: the `None` segment and the colour well live
 * in the same field, because "no fill" is a value of the fill setting and
 * splitting it into a separate switch would make the strip four controls to say
 * one thing.
 */

import { Field, GroupField, ModuleOptions, RangeInput, Segmented, Switch } from '../../ui';

import {
  NO_PAINT,
  OPACITY_MAX,
  OPACITY_MIN,
  RADIUS_MAX,
  RADIUS_MIN,
  SHAPE_KINDS,
  STROKE_MAX,
  STROKE_MIN,
  DEFAULT_SHAPE_FILL,
  normalizePaint,
  validateShape,
  type ShapeKind,
} from './schema';

import type { ModuleConfigProps } from '../types';

import './shapePanel.css';

const OPACITY_STEP = 0.05;
const STROKE_STEP = 0.005;
const RADIUS_STEP = 0.01;

const SHAPE_LABELS: Readonly<Record<ShapeKind, string>> = {
  rect: 'Rect',
  circle: 'Circle',
  line: 'Line',
  ring: 'Ring',
};

const PAINTED = 'colour';

function asShape(raw: string): ShapeKind | null {
  return (SHAPE_KINDS as readonly string[]).includes(raw) ? (raw as ShapeKind) : null;
}

/**
 * One paint — a two-way choice and, when it is a colour, the well to pick it.
 *
 * `id` is the field id; the caller owns the label, so the two paints read as
 * the same control twice rather than as two different inventions.
 */
function PaintField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const isNone = value === NO_PAINT;
  return (
    <GroupField label={label} id={id}>
      <div className="kh-shape-paint">
        <Segmented
          id={id}
          labelledBy={`${id}-label`}
          value={isNone ? NO_PAINT : PAINTED}
          options={[
            { value: PAINTED, label: 'Colour' },
            { value: NO_PAINT, label: 'None' },
          ]}
          onChange={(next) => {
            onChange(next === NO_PAINT ? NO_PAINT : DEFAULT_SHAPE_FILL);
          }}
        />
        {!isNone && (
          <input
            className="kh-shape-swatch"
            id={`${id}-hex`}
            type="color"
            aria-label={label}
            value={value}
            data-testid={`${id}-hex`}
            onChange={(e) => {
              onChange(normalizePaint(e.target.value, value));
            }}
          />
        )}
      </div>
    </GroupField>
  );
}

export function ConfigPanel({ config, onChange }: ModuleConfigProps) {
  // Always first: `config` arrives from localStorage as `unknown`.
  const cfg = validateShape(config);

  return (
    <ModuleOptions
      advancedTestId="shape-advanced"
      primary={
        <>
          <GroupField label="Shape" id="shape-kind">
            <Segmented
              id="shape-kind"
              wrap
              labelledBy="shape-kind-label"
              value={cfg.shape}
              options={SHAPE_KINDS.map((s) => ({ value: s, label: SHAPE_LABELS[s] }))}
              onChange={(value) => {
                onChange({ ...cfg, shape: asShape(value) ?? cfg.shape });
              }}
            />
          </GroupField>

          <PaintField
            id="shape-fill"
            label="Fill"
            value={cfg.fill}
            onChange={(fill) => {
              onChange({ ...cfg, fill });
            }}
          />

          <PaintField
            id="shape-stroke"
            label="Stroke"
            value={cfg.stroke}
            onChange={(stroke) => {
              onChange({ ...cfg, stroke });
            }}
          />
        </>
      }
      advanced={
        <>
          <Field label="Fill opacity" htmlFor="shape-fill-opacity">
            <RangeInput
              id="shape-fill-opacity"
              value={cfg.fillOpacity}
              min={OPACITY_MIN}
              max={OPACITY_MAX}
              step={OPACITY_STEP}
              onChange={(fillOpacity) => {
                onChange({ ...cfg, fillOpacity });
              }}
            />
          </Field>

          <Field label="Stroke width" htmlFor="shape-stroke-width">
            <RangeInput
              id="shape-stroke-width"
              value={cfg.strokeWidth}
              min={STROKE_MIN}
              max={STROKE_MAX}
              step={STROKE_STEP}
              onChange={(strokeWidth) => {
                onChange({ ...cfg, strokeWidth });
              }}
            />
          </Field>

          <Field label="Corner radius" htmlFor="shape-radius">
            <RangeInput
              id="shape-radius"
              value={cfg.radius}
              min={RADIUS_MIN}
              max={RADIUS_MAX}
              step={RADIUS_STEP}
              disabled={cfg.shape !== 'rect'}
              title={cfg.shape === 'rect' ? '' : 'Corners are a rectangle setting.'}
              onChange={(radius) => {
                onChange({ ...cfg, radius });
              }}
            />
          </Field>

          <GroupField label="Dashed" id="shape-dash">
            <Switch
              id="shape-dash"
              labelledBy="shape-dash-label"
              checked={cfg.dash}
              onChange={(dash) => {
                onChange({ ...cfg, dash });
              }}
            />
          </GroupField>
        </>
      }
    />
  );
}
