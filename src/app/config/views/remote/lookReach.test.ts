import { describe, expect, it } from 'vitest';

import { arrangementPresence } from './lookReach';

import type { PanelPresence } from '../../panelPresence';

/**
 * The one rule that keeps the phone's editor honest.
 *
 * `panelPresence` answers *is a Kraken there*. The editor needs a different
 * question answered — *did this arrangement get to it* — and the two do not
 * follow from each other in either direction. Round 7's finding was a surface
 * using the presence it had for the claim it wanted; this is the same mistake
 * refused in advance.
 *
 * W1c moved which windows can answer yes — the wire carries `look` now, so a
 * paired phone delivers where before only CAM's own window did — and moved
 * nothing about the rule. That is exactly what this file is for: the tests
 * below are stated over `delivers` as a fact, never over how a caller computes
 * it, so the change that made `delivers` reachable on a phone touched no
 * assertion here.
 */

const ALL: readonly PanelPresence[] = ['never-seen', 'quiet', 'live'];

describe('arrangementPresence', () => {
  it('is the panel’s own presence on a window whose writes land', () => {
    for (const presence of ALL) {
      expect(arrangementPresence({ presence, delivers: true })).toBe(presence);
    }
  });

  /**
   * The finding, as a property: a window that cannot deliver never reaches the
   * live tense — which is the only tense that says the Kraken HAS the look.
   */
  it('never reaches the live tense on a window that cannot deliver', () => {
    for (const presence of ALL) {
      expect(arrangementPresence({ presence, delivers: false })).not.toBe('live');
    }
  });

  it('keeps the Kraken it has seen, rather than pretending there is none', () => {
    // `quiet`, not `never-seen`: the panel is real and the edit is kept here.
    expect(arrangementPresence({ presence: 'live', delivers: false })).toBe('quiet');
    expect(arrangementPresence({ presence: 'quiet', delivers: false })).toBe('quiet');
    expect(arrangementPresence({ presence: 'never-seen', delivers: false })).toBe('never-seen');
  });
});
