// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { CAM_PATH_FRAME_RATE } from '../../../config/camPaths';
import { resetNamespace } from '../../../platform/storage';

import {
  ADVISORY_CARD_MS,
  LOW_FPS_THRESHOLD,
  createFpsAdvisory,
  isFpsAdvisoryDismissed,
  renderFpsBadge,
  renderFpsCard,
  setFpsAdvisoryDismissed,
} from './FpsAdvisory';

/**
 * §8.1. The advisory exists because CAM ships the slider at 1 FPS and a user who
 * never touches it blames the app. So the machine has to be right about three
 * things: it appears, it shrinks, and it goes away by itself.
 */

beforeEach(() => {
  resetNamespace();
});

describe('createFpsAdvisory', () => {
  it('shows a full card at or below the threshold, then a badge after 20 s', () => {
    let clock = 0;
    const a = createFpsAdvisory({ now: () => clock, isDismissed: () => false });
    expect(a.update(1)).toBe('card');
    clock += ADVISORY_CARD_MS - 1;
    expect(a.update(1)).toBe('card');
    clock += 2;
    expect(a.update(1)).toBe('badge');
  });

  it('stays hidden above the threshold', () => {
    const a = createFpsAdvisory({ now: () => 0, isDismissed: () => false });
    expect(a.update(LOW_FPS_THRESHOLD + 1)).toBe('hidden');
    expect(a.update(40)).toBe('hidden');
  });

  it('clears itself the moment a higher frame rate is observed', () => {
    let clock = 0;
    const a = createFpsAdvisory({ now: () => clock, isDismissed: () => false });
    expect(a.update(1)).toBe('card');
    clock += ADVISORY_CARD_MS + 1;
    expect(a.update(1)).toBe('badge');
    expect(a.update(40)).toBe('hidden');
  });

  it('re-arms as a full CARD when the rate drops again', () => {
    let clock = 0;
    const a = createFpsAdvisory({ now: () => clock, isDismissed: () => false });
    a.update(1);
    clock += ADVISORY_CARD_MS + 1;
    expect(a.update(1)).toBe('badge');
    expect(a.update(40)).toBe('hidden');
    // A slider dragged up and back down deserves the full explanation again,
    // not a badge nobody reads.
    expect(a.update(1)).toBe('card');
  });

  it('respects the config-side dismissal — the only place it CAN be dismissed', () => {
    const a = createFpsAdvisory({ now: () => 0, isDismissed: () => true });
    expect(a.update(1)).toBe('hidden');
  });
});

describe('the dismiss key', () => {
  it('round-trips through the namespaced store', () => {
    expect(isFpsAdvisoryDismissed()).toBe(false);
    setFpsAdvisoryDismissed(true);
    expect(isFpsAdvisoryDismissed()).toBe(true);
    setFpsAdvisoryDismissed(false);
    expect(isFpsAdvisoryDismissed()).toBe(false);
  });
});

describe('rendering', () => {
  /**
   * The path comes from `src/config/camPaths.ts` and nowhere else (round 2,
   * R6). Asserting against the constant rather than a copy of the string is the
   * point: five spellings of two menu paths were shipping side by side, and a
   * test carrying a sixth is how that happens again.
   */
  it('names the one CAM frame-rate path in the card', () => {
    const el = renderFpsCard(1);
    const text = el.textContent;
    expect(text).toContain('1 FPS');
    expect(text).toContain(CAM_PATH_FRAME_RATE);
  });

  /**
   * Round 3: the body ended in a hardcoded "(40 on Elite)" on every panel,
   * including the two it is wrong for. The ceiling is passed in from
   * `devicePresets` now, and an unknown panel gets no ceiling at all.
   */
  it('quotes the ceiling of the panel it was given, and none when it was given none', () => {
    expect(renderFpsCard(1, 25).textContent).toContain('25 FPS on this panel');
    expect(renderFpsCard(1, 40).textContent).not.toContain('Elite');
    expect(renderFpsCard(1).textContent).not.toContain('on this panel');
  });

  it('shrinks to a badge that says the number and nothing else', () => {
    const el = renderFpsBadge(1);
    expect(el.textContent).toBe('1 FPS ⚠');
    expect(el.dataset['advisory']).toBe('badge');
  });
});
