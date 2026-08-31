/**
 * "Has a Kraken ever connected to this installation?"
 *
 * The first-run problem, done the Apple way: the CAM install card is the most
 * important thing on the screen until it has been used exactly once, and then
 * it must get out of the way forever. It cannot be a dismissible banner —
 * nobody dismisses the one card that would have fixed their black screen — and
 * it cannot be a permanent panel either, because a user with a working cooler
 * should never again be told how to install the thing they are looking at.
 *
 * So the trigger is not a click. It is evidence: the display page publishes to
 * this origin's `localStorage` the moment it boots (its `DiagReport` while
 * `?diag=1` runs, its video telemetry during ordinary use), and
 * `homeState.readDisplayFacts()` already reads both. The first time either one
 * is present the answer is latched into a namespaced key, because the evidence
 * itself is perishable — telemetry stops when CAM closes, and a user who
 * finished setup last week must not be shown step one again on a cold boot.
 *
 * One-way on purpose: nothing clears the latch. The install instructions do not
 * disappear, they move to `#/about` ("Add to CAM"), which is where somebody
 * reinstalling CAM or setting up a second machine will look for them.
 */

import { readRaw, writeRaw } from '../../platform/storage';

import { readDisplayFacts } from './homeState';

/** `kraken-hub:v1:config:displaySeen` — namespaced like everything else (I5). */
export const DISPLAY_SEEN_SUFFIX = 'config:displaySeen';

/** True once anything the DISPLAY published has been observed, ever. */
export function hasDisplayBeenSeen(): boolean {
  if (readRaw(DISPLAY_SEEN_SUFFIX) === '1') return true;
  if (readDisplayFacts() === null) return false;
  // Latch it. A write failure is not worth handling: the fallback is that the
  // check runs again next time and finds the same evidence, or asks for it.
  writeRaw(DISPLAY_SEEN_SUFFIX, '1');
  return true;
}
