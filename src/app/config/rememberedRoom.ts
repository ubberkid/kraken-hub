/**
 * The room this device is paired with, remembered.
 *
 * A phone that scanned the QR once should never be asked again. It gets added
 * to a home screen, opened from a bookmark, or simply reloaded — and every one
 * of those arrives at a plain `#/remote` with no room in the link. Without this,
 * the answer was an empty pairing card and a code to retype off a monitor in
 * another room.
 *
 * ## Why this is its own key rather than the state document
 *
 * `AppState.sync.roomCode` is shared, published and remotely writable: the
 * config page, the display and the remote all read the same document, and the
 * display persists what a remote sends it. This key is the opposite — strictly
 * local, strictly this browser profile, never published, never merged, never
 * part of a snapshot on the wire. It exists so that "which Kraken is this phone
 * paired with" survives a state document being cleared, migrated, or replaced by
 * a retained frame from a room this device is no longer in.
 *
 * It is also the thing Unpair clears. A user pressing that must
 * end up genuinely unpaired, not repaired on the next reload by a value hiding
 * in another layer.
 *
 * Namespaced through `platform/storage` like everything else (invariant I5):
 * a fork on `<user>.github.io` shares an origin with every other repo that user
 * publishes, and an unprefixed `room` key would be a collision waiting to happen.
 */

import { readRaw, removeRaw, writeRaw } from '../../platform/storage';
import { isValidRoomCode, normalizeRoomCode } from '../../sync/roomCode';

/** `kraken-hub:v1:remote:room` */
export const REMEMBERED_ROOM_SUFFIX = 'remote:room';

/**
 * The remembered code, or `null`.
 *
 * Checked on the way out rather than trusted — this is user-visible storage on
 * an origin a fork shares with every other repo its author publishes — and
 * checked *strictly*, with `isValidRoomCode` rather than `normalizeRoomCode`.
 *
 * The difference is not pedantry. `normalizeRoomCode` is deliberately forgiving
 * because it reads what a human typed: it strips separators and folds the
 * ambiguous glyphs, so `abcd-1234` and `ABCD1234` are the same room. Run it over
 * arbitrary garbage and it happily produces a *valid-shaped* code —
 * `{"not":"a code"}` normalises to `N0TAC0DE` — and the sync layer would then
 * derive a real topic and a real key for a room nobody is in, which surfaces to
 * the user as a silent failure to connect rather than as "not paired".
 *
 * Writes normalise, reads verify. That is the right way round.
 */
export function readRememberedRoom(): string | null {
  const raw = readRaw(REMEMBERED_ROOM_SUFFIX);
  return raw !== null && isValidRoomCode(raw) ? raw : null;
}

/** Remember a room. Ignores anything that is not a valid code. */
export function rememberRoom(code: string): void {
  const normalized = normalizeRoomCode(code);
  if (normalized === null) return;
  if (readRaw(REMEMBERED_ROOM_SUFFIX) === normalized) return;
  writeRaw(REMEMBERED_ROOM_SUFFIX, normalized);
}

/** What Unpair clears. */
export function forgetRoom(): void {
  removeRaw(REMEMBERED_ROOM_SUFFIX);
}
