import { describe, expect, it } from 'vitest';

import { ownsBytes } from './surface';

/**
 * The gate is one boolean, so the test is about the FAILURE direction.
 *
 * Everything wave 1 removes from the phone hangs off this function, and the
 * expensive mistake is not "CAM was told it cannot ingest" (visible instantly,
 * fixed in a minute) but "a phone was told it can" — which produces a second,
 * real, empty library backed by a database the Kraken cannot open. So the rule
 * fails closed: anything short of both signals agreeing is a remote.
 */
describe('ownsBytes', () => {
  it('is true only inside CAM’s Configuration Browser', () => {
    expect(ownsBytes({ camDetected: true, role: 'config' })).toBe(true);
  });

  it('fails closed when the two signals disagree', () => {
    expect(ownsBytes({ camDetected: true, role: 'remote' })).toBe(false);
    expect(ownsBytes({ camDetected: false, role: 'config' })).toBe(false);
  });

  it('is false for a phone and for a desktop browser at a desk', () => {
    expect(ownsBytes({ camDetected: false, role: 'remote' })).toBe(false);
  });

  it('never claims the display page owns the config window’s storage', () => {
    // The display shares the partition but is not a configuration surface: it
    // has no file picker, no drop target and nothing to gate.
    expect(ownsBytes({ camDetected: true, role: 'display' })).toBe(false);
  });

  /*
   * `surfaceName()` used to be asserted here, and it is gone.
   *
   * It was a dead export — this test was its only caller — whose docstring
   * promised a `data-surface` attribute no component rendered. Its claim was
   * "there are exactly two windows, and everything that is not CAM is a remote",
   * which is the two cases directly above: the gate is one boolean, so naming
   * the false side was a second spelling of the same fact rather than a second
   * fact. Deleting the function without deleting the claim is the only way this
   * removal could have cost anything.
   */
});
