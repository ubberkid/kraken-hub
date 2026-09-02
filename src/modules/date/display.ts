/**
 * STEP 3 (docs/modules.md §5) — the Date layer's imperative display renderer.
 *
 * ## The one rule about time this file exists to get right
 *
 * A date changes once a day. `frame()` fires up to forty times a second, and
 * `cost().cadence` is `'tick'` — at most once a second — so the tick may not do
 * per-frame work. `minuteOf(Date.now())` is one integer compare; the string is
 * only rebuilt when that integer changes, which is once a minute, and the DOM
 * is only written when the string itself changed, which is once a day.
 *
 * A minute rather than a day because the layer must also be correct the moment
 * a config changes, a clock is corrected, or the machine comes back from
 * suspend — the clock module's `paint()` guard has exactly this shape and for
 * exactly this reason.
 *
 * ## The size rule
 *
 * Date is a `resize: 'frame'` kind (design-layers-architecture.md §3.2): the
 * editor's gesture commits `frame := frame × factor` and the layer RE-LAYS OUT,
 * so glyphs stay crisp instead of being scaled by the compositor.
 *
 *     fontPx = min(size × hostW, hostH × LINE_CAP)
 *
 * — the same rule `text/display.ts` documents, because it is the same problem:
 * `size` is the share of its box's WIDTH one em of type claims, never taller
 * than the box. A date line does not wrap (a date broken across two lines is
 * not a date), so a corrective pass shrinks the type if the formatted string is
 * wider than the box — a long weekday in a narrow frame is the case, and
 * clipping it would be the app showing half a word.
 *
 * ## The corrective pass measures the CONTENT box, not the border box (F7)
 *
 * That pass shipped comparing `line.scrollWidth` against the host's width, and
 * on a round panel it could not converge. `.kh-date__line` carries the layer's
 * own safe inset as horizontal padding — 121 px a side on a 640 Elite — so the
 * scroll width it was comparing was the glyphs PLUS 242 px of padding that does
 * not shrink when the type does. Scaling the font by `room / total` therefore
 * always overshoots: measured, "Wed, Sep 2" went from 102 px type to 87 px and
 * the line stayed 673.9 px wide inside a 640 px panel, with the same failure at
 * 320 (337.2 px). One panel in three passed, and it was the square one, whose
 * inset is small enough for the error to vanish.
 *
 * Both numbers are now taken inside the padding: the room is the box minus the
 * two insets, and the ink is the scroll width minus the same. That difference
 * is also the whole of the round-panel fix, and not by accident — the inset the
 * platform publishes as `--kh-safe` IS the inscribed safe square on a circle
 * (`geometry.ts`, `circleSafeInsetPx`), so fitting the glyphs inside it fits
 * them inside the chord rather than inside the bounding box's corners, which a
 * circular panel does not have.
 */

import { formatDate, minuteOf } from './format';
import { DATE_DEFAULTS, type DateConfig } from './schema';

import type { Geometry } from '../../platform/geometry';
import type { DisplayRenderer, ModuleContext } from '../types';

import './date.css';

/** The share of the box's height a single line of type may claim. */
const LINE_CAP = 0.82;

/** Below this a glyph is a smudge on a compressed frame; a floor, not a size. */
const MIN_FONT_PX = 4;

interface Box {
  w: number;
  h: number;
}

/**
 * THE rule, extracted so it can be tested without a DOM. Total: a zero or
 * negative box yields the floor rather than `NaN` or a font size of 0.
 */
export function fontPxFor(size: number, box: Box): number {
  const px = Math.min(size * box.w, box.h * LINE_CAP);
  return Number.isFinite(px) && px > MIN_FONT_PX ? px : MIN_FONT_PX;
}

/**
 * The type size at which `inkPx` of glyphs fits `roomPx` of room.
 *
 * Pure, and floored rather than rounded: a rounded-up size is the one that
 * leaves the line a pixel too wide, which on this layer is the whole bug. Both
 * arguments must be measured INSIDE the line's padding — see the note at the
 * top of the file.
 */
export function shrinkToFit(px: number, inkPx: number, roomPx: number): number {
  if (!(inkPx > roomPx) || !(inkPx > 0) || !(roomPx > 0)) return px;
  return Math.max(Math.floor((px * roomPx) / inkPx), MIN_FONT_PX);
}

/**
 * How many times the fit is allowed to run.
 *
 * The shrink is linear in the font size, so the first pass is the answer and
 * the second only mops up the floor's rounding. Three is a bound, not a budget.
 */
