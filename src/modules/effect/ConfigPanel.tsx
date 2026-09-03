/**
 * STEP 4 (docs/modules.md §6) — the Effects settings panel.
 *
 * Config-only code: `.tsx` under `src/modules/` is chunked into `config-ui` and
 * can never reach the display graph (invariant I8), so this file is free to use
 * the UI kit, React, and the whole twelve-palette catalogue.
 *
 * ## This panel IS the strip
 *
 * `docs/design/design-editor-ux.md` §2.3 used to give an Effect layer five
 * controls — effect · preset · custom colours · reacts-to-temp · More — and four
 * of them opened this panel. So the strip is one control now (`Effect…`), and
 * everything it used to name is here in that same order: the picker, the preset
 * chips, the four wells, the temperature switch. Speed, scale, brightness and
 * which sensor drives the warmth are behind the single `Advanced` disclosure
 * `ModuleOptions` owns. One surface, so there is nothing to keep in step.
 *
 * ## Two shapes that are not `Segmented`
 *
 * **The effect picker is a card strip.** Twelve choices whose whole point is
 * what they look like: a row of twelve words would be a menu of names for
 * pictures nobody has seen. Each card carries the effect's own Classic material
 * as a gradient — a still, cheap likeness of the palette, not the effect
 * running — plus its name. It is a `radiogroup` of `radio` buttons, the same
 * mechanics `Segmented` uses, so it keeps the roving tabindex and the arrow keys.
 *
 * **The colour wells are native `<input type="color">`.** That is not a hole in
 * the round-2 rule: what round 2 deleted was every native *picker of sentences*.
 * A colour is not an enumeration and cannot be one.
 *
 * A preset is one of the author's own Unity materials — Graphite, Bubblegum,
 * Sunburst. Pressing one writes its colours; editing a well afterwards leaves
 * the colours alone and the chip row simply says Custom, because the row reads
 * the colours rather than remembering what was pressed.
 *
 * ## Both of them are full-width rows, and that is the whole layout fix
 *
 * `.kh-field` is a label on the left and a control on the right, which is right
 * for a switch and wrong for anything that wants the width: audit 9 photographed
 * four colour wells stacked in a column against the right margin with ~500 px of
 * nothing beside the word "Colours", and the twelve cards clipped mid-card at the
 * panel's edge with no way to see the rest. Both are the same cause — a wide
 * child sized as a flex item in a two-column row — so both take `flex: 1 0 100%`
 * and drop under their label. The strip is then a real horizontal scroller (fade
 * at whichever edge has more, arrow keys that move the focus with the selection),
 * and the wells are a wrapping row of labelled swatches.
 */

import { useEffect, useRef } from 'react';

import { Field, GroupField, ModuleOptions, RangeInput, Segmented, Switch } from '../../ui';

import { EFFECT_CATALOG, EFFECT_LIST, matchPreset, presetColours } from './catalog';
import {
  BRIGHTNESS_MAX,
  BRIGHTNESS_MIN,
  CUSTOM_PRESET_ID,
  SCALE_MAX,
  SCALE_MIN,
  SPEED_MAX,
  SPEED_MIN,
  TEMP_SOURCES,
  validateEffect,
  type EffectId,
  type TempSource,
} from './schema';

import type { ModuleConfigProps } from '../types';

import './effectPanel.css';

/** Fine enough to be worth dragging, coarse enough that every stop differs. */
const SLIDER_STEP = 0.05;

const TEMP_LABELS: Readonly<Record<TempSource, string>> = {
  cpu: 'CPU',
  gpu: 'GPU',
  liquid: 'Liquid',
};

/** The angle the card swatches share, so the twelve read as one row. */
const SWATCH_ANGLE = '145deg';

function asTempSource(raw: string, def: TempSource): TempSource {
  return (TEMP_SOURCES as readonly string[]).includes(raw) ? (raw as TempSource) : def;
}

/** A still likeness of a palette: the four colours as one soft ramp. */
function swatch(colors: readonly string[]): string {
  return `linear-gradient(${SWATCH_ANGLE}, ${colors.join(', ')})`;
}

/** Slack before an edge counts as reached, so a fractional scroll still ends. */
const EDGE_SLACK_PX = 2;

