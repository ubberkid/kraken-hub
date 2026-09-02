/**
 * STEP 1 (docs/modules.md §3) — the Text layer's config, its defaults, and a
 * validator that cannot throw.
 *
 * Eager: the registry imports this so both pages can validate stored config
 * before anything renders. No DOM, no storage, no network — the font *loader*
 * is a separate file (`fonts.ts`) that only the display chunk pulls in.
 *
 * ## The size unit, and why it is not pixels
 *
 * `size` is a fraction of the layer's own box, not of the panel and not a pixel
 * count. A look composed on a 640 round Elite has to land identically on a 240
 * square Kraken, so nothing geometric in a layer is ever written down in pixels
 * (docs/design/design-layers-architecture.md §1.1). `display.ts` turns it into
 * a font size against the box it measures; the exact rule is documented there
 * and tested at three host sizes.
 */

import { clamp, isFiniteNumber, isPlainObject } from '../../lib/clamp';

/**
 * The type weights the panel offers.
 *
 * Three, not nine: the LCD is read at arm's length through CAM's frame
 * compressor, where the difference between 400 and 500 is a rendering artefact
 * rather than a decision. Regular, semibold and heavy are the three that read
 * differently on a panel.
 */
const WEIGHT_REGULAR = 400;
const WEIGHT_MEDIUM = 600;
const WEIGHT_HEAVY = 800;

export type TextWeight = typeof WEIGHT_REGULAR | typeof WEIGHT_MEDIUM | typeof WEIGHT_HEAVY;
export const TEXT_WEIGHTS: readonly TextWeight[] = [WEIGHT_REGULAR, WEIGHT_MEDIUM, WEIGHT_HEAVY];

export type TextAlign = 'left' | 'center' | 'right';
export const TEXT_ALIGNS: readonly TextAlign[] = ['left', 'center', 'right'];

/**
 * The system face plus the six curated ones (design-editor-ux.md §10).
 *
 * The ids are ROLES, not family names — `serif`, not `playfair`. A face can be
 * swapped for a better-licensed or better-hinted one without rewriting every
 * stored config and every synced look, which is exactly what would happen if
 * the wire carried the family name.
 */
export type TextFontId =
  'system' | 'display' | 'serif' | 'mono' | 'rounded' | 'condensed' | 'script';

export const TEXT_FONTS: readonly TextFontId[] = [
  'system',
  'display',
  'serif',
  'mono',
  'rounded',
  'condensed',
  'script',
];

/** The six that need a stylesheet before they can render. `system` never does. */
export const CURATED_FONTS: readonly Exclude<TextFontId, 'system'>[] = [
  'display',
  'serif',
  'mono',
  'rounded',
  'condensed',
  'script',
];

export interface TextFace {
  /** What the panel calls it. */
  readonly label: string;
  /**
   * The full `font-family` value, curated family FIRST and a real fallback
   * stack behind it.
   *
   * The fallback is not decoration. A curated face is fetched lazily and may
   * never arrive — no network in CAM, a stylesheet that 404s, a user who
   * switched fonts a frame before the panel painted — and in every one of those
   * cases the layer still has to render legible text of roughly the right
   * character. Each stack names widely-installed faces of the same voice.
   */
  readonly stack: string;
}

const SYSTEM_STACK = "system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";

/**
 * The seven faces, as CSS.
 *
 * The six curated families are the ones `fonts.ts` fetches a stylesheet for.
 * They are named here rather than in the loader because the PANEL needs the
 * labels and the DISPLAY needs the stacks, and the panel must not import
 * display-chunk code (docs/modules.md §6).
 */
