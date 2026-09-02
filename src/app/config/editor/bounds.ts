/**
 * "May be cut by the bezel."
 *
 * The safe circle is NOT a clip (§2.7): the stage mask clips the whole stack to
 * the bezel and nothing else does. So a layer sitting half outside the visible
 * disc renders exactly as asked and is simply half invisible on the hardware —
 * which is fine for a photo bleeding to the edge and a disaster for a clock.
 *
 * The app therefore does not police it; it SAYS it. This predicate is the whole
 * mechanism behind that sentence: the editor shows the warning when it is true,
 * and never blocks the placement.
 *
 * Both surfaces (halo and phone ring) call this with their own panel geometry
 * and get the same answer, because it runs on the same `layerBounds()` the
 * compositor positions the host with.
 */

import { layerBounds } from '../../../render/layerBox';
import { isInsideSafeCircle } from '../../../render/safeArea';

import type { GeometryRender, Geometry } from '../../../platform/geometry';
import type { Layer } from '../../../state/look/types';

/**
 * Is any transformed corner of this layer outside the visible disc?
 *
 * The base is never "outside": it wears the panel, and full-bleed content is
 * MEANT to reach the bezel.
 */
export function outsideSafeCircle(layer: Layer, panel: Geometry, render: GeometryRender): boolean {
  if (layer.frame === 'panel') return false;
  const { corners } = layerBounds(layer, panel);
  const shape = { width: panel.width, height: panel.height, shape: panel.shape };
  return corners.some(([x, y]) => !isInsideSafeCircle(shape, render.safeRadiusPct, x, y));
}
