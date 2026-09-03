/**
 * What may be the BACKGROUND — one derivation, two pickers (round 11's M-a).
 *
 * The app shipped two base pickers that disagreed. The rail's chip row was
 * `listModules()` in registry order — nine chips, including Text, Icon and Date,
 * which `layer.roles` says can only ever be overlays, and excluding the Solid
 * colour the add sheet offers. The add sheet's BACKGROUND row was already
 * derived (`roles.includes('base')`) and carried Solid. So pressing **Text** in
 * the rail asked the app to make a background out of a kind that declares it
 * cannot be one, and a person who had used the add sheet first had learned a
 * different list of backgrounds from the one the rail showed them.
 *
 * Neither list is now written down anywhere: both surfaces call this, `roles`
 * is the module's own statement, and a kind added to the registry next month
 * appears in both places or in neither.
 *
 * ## Why Solid is not a kind
 *
 * "Solid colour" is the shape kind wearing {@link SOLID_BASE_CFG} — a flat
 * ground, edge to edge — rather than a tenth module, exactly as §10 asks. It is
 * therefore an EXTRA entry beside the derived ones rather than part of the
 * derivation, in both pickers, and both get it from this file so they cannot
 * drift into disagreeing about what "solid" means either.
 *
 * Pure and DOM-free: the rule is a filter over manifests, and its test is a
 * unit test.
 */

import { SOLID_BASE_CFG } from '../../../modules/shape/schema';

import type { AnyKrakenModule } from '../../../modules/types';

/** The kind Solid colour is made of. Named once, read by both pickers. */
export const SOLID_BASE_KIND = 'shape';

/**
 * The kinds this build will accept as a background, in registry order.
 *
 * `layer.roles` is the module's own answer; a manifest with no `layer` block at
 * all declares nothing and is therefore not offered — the safe direction, since
 * the alternative is a picker that offers a background the compositor will
 * refuse.
 */
export function baseCapableKinds(modules: readonly AnyKrakenModule[]): readonly AnyKrakenModule[] {
  return modules.filter((m) => (m.layer?.roles ?? []).includes('base'));
}

/**
 * The value Solid colour carries in a SEGMENTED base picker.
 *
 * Not a module id, for the reason CAM's chip is `base-chip-solid` rather than
 * `module-chip-solid`: "solid" names a config of the shape kind, and a value
 * that looked like a module id would be one the registry cannot resolve.
 */
export const SOLID_OPTION_VALUE = 'base-solid';

/**
 * The whole picker, as options — the phone's "Showing" row (round 13).
 *
 * CAM's chip row and the add sheet's Background row each lay their own tiles
 * out and so take the two functions above; the remote's row is a `Segmented`,
 * which wants `{value,label}` pairs, and a third hand-rolled list is exactly
 * how the phone ended up offering Text as a background in the first place.
 * Same filter, same Solid entry, same order.
 */
export function baseOptions(
  modules: readonly AnyKrakenModule[],
): readonly { value: string; label: string }[] {
  return [
    ...baseCapableKinds(modules).map((m) => ({ value: m.id, label: m.chipName ?? m.name })),
    ...(hasSolidBase(modules) ? [{ value: SOLID_OPTION_VALUE, label: 'Solid' }] : []),
  ];
}

/** Whether this build can offer Solid colour at all — it needs the shape kind. */
export function hasSolidBase(modules: readonly AnyKrakenModule[]): boolean {
  return modules.some((m) => m.id === SOLID_BASE_KIND);
}

export { SOLID_BASE_CFG };
