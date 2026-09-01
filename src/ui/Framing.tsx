/**
 * How a picture sits in the panel — once, for every module that puts one there.
 *
 * The design audit found the same control written three times in three different
 * wordings: home said "Fill · **Cover**", the remote said "Cover — fill the
 * panel, crop the **edges**", and the video panel said "Cover — fill the panel,
 * crop the **overflow**". Same setting, same effect, three vocabularies, so a
 * user who learned it in one place had to learn it again in the next.
 *
 * The fit/zoom pair is now one component, imported by the video panel, the image
 * panel and the home screen's ops strip. The option labels are ONE WORD each —
 * the sentence that used to be inside every `<option>` is a `title` on the
 * segment, where it explains without being read aloud every time.
 */

import { PAN_LIMIT, ZOOM_MAX, ZOOM_MIN } from '../render/types';

import { FIT_SEGMENTS } from './fitOptions';

import { Field, GroupField, RangeInput, Segmented } from './index';

import type { RenderSettings } from '../state/schema';

const ZOOM_STEP = 0.05;
const PAN_STEP = 0.01;
const ZOOM_DECIMALS = 2;
const PAN_DECIMALS = 2;

// Named individually: invariant I5's `no-magic-numbers` exempts `const`
// initialisers but not array elements, and 90/180/270 are quarter turns rather
// than anything device-shaped.
const QUARTER = 90;
const HALF_TURN = 180;
const THREE_QUARTER = 270;
const ROTATIONS: readonly RenderSettings['rotate'][] = [0, QUARTER, HALF_TURN, THREE_QUARTER];

interface FramingValue {
  fit: RenderSettings['fit'];
  zoom: number;
  offsetX: number;
  offsetY: number;
  rotate: RenderSettings['rotate'];
}

/** The fit segmented control on its own — the home ops strip uses only this. */
export function FitControl({
  id,
  value,
  onChange,
  ariaLabel,
  labelledBy,
}: {
  id: string;
  value: RenderSettings['fit'];
  onChange: (next: RenderSettings['fit']) => void;
  ariaLabel?: string | undefined;
  labelledBy?: string | undefined;
}) {
  return (
    <Segmented
      id={id}
      value={value}
      ariaLabel={ariaLabel}
      labelledBy={labelledBy}
      options={FIT_SEGMENTS}
      onChange={(next) => {
        const found = FIT_SEGMENTS.find((f) => f.value === next);
        if (found !== undefined) onChange(found.value);
      }}
    />
  );
}

/**
 * Zoom, nudge and rotate — behind the module's one Advanced door, never on top.
 *
 * Fit used to sit above this, in a `FramingPrimary` every panel rendered. It was
 * the round-2 audit's clearest duplicate: the home screen's ops strip already
 * carries Fit for the module that is on screen, so the panel underneath was
 * asking the same question a second time, in the same words, two inches lower.
 * There is one Fit control now and it is the one you can see without opening
 * anything — `FitControl`, on the strip.
 */
export function FramingAdvanced({
  idPrefix,
  value,
  onChange,
}: {
  idPrefix: string;
  value: FramingValue;
  onChange: (patch: Partial<FramingValue>) => void;
}) {
  return (
    <>
      <Field label={`Zoom — ${value.zoom.toFixed(ZOOM_DECIMALS)}×`} htmlFor={`${idPrefix}-zoom`}>
        <RangeInput
          id={`${idPrefix}-zoom`}
          value={value.zoom}
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          step={ZOOM_STEP}
          onChange={(zoom) => {
            onChange({ zoom });
          }}
        />
      </Field>

      <Field
        label={`Nudge across — ${value.offsetX.toFixed(PAN_DECIMALS)}`}
        htmlFor={`${idPrefix}-panx`}
      >
        <RangeInput
          id={`${idPrefix}-panx`}
          value={value.offsetX}
          min={-PAN_LIMIT}
          max={PAN_LIMIT}
          step={PAN_STEP}
          onChange={(offsetX) => {
            onChange({ offsetX });
          }}
        />
      </Field>

      <Field
        label={`Nudge down — ${value.offsetY.toFixed(PAN_DECIMALS)}`}
        htmlFor={`${idPrefix}-pany`}
      >
        <RangeInput
          id={`${idPrefix}-pany`}
          value={value.offsetY}
          min={-PAN_LIMIT}
          max={PAN_LIMIT}
          step={PAN_STEP}
          onChange={(offsetY) => {
            onChange({ offsetY });
          }}
        />
      </Field>

      <GroupField label="Turn the picture" id={`${idPrefix}-rotate`}>
        <Segmented
          id={`${idPrefix}-rotate`}
          labelledBy={`${idPrefix}-rotate-label`}
          value={String(value.rotate)}
          options={ROTATIONS.map((r) => ({ value: String(r), label: `${String(r)}°` }))}
          onChange={(next) => {
            const rotate = ROTATIONS.find((r) => String(r) === next);
            if (rotate !== undefined) onChange({ rotate });
          }}
        />
      </GroupField>
    </>
  );
}
