import { CAM_PATH_CONFIGURE } from '../../config/camPaths';

import { el } from './dom';

/**
 * The one thing a user can see when a module fails on a device with no input.
 *
 * Low entropy on purpose: flat black, a few large glyphs, no gradients and no
 * animation, so CAM's frame compressor has almost nothing to encode. The footer
 * is fixed text because it is the only actionable instruction that exists on a
 * screen you cannot click — and it is still the ONE spelling of that
 * destination, imported from `camPaths.ts` rather than typed here.
 */
export function moduleErrorCard(title: string, detail: string): HTMLDivElement {
  return el('div', { class: 'kh-overlay kh-error' }, [
    el('div', { class: 'kh-card' }, [
      el('p', { class: 'kh-card__title' }, title),
      el('p', { class: 'kh-card__body' }, detail),
      el('p', { class: 'kh-card__footer' }, `Fix in ${CAM_PATH_CONFIGURE}`),
    ]),
  ]);
}
