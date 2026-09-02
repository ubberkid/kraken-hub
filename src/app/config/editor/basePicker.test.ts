/**
 * One derivation, two pickers — round 11's M-a.
 *
 * The bug was not that either list was wrong on its own; it was that there were
 * two of them. The rail's chip row was the whole registry and the add sheet's
 * Background row was derived from `layer.roles`, so the two disagreed in both
 * directions at once: the rail offered Text, Icon and Date as backgrounds (they
 * declare `roles: ['overlay']` and cannot be one) and did not offer the Solid
 * colour the sheet did.
 *
 * These tests are therefore about the RULE rather than about a list of names.
 * Two of them run against the shipped registry, so a manifest that changes its
 * roles is caught here rather than by somebody pressing a chip; the rest run
 * against hand-made manifests, so the rule itself is pinned without depending
 * on which kinds happen to exist this month.
 */

import { describe, expect, it } from 'vitest';

import { listModules } from '../../../modules/registry';

import { SOLID_BASE_KIND, baseCapableKinds, hasSolidBase } from './basePicker';

import type { AnyKrakenModule } from '../../../modules/types';

/** The smallest thing this function looks at, as a manifest-shaped object. */
function fake(id: string, roles: readonly ('base' | 'overlay')[] | null): AnyKrakenModule {
  return {
    id,
    ...(roles === null ? {} : { layer: { roles } }),
  } as unknown as AnyKrakenModule;
}

describe('the base picker’s one list', () => {
  it('offers a kind that declares base, and only such kinds', () => {
    const modules = [
      fake('ground', ['base']),
      fake('either', ['base', 'overlay']),
      fake('over', ['overlay']),
    ];
    expect(baseCapableKinds(modules).map((m) => m.id)).toEqual(['ground', 'either']);
  });

  /**
   * A manifest that says nothing is not a background.
   *
   * The alternative — treating silence as permission — would put a kind in the
   * picker whose renderer the compositor will refuse to mount as a base, which
   * is a control that does nothing and says nothing about why.
   */
  it('refuses a manifest that declares no roles at all', () => {
    expect(baseCapableKinds([fake('quiet', null)])).toEqual([]);
  });

  it('keeps the registry’s own order, so both pickers read the same way', () => {
    const modules = [fake('c', ['base']), fake('a', ['base']), fake('b', ['base'])];
    expect(baseCapableKinds(modules).map((m) => m.id)).toEqual(['c', 'a', 'b']);
  });

  it('offers Solid colour only where the kind it is made of exists', () => {
    expect(hasSolidBase([fake(SOLID_BASE_KIND, ['base', 'overlay'])])).toBe(true);
    expect(hasSolidBase([fake('something-else', ['base'])])).toBe(false);
  });

  /**
   * …and against the build this tree actually ships.
   *
   * Named kinds rather than a count: the three that were wrongly on the rail
   * are the finding, and a count would pass the day one of them came back and
   * something else left.
   */
  it('excludes the overlay-only kinds this build ships', () => {
    const ids = baseCapableKinds(listModules()).map((m) => m.id);
    expect(ids.length).toBeGreaterThan(3);
    for (const overlayOnly of ['text', 'icon', 'date']) {
      expect(ids, `${overlayOnly} cannot be a background`).not.toContain(overlayOnly);
    }
    // The commonest background of all is in it, or the filter is over-eager.
    expect(ids).toContain('video');
    expect(hasSolidBase(listModules())).toBe(true);
  });
});
