/**
 * The video engine's view of the fit math.
 *
 * The generic half moved to `src/render/fit.ts` in M3, so the image module can
 * reuse it without importing the video module (invariant I6, and a chunking
 * rule: a group claims its matched modules *and their dependencies*, so an
 * `src/modules/video/**` import would have pulled the whole player into the
 * image module's chunk). What is left here is the part that is genuinely about
 * *providers* — the two helpers that know some sources paint their own chrome.
 */

import { PAN_LIMIT, ZOOM_MAX, ZOOM_MIN } from '../types';

import type { ProviderCapabilities, Rect, RenderConfig, SourceRect } from '../types';

export {
  FIT_DECIMALS,
  computeFit,
  inscribeInCircle,
  toTransformCss,
  type FitInput,
  type FitResult,
} from '../../../render/fit';

/**
 * §4.1 — `cover` always uses the chrome-free rect; the others may use the full
 * media rect, but only with explicit consent, because on a provider that paints
 * its own UI `full` includes that UI.
 */
export function pickSourceRect(
  source: SourceRect,
  render: Pick<RenderConfig, 'fit' | 'allowChrome'>,
): Rect {
  if (render.fit === 'cover') return source.safe;
  return render.allowChrome ? source.full : source.safe;
}

/**
 * §4.1 — on a provider that paints its own chrome, `contain` on the *safe* rect
 * is a square crop contained in a square panel, i.e. visually identical to
 * `cover`. Rather than ship that confusion, `fit` is forced to `cover` unless
 * the user explicitly allows chrome.
 */
export function effectiveFit(
  fit: RenderConfig['fit'],
  caps: Pick<ProviderCapabilities, 'hasOwnChrome'>,
  allowChrome: boolean,
): RenderConfig['fit'] {
  return caps.hasOwnChrome && !allowChrome ? 'cover' : fit;
}

export { PAN_LIMIT, ZOOM_MAX, ZOOM_MIN };
