/**
 * STEP 2 — the imperative display renderer.
 *
 * `host` is an empty, absolutely-positioned div sized to the viewport; own it
 * entirely. Read sizes from `ctx.geometry()`, never from a literal: the same
 * code has to be right on a 640 round Elite and a 240 square Kraken.
 *
 * Anything that changes every frame belongs in `frame()` and must be written
 * straight to the DOM — never through React state (invariant I4).
 */

import { type TemplateConfig } from './schema';

import type { DisplayRenderer, ModuleContext } from '../types';

const LABEL_SCALE = 0.12;

export function createRenderer(): DisplayRenderer<TemplateConfig> {
  let root: HTMLElement | null = null;

  return {
    mount(host: HTMLElement, ctx: ModuleContext, config: TemplateConfig) {
      const g = ctx.geometry();
      root = document.createElement('div');
      root.style.cssText =
        'position:absolute;inset:0;display:grid;place-items:center;text-align:center';
      root.style.fontSize = `${String(Math.round(g.inscribedSquarePx * LABEL_SCALE))}px`;
      root.textContent = config.label;
      host.append(root);
    },

    update(config: TemplateConfig) {
      if (root !== null) root.textContent = config.label;
    },

    geometry(g) {
      if (root !== null) {
        root.style.fontSize = `${String(Math.round(g.inscribedSquarePx * LABEL_SCALE))}px`;
      }
    },

    /** MUST revoke blob URLs, clear timers and remove listeners. */
    unmount() {
      root?.remove();
      root = null;
    },
  };
}
