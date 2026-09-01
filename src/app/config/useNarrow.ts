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

/** Matches `ui.css`'s own phone breakpoint, so the two never disagree. */
export const PHONE_QUERY = '(max-width: 700px)';

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
