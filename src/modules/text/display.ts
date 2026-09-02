/**
 * STEP 3 (docs/modules.md §5) — the Text layer's imperative display renderer.
 *
 * ## The one rule this file exists to get right
 *
 * Text is a `resize: 'frame'` kind (design-layers-architecture.md §3.2): the
 * editor's resize gesture commits `frame := frame × factor` and leaves `t.s` at
 * 1, so the layer RE-LAYS OUT at the new size instead of being scaled by the
 * compositor. Crisp glyphs, not a stretched bitmap — and the price is that this
 * renderer has to know how big its box actually is.
 *
 *     fontPx = min(size × hostW, hostH × LINE_CAP)
 *
 * Read it as: **`size` is the share of its box's WIDTH that one em of type
 * claims, never taller than the box.** Width, because a line of text runs along
 * the width and a text layer's frame is wide and short by default
 * (`{w:1.2,h:0.3}` — a banner). The `LINE_CAP` term is what stops a nearly
 * square box from producing type taller than the box that holds it; the clock's
 * digital face caps its digits the same way and for the same reason.
 *
 * The rule is a function of the BOX, so it is identical on a 640 round Elite
 * and a 240 square Kraken — the box is in unit-radius diameters and the panel
 * only ever enters through `radiusPx`. `size.test.ts` pins it at three host
 * sizes with no device literal in sight.
 *
 * ## How the box is measured
 *
 * `ResizeObserver` on the host, which is the compositor's own div: a frame
 * change resizes the host and the observer fires, so a re-layout costs nothing
 * on the frames where nothing changed. `ctx.geometry()` is the fallback for the
 * first paint and for any environment without an observer — it reports this
 * LAYER's derived geometry, so it agrees with the host by construction.
 *
 * There is no `frame()`. Nothing here changes over time; `motionLevel` is
 * `'static'` and `cost().cadence` is `'static'`, and both are true.
 */

import { ensureFontLoaded } from './fonts';
import { TEXT_DEFAULTS, TEXT_FACES, type TextAlign, type TextConfig } from './schema';

import type { Geometry } from '../../platform/geometry';
import type { DisplayRenderer, ModuleContext } from '../types';

import './text.css';

/**
 * The share of the box's height a single line of type may claim.
 *
 * `line-height: 1.1` in `text.css` plus a little room for descenders: a cap of
 * 1 would let a one-line layer clip its own tails at the box edge.
 */
const LINE_CAP = 0.82;

/** Below this a glyph is a smudge on a compressed frame; it is a floor, not a size. */
const MIN_FONT_PX = 4;

/**
 * `align` as a main-axis alignment.
 *
 * The physical keywords rather than `start`/`end`: this layer's writing
 * direction is the panel's, `align` means what the person picking it thinks it
 * means, and a logical keyword would quietly flip the layout on an RTL page
 * that the LCD does not have and cannot have.
 */
export const FLEX_ALIGN: Readonly<Record<TextAlign, string>> = {
  left: 'flex-start',
  center: 'center',
  right: 'flex-end',
};

interface Box {
  w: number;
  h: number;
}

/**
 * THE rule, extracted so it can be tested without a DOM.
 *
 * Pure, and deliberately total: a zero or negative box (a host that has not
 * been laid out yet, an observer firing during teardown) yields the floor
 * rather than `NaN` or a font size of 0.
 */
export function fontPxFor(size: number, box: Box): number {
  const byWidth = size * box.w;
  const byHeight = box.h * LINE_CAP;
  const px = Math.min(byWidth, byHeight);
  return Number.isFinite(px) && px > MIN_FONT_PX ? px : MIN_FONT_PX;
}

export function createRenderer(): DisplayRenderer<TextConfig> {
  let root: HTMLElement | null = null;
  let line: HTMLElement | null = null;
  let hostRef: HTMLElement | null = null;
  let ctxRef: ModuleContext | null = null;
  let observer: ResizeObserver | null = null;
  let cfg: TextConfig = TEXT_DEFAULTS;
  /**
   * The last geometry the shell REPORTED, which is not always what
   * `ctx.geometry()` answers: the compositor hands `geometry(g)` this layer's
   * new box and the context object is free to be the one captured at mount.
   * Preferring the report is what makes a frame change re-lay out.
   */
  let reported: Geometry | null = null;

  /** The host's real box, falling back to this layer's derived geometry. */
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
    line.style.fontSize = `${String(Math.round(fontPxFor(cfg.size, measure())))}px`;
  };

  /** Everything that is a pure function of the config. */
  const apply = (): void => {
    if (root === null || line === null) return;
    if (cfg.font !== 'system') ensureFontLoaded(cfg.font);

    root.classList.toggle('kh-text--upper', cfg.uppercase);
    root.classList.toggle('kh-text--shadow', cfg.shadow);
    root.style.color = cfg.color;
    root.style.textAlign = cfg.align;
    /*
     * The horizontal half of "the visual centre is the anchor" (see text.css).
     *
     * `text-align` alone puts a short line in the right place inside a line box
     * that still spans the whole layer, so the rendered TEXT and the layer box
     * only share a centre by accident. Centring the flex item as well makes the
     * two the same thing by construction, and `text-align` stays because it is
     * what aligns the second and third lines of a line that wrapped.
     */
    root.style.justifyContent = FLEX_ALIGN[cfg.align];

    line.style.fontFamily = TEXT_FACES[cfg.font].stack;
    line.style.fontWeight = String(cfg.weight);
    line.style.letterSpacing = `${String(cfg.letterSpacing)}em`;
    if (line.textContent !== cfg.text) line.textContent = cfg.text;
  };

  return {
    mount(host: HTMLElement, ctx: ModuleContext, config: TextConfig) {
      hostRef = host;
      ctxRef = ctx;
      cfg = config;

      root = document.createElement('div');
      root.className = 'kh-text';
      line = document.createElement('div');
      line.className = 'kh-text__line';
      root.append(line);
      host.append(root);

      apply();
      layout();

      // A frame change resizes the host; the observer is what turns that into a
      // re-layout without a per-frame measurement. Guarded because jsdom (and
      // any older engine) may not have one — `geometry()` still covers the case.
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(() => {
          layout();
        });
        observer.observe(host);
      }
    },

    update(config: TextConfig) {
      cfg = config;
      apply();
      layout();
    },

    geometry(g) {
      reported = g;
      layout();
    },

    reinit() {
      apply();
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
    },
  };
}
