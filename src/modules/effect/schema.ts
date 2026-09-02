/**
 * STEP 1 (docs/modules.md §3) — the Effects config type, its defaults, and a
 * validator that cannot throw.
 *
 * Eager: the registry imports this so both pages can validate stored state
 * before anything renders. No DOM, no storage, and — deliberately — **no
 * palettes and no fragment sources**. What lives here is the id table, the
 * preset NAMES, and the clamps; the colours, the human labels and the GLSL are
 * in `catalog.ts` and `effects/`, both of which are lazy. An eager table of
 * twelve palettes would be a kilobyte of the LCD's 90 kB critical path spent on
 * something only the settings page ever reads.
 *
 * ## `colors` is the truth, `preset` is the label
 *
 * A preset is a *material* out of the author's own Unity banners — pressing one
 * writes its four colours into `colors` and records its id in `preset`. The
 * renderer reads `colors` and never resolves a preset, which is what keeps the
 * display chunk free of the palette table. Editing one well afterwards sets
 * `preset` to `'custom'`; nothing about the picture changes at that moment,
 * because the picture was always the colours.
 */

import { clamp, isFiniteNumber, isPlainObject } from '../../lib/clamp';

export type EffectId =
  | 'plasma'
  | 'twisted-nebula'
  | 'satin-swirl'
  | 'triad-nexus'
  | 'voronoi'
  | 'interference'
  | 'wave-ripple'
  | 'wavy-gradient'
  | 'classic'
  | 'colour-spiral'
  | 'infinite-rings'
  | 'prism';

/**
 * Picker order: the calm, well-diffed ports first, the two high-entropy ones
 * next to last, and the experimental one last (PORTS.md marks `prism` as never
 * diffed against a Unity screenshot).
 */
export const EFFECT_IDS: readonly EffectId[] = [
  'plasma',
  'twisted-nebula',
  'satin-swirl',
  'triad-nexus',
  'voronoi',
  'interference',
  'wave-ripple',
  'wavy-gradient',
  'classic',
  'colour-spiral',
  'infinite-rings',
  'prism',
];

/** Which reading drives the warmth. There is no pump RPM field on this hardware. */
export type TempSource = 'cpu' | 'gpu' | 'liquid';
export const TEMP_SOURCES: readonly TempSource[] = ['cpu', 'gpu', 'liquid'];

/**
 * Every port takes four colours (PORTS.md: the uniform contract is
 * `uColor0..uColor3` for all twelve). It is still a per-effect number rather
 * than a constant, because the first effect that wants three or six should cost
 * one line here and not a rewrite of `validate()`.
 */
export const EFFECT_COLOUR_SLOTS: Readonly<Record<EffectId, number>> = {
  plasma: 4,
  'twisted-nebula': 4,
  'satin-swirl': 4,
  'triad-nexus': 4,
  voronoi: 4,
  interference: 4,
  'wave-ripple': 4,
  'wavy-gradient': 4,
  classic: 4,
  'colour-spiral': 4,
  'infinite-rings': 4,
  prism: 4,
};

/** Widest palette any effect asks for — the renderer sizes its buffer by it. */
export const MAX_COLOUR_SLOTS = Math.max(...Object.values(EFFECT_COLOUR_SLOTS));

/** The one preset every effect has — and therefore the fallback for a bad id. */
export const DEFAULT_PRESET_ID = 'classic';
/** `preset` when the colours no longer match any material. */
export const CUSTOM_PRESET_ID = 'custom';

// The material variants that exist in the author's Unity project, shared out by
// set so the eager table stays a few hundred bytes.
const ALL_NINE: readonly string[] = [
  'classic',
  'graphite',
  'ice',
  'lime',
  'bubblegum',
  'amethyst',
  'ember',
  'snow',
  'sunburst',
];
const NO_ICE: readonly string[] = ALL_NINE.filter((p) => p !== 'ice');
const NO_AMETHYST: readonly string[] = ALL_NINE.filter((p) => p !== 'amethyst');
const ONLY_CLASSIC: readonly string[] = ['classic'];

/**
 * Preset ids per effect — names only, no colours.
 *
 * `catalog.test.ts` asserts this table and the lazy catalogue agree, so the two
 * cannot drift: this one decides what `validate()` accepts, that one decides
 * what the chips paint.
 */
export const EFFECT_PRESET_IDS: Readonly<Record<EffectId, readonly string[]>> = {
  plasma: ALL_NINE,
  'twisted-nebula': ['classic', 'lime', 'snow'],
  'satin-swirl': ['classic', 'bubblegum', 'snow'],
  'triad-nexus': ['classic', 'ice', 'snow'],
  voronoi: ALL_NINE,
  interference: ONLY_CLASSIC,
  'wave-ripple': ['classic', 'graphite', 'ice'],
  'wavy-gradient': NO_AMETHYST,
  classic: NO_ICE,
  'colour-spiral': ONLY_CLASSIC,
  'infinite-rings': ['classic', 'graphite', 'lime'],
  prism: ALL_NINE,
};

