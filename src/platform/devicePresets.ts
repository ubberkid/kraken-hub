/**
 * Device geometry constants.
 *
 * Invariant I3: panel dimensions live here and in `geometry.ts` and nowhere
 * else. Everything downstream reads them from `Geometry`, so a Kraken Z (320)
 * or a Kraken 2023 (240 square) is correct without a single extra branch.
 *
 * Sources: developer.nzxt.com device table + research-nzxtPlatform.md.
 * Kraken Plus (2025) is UNVERIFIED — tracked as H22 in the hardware checklist.
 */

export type Shape = 'circle' | 'square';

export type DevicePresetId = 'elite' | 'plus' | 'z' | 'kraken2023';

export interface DevicePreset {
  readonly id: DevicePresetId;
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly shape: Shape;
  /** The maximum the CAM frame-rate slider offers for this panel. */
  readonly targetFps: number;
  readonly verified: boolean;
}

export const DEVICE_PRESETS: Readonly<Record<DevicePresetId, DevicePreset>> = {
  elite: {
    id: 'elite',
    label: 'Kraken Elite (640 round)',
    width: 640,
    height: 640,
    shape: 'circle',
    targetFps: 40,
    verified: true,
  },
  plus: {
    id: 'plus',
    label: 'Kraken Plus (640 round, unverified)',
    width: 640,
    height: 640,
    shape: 'circle',
    targetFps: 40,
    verified: false,
  },
  z: {
    id: 'z',
    label: 'Kraken Z (320 round)',
    width: 320,
    height: 320,
    shape: 'circle',
    targetFps: 1,
    verified: true,
  },
  kraken2023: {
    id: 'kraken2023',
    label: 'Kraken (2023, 240 square)',
    width: 240,
    height: 240,
    shape: 'square',
    targetFps: 25,
    verified: true,
  },
};

export const DEVICE_PRESET_IDS = Object.keys(DEVICE_PRESETS) as readonly DevicePresetId[];

/**
 * The preset for a panel the platform actually reported, or `null`.
 *
 * Round 3 found the low-frame-rate advisory ending in a hardcoded *"(40 on
 * Elite)"* — a ceiling that is wrong by a factor of 40 on a Kraken Z and by 15
 * FPS on a Kraken 2023, told to the user in the exact moment they are being
 * asked to drag a slider to it. The maximum is a property of the panel and it
 * is already written down here, once, per device.
 *
 * `null` rather than a guess: an unrecognised panel (a fork, a device newer than
 * this build) has a maximum nobody here knows, and the copy is written to drop
 * the clause rather than invent one.
 */
export function presetForPanel(width: number, height: number, shape: string): DevicePreset | null {
  for (const preset of Object.values(DEVICE_PRESETS)) {
    if (preset.width === width && preset.height === height && preset.shape === shape) return preset;
  }
  return null;
}

/** The frame rate CAM's slider tops out at for this panel, or `null` if unknown. */
export function maxTargetFpsForPanel(width: number, height: number, shape: string): number | null {
  return presetForPanel(width, height, shape)?.targetFps ?? null;
}

export function isDevicePresetId(value: string): value is DevicePresetId {
  return Object.hasOwn(DEVICE_PRESETS, value);
}

/**
 * Used only when CAM never injected `window.nzxt`: the Elite panel, because it
 * is by far the most common and because guessing large is safer than guessing
 * small (content laid out for 640 scales down cleanly; the reverse does not).
 */
export const FALLBACK_WIDTH = 640;
export const FALLBACK_HEIGHT = 640;
export const FALLBACK_SHAPE: Shape = 'circle';

/**
 * CAM's own factory default for the frame-rate slider is 1 FPS. `nzxt.ts`
 * reports that verbatim so diagnostics never lie about what the platform said;
 * `geometry.ts` substitutes `PlatformPrefs.fallbackTargetFps` (30) when the
 * object was absent entirely, because an absent object tells us nothing about
 * the slider and a 1 FPS assumption would cripple a late-injecting display.
 */
export const FALLBACK_TARGET_FPS = 1;

/**
 * Fraction of the panel radius treated as reliably visible on a round LCD.
 * 0.88 is the community-practice starting point; H20 (`&pattern=rings`)
 * measures the real value on hardware and this constant is then recalibrated.
 */
export const DEFAULT_SAFE_RADIUS_PCT = 0.88;
