/**
 * The selection strip — "one selection, a few controls" (principle 3).
 *
 * Selecting a layer changes exactly one thing on the screen: this row. It shows
 * that KIND's three to five essential controls, fetched from the module by
 * `editor.loadStrip()` — one small chunk out of the module-editors bundle, on
 * first selection of a kind — and rendered here generically. `More` is always
 * last and always opens the inspector.
 *
 * The old `OpsStrip` this replaces was a chain of `if (activeId === 'clock')`
 * branches. It knew four modules by name, so the three that shipped after it —
 * text, shape, effect — had no strip at all and no way to get one without a
 * fifth branch in a view. Nothing here knows any module's name.
 *
 * The `data-testid`s are `ops-<control id>`, which is deliberately the same
 * shape the branch-based strip used: `ops-fill`, `ops-face`, `ops-format`,
 * `ops-seconds` and `ops-loop-button` are load-bearing in the e2e suite, and a
 * redesign that renamed them would be a redesign that hid whether it had
 * changed behaviour.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { BASE_LAYER_ID, type Layer } from '../../../../state/look/types';
import { RangeInput, Segmented } from '../../../../ui';
import { FitControl } from '../../../../ui/Framing';
import { signed, signedText } from '../../editor/signed';
import {
  stripValue,
  configWith,
  loadStripFor,
  loadedStrip,
  transformPatchOf,
} from '../../editor/strip';
import { LOCKED_REASON } from '../../editor/useEditor';

import type { StripAction, StripControl, StripOption } from '../../../../modules/types';
import type { RenderSettings } from '../../../../state/schema';
import type { ReactNode } from 'react';

export interface SelectionStripProps {
  layer: Layer;
  /** The layer's resolved config — the bank for the base, its own for an overlay. */
  config: unknown;
  /** Write a config. The caller decides which home it has (§4.1). */
  onConfig: (next: unknown) => void;
  /** Write a transform field. Refused on the base, whose `t` is IDENTITY. */
  onTransform: (patch: Record<string, number>) => void;
  /** Grow or shrink by a factor — the resize gesture, as two buttons (§3.2). */
  onResize: (factor: number) => void;
  onAction: (action: StripAction) => void;
  onMore: () => void;
  /** Whether the loop scrubber is open, for `aria-expanded` on its button. */
  loopOpen?: boolean;
}

/** One step of the size buttons. Roughly a tenth, which reads as a nudge. */
const SIZE_STEP = 1.1;

/**
 * The height a strip's tallest control occupies, reserved while a kind's
 * declaration is on its way.
 *
 * A strip is one line of labelled controls and the ROW measures 40 px in every
 * state §2.3 allows — `.kh-ops`'s own 6 px padding and 1 px rule account for
 * the difference, so what a placeholder has to reserve is the 26 px of content
 * inside it, not the 40. Reserving 40 measured the row at 54 and moved the
 * strip 14 px, which is the jump this exists to prevent; the number is checked
 * against the six base kinds rather than guessed.
 *
 * The load is one chunk of a few hundred bytes from the same origin, so on all
 * but the first selection of a kind this placeholder never renders at all.
 */
const STRIP_CONTENT_PX = 26;

/**
 * The kind's strip, loaded on first selection and cached on the contract.
 *
 * A kind already seen is already in that cache, so it renders synchronously
 * with no effect and no extra render.
 */
function useStrip(kind: string): readonly StripControl[] | null {
  const [, bump] = useState(0);
  const strip = loadedStrip(kind);

  useEffect(() => {
    if (strip !== undefined) return;
    let live = true;
    void loadStripFor(kind).then(
      () => {
        // The strip is on the contract now; re-render to read it.
        if (live) bump((n) => n + 1);
      },
      () => {
        // A chunk that will not load leaves the frame reserved and empty. The
        // canvas, the rail and every gesture still work: the strip is the one
        // thing on the screen that is a convenience.
      },
    );
    return () => {
      live = false;
    };
  }, [kind, strip]);

  return strip ?? null;
}

/**
 * Which end of the scrolling row is cut, as an attribute — round 11's F-3.
 *
 * The fade is a `mask-image` in `ui.css` and a mask is a static declaration, so
 * the one thing it cannot know is whether there is anything left to reveal. A
 * strip that fades its right edge with nothing beyond it is an affordance for a
 * gesture that does nothing, which is worse than no affordance at all — so the
 * attribute is measured from the element rather than assumed from the kind.
 *
 * Re-measured on scroll, on resize and whenever the strip's contents change
 * (the kind's declaration arrives one chunk late on first selection of a kind),
 * which is what the `ResizeObserver` on the row's own scroll box covers.
 */
