/**
 * The inspector — §2.4's "More", as a sheet over the rail (M6).
 *
 * ## What it replaces, and why
 *
 * `More` opened the home screen's module options panel: the same 621 px wall for
 * every control that claimed to be different. On the Effect strip, "Effect" and
 * "Preset" were two separate actions that opened the same panel scrolled to the
 * same place, and Colours opened a panel whose four swatches sat above ~500 px
 * of nothing. A row of buttons that all do one thing is a row of buttons
 * pretending to be a row of buttons.
 *
 * §2.4 asks for an inspector instead: everything about the SELECTED layer, in
 * one place, in four sections — Layout, the kind's own panel, Visibility,
 * Advanced. It takes the rail's column rather than the page's bottom, exactly
 * the way the add sheet does (`grid-area: rail`, its BODY the thing that
 * scrolls), so opening it costs the canvas nothing: the halo does not shrink,
 * the page does not grow, and the thing you asked to see is on the screen.
 *
 * ## Layout is numbers, and they go through the ops
 *
 * Position, size, rotation and opacity are the four things a person comes to an
 * inspector to type exactly. They are `<input type="number">` in tabular figures
 * — the drag's HUD reads the same values in the same units — and every one of
 * them writes through `editor.transform`, which is `ops.setTransformOf`: the
 * same clamps, the same refusal on a locked layer, and one history entry per
 * commit, identical to what a drag on the halo produces.
 */

import { useEffect, useRef, useState, type ComponentType } from 'react';

import { BASE_LAYER_ID, TRANSFORM_LIMITS, type Layer } from '../../../../state/look/types';
import { loadConfigPanel, readConfigPanel } from '../configPanels';

import type { AnyKrakenModule, ModuleConfigProps } from '../../../../modules/types';
import type { EditorApi } from '../../editor/useEditor';

export interface InspectorSheetProps {
  editor: EditorApi;
  /** The layer being inspected — the selection, or the base at rest. */
  layer: Layer;
  /** The kind's manifest, for its name and its panel. `null` for a fork's kind. */
  module: AnyKrakenModule | null;
  /** The layer's resolved config: the bank for the base, its own for an overlay. */
  config: unknown;
  /**
   * The panel this look is for, in its own pixels — the only thing Layout needs
   * to turn the model's diameters into the pixels a person reads (M1).
   */
  panel: { width: number; height: number };
  /**
   * Whether this window owns the bytes — `ownsBytes()`, handed to the kind's
   * own panel.
   *
   * The inspector mounts the module's real `ConfigPanel`, which is exactly what
   * makes the phone's editor the same editor. It is also how round 13's audit
   * found *"On this PC"*, the **Local downloader** card and a *"Download for
   * Windows"* button rendered on a sofa: the panel is one component and the
   * surface it opens on is not. So the answer travels with it, and the panel
   * drops the half of itself that acts on a disk this window does not have.
   */
  ownsBytes?: boolean;
  /** Writes it back to whichever home §4.1 gives it. */
  onConfig: (next: unknown) => void;
  onClose: () => void;
  /**
   * The section the press that opened this sheet was ASKING for — round 11's
   * F-7.
   *
   * The strip's Effect, Preset and Colours buttons are three doors into one
   * room: the kind's own panel, which is the `inspect-options` section here.
   * The sheet opens at the top, which is Layout, and its body scrolls — 365 px
   * of window over 1,651 px of content on the effect layer at 866x537 — so a
   * person who pressed **Effect** got five number fields and none of the twelve
   * effects, with nothing on the screen saying the catalogue was below the
   * fold. Naming the destination is what turns that into an answer.
   *
   * `null` for `More`, which asks for the sheet rather than for anything in it,
   * and the sheet then opens where it always has. The `nonce` is what makes a
   * SECOND press of the same button scroll again after the reader has scrolled
   * away — the section is the same, so nothing else about the value changes.
   */
  reveal?: { section: 'options'; nonce: number } | null;
}

/** How finely the inspector lets you type each field. */
const STEP = { pos: 0.01, size: 0.01, rot: 1, opacity: 0.05 } as const;