export const TEXT_FACES: Readonly<Record<TextFontId, TextFace>> = {
  system: { label: 'System', stack: SYSTEM_STACK },
  display: { label: 'Display', stack: `Anton, Impact, 'Arial Narrow Bold', ${SYSTEM_STACK}` },
  serif: { label: 'Serif', stack: "'Playfair Display', Georgia, 'Times New Roman', serif" },
  mono: {
    label: 'Mono',
    stack: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  },
  rounded: { label: 'Rounded', stack: `Quicksand, 'Trebuchet MS', Verdana, ${SYSTEM_STACK}` },
  condensed: { label: 'Condensed', stack: `Oswald, 'Arial Narrow', ${SYSTEM_STACK}` },
  script: { label: 'Script', stack: "Pacifico, 'Segoe Script', 'Brush Script MT', cursive" },
};

/**
 * Long enough for a gamer tag, a rig name or a short line of encouragement;
 * short enough that a look stays inside `MAX_LOOK_BYTES` with eight of them.
 */
export const MAX_TEXT_LEN = 200;

export const SIZE_MIN = 0.05;
export const SIZE_MAX = 0.6;
export const TRACKING_MIN = -0.05;
export const TRACKING_MAX = 0.3;

export interface TextConfig {
  /** ≤ `MAX_TEXT_LEN` characters. */
  text: string;
  /** Fraction of the layer's own box. See `display.ts` for the exact rule. */
  size: number;
  weight: TextWeight;
  font: TextFontId;
  /** `#rrggbb`, lowercase. */
  color: string;
  align: TextAlign;
  /** Letter spacing in `em`, so it tracks the size. */
  letterSpacing: number;
  uppercase: boolean;
  /** One flat drop shadow, for text over a busy video base. */
  shadow: boolean;
}

/** The same near-white the clock and the stats readout default to. */
export const DEFAULT_TEXT_COLOR = '#f2f4f8';

export const TEXT_DEFAULTS: TextConfig = {
  text: 'Hello',
  size: 0.14,
  weight: 600,
  font: 'system',
  color: DEFAULT_TEXT_COLOR,
  align: 'center',
  letterSpacing: 0,
  uppercase: false,
  shadow: false,
};

const HEX_SHORT_RE = /^#[0-9a-f]{3}$/;
const HEX_LONG_RE = /^#[0-9a-f]{6}$/;

/**
 * `#RGB` and `#RRGGBB`, case-insensitively, normalised to lowercase six digits.
 *
 * Normalising rather than merely accepting is what keeps `validate()`
 * idempotent: `#FFF` and `#ffffff` are the same colour, and a validator that
 * returned the first one unchanged would produce a different object on the
 * second pass and fail the registry's idempotence assertion.
 */
export function normalizeHex(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const s = raw.trim().toLowerCase();
  if (HEX_LONG_RE.test(s)) return s;
  // `#abc` → `#aabbcc`: the `#` is not in the character class, so only the
  // three digits are doubled.
  if (HEX_SHORT_RE.test(s)) return s.replace(/[0-9a-f]/g, (c) => c + c);
  return fallback;
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
export function validateText(raw: unknown): TextConfig {
  const o = isPlainObject(raw) ? raw : {};
  const text = o['text'];
  return {
    text: typeof text === 'string' && text.length <= MAX_TEXT_LEN ? text : TEXT_DEFAULTS.text,
    size: num(o['size'], SIZE_MIN, SIZE_MAX, TEXT_DEFAULTS.size),
    weight: pick(o['weight'], TEXT_WEIGHTS, TEXT_DEFAULTS.weight),
    font: pick(o['font'], TEXT_FONTS, TEXT_DEFAULTS.font),
    color: normalizeHex(o['color'], TEXT_DEFAULTS.color),
    align: pick(o['align'], TEXT_ALIGNS, TEXT_DEFAULTS.align),
    letterSpacing: num(o['letterSpacing'], TRACKING_MIN, TRACKING_MAX, TEXT_DEFAULTS.letterSpacing),
    uppercase: flag(o['uppercase'], TEXT_DEFAULTS.uppercase),
    shadow: flag(o['shadow'], TEXT_DEFAULTS.shadow),
  };
}
