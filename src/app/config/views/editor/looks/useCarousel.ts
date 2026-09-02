/**
 * The carousel's timer — the one place a rotation actually turns.
 *
 * It lives on the HOME screen rather than inside the Looks sheet, because a
 * rotation that stopped when you closed the menu would be a rotation nobody
 * could use. It does not live on the display at all; `carousel.ts` explains why
 * at length, and the short version is that the display cannot resolve an id in a
 * store it does not have.
 *
 * Three guards, and each one is a decision:
 *
 *  - **`owns`** — `ownsBytes()`. A window that is not CAM's configuration
 *    browser has an empty saved-Looks store, so its ids resolve to nothing; the
 *    guard is here so the reason is stated rather than emerging from an empty
 *    list.
 *  - **A wall clock, not a long timer.** One tick a second comparing two
 *    numbers, because a `setTimeout` for an hour is a timer a sleeping laptop
 *    discards.
 *  - **No history entry.** The tick commits through the store directly rather
 *    than through `editor.applyLook`, because a rotation is not an edit and an
 *    undo stack full of the clock's decisions is an undo stack with the user's
 *    last real change buried in it.
 *  - **The library is read only when the rotation is ON.** The hook is mounted
 *    on the HOME screen, and the carousel is off by default, so reading the
 *    media index at mount pulled `module-video`, `module-image` and every
 *    library row into CAM's boot path for a feature nobody had switched on —
 *    and, worse, ran the legacy→merged picture migration before anybody had
 *    opened the shelf. The read is therefore tied to `state.carousel` being
 *    defined: at mount if it already is, on the store transition when it is
 *    switched on later, and on a tick that has to resolve media without one.
 */

import { useEffect, useRef } from 'react';

import { applyLookFile, resolveMedia } from '../../../../../state/look/file';
import { withBaseKind } from '../../../../state/switchBase';
import { readLooksDoc, subscribeLooks } from '../../../editor/looksStore';

import { CAROUSEL_TICK_MS, carouselStep } from './carousel';
import { crossFadeLookSwitch } from './crossFade';
import { readMediaIndex } from './mediaIndex';

import type { MediaIndex } from '../../../../../state/look/file';
import type { Store } from '../../../../../state/store';

export interface CarouselOptions {
  store: Store;
  /** `ownsBytes(runtime)` — whether this window holds the library and the shelf. */
  owns: boolean;
}

/**
 * Run the rotation for as long as this component is mounted.
 *
 * Returns nothing: the effect IS the feature. Everything a caller might want to
 * read — which Looks are in the set, whether it is running — is derivable from
 * `state.carousel` and the store, and a second copy of it here would be a second
 * answer to the same question.
 */
export function useCarousel({ store, owns }: CarouselOptions): void {
  /** What this window last put on the panel, and when. Never persisted. */
  const showing = useRef<{ id: string | null; at: number }>({ id: null, at: 0 });
  const media = useRef<MediaIndex>([]);
  /**
   * "Read the library if the rotation is on and we have not read it yet."
   *
   * A ref rather than a plain function because the tick effect needs to ask for
   * a read that the reading effect owns, and the two effects have different
   * lifetimes. It is a no-op while the hook is unmounted or the carousel is off.
   */
  const ensureMedia = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!owns) return undefined;
    let live = true;
    /** Whether a read has been started for the current "on" stretch. */
    let started = false;
    const on = (): boolean => store.getSnapshot().carousel !== undefined;
    const read = (): void => {
      started = true;
      void readMediaIndex().then((index) => {
        if (live) media.current = index;
      });
    };
    const ensure = (): void => {
      if (!on()) {
        // Switched off: the next switch-on reads again, because the library may
        // well have changed while the rotation was not looking at it.
        started = false;
        return;
      }
      if (!started) read();
    };
    ensureMedia.current = ensure;
    ensure();
    const offStore = store.subscribe(ensure);
    // A saved-Looks change can add a Look that names media this index has never
    // seen — but only a running rotation has any use for the answer.
    const offLooks = subscribeLooks(() => {
      if (on()) read();
    });
    return () => {
      live = false;
      ensureMedia.current = () => undefined;
      offStore();
      offLooks();
    };
  }, [owns, store]);

  useEffect(() => {
    if (!owns) return undefined;

    const tick = (): void => {
      const state = store.getSnapshot();
      const settings = state.carousel;
      if (settings === undefined) {
        // Switched off: forget where we were, so switching it back on starts at
        // the top rather than resuming a rotation nobody asked to resume.
        showing.current = { id: null, at: 0 };
        return;
      }

      // A tick with a rotation on is the other moment the index is needed: if
      // the switch-on and the tick raced, this is what makes the read happen.
      ensureMedia.current();

      const doc = readLooksDoc();
      const next = carouselStep({
        settings,
        doc,
        showingId: showing.current.id,
        shownAt: showing.current.at,
        now: Date.now(),
        owns,
      });
      if (next === null) return;

      const patch = applyLookFile(state, resolveMedia(next.file, media.current));
      crossFadeLookSwitch();
      store.commit((s) => {
        const kind = patch.look.layers[0]?.kind;
        const based = kind === undefined ? s : withBaseKind(s, kind);
        return { ...based, look: patch.look, modules: patch.modules };
      });
      showing.current = { id: next.id, at: Date.now() };
    };

    tick();
    const timer = setInterval(tick, CAROUSEL_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [owns, store]);
}