export function InspectorSheet({
  editor,
  layer,
  module,
  config,
  panel,
  reveal = null,
  ownsBytes = true,
  onConfig,
  onClose,
}: InspectorSheetProps) {
  const isBase = layer.id === BASE_LAYER_ID;
  const locked = layer.locked === true;
  const { pos, sMin, sMax, rot } = TRANSFORM_LIMITS;

  /*
   * Scroll to the named section, once the section has something in it.
   *
   * `KindPanel` below is a lazily-imported chunk, so on the first inspection of
   * a kind `inspect-options` exists and is EMPTY for a beat — scrolling to it
   * then lands on a 0 px box near the top and the panel arrives underneath the
   * fold again. `panelReady` is the chunk reporting for duty, and it is in the
   * dependency list precisely so the scroll happens twice on a cold open and
   * once on a warm one.
   *
   * `block: 'start'` and no `behavior`: this is not a journey the reader took,
   * it is where the sheet was always meant to open, and an animated slide would
   * be 300 ms of the reader watching the app find the thing they asked for.
   */
  const optionsRef = useRef<HTMLElement | null>(null);
  const [panelReady, setPanelReady] = useState(false);
  useEffect(() => {
    if (reveal === null) return undefined;
    /*
     * Now, and again one frame later — round 13's finding 5.
     *
     * `panelReady` says the chunk is IN, not that the browser has laid it out:
     * the effect panel's twelve tiles and four colour wells are still zero-high
     * in the same tick, so under load the scroll lands short and the section's
     * top sits below the port. Nothing here can ask "is it settled?" — but a
     * frame later the layout is done, which is the same one-frame delay
     * `RemoteView` already uses to scroll onto a control the editor just
     * unmounted. The immediate call stays: on a warm panel it is already right,
     * and a scroll that is correct twice is invisible.
     */
    optionsRef.current?.scrollIntoView({ block: 'start' });
    const frame = requestAnimationFrame(() => {
      optionsRef.current?.scrollIntoView({ block: 'start' });
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [reveal, panelReady, layer.id]);

  const write = (patch: Record<string, number>): void => {
    editor.transform(layer.id, patch);
  };

  return (
    <section
      className="kh-sheet kh-sheet--inspect"
      data-testid="inspector-sheet"
      aria-label="Layer settings"
    >
      <header className="kh-sheet__head">
        <h2>{module === null ? layer.kind : (module.chipName ?? module.name)}</h2>
        <button
          type="button"
          className="kh-iconbtn"
          data-testid="inspector-close"
          aria-label="Close"
          onClick={onClose}
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>

      <div className="kh-sheet__body">
        {/*
          Layout — the four numbers, and the one that is not a number.

          Disabled on the base rather than hidden: a background wears `IDENTITY`
          by definition (§4.1), and a section that vanished for one layer and
          appeared for the next would make the inspector a different shape
          depending on what you clicked, which is the one thing it must not be.
        */}
        <section className="kh-sheet__group" data-testid="inspect-layout">
          <h3>
            Layout
            {isBase && <small className="kh-sheet__why">The background fills the panel.</small>}
            {!isBase && locked && <small className="kh-sheet__why">This layer is locked.</small>}
          </h3>
          {/*
            The units are the reader's, not the model's — round 10's M1.

            X and Y were `0.153` and `-0.867`: diameters from the centre, which
            is what a look file stores and what every clamp in `ops.ts` speaks,
            and which nobody is thinking in while they line two layers up. Each
            field converts at the edge — `unit` per pixel for position, 100 per
            unit for the two fractions — so the document is untouched and the
            person gets pixels, per cent and degrees. The drag's HUD does the
            same conversion from the same two panel numbers, so the two readouts
            still agree to the pixel.
          */}
          <div className="kh-num">
            <Num
              id="x"
              label="X"
              unit="px"
              perUnit={panel.width / 2}
              value={layer.t.x}
              min={-pos}
              max={pos}
              step={STEP.pos}
              disabled={isBase || locked}
              onChange={(x) => {
                write({ x });
              }}
            />
            <Num
              id="y"
              label="Y"
              unit="px"
              perUnit={panel.height / 2}
              value={layer.t.y}
              min={-pos}
              max={pos}
              step={STEP.pos}
              disabled={isBase || locked}
              onChange={(y) => {
                write({ y });
              }}
            />
            <Num
              id="s"
              label="Size"
              unit="%"
              perUnit={100}
              value={layer.t.s}
              min={sMin}
              max={sMax}
              step={STEP.size}
              disabled={isBase || locked}
              onChange={(s) => {
                write({ s });
              }}
            />
            <Num
              id="r"
              label="Rotation"
              value={layer.t.r}
              min={-rot}
              max={rot}
              step={STEP.rot}
              unit="°"
              disabled={isBase || locked}
              onChange={(r) => {
                write({ r });
              }}
            />
            <Num
              id="a"
              label="Opacity"
              unit="%"
              perUnit={100}
              value={layer.t.a}
              min={0}
              max={1}
              step={STEP.opacity}
              disabled={isBase || locked}
              onChange={(a) => {
                write({ a });
              }}
            />
          </div>
          <p className="kh-hint" data-testid="inspect-layout-units">
            X and Y are panel pixels from the centre.
          </p>
        </section>

        {/* The kind's own panel, in full — the same component the options panel renders. */}
        {module !== null && (
          <section className="kh-sheet__group" data-testid="inspect-options" ref={optionsRef}>
            <h3>{module.chipName ?? module.name}</h3>
            <KindPanel
              id={module.id}
              config={config}
              ownsBytes={ownsBytes}
              onChange={onConfig}
              onReady={setPanelReady}
            />
          </section>
        )}

        <section className="kh-sheet__group" data-testid="inspect-visibility">
          <h3>Visibility</h3>
          <div className="kh-inspect__row">
            <button
              type="button"
              className="kh-tile"
              aria-pressed={layer.on}
              disabled={isBase}
              data-testid="inspect-on"
              onClick={() => {
                editor.setOn(layer.id, !layer.on);
              }}
            >
              <b>{layer.on ? 'On the panel' : 'Hidden'}</b>
              <small>A hidden layer costs nothing and keeps its settings.</small>
            </button>
            <button
              type="button"
              className="kh-tile"
              aria-pressed={locked}
              disabled={isBase}
              data-testid="inspect-lock"
              onClick={() => {
                editor.setLocked(layer.id, !locked);
              }}
            >
              <b>{locked ? 'Locked' : 'Unlocked'}</b>
              <small>A locked layer cannot be dragged on the canvas.</small>
            </button>
          </div>
        </section>

        {/*
          Advanced, and it is a real `<details>` — the same door the module
          panels use, so the keyboard and the screen reader treat it the same way
          here as they do one level down.
        */}
        <details className="kh-inspect__adv" data-testid="inspect-advanced">
          <summary>Advanced</summary>
          <p className="kh-hint">
            This layer is a <b>{module === null ? layer.kind : (module.chipName ?? module.name)}</b>
            {layer.name !== undefined && layer.name !== '' ? ` called “${layer.name}”` : ''}. Its
            settings travel with the look, so a Look you save or send carries them with it.
          </p>
        </details>
      </div>
    </section>
  );
}

/**
 * One number, labelled, tabular and clamped by the op rather than by the input.
 *
 * The `<input>`'s own `min`/`max` are advisory — a person can still paste
 * anything into it — so the value goes through `editor.transform` and comes back
 * clamped by `TRANSFORM_LIMITS`, which is the same clamp the drag obeys.
 */
function Num({
  id,
  label,
  value,
  min,
  max,
  step,
  unit,
  perUnit = 1,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  /** In the MODEL's units, always. The display conversion is `perUnit`. */
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  /**
   * How many display units one model unit is worth — round 10's M1.
   *
   * `1` for a quantity already in the reader's units (rotation is degrees on
   * both sides), `100` for a fraction shown as a percentage, `panel.width / 2`
   * for a position shown in pixels from the centre. `min`, `max` and `step` are
   * given in model units too and are converted alongside, so a caller states its
   * limits once, in the units the ops clamp in.
   */
  perUnit?: number;
  disabled: boolean;
  onChange: (next: number) => void;
}) {
  /*
   * A converted field is a WHOLE number: 48.832 px is not a position anybody
   * types, and the fraction is an artefact of the unit change rather than a
   * precision the reader asked for. An unconverted one keeps its own precision,
   * because that is the number the model holds.
   */
  const show = (v: number): number =>
    perUnit === 1 ? Math.round(v * 1000) / 1000 : Math.round(v * perUnit);
  const shownStep = perUnit === 1 ? step : 1;
  return (
    <label className="kh-num__field" htmlFor={`kh-inspect-${id}`}>
      <span className="kh-num__lab">
        {label}
        {unit !== undefined && <span aria-hidden="true"> {unit}</span>}
      </span>
      <input
        className="kh-op__text kh-tnum"
        id={`kh-inspect-${id}`}
        data-testid={`inspect-${id}`}
        type="number"
        inputMode="decimal"
        value={show(value)}
        min={show(min)}
        max={show(max)}
        step={shownStep}
        disabled={disabled}
        /*
          Back to model units before the write. The op clamps, so a paste of
          something wild is still refused by the same rule a drag obeys.
        */
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) onChange(next / perUnit);
        }}
      />
    </label>
  );
}

