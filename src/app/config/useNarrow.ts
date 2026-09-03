/**
 * A media query as React state.
 *
 * Two callers, and both need JavaScript rather than CSS because what they change
 * is not a style: the home screen's paste field rewrites a `placeholder`
 * attribute (at 390 px the long form truncated mid-word to *"Paste a video
 * link — YouTube, MP4, HI"*, which reads as a rendering bug), and the unpaired
 * remote decides whether to MOUNT the install band at all — a phone cannot
 * install CAM, because the phone is not the PC, and `display: none` on advice
 * that does not apply is still a control in the accessibility tree.
 */

import { useEffect, useState } from 'react';

import { ownsBytes, type SurfaceSignals } from './surface';

/** Matches `ui.css`'s own phone breakpoint, so the two never disagree. */
export const PHONE_QUERY = '(max-width: 700px)';

/**
 * A **phone**, as opposed to a narrow window — and the difference is the whole
 * point of having two queries.
 *
 * `PHONE_QUERY` answers *is this layout cramped?*, which is a question about
 * pixels and is correctly true for a half-width desktop window and for CAM's own
 * 866×537 Electron frame at some zoom levels. This one answers *is this a device
 * held in a hand?*, and it is the gate on which of the two apps a non-CAM
 * visitor gets at all — so it must not fire for somebody who merely dragged a
 * window narrow. A coarse pointer is the signal that separates them: a finger
 * rather than a mouse. Both halves, never either.
 *
 * `?phone=1|0` overrides it (`urlParams.ts`), which is a simulator seam rather
 * than a feature — the same shape `?cam=` has, for the same reason.
 */
export const PHONE_CLASS_QUERY = '(max-width: 700px) and (pointer: coarse)';

/**
 * A FINGER, at any width — round 12's phone-editing round.
 *
 * The editor derived "is this touch?" from `PHONE_QUERY`, which is a question
 * about pixels: a phone turned landscape, a phone whose browser window is 780
 * px, or a tablet at 800×1180 answered *no* and got the mouse's editor —
 * 24 px handles, no pinch, no two-finger rotate, no long press, and strip
 * buttons at 28–39 px under a thumb. Width decides the LAYOUT; the pointer
 * decides the GESTURES, and conflating them is what made "resize the window
 * bigger" the only way to reach an effect preset.
 *
 * The same string `ui.css`'s `@media (pointer: coarse)` blocks use, for the
 * reason `PHONE_QUERY` is shared: two answers to one question is how a handle
 * ends up 24 px in JS and 44 px in CSS.
 */
export const COARSE_QUERY = '(pointer: coarse)';

/** Whether the primary pointer on this device is a finger rather than a mouse. */
export function useCoarsePointer(): boolean {
  return useNarrow(COARSE_QUERY);
}

export function useNarrow(query: string): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mql = window.matchMedia(query);
    const onChange = (): void => {
      setNarrow(mql.matches);
    };
    onChange();
    mql.addEventListener('change', onChange);
    return () => {
      mql.removeEventListener('change', onChange);
    };
  }, [query]);
  return narrow;
}

/**
 * "This window gets the remote and nothing else."
 *
 * The one derivation behind the phone rule, so the two places that turn on it —
 * `ConfigApp`, which decides what a route resolves to, and `RemoteView`, which
 * decides whether to offer a link to a page that no longer exists here — cannot
 * answer it differently. Exactly the reason `ownsBytes()` is a function rather
 * than two `if`s, one level up.
 */
export function usePhoneOnly(surface: SurfaceSignals & { phoneOverride: boolean | null }): boolean {
  const phoneClass = useNarrow(PHONE_CLASS_QUERY);
  return (surface.phoneOverride ?? phoneClass) && !ownsBytes(surface);
}
