/**
 * A row that scrolls sideways, and the two things that make one usable.
 *
 * Extracted from `SelectionStrip.tsx` in round 12 (F12-2), because the editor
 * has TWO of these rows and only one of them worked. The selection strip's
 * `.kh-ops__scroll` measured its own edges, faded the clipped one and mapped a
 * vertical wheel onto its horizontal axis; the rail's BASE chip row
 * (`.kh-mods`, a hidden-scrollbar scroller at CAM's 537 px height) had the
 * `overflow-x` and none of the rest. Measured at 866x537: the box was 231 px
 * against 417 px of chips, so `Image` was sliced at the edge and `Shape`,
 * `Effect` and `Solid` were off-screen — with no fade saying so and a mouse
 * wheel that left `scrollLeft` at 0. Three of the seven backgrounds were
 * unreachable with a mouse.
 *
 * A second copy of the machinery would have been a second thing to keep in
 * step, so it is one hook with two callers.
 *
 * ## What it does NOT do
 *
 * There is no `tabindex` here, deliberately: every control inside these rows is
 * a tab stop already, and focusing one inside an `overflow` box scrolls it into
 * view. A tab stop on the BOX would add a stop that does nothing on the way to
 * the ones that do. The keyboard contract is the focus ring on the container
 * (`:focus-visible` in `ui.css`) plus the browser's own scroll-into-view.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { WheelEvent } from 'react';

/**
 * Which end of the row is cut, as an attribute — round 11's F-3.
 *
 * The fade is a `mask-image` in `ui.css` and a mask is a static declaration, so
 * the one thing it cannot know is whether there is anything left to reveal. A
 * row that fades its right edge with nothing beyond it is an affordance for a
 * gesture that does nothing, which is worse than no affordance at all — so the
 * attribute is measured from the element rather than assumed from its contents.
 */
export type Clipped = 'none' | 'true' | 'start' | 'both';

export interface ScrollEdges {
  /** Ref callback for the scroll box. Measures on attach. */
  attach: (el: HTMLElement | null) => void;
  clipped: Clipped;
  /** Re-measure — wire to `onScroll`. */
  remeasure: () => void;
  /**
   * A wheel with no horizontal axis still moves the row.
   *
   * A trackpad already sends `deltaX` and a horizontal `overflow` box already
   * consumes it; a MOUSE wheel sends only `deltaY`, and over a row that is the
   * only scrollable thing in its corner of the screen that was a gesture with
   * no effect at all. Mapped here rather than in CSS because it is a behaviour,
   * and guarded so it is never a hijack: the event is consumed only while the
   * row can actually move the way the wheel is pointing, so at either end the
   * page gets the scroll back.
   */
  onWheel: (event: WheelEvent<HTMLElement>) => void;
}

export function useScrollEdges(): ScrollEdges {
  const node = useRef<HTMLElement | null>(null);
  const [clipped, setClipped] = useState<Clipped>('none');

  const measure = useCallback((): void => {
    const el = node.current;
    if (el === null) return;
    // 1 px of slack: a fractional layout width must not read as "clipped".
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setClipped(left && right ? 'both' : left ? 'start' : right ? 'true' : 'none');
  }, []);

  const attach = useCallback(
    (el: HTMLElement | null): void => {
      node.current = el;
      measure();
    },
    [measure],
  );

  /*
   * Re-measured on every render, on resize and whenever the contents change —
   * a kind's strip declaration arrives one chunk late on first selection, and
   * the chip row gains a chip when a module registers one.
   */
  useEffect(() => {
    const el = node.current;
    if (el === null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    return () => {
      observer.disconnect();
    };
  });

  const onWheel = useCallback(
    (event: WheelEvent<HTMLElement>): void => {
      const el = event.currentTarget;
      if (event.deltaX !== 0 || event.deltaY === 0) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return;
      const next = Math.max(0, Math.min(max, el.scrollLeft + event.deltaY));
      if (next === el.scrollLeft) return;
      el.scrollLeft = next;
      measure();
    },
    [measure],
  );

  return { attach, clipped, remeasure: measure, onWheel };
}