const MAX_FIT_PASSES = 3;

/** The layer's own safe inset, as the stylesheet applied it to the line. */
function insetPxOf(el: HTMLElement): number {
  if (typeof getComputedStyle !== 'function') return 0;
  const n = Number.parseFloat(getComputedStyle(el).paddingLeft);
  return Number.isFinite(n) ? n : 0;
}

export function createRenderer(): DisplayRenderer<DateConfig> {
  let root: HTMLElement | null = null;
  let line: HTMLElement | null = null;
  let hostRef: HTMLElement | null = null;
  let ctxRef: ModuleContext | null = null;
  let observer: ResizeObserver | null = null;
  let cfg: DateConfig = DATE_DEFAULTS;
  let reported: Geometry | null = null;
  /** The tick guard: the minute the painted line was formatted in. */
  let paintedMinute = Number.NaN;
  /** The write guard: the text actually in the DOM. */
  let paintedText = '';

  const measure = (): Box => {
    if (hostRef !== null) {
      const rect = hostRef.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return { w: rect.width, h: rect.height };
    }
    const g: Geometry | null = reported ?? ctxRef?.geometry() ?? null;
    return g === null ? { w: 0, h: 0 } : { w: g.width, h: g.height };
  };

  const layout = (): void => {
    if (line === null) return;
    const box = measure();
    let px = Math.round(fontPxFor(cfg.size, box));
    line.style.fontSize = `${String(px)}px`;

    /*
     * A long weekday in a narrow frame gets smaller type rather than a clipped
     * word — measured inside the line's own safe padding at both ends, which is
     * what makes the pass converge and what keeps the glyphs inside a round
     * panel's chord rather than inside its bounding box. `scrollWidth` is 0 in
     * an unlaid-out host, so the guard is on the measurement, not on the branch.
     */
    const inset = insetPxOf(line);
    const room = box.w - inset * 2;
    if (!(room > 0)) return;
    for (let pass = 0; pass < MAX_FIT_PASSES; pass += 1) {
      const ink = line.scrollWidth - inset * 2;
      const next = shrinkToFit(px, ink, room);
      if (next >= px) break;
      px = next;
      line.style.fontSize = `${String(px)}px`;
    }
  };

  /** Everything that is a pure function of the config. */
  const style = (): void => {
    if (root === null || line === null) return;
    root.classList.toggle('kh-date--upper', cfg.uppercase);
    root.style.color = cfg.color;
    line.style.fontWeight = String(cfg.weight);
  };

  /**
   * The line, for one instant. `force` is what a config change passes: the
   * minute has not moved, but the FORMAT has.
   */
  const paint = (now: Date, force: boolean): void => {
    if (line === null) return;
    const minute = minuteOf(now.getTime());
    if (!force && minute === paintedMinute) return;
    paintedMinute = minute;

    const text = formatDate(now, cfg.format, cfg.locale);
    if (text === paintedText) return;
    paintedText = text;
    line.textContent = text;
    layout();
  };

  return {
    mount(host: HTMLElement, ctx: ModuleContext, config: DateConfig) {
      hostRef = host;
      ctxRef = ctx;
      cfg = config;

      root = document.createElement('div');
      root.className = 'kh-date';
      line = document.createElement('div');
      line.className = 'kh-date__line';
      root.append(line);
      host.append(root);

      style();
      paint(new Date(), true);
      layout();

      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(() => {
          layout();
        });
        observer.observe(host);
      }
    },

    update(config: DateConfig) {
      cfg = config;
      style();
      paint(new Date(), true);
      layout();
    },

    /**
     * One integer compare per frame, one `Intl` format per minute, one DOM
     * write per day. This is what `cadence: 'tick'` promises.
     */
    frame() {
      paint(new Date(), false);
    },

    geometry(g) {
      reported = g;
      layout();
    },

    reinit() {
      // Idempotent: clearing both guards makes the next paint rewrite the line,
      // and rewriting the same line changes nothing.
      paintedMinute = Number.NaN;
      paintedText = '';
      style();
      paint(new Date(), true);
      layout();
    },

    unmount() {
      observer?.disconnect();
      observer = null;
      root?.remove();
      root = null;
      line = null;
      hostRef = null;
      ctxRef = null;
      reported = null;
      paintedMinute = Number.NaN;
      paintedText = '';
    },
  };
}
