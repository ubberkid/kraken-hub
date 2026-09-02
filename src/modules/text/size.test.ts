import { describe, expect, it } from 'vitest';

import { DEVICE_PRESETS, DEVICE_PRESET_IDS } from '../../platform/devicePresets';

import { fontPxFor } from './display';
import { TEXT_DEFAULTS } from './schema';

import { textModule } from './index';

/**
 * The one rule, pinned.
 *
 *     fontPx = min(size × hostW, hostH × LINE_CAP)
 *
 * The interesting property is not any single number, it is that the number is a
 * function of the BOX and of nothing else — so the same look renders the same
 * relative type on every panel this app supports. The boxes below are therefore
 * DERIVED from `DEVICE_PRESETS` and from the module's own `overlayDefault`,
 * never written down: a device dimension typed into a test is the invariant-5
 * failure wearing a green tick.
 */

/** The host box, in px, for this module's default overlay frame on a panel. */
function hostBoxOn(preset: { width: number; height: number }): { w: number; h: number } {
  // Frames are DIAMETER units against `radiusPx = min(w,h)/2` (§1.1).
  const radius = Math.min(preset.width, preset.height) / 2;
  const placement = textModule.layer;
  if (placement === undefined) throw new Error('text must declare a layer placement');
  const { frame } = placement.overlayDefault;
  return { w: frame.w * radius, h: frame.h * radius };
}

const BOXES = DEVICE_PRESET_IDS.map((id) => [id, hostBoxOn(DEVICE_PRESETS[id])] as const);

describe('the font-size rule', () => {
  it('has at least three distinct host sizes to check', () => {
    // A preset table that collapsed to one size would make every case below
    // the same case, which is the way a table-driven test stops being one.
    const distinct = new Set(BOXES.map(([, box]) => `${String(box.w)}x${String(box.h)}`));
    expect(distinct.size).toBeGreaterThanOrEqual(3);
  });

  it.each(BOXES)('on %s the default line fits its box', (_id, box) => {
    const px = fontPxFor(TEXT_DEFAULTS.size, box);
    // Fits: a line of this type, at `line-height: 1.1`, is shorter than the box.
    expect(px * 1.1).toBeLessThanOrEqual(box.h);
    expect(px).toBeGreaterThan(0);
  });

  /**
   * Scale invariance, which is the whole point of unit-radius coordinates: two
   * panels differing only in size produce font sizes in exactly that ratio, so
   * a look composed on one lands identically on the other.
   */
  it('scales exactly with the box', () => {
    const small = { w: 100, h: 40 };
    const big = { w: small.w * 4, h: small.h * 4 };
    expect(fontPxFor(TEXT_DEFAULTS.size, big)).toBeCloseTo(
      fontPxFor(TEXT_DEFAULTS.size, small) * 4,
    );
  });

  it('takes the width term when the box is wide', () => {
    // 0.25 × 200 = 50, which is under the height cap for a 200-tall box.
    expect(fontPxFor(0.25, { w: 200, h: 200 })).toBeCloseTo(50);
  });

  it('takes the height cap when the box is short', () => {
    // 0.5 × 400 = 200 would be taller than a 40-tall box, so the cap wins.
    const px = fontPxFor(0.5, { w: 400, h: 40 });
    expect(px).toBeLessThan(40);
    expect(px).toBeGreaterThan(0);
  });

  it.each([
    ['zero', { w: 0, h: 0 }],
    ['negative', { w: -10, h: -10 }],
    ['not a number', { w: Number.NaN, h: Number.NaN }],
  ])('returns a floor rather than nonsense for a %s box', (_why, box) => {
    const px = fontPxFor(TEXT_DEFAULTS.size, box);
    expect(Number.isFinite(px)).toBe(true);
    expect(px).toBeGreaterThan(0);
  });
});