type Clipped = 'none' | 'true' | 'start' | 'both';

function useScrollEdges(): {
  attach: (el: HTMLSpanElement | null) => void;
  clipped: Clipped;
  remeasure: () => void;
} {
  const node = useRef<HTMLSpanElement | null>(null);
  const [clipped, setClipped] = useState<Clipped>('none');

  const measure = useCallback((): void => {
    const el = node.current;
    if (el === null) return;
    // 1 px of slack: a fractional layout width must not read as "clipped".
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setClipped(left && right ? 'both' : left ? 'start' : right ? 'true' : 'none');
  }, []);

  const attach = useCallback(
    (el: HTMLSpanElement | null): void => {
      node.current = el;
      measure();
    },
    [measure],
  );

  useEffect(() => {
    const el = node.current;
    if (el === null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    return () => {
      observer.disconnect();
    };
  });

  return { attach, clipped, remeasure: measure };
}

export function SelectionStrip({
  layer,
  config,
  onConfig,
  onTransform,
  onResize,
  onAction,
  onMore,
  loopOpen = false,
}: SelectionStripProps) {
  const isBase = layer.id === BASE_LAYER_ID;
  const strip = useStrip(layer.kind);
  const { attach, clipped, remeasure } = useScrollEdges();

  /*
   * The frame, before the controls.
   *
   * Not a spinner and not a "More"-only strip: a spinner for 300 bytes is a
   * lie about how long this takes, and a lone `More` that re-flowed into four
   * controls a frame later would be the layout jump this reserves height to
   * avoid. An empty row of the right height, for one paint, reads as nothing
   * at all.
   */
  if (strip === null) {
    /*
     * A zero-WIDTH spacer, deliberately: the row is a centred flex line, so a
     * placeholder with width would shift nothing vertically and everything
     * horizontally. It also carries no `kh-op` class — that class's own padding
     * measured the row at 54 px against the loaded strip's 40, which is the
     * 14 px jump this exists to prevent.
     */
    return (
      <span
        data-testid="ops-loading"
        aria-hidden="true"
        style={{ display: 'block', width: 0, height: `${String(STRIP_CONTENT_PX)}px` }}
      />
    );
  }

  const locked = layer.locked === true;

  /*
   * `More` is PINNED, and everything else scrolls past it — round 11's F-3.
   *
   * The strip is one row that scrolls sideways when a kind declares more than
   * fits (M5, `.kh-ops__scroll` in `ui.css`). `More` was the last control INSIDE
   * that row, so on the two kinds whose declarations are longest it was simply
   * off the screen with nothing to say so: measured at 866x537, the strip's box
   * is 542 px wide and Stats' content is 975 and Text's 958, which put
   * `ops-more` at x = 957 and x = 940 — past the right edge of a 866 px window,
   * with the row cut mid-control on seven of the eight overlay kinds.
   *
   * The door to the inspector is not an overflow item: it is the answer to
   * "where is everything else", which is exactly the question a clipped row
   * provokes. So it leaves the scroller and sits at the row's right edge, in
   * every state, for every kind — and the scroller gets an edge fade so the
   * clipping it does is legible rather than a control that happens to end.
   *
   * Split here rather than in the two views that render this component, because
   * the phone's home screen and the remote editor mount the same strip and a
   * second copy of the arrangement is a second thing to keep in step.
   */
  const controls = strip.filter((c) => c.control !== 'more');
  const more = strip.find((c) => c.control === 'more');

  return (
    <>
      <span
        ref={attach}
        className="kh-ops__scroll"
        data-testid="ops-scroll"
        data-clipped={clipped}
        onScroll={remeasure}
        /*
          A wheel with no horizontal axis still moves the row.

          A trackpad already sends `deltaX` and a horizontal `overflow` box
          already consumes it; a MOUSE wheel sends only `deltaY`, and over a row
          that is the only scrollable thing on the screen that was a gesture
          with no effect at all. Mapped here rather than in CSS because it is a
          behaviour, and guarded so it is never a hijack: the event is consumed
          only while the row can actually move the way the wheel is pointing, so
          at either end the page gets the scroll back.

          The keyboard needs nothing added: every control in this row is a tab
          stop, and focusing one inside an overflow box scrolls it into view.
          That is a better contract than a tab stop on the box itself, which is
          why there is no `tabindex` here.
        */
        onWheel={(e) => {
          const el = e.currentTarget;
          if (e.deltaX !== 0 || e.deltaY === 0) return;
          const max = el.scrollWidth - el.clientWidth;
          if (max <= 0) return;
          const next = Math.max(0, Math.min(max, el.scrollLeft + e.deltaY));
          if (next === el.scrollLeft) return;
          el.scrollLeft = next;
          remeasure();
        }}
      >
        {controls.map((control) => (
          <Control
            key={control.id}
            control={control}
            layer={layer}
            config={config}
            isBase={isBase}
            locked={locked}
            onConfig={onConfig}
            onTransform={onTransform}
            onResize={onResize}
            onAction={onAction}
            onMore={onMore}
            loopOpen={loopOpen}
          />
        ))}
        {/*
        Why those controls are grey — round 10's M5.

        A locked layer stays SELECTABLE from the rail (selection is not a
        transform, and refusing it would put the layer's own inspector out of
        reach behind its own lock), so the strip is reachable with every
        `'layer'` control on it disabled. Disabled and unexplained is the same
        silence the layer cap had: the sentence is the one `useEditor` already
        gives a refused gesture, said before the gesture rather than after it.
      */}
        {locked && !isBase && (
          <span className="kh-op kh-op--why" data-testid="ops-lock-reason" role="status">
            <span className="kh-op__lab">{LOCKED_REASON}</span>
          </span>
        )}
      </span>
      {more !== undefined && (
        <Control
          control={more}
          layer={layer}
          config={config}
          isBase={isBase}
          locked={locked}
          onConfig={onConfig}
          onTransform={onTransform}
          onResize={onResize}
          onAction={onAction}
          onMore={onMore}
          loopOpen={loopOpen}
        />
      )}
    </>
  );
}

function Op({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <span className="kh-op" data-testid={testId}>
      <span className="kh-op__lab">{label}</span>
      {children}
    </span>
  );
}

function Control({
  control,
  layer,
  config,
  isBase,
  locked,
  onConfig,
  onTransform,
  onResize,
  onAction,
  onMore,
  loopOpen,
}: {
  control: StripControl;
  layer: Layer;
  config: unknown;
  isBase: boolean;
  /** A locked layer's `'layer'` controls are shown and disabled (§2.2, M3). */
  locked: boolean;
} & Pick<SelectionStripProps, 'onConfig' | 'onTransform' | 'onResize' | 'onAction' | 'onMore'> & {
    loopOpen: boolean;
  }) {
  const testId = `ops-${control.id}`;
  const id = `ed-${layer.id}-${control.id}`;
  const value = stripValue(control, layer, config);

  if (control.control === 'more') {
    /*
     * ONE `ops-more` in the DOM, and it is the button (F5).
     *
     * The wrapper carried `data-testid={testId}` — which for this control IS
     * `ops-more` — so every strip in every state shipped the id twice, and the
     * repo's own e2e failed Playwright's strict mode on `getByTestId('ops-more')`
     * before it could press anything. The wrapper keeps a class and loses the id:
     * the id belongs to the thing you click.
     */
    return (
      <span className="kh-op kh-op--pin">
        <button type="button" className="kh-op__btn" data-testid="ops-more" onClick={onMore}>
          <span className="kh-op__lab">{control.label}</span>
        </button>
      </span>
    );
  }

  if (control.control === 'action') {
    /*
     * Loop keeps the identity the branch-based strip gave it — a button with
     * `aria-expanded` over the A/B scrubber that opens under the strip — because
     * that pair is what four e2e specs press.
     */
    const isLoop = control.action === 'loop';
    return (
      <span className="kh-op" data-testid={testId}>
        <button
          type="button"
          className="kh-op__btn"
          data-testid={isLoop ? 'ops-loop-button' : `${testId}-button`}
          {...(isLoop ? { 'aria-expanded': loopOpen, 'aria-controls': 'ops-loop-panel' } : {})}
          onClick={() => {
            onAction(control.action);
          }}
        >
          <span className="kh-op__lab">{control.label}</span>
        </button>
      </span>
    );
  }

  if (control.control === 'size') {
    return (
      <Op label={control.label} testId={testId}>
        <span className="kh-op__pair">
          <button
            type="button"
            className="kh-op__step"
            aria-label={`${control.label} smaller`}
            data-testid={`${testId}-down`}
            disabled={isBase || locked}
            onClick={() => {
              onResize(1 / SIZE_STEP);
            }}
          >
            −
          </button>
          <button
            type="button"
            className="kh-op__step"
            aria-label={`${control.label} bigger`}
            data-testid={`${testId}-up`}
            disabled={isBase || locked}
            onClick={() => {
              onResize(SIZE_STEP);
            }}
          >
            +
          </button>
        </span>
      </Op>
    );
  }

  const writeCfg = (next: string | number | boolean): void => {
    const cfg = configWith(control, config, next);
    if (cfg !== null) onConfig(cfg);
    const patch = transformPatchOf(control, next);
    if (patch !== null) onTransform(patch);
  };

  /*
   * A `'layer'` control on the BASE is shown and disabled, never hidden.
   *
   * A picture used as the background genuinely has no opacity to set — the base
   * wears `IDENTITY` by definition — and a control that quietly vanished would
   * make the strip a different shape for the same kind depending on where it
   * sits, which is the one thing a strip must not be.
   */
  const disabled = control.target === 'layer' && (isBase || locked);

  if (control.control === 'fit') {
    return (
      <Op label={control.label} testId={testId}>
        <FitControl
          id={id}
          ariaLabel={control.label}
          value={(typeof value === 'string' ? value : 'cover') as RenderSettings['fit']}
          onChange={writeCfg}
        />
      </Op>
    );
  }

  if (control.control === 'segmented') {
    /*
     * A long choice SCROLLS on the strip; it does not wrap (M5).
     *
     * Stats' Face and Text's Font declare seven and six options, and `wrap`
     * turned each of them into a four-row block: the Stats strip measured
     * 131 px and Text 108, against §2.3's one row. That matters more since the
     * strip started floating over the canvas — a 131 px strip covers the bottom
     * third of the halo it is supposed to be a caption for. So the row keeps
     * its one line and takes a horizontal scroller when it is longer than the
     * strip is wide, which is the same shape the shelf uses elsewhere.
     */
    const long = control.options.length > 4;
    const seg = (
      <Segmented
        id={id}
        ariaLabel={control.label}
        value={typeof value === 'string' ? value : (control.options[0]?.value ?? '')}
        options={control.options}
        onChange={writeCfg}
      />
    );
    return (
      <Op label={control.label} testId={testId}>
        {long ? (
          <span className="kh-op__scroll" data-testid={`${testId}-scroll`}>
            {seg}
          </span>
        ) : (
          seg
        )}
      </Op>
    );
  }

  if (control.control === 'toggle') {
    // One shape for a boolean, everywhere on this screen (round 2's R8).
    return (
      <Op label={control.label} testId={testId}>
        <Segmented
          id={id}
          ariaLabel={control.label}
          value={value === true ? 'on' : 'off'}
          options={[
            { value: 'on', label: 'On' },
            { value: 'off', label: 'Off' },
          ]}
          onChange={(next) => {
            writeCfg(next === 'on');
          }}
        />
      </Op>
    );
  }

  if (control.control === 'swatches') {
    return (
      <Op label={control.label} testId={testId}>
        <Swatches
          id={id}
          label={control.label}
          options={control.options}
          value={typeof value === 'string' ? value : ''}
          onChange={writeCfg}
        />
      </Op>
    );
  }

  if (control.control === 'range') {
    const numeric = typeof value === 'number' ? value : control.min;
    return (
      <Op label={control.label} testId={testId}>
        <RangeInput
          id={id}
          value={numeric}
          min={control.min}
          max={control.max}
          step={control.step}
          disabled={disabled}
          title={control.label}
          onChange={writeCfg}
        />
        {/*
          A real minus in the readout, an ASCII one in the field — M-f. The
          value is set in tabular figures beside a stepper whose own button is
          U+2212, and a hyphen among them is the wrong glyph twice over.
        */}
        <b className="kh-op__val kh-tnum">
          {control.format === 'percent'
            ? `${signed(Math.round(numeric * 100))}%`
            : signedText(numeric.toFixed(2))}
        </b>
      </Op>
    );
  }

  return (
    <Op label={control.label} testId={testId}>
      <input
        className="kh-op__text"
        id={id}
        type="text"
        aria-label={control.label}
        maxLength={control.max ?? 200}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => {
          writeCfg(e.target.value);
        }}
      />
    </Op>
  );
}

/**
 * A colour choice, shown as colour.
 *
 * A `radiogroup` rather than five buttons, so the whole row is one tab stop and
 * arrows move inside it — the same keyboard contract `Segmented` makes, because
 * this IS a segmented control whose labels happen to be swatches.
 */
function Swatches({
  id,
  label,
  options,
  value,
  onChange,
}: {
  id: string;
  label: string;
  options: readonly StripOption[];
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="kh-swatches" id={id} role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          className="kh-swatch"
          aria-checked={option.value === value}
          aria-label={option.label}
          tabIndex={option.value === value ? 0 : -1}
          title={option.title ?? option.label}
          data-testid={`${id}-${option.value}`}
          style={{ '--kh-swatch': option.swatch ?? option.value } as React.CSSProperties}
          onClick={() => {
            onChange(option.value);
          }}
        >
          <span aria-hidden="true" className="kh-swatch__dot" />
        </button>
      ))}
    </div>
  );
}
