/**
 * One gesture, one history entry, N previews.
 *
 * A drag is not N edits. `beginGesture` captures the layer as it was,
 * `applyGesture` answers "what would it look like right now" (cheap, pure, no
 * commit — the caller hands the result to `compositor.preview()`, which is one
 * style write and never a React render, I4), and `endGesture` produces the ONE
 * look that goes into the store and the ONE entry that goes into the undo ring.
 * Undoing a drag puts the layer back where the finger went down, not at the
 * penultimate frame of the drag.
 *
 * Everything is in UNITS. The caller converts screen px to units through its own
 * surface scale (`frame.width / panel.w` on the halo, `RING_PX / display.w` on
 * the phone), which is why the same gesture code drives both.
 *
 * Scale is uniform and about the layer's CENTRE. `endGesture` is where the
 * §3.2 split happens: a `resize:'frame'` kind commits its BOX and leaves `t.s`
 * exactly where it started (crisp text), a `resize:'scale'` kind commits `t.s`.
 *
 * See docs/design/design-layers-architecture.md §8.
 */

import { setFrame, setTransform } from './ops';
import { snap, type Guide, type SnapPanel, type SnapRender } from './snap';

import type { EditorRegistry } from './registryPort';
import type { Layer, Look, LayerId, Transform, Units } from '../../../state/look/types';

export type GestureHandle = 'move' | 'scale-nw' | 'scale-ne' | 'scale-se' | 'scale-sw' | 'rotate';

export interface UnitPoint {
  x: Units;
  y: Units;
}

/**
 * What a gesture needs to know that is not the layer: the rest of the look (to
 * snap against), the panel's shape, the safe ring, and the registry (to know
 * what a resize means for this kind).
 */
export interface GestureContext {
  look: Look;
  registry: EditorRegistry;
  panel: SnapPanel;
  render: SnapRender;
}

export interface GestureState {
  readonly id: LayerId;
  readonly handle: GestureHandle;
  readonly layer: Layer;
  /** The transform at finger-down. Undo returns here. */
  readonly start: Transform;
  readonly p0: UnitPoint;
  readonly resize: 'frame' | 'scale';
  readonly ctx: GestureContext;
  /** The most recent `applyGesture` result — what `endGesture` commits. */
  current: Transform;
  /** The guides that explain `current`, for the editor to draw. */
  guides: Guide[];
}

const DEG = 180 / Math.PI;
/** Below this the scale pivot is degenerate and a factor would be meaningless. */
const MIN_GRAB_RADIUS = 1e-3;

function isScale(handle: GestureHandle): boolean {
  return handle.startsWith('scale-');
}

/** Degrees into (-180, 180]. 180 stays 180: the model's limit is inclusive. */
function wrap180(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return Object.is(d, -0) ? 0 : d;
}

export function beginGesture(
  layer: Layer,
  handle: GestureHandle,
  p0: UnitPoint,
  ctx: GestureContext,
): GestureState {
  const start = { ...layer.t };
  return {
    id: layer.id,
    handle,
    layer,
    start,
    p0: { ...p0 },
    resize: ctx.registry.placementOf(layer.kind)?.resize ?? 'scale',
    ctx,
    current: start,
    guides: [],
  };
}

/**
 * The transform the layer would have if the finger stopped here.
 *
 * `mods.snap` is the modifier state, not a mode: holding the key OFF gives raw
 * placement, which is the escape hatch for the one pixel the guides refuse to
 * let you reach.
 */
export function applyGesture(
  gs: GestureState,
  p: UnitPoint,
  mods: { snap: boolean } = { snap: true },
): Transform {
  const { start, p0 } = gs;
  let next: Transform = { ...start };

  if (gs.handle === 'move') {
    next.x = start.x + (p.x - p0.x);
    next.y = start.y + (p.y - p0.y);
  } else if (gs.handle === 'rotate') {
    const a0 = Math.atan2(p0.y - start.y, p0.x - start.x) * DEG;
    const a1 = Math.atan2(p.y - start.y, p.x - start.x) * DEG;
    next.r = wrap180(start.r + (a1 - a0));
  } else if (isScale(gs.handle)) {
    const d0 = Math.hypot(p0.x - start.x, p0.y - start.y);
    const d1 = Math.hypot(p.x - start.x, p.y - start.y);
    const factor = d0 < MIN_GRAB_RADIUS ? 1 : d1 / d0;
    next.s = start.s * factor;
  }

  if (mods.snap && !isScale(gs.handle)) {
    const snapped = snap(next, { ...gs.layer, t: next }, gs.ctx.look, gs.ctx.panel, gs.ctx.render);
    next = snapped.t;
    gs.guides = snapped.guides;
  } else {
    gs.guides = [];
  }

  gs.current = next;
  return next;
}

/**
 * Commit the gesture: exactly one look, for exactly one history entry.
 *
 * A scale on a `resize:'frame'` kind is the interesting case — the preview was
 * a CSS scale (one style write per frame, no re-layout), and on release the box
 * grows by the same factor while `t.s` returns to where it started. That is why
 * a clock dragged twice as big is still crisp instead of a blurry bitmap.
 */
export function endGesture(gs: GestureState, look: Look): Look {
  const { id, current, start } = gs;

  if (gs.handle === 'move') {
    return setTransform(look, id, { x: current.x, y: current.y });
  }
  if (gs.handle === 'rotate') {
    return setTransform(look, id, { r: current.r });
  }

  const factor = start.s === 0 ? 1 : current.s / start.s;
  const layer = look.layers.find((l) => l.id === id);
  if (layer === undefined || layer.frame === 'panel') return look;

  if (gs.resize === 'frame') {
    const sized = setFrame(
      look,
      id,
      { w: layer.frame.w * factor, h: layer.frame.h * factor, shape: layer.frame.shape },
      gs.ctx.registry,
    );
    return setTransform(sized, id, { s: start.s });
  }
  return setTransform(look, id, { s: current.s });
}
