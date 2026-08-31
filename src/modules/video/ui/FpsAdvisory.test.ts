// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

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
  it('names the exact CAM path in the card', () => {
    const el = renderFpsCard(1);
    const text = el.textContent;
    expect(text).toContain('1 FPS');
    expect(text).toContain('Lighting → Kraken → Web Integration → Frame Rate');
  });

  it('shrinks to a badge that says the number and nothing else', () => {
    const el = renderFpsBadge(1);
    expect(el.textContent).toBe('1 FPS ⚠');
    expect(el.dataset['advisory']).toBe('badge');
  });
});
