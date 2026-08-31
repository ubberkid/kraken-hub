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
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="kh-panel">
      <h2>{title}</h2>
      {hint !== undefined && <p className="kh-hint">{hint}</p>}
      {children}
    </section>
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

export function Select({
  id,
  value,
  options,
  onChange,
}: {
  id: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (next: string) => void;
}) {
  return (
    <select
      className="kh-select"
      id={id}
      value={value}
      onChange={(e) => {
        onChange(e.target.value);
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Toggle({
  id,
  checked,
  onChange,
}: {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <input
      id={id}
      type="checkbox"
      checked={checked}
      onChange={(e) => {
        onChange(e.target.checked);
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
}) {
  return (
    <button
      type="button"
      className={primary === true ? 'kh-btn kh-btn--primary' : 'kh-btn'}
      title={title ?? ''}
      disabled={disabled === true}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function Chip({ tone, children }: { tone: 'ok' | 'warn' | 'neutral'; children: ReactNode }) {
  const cls = tone === 'neutral' ? 'kh-chip' : `kh-chip kh-chip--${tone}`;
  return <span className={cls}>{children}</span>;
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="kh-code">{children}</code>;
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
export function Meter({ pct, label }: { pct: number | null; label: string }) {
  return (
    <div className="kh-meter">
      <div className="kh-meter__track">
        <div className="kh-meter__fill" style={{ width: `${String(pct ?? 100)}%` }} />
      </div>
      <span className="kh-meter__label">{label}</span>
    </div>
  );
}
