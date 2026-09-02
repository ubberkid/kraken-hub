/**
 * STEP 3 (docs/modules.md §5) — the Icon layer's imperative display renderer.
 *
 * Deliberately thin, in the shape `shape/display.ts` set: all the geometry is in
 * `svg.ts`, which is pure and unit-tested in node; this file measures the box,
 * asks for the markup, and writes it once. There is no `frame()` — nothing here
 * changes over time, which is why `motionLevel` is `'static'` and
 * `cost().cadence` agrees.
 *
 * `innerHTML` rather than `createElementNS`, exactly as the clock's dial and the
 * shape module do it: the HTML parser puts `<svg>` in the SVG namespace by
 * itself, so this avoids naming the namespace URI — a string invariant 4's "no
 * hardcoded origins" rule cannot tell from a real origin. Every value
 * interpolated into that markup has been through `validateIcon()` and is a hex
 * colour, a number, or path data from this repository's own table.
 *
 * The box comes from a `ResizeObserver` on the host — the compositor's own div —
 * with this layer's `Geometry` as the fallback for the first paint and for any
 * environment without an observer. A repaint costs one string build and one
 * `innerHTML` write, and only happens when the config or the box changed.
 */

import { ICON_DEFAULTS, type IconConfig } from './schema';
import { iconMarkup, iconSidePx, type IconBox } from './svg';

import type { Geometry } from '../../platform/geometry';
import type { DisplayRenderer, ModuleContext } from '../types';

import './icon.css';

export function createRenderer(): DisplayRenderer<IconConfig> {
  let root: HTMLElement | null = null;
  let hostRef: HTMLElement | null = null;
  let ctxRef: ModuleContext | null = null;
  let observer: ResizeObserver | null = null;
  let cfg: IconConfig = ICON_DEFAULTS;
  /**
   * The last geometry the shell REPORTED. Not the same thing as
   * `ctx.geometry()`: the compositor hands `geometry(g)` this layer's new box
   * and the context object may still be the one captured at mount. Preferring
   * the report is what makes a frame change re-fit the glyph.
   */
  let reported: Geometry | null = null;
  /** The repaint guard: the markup we last wrote. */
  let painted = '';

  const measure = (): IconBox => {
    if (hostRef !== null) {
      const rect = hostRef.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return { w: rect.width, h: rect.height };
    }
    const g: Geometry | null = reported ?? ctxRef?.geometry() ?? null;
    return g === null ? { w: 0, h: 0 } : { w: g.width, h: g.height };
  };

  const paint = (): void => {
    if (root === null) return;
    root.classList.toggle('kh-icon--glow', cfg.glow);
    const markup = iconMarkup(cfg, iconSidePx(cfg.size, measure()));
    if (markup === painted) return;
    painted = markup;
    root.innerHTML = markup;
  };

  return {
    mount(host: HTMLElement, ctx: ModuleContext, config: IconConfig) {
      hostRef = host;
      ctxRef = ctx;
      cfg = config;

      root = document.createElement('div');
      root.className = 'kh-icon';
      host.append(root);
      paint();

      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(() => {
          paint();
        });
        observer.observe(host);
      }
    },

    update(config: IconConfig) {
      cfg = config;
      paint();
    },

    geometry(g) {
      reported = g;
      paint();
    },

    reinit() {
      // Idempotent by construction: clearing the guard makes the next paint
      // rewrite the markup, and rewriting identical markup changes nothing.
      painted = '';
      paint();
    },

    unmount() {
      observer?.disconnect();
      observer = null;
      root?.remove();
      root = null;
      hostRef = null;
      ctxRef = null;
      reported = null;
      painted = '';
    },
  };
}