/** Which end of the card strip has more behind it. Drives the fade. */
function moreAt(el: HTMLElement): 'none' | 'start' | 'end' | 'both' {
  const start = el.scrollLeft > EDGE_SLACK_PX;
  const end = el.scrollLeft + el.clientWidth < el.scrollWidth - EDGE_SLACK_PX;
  if (start && end) return 'both';
  if (start) return 'start';
  return end ? 'end' : 'none';
}

export function ConfigPanel({ config, onChange }: ModuleConfigProps) {
  // Always first: `config` arrives from localStorage as `unknown`.
  const cfg = validateEffect(config);
  const descriptor = EFFECT_CATALOG[cfg.effect];
  const preset = matchPreset(cfg.effect, cfg.colors);
  const custom = preset === CUSTOM_PRESET_ID;

  const stripRef = useRef<HTMLDivElement | null>(null);
  /** Set by an arrow key, read once by the effect below. Never rendered. */
  const followFocus = useRef(false);

  /**
   * The fade says "there is more this way", so it has to be measured rather
   * than assumed: at 866 px twelve cards overflow and at 1400 they may not.
   */
  useEffect(() => {
    const el = stripRef.current;
    if (el === null) return undefined;
    const sync = (): void => {
      el.dataset['more'] = moreAt(el);
    };
    sync();
    el.addEventListener('scroll', sync, { passive: true });
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(sync);
      observer.observe(el);
    }
    return () => {
      el.removeEventListener('scroll', sync);
      observer?.disconnect();
    };
  });

  /**
   * A roving tabindex has to actually rove: pressing → moves the selection, so
   * the focus and the scroll follow it to the newly selected card. Without this
   * the arrow keys walked the strip while the focus ring stayed on the card the
   * user started from, and the card they had selected could be off-screen.
   */
  useEffect(() => {
    if (!followFocus.current) return;
    followFocus.current = false;
    const card = stripRef.current?.querySelector<HTMLElement>(
      `[data-testid="effect-pick-${cfg.effect}"]`,
    );
    card?.focus();
    // jsdom has no layout and therefore no `scrollIntoView`, and this is the one
    // call in the panel that would throw there rather than do nothing useful.
    if (typeof card?.scrollIntoView === 'function') {
      card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [cfg.effect]);

  /** Switching effect keeps the preset if the new effect has one by that name. */
  const chooseEffect = (next: EffectId): void => {
    const wanted = custom ? CUSTOM_PRESET_ID : preset;
    const colors = presetColours(next, wanted) ?? presetColours(next, 'classic') ?? cfg.colors;
    onChange({ ...cfg, effect: next, preset: matchPreset(next, colors), colors: [...colors] });
  };

  const choosePreset = (id: string): void => {
    const colors = presetColours(cfg.effect, id);
    if (colors === null) return;
    onChange({ ...cfg, preset: id, colors: [...colors] });
  };

  const chooseColour = (slot: number, value: string): void => {
    const colors = cfg.colors.map((c, i) => (i === slot ? value.toUpperCase() : c));
    onChange({ ...cfg, colors, preset: matchPreset(cfg.effect, colors) });
  };

  /** Arrow keys inside the card strip, exactly as `Segmented` behaves. */
  const moveEffect = (delta: number): void => {
    const at = EFFECT_LIST.findIndex((d) => d.id === cfg.effect);
    const from = at === -1 ? 0 : at;
    const next = EFFECT_LIST[(from + delta + EFFECT_LIST.length) % EFFECT_LIST.length];
    if (next === undefined) return;
    followFocus.current = true;
    chooseEffect(next.id);
  };

  const presetOptions = descriptor.presets.map((p) => ({ value: p.id, label: p.name }));
  // The Custom chip exists only while the colours ARE custom — a chip that is
  // selected the moment you edit a well, rather than one that does nothing.
  if (custom) presetOptions.push({ value: CUSTOM_PRESET_ID, label: 'Custom' });

  return (
    <ModuleOptions
      advancedTestId="effect-advanced"
      primary={
        <>
          <GroupField
            label="Effect"
            id="effect-pick"
            {...(descriptor.experimental === true
              ? { description: 'This one is still being tuned — it may change.' }
              : {})}
          >
            {/*
              The shell exists only to be the CONTAINER the cards are measured
              against (audit 10, F9): `container-type: inline-size` cannot go on
              the scroller itself, because a container query may not be answered
              by the element the query is styling. It is the row that claims the
              width now; the cards fill it.
            */}
            <div className="kh-effect-cards-shell">
              <div
                className="kh-effect-cards"
                id="effect-pick"
                ref={stripRef}
                role="radiogroup"
                aria-labelledby="effect-pick-label"
                data-more="none"
              >
                {EFFECT_LIST.map((d) => {
                  const selected = d.id === cfg.effect;
                  const colors = selected ? cfg.colors : (d.presets[0]?.colors ?? cfg.colors);
                  return (
                    <button
                      key={d.id}
                      type="button"
                      role="radio"
                      className="kh-effect-card"
                      aria-checked={selected}
                      tabIndex={selected ? 0 : -1}
                      data-testid={`effect-pick-${d.id}`}
                      onClick={() => {
                        chooseEffect(d.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                          e.preventDefault();
                          moveEffect(1);
                        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                          e.preventDefault();
                          moveEffect(-1);
                        }
                      }}
                    >
                      <span
                        className="kh-effect-card__art"
                        style={{ background: swatch(colors) }}
                        aria-hidden="true"
                      />
                      <span className="kh-effect-card__name">{d.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </GroupField>

          <GroupField label="Preset" id="effect-preset">
            <Segmented
              id="effect-preset"
              wrap
              labelledBy="effect-preset-label"
              value={preset}
              options={presetOptions}
              onChange={choosePreset}
            />
          </GroupField>

          <GroupField label="Colours" id="effect-colours">
            <div className="kh-effect-wells">
              {cfg.colors.map((hex, slot) => {
                const id = `effect-colour-${String(slot)}`;
                return (
                  <div className="kh-effect-well" key={id}>
                    <input
                      className="kh-effect-swatch"
                      id={id}
                      type="color"
                      value={hex}
                      data-testid={id}
                      onChange={(e) => {
                        chooseColour(slot, e.target.value);
                      }}
                    />
                    {/* Under the well, not beside it: the swatch is the control
                        and the slot name is its caption. */}
                    <label htmlFor={id}>{descriptor.slots[slot] ?? `Colour ${String(slot)}`}</label>
                  </div>
                );
              })}
            </div>
          </GroupField>

          <GroupField
            label="Reacts to temperature"
            id="effect-temp"
            description="The picture warms toward ember as the reading climbs, and glides back down."
          >
            <Switch
              id="effect-temp"
              labelledBy="effect-temp-label"
              checked={cfg.reactsToTemp}
              onChange={(reactsToTemp) => {
                onChange({ ...cfg, reactsToTemp });
              }}
            />
          </GroupField>
        </>
      }
      advanced={
        <>
          <GroupField
            label="Reading"
            id="effect-temp-source"
            description="Which sensor drives the warmth. CAM does not report a pump speed."
          >
            <Segmented
              id="effect-temp-source"
              labelledBy="effect-temp-source-label"
              value={cfg.tempSource}
              options={TEMP_SOURCES.map((s) => ({ value: s, label: TEMP_LABELS[s] }))}
              onChange={(value) => {
                onChange({ ...cfg, tempSource: asTempSource(value, cfg.tempSource) });
              }}
            />
          </GroupField>

          <Field label="Speed" htmlFor="effect-speed">
            <RangeInput
              id="effect-speed"
              value={cfg.speed}
              min={SPEED_MIN}
              max={SPEED_MAX}
              step={SLIDER_STEP}
              onChange={(speed) => {
                onChange({ ...cfg, speed });
              }}
            />
          </Field>

          <Field label="Scale" htmlFor="effect-scale">
            <RangeInput
              id="effect-scale"
              value={cfg.scale}
              min={SCALE_MIN}
              max={SCALE_MAX}
              step={SLIDER_STEP}
              onChange={(scale) => {
                onChange({ ...cfg, scale });
              }}
            />
          </Field>

          <Field label="Brightness" htmlFor="effect-brightness">
            <RangeInput
              id="effect-brightness"
              value={cfg.brightness}
              min={BRIGHTNESS_MIN}
              max={BRIGHTNESS_MAX}
              step={SLIDER_STEP}
              onChange={(brightness) => {
                onChange({ ...cfg, brightness });
              }}
            />
          </Field>
        </>
      }
    />
  );
}