/**
 * The kind's `ConfigPanel`, resolved out of the same cache the options panel
 * reads (`configPanels.ts`) rather than through a second `lazy()`.
 *
 * Renders nothing for the one beat a cold chunk takes, for the reason round 3
 * recorded: a placeholder at the wrong height is the same pause with a lie drawn
 * over it.
 */
function KindPanel({
  id,
  config,
  ownsBytes,
  onChange,
  onReady,
}: {
  id: string;
  config: unknown;
  /** Passed straight through — see `ModuleConfigProps.ownsBytes`. */
  ownsBytes: boolean;
  onChange: (next: unknown) => void;
  /**
   * Told once the chunk is in and the panel has something to measure — F-7.
   *
   * The sheet scrolls to this section when the strip asked for it, and a
   * scroll to an empty box is a scroll to the wrong place.
   */
  onReady: (ready: boolean) => void;
}) {
  const [loaded, setLoaded] = useState<ComponentType<ModuleConfigProps> | null>(() =>
    readConfigPanel(id),
  );
  const [loadedFor, setLoadedFor] = useState(id);
  if (loadedFor !== id) {
    setLoadedFor(id);
    // Through a thunk: `setState(fn)` would CALL the component.
    setLoaded(() => readConfigPanel(id));
  }

  useEffect(() => {
    if (readConfigPanel(id) !== null) return undefined;
    let gone = false;
    const isGone = (): boolean => gone;
    void loadConfigPanel(id).then((found) => {
      if (!isGone() && found !== null) setLoaded(() => found);
    });
    return () => {
      gone = true;
    };
  }, [id]);

  useEffect(() => {
    onReady(loaded !== null);
  }, [loaded, onReady]);

  if (loaded === null) return null;
  const Panel = loaded;
  return <Panel config={config} ownsBytes={ownsBytes} onChange={onChange} />;
}