export interface EffectConfig {
  effect: EffectId;
  /** `'custom'`, or one of `EFFECT_PRESET_IDS[effect]`. A label, not a source. */
  preset: string;
  /** `#RRGGBB`, exactly `EFFECT_COLOUR_SLOTS[effect]` of them. */
  colors: string[];
  speed: number;
  scale: number;
  brightness: number;
  reactsToTemp: boolean;
  tempSource: TempSource;
}

export const SPEED_MIN = 0.25;
export const SPEED_MAX = 2;
export const SCALE_MIN = 0.5;
export const SCALE_MAX = 2;
export const BRIGHTNESS_MIN = 0.5;
export const BRIGHTNESS_MAX = 1.5;
/** Speed, scale and brightness all rest at 1: the effect exactly as authored. */
const NEUTRAL = 1;

/** Padding for a slot the stored config does not have. Neutral on any palette. */
const FALLBACK_COLOUR = '#808080';

const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

/**
 * Lava lamp in its Classic material — the `plasma_banner_material` colours,
 * unchanged, which is the effect the author's own project opens with.
 */
export const EFFECT_DEFAULTS: EffectConfig = {
  effect: 'plasma',
  preset: DEFAULT_PRESET_ID,
  colors: ['#D6B700', '#F0FF00', '#00FFAF', '#A900FF'],
  speed: NEUTRAL,
  scale: NEUTRAL,
  brightness: NEUTRAL,
  // Off by default: a picture that changes with the machine is a choice, and a
  // user who never opens this panel should get the palette they chose.
  reactsToTemp: false,
  tempSource: 'cpu',
};

/**
 * The two ports whose whole frame moves every tick — a hard-edged spiral arm
 * sweeping the disc, and a continuous exponential zoom. PORTS.md classes them
 * on frame-to-frame ENTROPY rather than GPU cost, because that is what CAM's
 * compressor is charged for: `voronoi` is the most expensive of the twelve to
 * render and among the calmest to encode.
 */
const HIGH_ENTROPY: readonly EffectId[] = ['colour-spiral', 'infinite-rings'];

/** What the look's cost bar should say this config does to the compressor. */
export function effectEntropy(raw: unknown): 'mid' | 'high' {
  const id = isPlainObject(raw) ? raw['effect'] : undefined;
  return typeof id === 'string' && (HIGH_ENTROPY as readonly string[]).includes(id)
    ? 'high'
    : 'mid';
}

function pick<T extends string>(raw: unknown, allowed: readonly T[], def: T): T {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : def;
}

function num(raw: unknown, min: number, max: number, def: number): number {
  return isFiniteNumber(raw) ? clamp(raw, min, max) : def;
}

/** `#rrggbb` -> `#RRGGBB`; anything else -> the neutral pad. */
function colour(raw: unknown, def: string): string {
  return typeof raw === 'string' && HEX_COLOUR.test(raw) ? raw.toUpperCase() : def;
}

/**
 * Coerce to exactly `slots` colours: pad short, truncate long, replace junk.
 *
 * The default palette fills the first slots when a stored config is missing
 * them, so switching from a four-slot effect to a (future) six-slot one leaves
 * the four the user chose alone.
 */
function colours(raw: unknown, slots: number, def: readonly string[]): string[] {
  const list = Array.isArray(raw) ? (raw as unknown[]) : [];
  const out: string[] = [];
  for (let i = 0; i < slots; i += 1) {
    out.push(colour(list[i], colour(def[i], FALLBACK_COLOUR)));
  }
  return out;
}

/** Never throws: every invalid field falls back to its default. */
export function validateEffect(raw: unknown): EffectConfig {
  const o = isPlainObject(raw) ? raw : {};
  const effect = pick(o['effect'], EFFECT_IDS, EFFECT_DEFAULTS.effect);
  const allowed = [CUSTOM_PRESET_ID, ...EFFECT_PRESET_IDS[effect]];
  return {
    effect,
    // A preset from ANOTHER effect is not a preset of this one — Classic is the
    // one every material set has, so an unrecognised id lands there.
    preset: pick(o['preset'], allowed, DEFAULT_PRESET_ID),
    colors: colours(o['colors'], EFFECT_COLOUR_SLOTS[effect], EFFECT_DEFAULTS.colors),
    speed: num(o['speed'], SPEED_MIN, SPEED_MAX, EFFECT_DEFAULTS.speed),
    scale: num(o['scale'], SCALE_MIN, SCALE_MAX, EFFECT_DEFAULTS.scale),
    brightness: num(o['brightness'], BRIGHTNESS_MIN, BRIGHTNESS_MAX, EFFECT_DEFAULTS.brightness),
    reactsToTemp: typeof o['reactsToTemp'] === 'boolean' ? o['reactsToTemp'] : false,
    tempSource: pick(o['tempSource'], TEMP_SOURCES, EFFECT_DEFAULTS.tempSource),
  };
}
