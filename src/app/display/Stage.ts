import { el, setAttr, setClass } from './dom';

import type { Geometry } from '../../platform/geometry';

import './display.css';

/**
 * The host element for everything on the LCD.
 *
 * `contain: strict` keeps a misbehaving module from affecting layout outside
 * the stage, and the round mask (applied only when the panel really is round,
 * or when the user forced it) both prevents corner bleed into CAM's capture and
 * pins the invisible corners to flat black.
 *
 * The circle is also drawn under the simulator so a developer sees exactly what
 * the panel will clip — that is the whole point of the preview bezel.
 *
 * W9: the same element and the same four attributes it always had, built and
 * updated directly instead of re-rendered. `update` writes only what changed,
 * so a geometry tick that moves nothing touches nothing.
 */
export interface Stage {
  root: HTMLDivElement;
  update(geometry: Geometry, masked: boolean, background: string): void;
}

export function createStage(): Stage {
  const root = el('div', { class: 'kh-stage' });
  /*
   * The AUTHORED value, remembered. `style.background` reads back normalised
   * (`#123456` → `rgb(18, 52, 86)`), so comparing against the element would
   * report a change on every update and rewrite the declaration for nothing.
   */
  let background: string | null = null;
  return {
    root,
    update(geometry, masked, next) {
      setClass(root, masked ? 'kh-stage kh-stage--circle' : 'kh-stage');
      setAttr(root, 'data-shape', geometry.shape);
      setAttr(root, 'data-target-fps', String(geometry.targetFps));
      if (next !== background) {
        background = next;
        root.style.background = next;
      }
    },
  };
}
