/**
 * STEP 1 (docs/modules.md §3) — the Date layer's config, its defaults, and a
 * validator that cannot throw.
 *
 * Eager: the registry imports this so both pages can validate stored config
 * before anything renders. No DOM, no storage, no network.
 *
 * `size` is a fraction of the layer's own box, exactly as `text`'s is, never a
 * pixel count — a look composed on a 640 round Elite has to land identically on
 * a 240 square Kraken (design-layers-architecture.md §1.1).
 */

import { clamp, isFiniteNumber, isPlainObject } from '../../lib/clamp';

import { AUTO_LOCALE, DATE_FORMATS, type DateFormat } from './format';

/** The three weights `text` offers, for the same reason it offers three. */
const WEIGHT_REGULAR = 400;
const WEIGHT_MEDIUM = 600;
const WEIGHT_HEAVY = 800;

export type DateWeight = typeof WEIGHT_REGULAR | typeof WEIGHT_MEDIUM | typeof WEIGHT_HEAVY;
export const DATE_WEIGHTS: readonly DateWeight[] = [WEIGHT_REGULAR, WEIGHT_MEDIUM, WEIGHT_HEAVY];

export const SIZE_MIN = 0.05;
export const SIZE_MAX = 0.6;

/**
 * A BCP-47-ish tag, or `auto`.
 *
 * Deliberately permissive rather than a list: the set of locales a browser
 * knows is the browser's business, and `formatDate()` already falls back when
 * one cannot be built. What this pattern is for is keeping arbitrary strings
 * out of the config document — a tag is letters, digits and hyphens, and short.
 */
const LOCALE_RE = /^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$/i;
export const MAX_LOCALE_LEN = 20;

export interface DateConfig {
  format: DateFormat;
  /** `'auto'` (this machine's locale) or a language tag. */
  locale: string;
  /** Fraction of the layer's own box. See `display.ts` for the exact rule. */
  size: number;
  /** `#rrggbb`, lowercase. */
  color: string;
  weight: DateWeight;
  uppercase: boolean;
}

/** The same near-white the clock, the stats readout and the text layer default to. */
export const DEFAULT_DATE_COLOR = '#f2f4f8';

export const DATE_DEFAULTS: DateConfig = {
  format: 'weekday-day-month',
  locale: AUTO_LOCALE,
  size: 0.16,
  color: DEFAULT_DATE_COLOR,
  weight: 600,
  uppercase: false,
};

const HEX_SHORT_RE = /^#[0-9a-f]{3}$/;
const HEX_LONG_RE = /^#[0-9a-f]{6}$/;

/**
 * `#RGB` and `#RRGGBB`, case-insensitively, normalised to lowercase six digits —
 * normalising rather than merely accepting is what keeps `validate()`
 * idempotent.
 */
export function normalizeHex(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const s = raw.trim().toLowerCase();
  if (HEX_LONG_RE.test(s)) return s;
  if (HEX_SHORT_RE.test(s)) return s.replace(/[0-9a-f]/g, (c) => c + c);
  return fallback;
}

/** `auto`, or a plausible tag, lowercased so the validator is idempotent. */
export function normalizeLocale(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const s = raw.trim().toLowerCase();
  if (s === AUTO_LOCALE) return AUTO_LOCALE;
  return s.length <= MAX_LOCALE_LEN && LOCALE_RE.test(s) ? s : fallback;
}

function pick<T extends string | number>(raw: unknown, allowed: readonly T[], def: T): T {
  return (allowed as readonly unknown[]).includes(raw) ? (raw as T) : def;
}

function flag(raw: unknown, def: boolean): boolean {
  return typeof raw === 'boolean' ? raw : def;
}

function num(raw: unknown, min: number, max: number, def: number): number {
  return isFiniteNumber(raw) ? clamp(raw, min, max) : def;
}

/** Never throws: an invalid field falls back to its default. */
export function validateDate(raw: unknown): DateConfig {
  const o = isPlainObject(raw) ? raw : {};
  return {
    format: pick(o['format'], DATE_FORMATS, DATE_DEFAULTS.format),
    locale: normalizeLocale(o['locale'], DATE_DEFAULTS.locale),
    size: num(o['size'], SIZE_MIN, SIZE_MAX, DATE_DEFAULTS.size),
    color: normalizeHex(o['color'], DATE_DEFAULTS.color),
    weight: pick(o['weight'], DATE_WEIGHTS, DATE_DEFAULTS.weight),
    uppercase: flag(o['uppercase'], DATE_DEFAULTS.uppercase),
  };
}
