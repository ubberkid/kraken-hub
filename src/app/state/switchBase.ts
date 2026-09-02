/**
 * The ONE place the app changes what is on the panel.
 *
 * Schema 7 gave the document two ways to say "the base is a video":
 * `look.layers[0].kind`, which is the truth the compositor renders, and
 * `activeModuleId`, which is the flat field that predates looks and is still
 * the WINNING write path — `validateAppState` rewrites the base kind from it for
 * one release, so that a peer, a URL or a stored snapshot that only knows about
 * the old field still lands somewhere coherent (§4.2, §6.1).
 *
 * That direction is deliberate and it is also a trap: a commit that writes only
 * `activeModuleId` is correct today and silently wrong the moment the validator
 * stops mirroring, and a commit that writes only `look` is silently overwritten
 * by the validator *right now*. Twenty-one call sites each getting that right
 * from memory is twenty-one chances to get it wrong once.
 *
 * So there is one helper, every base-kind write goes through it, and a
 * grep-based test (`switchBase.test.ts`, the shape the vocabulary spine uses)
 * fails the build on a direct `activeModuleId:` write anywhere in `src/app/**`.
 * When the mirrored field retires, this file is the only edit.
 *
 * The editor's own overlay ops are NOT this: they write `look` and nothing else,
 * because they never change the base kind. Only a change of BASE KIND comes
 * here.
 */

import { switchBase as switchBaseLook } from '../../state/look/selectors';

import type { AppState, ModuleId } from '../../state/schema';
import type { Store } from '../../state/store';

/**
 * The state with `kind` as its base, both ways round.
 *
 * `switchBase` (the pure look op, §4.3) replaces `layers[0]` and keeps every
 * overlay standing — switching from a video to an effect keeps the clock that
 * was sitting on top of it — and the outgoing kind's config stays in the
 * `modules` bank, so switching back is not a way to lose your settings.
 *
 * The mirrored `activeModuleId` is written in the SAME commit rather than in a
 * second one: two commits are two synced snapshots, and a peer that saw only
 * the first would render a look whose base disagrees with the flat field.
 */
export function withBaseKind<S extends AppState>(state: S, kind: ModuleId): S {
  return { ...switchBaseLook(state, kind), activeModuleId: kind };
}

/**
 * The same thing, composed with another patch.
 *
 * The common shape at the call sites: "put this clip in the video module's bank
 * AND make video the base", as one commit. `patch` runs first, so a helper that
 * writes `modules` sees the state it expects and this only ever settles the two
 * base fields on top.
 */
export function commitBaseKind(
  store: Store,
  kind: ModuleId,
  patch?: (state: AppState) => AppState,
): void {
  store.commit((s) => withBaseKind(patch === undefined ? s : patch(s), kind));
}
