/**
 * STEP 1 (docs/modules.md §3) — the config type, its defaults, and a validator
 * that cannot throw.
 *
 * Eager: the registry imports this so both pages can validate stored state and
 * parse URL parameters before anything renders. No DOM, no storage, no `Date`.
 */

import { isPlainObject } from '../../lib/clamp';

export type ClockFace = 'digital' | 'analog';
export type ClockHourFormat = '12' | '24';
/**
 * Named themes rather than a free-form colour.
 *
 * The LCD has no colour picker and no preview at arm's length; a short list of
 * palettes that are all legible after CAM's frame compression is worth more
 * than an input that lets someone pick #111 on black. Each theme is a flat
 * foreground plus a dim accent — no gradients, per the low-entropy rule.
 */
export type ClockTheme = 'mono' | 'amber' | 'cyan' | 'lime' | 'magenta';

export const CLOCK_FACES: readonly ClockFace[] = ['digital', 'analog'];
export const CLOCK_HOUR_FORMATS: readonly ClockHourFormat[] = ['12', '24'];
export const CLOCK_THEMES: readonly ClockTheme[] = ['mono', 'amber', 'cyan', 'lime', 'magenta'];

export interface ClockConfig {
  face: ClockFace;
  hourFormat: ClockHourFormat;
  showSeconds: boolean;
  showDate: boolean;
  theme: ClockTheme;
}

export const CLOCK_DEFAULTS: ClockConfig = {
  face: 'digital',
  hourFormat: '24',
  showSeconds: true,
  showDate: false,
  // `mono` is `#f2f4f8`, which is exactly what `clock-lite` painted by default,
  // so a user migrated forward from M0 sees the same clock they had.
  theme: 'mono',
};

function pick<T extends string>(raw: unknown, allowed: readonly T[], def: T): T {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : def;
}

function flag(raw: unknown, def: boolean): boolean {
  return typeof raw === 'boolean' ? raw : def;
}

/** Never throws: an invalid field falls back to its default. */
export function validateClock(raw: unknown): ClockConfig {
  const o = isPlainObject(raw) ? raw : {};
  return {
    face: pick(o['face'], CLOCK_FACES, CLOCK_DEFAULTS.face),
    hourFormat: pick(o['hourFormat'], CLOCK_HOUR_FORMATS, CLOCK_DEFAULTS.hourFormat),
    showSeconds: flag(o['showSeconds'], CLOCK_DEFAULTS.showSeconds),
    showDate: flag(o['showDate'], CLOCK_DEFAULTS.showDate),
    theme: pick(o['theme'], CLOCK_THEMES, CLOCK_DEFAULTS.theme),
  };
}

export interface ClockPalette {
  /** The digits, and the hour/minute hands. */
  fg: string;
  /** The date line, the tick ring, and the second hand. */
  dim: string;
}

/**
 * Flat colours only. A gradient would change every pixel of the face on every
 * repaint, which is precisely what the Elite's frame compressor charges for.
 */
export const CLOCK_PALETTES: Readonly<Record<ClockTheme, ClockPalette>> = {
  mono: { fg: '#f2f4f8', dim: '#7c8798' },
  amber: { fg: '#ffb648', dim: '#8a6222' },
  cyan: { fg: '#5ad8ff', dim: '#2b6d84' },
  lime: { fg: '#8ef07a', dim: '#487a3f' },
  magenta: { fg: '#ff7ad9', dim: '#8a4275' },
};
