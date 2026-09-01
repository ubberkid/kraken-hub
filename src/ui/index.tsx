/**
 * Config-only component vocabulary.
 *
 * Invariant I8: display code must never import from here — the ESLint zone and
 * the bundle-graph check both enforce it. Everything in this file assumes a
 * mouse, a keyboard and a real browser window.
 */

import type { ReactNode } from 'react';

import './ui.css';

export function Panel({
  title,
  hint,
  children,
}: {
  /**
   * Optional, for the panels that are already named by the thing that opened
   * them.
   *
   * A module's options open inside the home screen's contextual panel, whose
   * own head carries the module's name — so the panel underneath printing
   * "Video" directly below a heading that says "Video" was a heading tax on the
   * one composition that has 537 px to spend.
   */
  title?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="kh-panel">
      {title !== undefined && <h2>{title}</h2>}
      {hint !== undefined && <p className="kh-hint">{hint}</p>}
      {children}
    </section>
  );
}

/**
 * A module's options panel — and the reason a door never opens onto an empty room.
 *
 * Round 3's F5: three of the four module panels opened to a **signpost sentence**
 * ("Face, hours and seconds are on the strip above") and a closed `Advanced`
 * disclosure. The user had made a deliberate second gesture — tapping the chip
 * that was already active — and been answered with a paragraph explaining that
 * the thing they wanted was somewhere else, plus another door to press. The
 * Stats panel had literally nothing else in it.
 *
 * Fixing the three panels would have been round 3 fixing three symptoms. The
 * class is *a panel whose entire content is a door*, and it is unrepresentable
 * here: this component is how every module builds its options, and when
 * `primary` is empty the door is **already open** on arrival. One tap, the
 * controls.
 *
 * ## Round 4's F2: depth is a property of the CONTROL, not of the moment
 *
 * Round 3 implemented that rule by *relocating* the advanced controls — with no
 * primary, the panel rendered `advanced` directly and the Advanced door was not
 * drawn at all. Which meant Stats' **Colour** row moved between two levels of
 * the hierarchy depending on the Layout segment: on One it sat behind Advanced,
 * on Two or All it sat at the top of the panel. Toggling Layout — a control on
 * the ops strip, about something else entirely — silently restructured the
 * panel underneath it. A user who learned where Colour lives learned something
 * that was not true.
 *
 * Depth is a property of the control. Colour is an advanced control on Clock and
 * on Stats, in every layout, forever. What the empty-room rule may change is
 * whether the door is OPEN, which is a statement about this moment rather than
 * about the hierarchy: nothing above it means there is nothing to choose between
 * looking at, so it opens showing what there is. The control does not move, its
 * heading does not move, and the summary row stays exactly where it was.
 *
 * `primary` is a render-time value rather than a static flag on the module
 * definition on purpose: Stats' one primary control exists only for the
 * single-dial layout, so whether that module has a room to open is a question
 * about the CONFIG, not about the module.
 *
 * There is no `hint` slot. A panel that has to explain itself is the signpost
 * again with better manners.
 */
export function ModuleOptions({
  primary,
  advanced,
  advancedTestId,
}: {
  /** The controls worth the panel. `null` when this config has none. */
  primary: ReactNode;
  /** Everything behind the one Advanced door. Always behind it. */
  advanced: ReactNode;
  advancedTestId?: string;
}) {
  const noRoom = primary === null || primary === false || primary === undefined;
  return (
    <>
      {/* No empty panel above an open door — but the door itself never moves. */}
      {!noRoom && <Panel>{primary}</Panel>}
      {/* ONE door, one level — the same rule, and the same level, for every module. */}
      <Disclosure
        summary="Advanced"
        defaultOpen={noRoom}
        {...(advancedTestId === undefined ? {} : { testId: advancedTestId })}
      >
        {advanced}
      </Disclosure>
    </>
  );
}

export function Field({
  label,
  htmlFor,
  description,
  children,
}: {
  label: string;
  htmlFor: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="kh-field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {description !== undefined && <p className="kh-desc">{description}</p>}
    </div>
  );
}

/**
 * `Field`, for a control that is not a single labelable element.
 *
 * A `<label for>` may only point at a form control, so a radiogroup — which is
 * a `<div>` with buttons inside — needs its name carried by `aria-labelledby`
 * instead. Same visual row, same description slot; the only difference is which
 * accessibility mechanism names the thing.
 */
