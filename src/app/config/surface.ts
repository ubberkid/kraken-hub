/**
 * Which window is this, and what is it allowed to do?
 *
 * ## The model
 *
 * There is exactly one Kraken. Every screen — CAM's Configuration Browser, a
 * phone remote, a desktop browser at a desk — is a *window* onto it, never an
 * owner of it. **Visibility is a property of the Kraken; capability is a
 * property of the window.** So a window that cannot hold the bytes still shows
 * the library and still routes the play command; the only thing it must not do
 * is offer a control whose bytes would land somewhere the Kraken can never read.
 *
 * ## The bug this closes
 *
 * `#/library` was routed with no surface gating at all, so a phone reached a
 * second, real, EMPTY library: `LibraryView` read the *phone's* IndexedDB,
 * rendered an empty grid, a phone-storage quota meter, a drop target and a
 * working `Browse…` that ingested into a store the Kraken can never open. That
 * is not a perception problem — it was literally two libraries backed by two
 * databases, both reachable, and it alone accounts for "the library is different
 * and the files are separate".
 *
 * ## Why `camDetected` is the gate rather than a new signal
 *
 * `mount.tsx` already computes `camDetected` (`window.nzxt` present, or an
 * Electron UA) and `role` from it, and until now they drove exactly one status
 * chip. They are already the right answer — CAM's two browser windows share one
 * storage partition, which is the entire reason the LCD can read what the
 * configuration window wrote, and nothing else on earth shares it. Promoting
 * them to THE gate adds no new concept and no new failure mode.
 *
 * Deliberately dependency-free and pure so the rule can be unit-tested without a
 * DOM, and so reading it costs nothing on the display's critical path.
 */

import type { Role } from '../../sync/types';

/** The half of `ConfigRuntime` this decision is allowed to look at. */
export interface SurfaceSignals {
  camDetected: boolean;
  role: Role;
}

/**
 * True when this window's IndexedDB is the one the LCD page reads back.
 *
 * Both signals, not either: `role` is derived from `camDetected` today, and
 * requiring the pair means a future build that lets them disagree fails closed
 * rather than opening a file picker into a store nothing can read.
 */
export function ownsBytes(surface: SurfaceSignals): boolean {
  return surface.camDetected && surface.role === 'config';
}

/*
 * There is no `surfaceName()` here any more, and that is the point.
 *
 * It returned 'cam' | 'remote' and its docstring called that "the name for this
 * window in prose and in `data-surface`" — a promise nothing kept: no component
 * rendered a `data-surface` attribute anywhere, and its only caller was its own
 * unit test. A dead export is cheap; a dead export with a docstring describing an
 * attribute the DOM does not have is a lie a future reader has to disprove, and
 * the shelf already marks the distinction where it matters, on the one element
 * whose behaviour turns on it (`data-owns` on `LibraryView`'s section).
 */
