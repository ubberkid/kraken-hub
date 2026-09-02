/**
 * STEP 3 (docs/modules.md §5) — the Shape layer's imperative display renderer.
 *
 * It is deliberately thin. All the geometry is in `svg.ts`, which is pure and
 * unit-tested in node; this file measures the box, asks for the markup, and
 * writes it once. There is no `frame()` — nothing here changes over time, which
 * is why `motionLevel` is `'static'` and `cost().cadence` agrees.
 *
 * `innerHTML` rather than `createElementNS`, exactly as the clock's dial does
 * it: the HTML parser puts `<svg>` in the SVG namespace by itself, so this
 * avoids naming the namespace URI — a string that invariant 4's "no hardcoded
 * origins" rule cannot tell from a real origin, and rightly refuses to
 * special-case. Every value interpolated into that markup has been through
 * `validateShape()` and is a hex colour, the literal `none`, or a number.
 *
 * The box comes from a `ResizeObserver` on the host — the compositor's own div —
 * with this layer's `Geometry` as the fallback for the first paint and for any
 * environment without an observer. A repaint costs one string build and one
 * `innerHTML` write, and only happens when the config or the box changed.
 */

import { SHAPE_DEFAULTS, type ShapeConfig } from './schema';
import { shapeMarkup, type ShapeBox } from './svg';

import type { Geometry } from '../../platform/geometry';
import type { DisplayRenderer, ModuleContext } from '../types';

import './shape.css';

export function createRenderer(): DisplayRenderer<ShapeConfig> {
  let root: HTMLElement | null = null;
  let hostRef: HTMLElement | null = null;
  let ctxRef: ModuleContext | null = null;
  let observer: ResizeObserver | null = null;
  let cfg: ShapeConfig = SHAPE_DEFAULTS;
  /**
   * The last geometry the shell REPORTED. Not the same thing as
   * `ctx.geometry()`: the compositor hands `geometry(g)` this layer's new box,
   * and the context object may still be the one captured at mount. Preferring
   * the report is what makes a frame change repaint.
   */
  let reported: Geometry | null = null;
  /** The repaint guard: the markup we last wrote. */
  let painted = '';

  const measure = (): ShapeBox => {
    if (hostRef !== null) {
      const rect = hostRef.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return { w: rect.width, h: rect.height };
    }
    const g: Geometry | null = reported ?? ctxRef?.geometry() ?? null;
    return g === null ? { w: 0, h: 0 } : { w: g.width, h: g.height };
  };

  const paint = (): void => {
    if (root === null) return;
    const markup = shapeMarkup(cfg, measure());
    if (markup === painted) return;
    painted = markup;
    root.innerHTML = markup;
  };

  return {
    mount(host: HTMLElement, ctx: ModuleContext, config: ShapeConfig) {
      hostRef = host;
      ctxRef = ctx;
      cfg = config;

      root = document.createElement('div');
      root.className = 'kh-shape';
      host.append(root);
      paint();

      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(() => {
          paint();
        });
        observer.observe(host);
      }
    },

    update(config: ShapeConfig) {
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