export function GroupField({
  label,
  id,
  description,
  children,
}: {
  label: string;
  /** The id of the group being named. `${id}-label` names the caption. */
  id: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="kh-field">
      <span className="kh-field__lab" id={`${id}-label`}>
        {label}
      </span>
      {children}
      {description !== undefined && <p className="kh-desc">{description}</p>}
    </div>
  );
}

/**
 * A segmented control — the shape a short, exclusive choice actually has.
 *
 * The design audit's F9 counted **171 words living inside `<option>` elements**:
 * a `<select>` whose choices are sentences is a control that has given up on
 * being understood at a glance. Every one of those choices was between two,
 * three or four things, which is exactly what a segment row is for — all the
 * options visible at once, one press to change, no popup, no reading.
 *
 * `role="radio"` on `<button>`s rather than real radio inputs: the pressed
 * state has to be styled as a filled segment, and a radio group's roving
 * tabindex (one tab stop for the group, arrows to move within it) is the
 * behaviour a segmented control should have anyway.
 */
export function Segmented({
  id,
  value,
  options,
  onChange,
  labelledBy,
  ariaLabel,
  wrap,
}: {
  id: string;
  value: string;
  options: readonly { value: string; label: string; title?: string }[];
  onChange: (next: string) => void;
  /** Usually `${id}-label`, from the `GroupField` wrapping this. */
  labelledBy?: string | undefined;
  ariaLabel?: string | undefined;
  /**
   * Allow the row to run onto a second line.
   *
   * For the handful of choices that are genuinely longer than two or three —
   * the five palettes, the quality ladder, the seven readings — where the
   * alternative is a `<select>` and the round-2 audit's rule is that there
   * isn't one on this surface any more.
   */
  wrap?: boolean;
}) {
  const move = (delta: number): void => {
    const at = options.findIndex((o) => o.value === value);
    const from = at === -1 ? 0 : at;
    const next = options[(from + delta + options.length) % options.length];
    if (next !== undefined) onChange(next.value);
  };

  return (
    <div
      className={wrap === true ? 'kh-seg kh-seg--wrap' : 'kh-seg'}
      id={id}
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-label={ariaLabel}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          className="kh-seg__opt"
          aria-checked={o.value === value}
          // Roving tabindex: the group is one tab stop, arrows move inside it.
          tabIndex={o.value === value ? 0 : -1}
          title={o.title ?? ''}
          data-testid={`${id}-${o.value}`}
          onClick={() => {
            onChange(o.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
              e.preventDefault();
              move(1);
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
              e.preventDefault();
              move(-1);
            }
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function TextInput({
  id,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  value: string;
  placeholder?: string;
  onChange: (next: string) => void;
}) {
  return (
    <input
      className="kh-input"
      id={id}
      type="text"
      value={value}
      placeholder={placeholder ?? ''}
      onChange={(e) => {
        onChange(e.target.value);
      }}
    />
  );
}

/*
 * `Select` and `Toggle` used to live here.
 *
 * Wave A took the native `<select>`s and checkboxes off the home screen and out
 * of every module's options; round 2's R8 finished the job on the two surfaces
 * that still had them — the Connection section's transport picker and its three
 * checkboxes, and the remote's Showing / Fit / Quality pickers. There is now no
 * native picker component in the vocabulary at all, which is the only version
 * of that rule a codebase can actually keep: you cannot reach for what is not
 * there. Short exclusive choices are `Segmented`; booleans are `Switch`.
 */

/**
 * The house boolean — ONE of them, used everywhere a yes/no is asked.
 *
 * The round-2 audit's control-idiom finding: the home screen's ops strip drew
 * `Seconds [On|Off]` as a segmented control while the panel two inches below it
 * drew the same setting as a bare browser checkbox, and a third surface drew it
 * as a sentence. A product with three shapes for one idea is a product a person
 * has to re-learn on every screen.
 *
 * It is `Segmented` rather than a hand-rolled switch on purpose: the two states
 * are both *named*, both visible, and both one press away, which is what makes a
 * boolean legible at a glance on a screen you are only glancing at.
 */
export function Switch({
  id,
  checked,
  onChange,
  labelledBy,
  ariaLabel,
  onLabel,
  offLabel,
}: {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  labelledBy?: string | undefined;
  ariaLabel?: string | undefined;
  /** For the rare boolean whose two states have better names than On/Off. */
  onLabel?: string;
  offLabel?: string;
}) {
  return (
    <Segmented
      id={id}
      value={checked ? 'on' : 'off'}
      labelledBy={labelledBy}
      ariaLabel={ariaLabel}
      options={[
        { value: 'on', label: onLabel ?? 'On' },
        { value: 'off', label: offLabel ?? 'Off' },
      ]}
      onChange={(next) => {
        onChange(next === 'on');
      }}
    />
  );
}

export function Button({
  children,
  onClick,
  primary,
  title,
  disabled,
  testId,
}: {
  children: ReactNode;
  onClick: () => void;
  primary?: boolean;
  title?: string;
  /**
   * A disabled control still needs a `title`: the remote's volume buttons are
   * disabled because webview audio routing is unverified on hardware (H08), and
   * a greyed-out button with no explanation reads as a bug.
   */
  disabled?: boolean;
  /** A stable `data-testid`, so a suite never has to match on user-facing copy. */
  testId?: string;
}) {
  return (
    <button
      type="button"
      className={primary === true ? 'kh-btn kh-btn--primary' : 'kh-btn'}
      title={title ?? ''}
      disabled={disabled === true}
      data-testid={testId}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * The house disclosure: a `<details>` with the app's own frame.
 *
 * "Disclosure over density" is one of the four principles the approved design
 * names, and this is the shape it takes everywhere below the primary controls —
 * the remote's diagnostics pull, the transport detail, the technical half of
 * every module panel. `<details>` rather than a state hook on purpose: it is
 * open/closed in the DOM, so it is keyboard-operable, findable by the browser's
 * own in-page search, and correct before any JavaScript has run.
 */
export function Disclosure({
  summary,
  children,
  testId,
  defaultOpen,
}: {
  summary: string;
  children: ReactNode;
  testId?: string;
  defaultOpen?: boolean;
}) {
  return (
    <details className="kh-details" data-testid={testId} open={defaultOpen === true}>
      <summary className="kh-details__summary">{summary}</summary>
      <div className="kh-details__body">{children}</div>
    </details>
  );
}

export function Chip({
  tone,
  children,
  testId,
}: {
  tone: 'ok' | 'warn' | 'neutral';
  children: ReactNode;
  /** For the rare chip a suite has to address directly rather than by class. */
  testId?: string;
}) {
  const cls = tone === 'neutral' ? 'kh-chip' : `kh-chip kh-chip--${tone}`;
  return (
    <span className={cls} data-testid={testId}>
      {children}
    </span>
  );
}

/**
 * `inline` is not decoration: the block form is `display: block`, so a snippet
 * dropped mid-sentence (`?diag=1`, `-an`) breaks the paragraph in half and reads
 * as a code listing. Blocks for URLs and JSON, inline for anything inside prose.
 */
export function Code({ children, inline }: { children: ReactNode; inline?: boolean }) {
  return (
    <code className={inline === true ? 'kh-code kh-code--inline' : 'kh-code'}>{children}</code>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <div className="kh-row">{children}</div>;
}

export function NumberInput({
  id,
  value,
  min,
  max,
  step,
  onChange,
}: {
  id: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (next: number) => void;
}) {
  return (
    <input
      className="kh-input"
      id={id}
      type="number"
      value={String(value)}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        const next = Number(e.target.value);
        if (Number.isFinite(next)) onChange(next);
      }}
    />
  );
}

export function RangeInput({
  id,
  value,
  min,
  max,
  step,
  onChange,
  disabled,
  title,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (next: number) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <input
      className="kh-range"
      id={id}
      type="range"
      value={String(value)}
      min={min}
      max={max}
      step={step}
      disabled={disabled === true}
      title={title ?? ''}
      onChange={(e) => {
        onChange(Number(e.target.value));
      }}
    />
  );
}

/** Inline validation line. `tone` mirrors the `Severity` model of routing/validate.ts. */
export function Notice({ tone, children }: { tone: 'error' | 'warn' | 'ok'; children: ReactNode }) {
  return (
    <p className={`kh-notice kh-notice--${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      {children}
    </p>
  );
}

/** Quota / download progress bar. `pct` is 0..100; `null` renders indeterminate. */
/**
 * A progress bar, with the number beside it or folded into the caller's own
 * prose.
 *
 * `label` is optional because the home screen's download story reads
 * "Downloading locally — 40%" in the step's own sentence, exactly as the
 * prototype writes it; repeating the percentage at the end of the bar would say
 * the same thing twice and shorten the bar to make room for the echo.
 */
export function Meter({ pct, label }: { pct: number | null; label?: string }) {
  return (
    <div className="kh-meter">
      <div className="kh-meter__track">
        <div className="kh-meter__fill" style={{ width: `${String(pct ?? 100)}%` }} />
      </div>
      {label !== undefined && <span className="kh-meter__label">{label}</span>}
    </div>
  );
}
