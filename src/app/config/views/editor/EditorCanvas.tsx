/**
 * The canvas IS the halo — principle 1.
 *
 * Not a thumbnail beside a form, and not a stylised disc that stands for the
 * panel: a real `LayerHost`, running the real display renderers, at the largest
 * size the window allows. What you drag is what the Kraken shows, because it is
 * the same compositor, the same `layerBox` maths and the same modules
 * (`previewRegistry.ts` swaps exactly one kind, and says why).
 *
 * ## Three things here are load-bearing
 *
 *  - **The overlays are a separate SVG above the mirror** (§2.1, invariant I8).
 *    Nothing the editor draws — the box, the handles, the guides, the HUD —
 *    exists inside the display bundle, so a look composited here and a look
 *    composited on the LCD are byte-identical DOM.
 *  - **A drag is a style write, never a render** (I4). `applyGesture` runs on
 *    the pointer event, the result goes straight onto the host's `transform`
 *    and onto the overlay's own attributes, and React hears about it once, on
 *    release, as one history entry.
 *  - **The host is sized to the PANEL and scaled down by CSS.** Every module
 *    lays itself out against `geometry()`, not against its container, so a
 *    stats face tuned for a 240 px square must be laid out at 240 px and then
 *    shrunk — never laid out at halo size and called a mirror. That is the same
 *    rule `replica.ts` follows for the phone's ring.
 *
 * ## Two components, because there are two mirrors — §8
 *
 * The phone edits the same Look, and its canvas is the remote's replica ring:
 * a live module renderer this file must not mount a second copy of, at a
 * geometry the display reported rather than one CAM chose. What the two
 * surfaces genuinely share is the layer above the mirror — the box, the
 * handles, the guides, the HUD, and every pointer that lands on them — so that
 * layer is {@link EditorOverlay}, and this component is what remains: the
 * compositor, the measurement, and zoom.
 *
 * The overlay takes its mirror as three functions ({@link EditorOverlayProps}:
 * where the stage is on screen, how to paint a preview, which frame clock to
 * settle on) rather than reaching for a ref, which is the whole of the seam.
 * Nothing about the desktop path changed when the phone arrived: `touch` is
 * `false` here, and every touch-only branch in the overlay begins by asking.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { getModule } from '../../../../modules/registry';
import { createFrameClock } from '../../../../platform/fpsGovernor';
import {
  hitTest,
  layerBounds,
  layerMatrix,
  transformCss,
  type Mat2x3,
} from '../../../../render/layerBox';
import { LayerHost } from '../../../../render/LayerHost';
import { configsOf } from '../../../../render/lookOf';
import {
  BASE_LAYER_ID,
  type Layer,
  type LayerId,
  type Transform,
} from '../../../../state/look/types';
import { outsideSafeCircle } from '../../editor/bounds';
import {
  beginGesture,
  applyGesture,
  endGesture,
  type GestureContext,
  type GestureHandle,
  type GestureState,
  type UnitPoint,
} from '../../editor/gesture';
import { createPreviewMonitoring } from '../../editor/previewMonitoring';
import { previewRegistry } from '../../editor/previewRegistry';
import { signed } from '../../editor/signed';
import { prefersReducedMotion, settle } from '../../editor/spring';
import {
  LONG_PRESS_SLOP_UNITS,
  pinchFactor,
  rotateDrivePoint,
  scaleDrivePoint,
  twistDegrees,
  twoFingerIntent,
  LONG_PRESS_MS,
  type TwoFingerIntent,
  type TwoFingerSample,
} from '../../editor/touchGesture';

import type { FrameClock } from '../../../../platform/fpsGovernor';
import type { Geometry } from '../../../../platform/geometry';
import type { AppState, RenderSettings } from '../../../../state/schema';
import type { MonitorSnapshot } from '../../../../sync/monitorSnapshot';
import type { Guide } from '../../editor/snap';
import type { EditorApi } from '../../editor/useEditor';
import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from 'react';

/** §2.1: 0.5× to 2×, wheel or pinch, double-tap to fit. */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2;
const ZOOM_STEP = 0.0015;

/**
 * Handle hit targets, in SCREEN pixels — §2.1's "≥ 24 px (44 on touch)".
 *
 * Drawn at `HANDLE_PX` and hit at `HANDLE_TOUCH_PX` on a coarse pointer, which
 * is why the drawn circle and the `<circle>` that takes the event are two
 * different radii: a 44 px dot on a 400 px halo would cover the thing it is
 * meant to be a handle for.
 */
export const HANDLE_PX = 24;
export const HANDLE_TOUCH_PX = 44;

/** The rotate lollipop's stem, in screen px above the box. */
const LOLLIPOP_PX = 28;

const SCALE_HANDLES: readonly { handle: GestureHandle; corner: number }[] = [
  { handle: 'scale-nw', corner: 0 },
  { handle: 'scale-ne', corner: 1 },
  { handle: 'scale-se', corner: 2 },
  { handle: 'scale-sw', corner: 3 },
];

interface Marquee {
  x0: number;
  y0: number;
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// The overlay's own arithmetic — how a box follows a finger (F3)
// ---------------------------------------------------------------------------

/**
 * The audit's F3, in one paragraph.
 *
 * The selection box and its five handles are drawn from `layerBounds(layer)`,
 * and `layer` is the COMMITTED layer — which by design does not move until the
 * finger comes up (one gesture, one history entry). So the cursor travelled
 * −90, −90 and every handle centre travelled 0, 0, and the box the user was
 * dragging by sat exactly where they had picked it up until they let go.
 *
 * Re-rendering the overlay per frame would fix it and break invariant I4. What
 * actually has to happen is what happens to the layer itself: ONE attribute
 * write, on ONE element, per frame. The overlay is drawn in panel coordinates
 * and the layer's own position is an affine map in the same space, so the map
 * that takes the box from where it was to where the finger is right now is
 *
 *     M(now) · M(start)⁻¹
 *
 * — and writing that on the group that holds the box, the handles and the
 * lollipop moves all seven of them together, for free, with no React at all.
 */

/** Invert a CSS-order affine. `null` for the degenerate case (`s → 0`). */
function invert(m: Mat2x3): Mat2x3 | null {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (det === 0 || !Number.isFinite(det)) return null;
  return [
    d / det,
    -b / det,
    -c / det,
    a / det,
    (c * f - d * e) / det,
    (b * e - a * f) / det,
  ] as const;
}

/** `a ∘ b` — apply `b`, then `a`. */
function compose(a: Mat2x3, b: Mat2x3): Mat2x3 {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ] as const;
}

function matrixAttr(m: Mat2x3): string {
  return `matrix(${m.map((v) => String(Math.round(v * 1e4) / 1e4)).join(',')})`;
}

/** The affine a group gesture is applying, in PANEL px. */
function groupMatrix(
  handle: GestureHandle,
  centre: { x: number; y: number },
  from: UnitPoint,
  to: UnitPoint,
  panel: Geometry,
): Mat2x3 {
  const r = panel.radiusPx;
  const cx = panel.width / 2 + centre.x * r;
  const cy = panel.height / 2 + centre.y * r;
  if (handle === 'move') {
    return [1, 0, 0, 1, (to.x - from.x) * r, (to.y - from.y) * r] as const;
  }
  if (handle === 'rotate') {
    const rad =
      Math.atan2(to.y - centre.y, to.x - centre.x) -
      Math.atan2(from.y - centre.y, from.x - centre.x);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return [cos, sin, -sin, cos, cx - cx * cos + cy * sin, cy - cx * sin - cy * cos] as const;
  }
  const f = groupScaleFactor(centre, from, to);
  return [f, 0, 0, f, cx * (1 - f), cy * (1 - f)] as const;
}

/**
 * A group scale is the ratio of two radii from the group's centre.
 *
 * Clamped away from zero at the bottom because a finger that lands ON the
 * centre would otherwise divide by nothing, and capped at the top because a
 * gesture is a gesture, not a catapult.
 */
function groupScaleFactor(
  centre: { x: number; y: number },
  from: UnitPoint,
  to: UnitPoint,
): number {
  const r0 = Math.hypot(from.x - centre.x, from.y - centre.y);
  const r1 = Math.hypot(to.x - centre.x, to.y - centre.y);
  if (r0 < 1e-4) return 1;
  return Math.max(0.05, Math.min(20, r1 / r0));
}

/** What a group gesture is doing to each of its members, in the model. */
function groupPatch(
  handle: GestureHandle,
  centre: { x: number; y: number },
  from: UnitPoint,
  to: UnitPoint,
  t0: Transform,
): Transform {
  if (handle === 'move') {
    return { ...t0, x: t0.x + (to.x - from.x), y: t0.y + (to.y - from.y) };
  }
  if (handle === 'rotate') {
    const rad =
      Math.atan2(to.y - centre.y, to.x - centre.x) -
      Math.atan2(from.y - centre.y, from.x - centre.x);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dx = t0.x - centre.x;
    const dy = t0.y - centre.y;
    return {
      ...t0,
      x: centre.x + dx * cos - dy * sin,
      y: centre.y + dx * sin + dy * cos,
      r: t0.r + (rad * 180) / Math.PI,
    };
  }
  const f = groupScaleFactor(centre, from, to);
  return {
    ...t0,
    x: centre.x + (t0.x - centre.x) * f,
    y: centre.y + (t0.y - centre.y) * f,
    s: t0.s * f,
  };
}

/** A look with the locked layers taken out, for hit-testing and the marquee. */
function unlockedLook(look: { layers: readonly Layer[] }): { layers: Layer[] } {
  const base = look.layers[0];
  const overlays = look.layers.slice(1).filter((l) => l.locked !== true);
  return { layers: base === undefined ? [] : [base, ...overlays] };
}

// ---------------------------------------------------------------------------
// The overlay — the layer above whichever mirror this is
// ---------------------------------------------------------------------------

export interface EditorOverlayProps {
  editor: EditorApi;
  /** The panel this mirror stands in for, at its own pixel size. */
  panel: Geometry;
  /** The safe ring, for the "may be cut" warning and for snapping. */
  render: RenderSettings;
  /** Panel px per CSS px on this surface. Every conversion divides by it. */
  k: number;
  /** Where the mirror's stage is on screen, right now. */
  rectOf: () => DOMRect | null;
  /** Paint one frame of a gesture. One style write, never a React render (I4). */
  preview: (id: LayerId, t: Transform) => void;
  /** The clock the spring settles on, or `null` for "commit immediately". */
  clockOf: () => FrameClock | null;
  /** 44 px hit targets rather than 24 (§2.1). */
  coarsePointer: boolean;
  /**
   * The phone (§8): pinch scales, two fingers twist, a long press asks.
   *
   * Off by default, and every branch that reads it is an ADDITION — the desktop
   * pointer path below is the same code it was before the phone could edit.
   */
  touch?: boolean;
  /** What a long press opens. Only ever called when `touch`. */
  onContext?: (layer: Layer) => void;
}

/**
 * The box, the handles, the guides, the HUD — and every pointer that lands.
 *
 * Split out of `EditorCanvas` so the phone's replica ring can wear it (§8).
 * It owns no mirror and no compositor: it is handed a rectangle, a way to paint
 * a preview and a clock, and it draws in the panel's own coordinate system, so
 * a 640 px Elite and a 240 px square need no special cases anywhere in it.
 */
export function EditorOverlay({
  editor,
  panel,
  render,
  k,
  rectOf,
  preview,
  clockOf,
  coarsePointer,
  touch = false,
  onContext,
}: EditorOverlayProps) {
  const gestureRef = useRef<GestureState | null>(null);
  const cancelSettleRef = useRef<(() => void) | null>(null);

  const [guides, setGuides] = useState<readonly Guide[]>([]);
  const [hud, setHud] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  /** Bumped when a drag ends, so the overlay re-reads the committed transform. */
  const [, setTick] = useState(0);

  /*
   * F3's three refs: the group the box lives in, the group a MULTI selection
   * lives in, and the HUD's own node.
   *
   * All three are written imperatively during a drag and by nothing else. React
   * does not manage a `transform` attribute it was never given as a prop, so an
   * incidental re-render (a guide appearing, say) leaves the write alone — and
   * `useLayoutEffect` below takes it back down the moment the gesture is over,
   * before the browser paints the committed position.
   */
  const selRef = useRef<SVGGElement | null>(null);
  const multiRef = useRef<SVGGElement | null>(null);
  const hudRef = useRef<HTMLParagraphElement | null>(null);
  /** `M(start)` for the single-layer gesture in flight. */
  const startMatRef = useRef<Mat2x3 | null>(null);
  /** True while the overlay's transform is ours, including the spring settle. */
  const paintingRef = useRef(false);
  /** A group gesture: what was grabbed, from where, and everyone's start. */
  const groupRef = useRef<{
    handle: GestureHandle;
    from: UnitPoint;
    centre: { x: number; y: number };
    starts: { id: LayerId; t: Transform }[];
  } | null>(null);

  useLayoutEffect(() => {
    if (paintingRef.current) return;
    selRef.current?.removeAttribute('transform');
    multiRef.current?.removeAttribute('transform');
  });

  /*
   * The touch bookkeeping — three refs, all of them empty on a desktop.
   *
   * `pointers` is what makes a second finger knowable at all; `two` is the
   * two-finger gesture in flight, including the intent it committed to on the
   * frame it cleared a dead zone; `press` is the finger that has not moved yet.
   */
  const pointersRef = useRef(new Map<number, UnitPoint>());
  const twoRef = useRef<{
    layer: Layer;
    start: TwoFingerSample;
    p0: UnitPoint;
    centre: UnitPoint;
    intent: TwoFingerIntent | null;
  } | null>(null);
  const pressRef = useRef<{
    layer: Layer;
    from: UnitPoint;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  /** CSS px on the stage → panel px. The one conversion, used by everything. */
  const toPanel = (event: {
    clientX: number;
    clientY: number;
  }): { x: number; y: number } | null => {
    const rect = rectOf();
    if (rect === null) return null;
    return { x: (event.clientX - rect.left) / k, y: (event.clientY - rect.top) / k };
  };

  /** Panel px → units, which is what the model speaks. */
  const toUnits = (pt: { x: number; y: number }): UnitPoint => ({
    x: (pt.x - panel.width / 2) / panel.radiusPx,
    y: (pt.y - panel.height / 2) / panel.radiusPx,
  });

  const gestureCtx = (): GestureContext => ({
    look: editor.look,
    registry: editor.registry,
    panel: { shape: panel.shape },
    render: { safeRadiusPct: render.safeRadiusPct },
  });

  /**
   * One attribute write, on one `<g>` — the whole of F3.
   *
   * Called from the same place `preview()` is, so the box, the five handles and
   * the lollipop travel on exactly the frames the layer does. No React.
   */
  const paintSingle = (id: LayerId, t: Transform): void => {
    const g = selRef.current;
    const m0 = startMatRef.current;
    const layer = editor.look.layers.find((l) => l.id === id);
    if (g === null || m0 === null || layer === undefined) return;
    const inverse = invert(m0);
    if (inverse === null) return;
    g.setAttribute('transform', matrixAttr(compose(layerMatrix({ ...layer, t }, panel), inverse)));
  };

  /** …and the same one write for a group, on the group's own `<g>`. */
  const paintGroup = (to: UnitPoint): void => {
    const group = groupRef.current;
    const g = multiRef.current;
    if (group === null || g === null) return;
    g.setAttribute(
      'transform',
      matrixAttr(groupMatrix(group.handle, group.centre, group.from, to, panel)),
    );
  };

  /** The HUD's text, written straight onto the node it is already in (F3). */
  const paintHud = (text: string): void => {
    if (hudRef.current !== null) hudRef.current.textContent = text;
  };

  const startGesture = (event: ReactPointerEvent, layer: Layer, handle: GestureHandle): void => {
    const point = toPanel(event);
    if (point === null) return;
    // A locked layer has no gestures at all (§2.2, M3).
    if (layer.locked === true) return;
    cancelSettleRef.current?.();
    cancelSettleRef.current = null;
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = beginGesture(layer, handle, toUnits(point), gestureCtx());
    startMatRef.current = layerMatrix(layer, panel);
    paintingRef.current = true;
    setHud(hudFor(layer.t, panel));
  };

  /**
   * A gesture on the WHOLE selection — F7.
   *
   * `⌘A`, a marquee and a shift-tap all marked rows in the rail and then left
   * the canvas showing nothing and offering nothing. A group gesture is the
   * other half of that: it runs on the same three handles, previews every
   * member per frame, and commits through `transformMany` as ONE history entry,
   * because a drag of four layers that took four presses to undo would be a
   * drag nobody could undo.
   */
  const startGroupGesture = (event: ReactPointerEvent, handle: GestureHandle): void => {
    const point = toPanel(event);
    if (point === null) return;
    const members = selected.filter((l) => l.locked !== true);
    if (members.length < 2) return;
    cancelSettleRef.current?.();
    cancelSettleRef.current = null;
    event.currentTarget.setPointerCapture(event.pointerId);
    const from = toUnits(point);
    const centre = {
      x: members.reduce((sum, l) => sum + l.t.x, 0) / members.length,
      y: members.reduce((sum, l) => sum + l.t.y, 0) / members.length,
    };
    groupRef.current = {
      handle,
      from,
      centre,
      starts: members.map((l) => ({ id: l.id, t: { ...l.t } })),
    };
    paintingRef.current = true;
    setHud(hudFor(members[0]?.t ?? { x: 0, y: 0, s: 1, r: 0, a: 1 }, panel));
  };

  const driveGroup = (event: ReactPointerEvent): void => {
    const group = groupRef.current;
    const point = toPanel(event);
    if (group === null || point === null) return;
    const to = toUnits(point);
    for (const { id, t } of group.starts) {
      preview(id, groupPatch(group.handle, group.centre, group.from, to, t));
    }
    paintGroup(to);
    const first = group.starts[0];
    if (first !== undefined) {
      paintHud(hudFor(groupPatch(group.handle, group.centre, group.from, to, first.t), panel));
    }
  };

  const finishGroup = (event?: ReactPointerEvent): void => {
    const group = groupRef.current;
    groupRef.current = null;
    if (group === null) return;
    const point = event === undefined ? null : toPanel(event);
    const to = point === null ? group.from : toUnits(point);
    paintingRef.current = false;
    setHud(null);
    editor.transformMany(
      group.starts.map(({ id, t }) => ({
        id,
        patch: groupPatch(group.handle, group.centre, group.from, to, t),
      })),
    );
    setTick((t) => t + 1);
  };

  /** Drop an in-flight gesture and put the layer back where the finger found it. */
  const abandonGesture = (): void => {
    const gs = gestureRef.current;
    gestureRef.current = null;
    startMatRef.current = null;
    paintingRef.current = false;
    selRef.current?.removeAttribute('transform');
    setGuides([]);
    setHud(null);
    if (gs !== null) preview(gs.id, gs.start);
  };

  const clearPress = (): void => {
    const press = pressRef.current;
    if (press === null) return;
    clearTimeout(press.timer);
    pressRef.current = null;
  };

  const onPointerMove = (event: ReactPointerEvent): void => {
    if (groupRef.current !== null) {
      driveGroup(event);
      return;
    }
    if (touch) {
      const p = toPanel(event);
      if (p !== null && pointersRef.current.has(event.pointerId)) {
        pointersRef.current.set(event.pointerId, toUnits(p));
      }
      if (twoRef.current !== null) {
        driveTwoFinger();
        return;
      }
      const press = pressRef.current;
      if (press !== null && p !== null) {
        // A finger that has travelled is dragging, whatever it was going to be.
        const to = toUnits(p);
        const drift = Math.hypot(to.x - press.from.x, to.y - press.from.y);
        if (drift > LONG_PRESS_SLOP_UNITS) clearPress();
      }
    }

    const gs = gestureRef.current;
    if (gs === null) {
      if (marquee !== null) {
        const p = toPanel(event);
        if (p !== null) setMarquee({ ...marquee, x: p.x, y: p.y });
      }
      return;
    }
    const point = toPanel(event);
    if (point === null) return;
    // Holding the modifier turns snapping OFF: the escape hatch for the one
    // pixel the guides refuse to let you reach (§8).
    const next = applyGesture(gs, toUnits(point), { snap: !(event.altKey || event.metaKey) });
    preview(gs.id, next);
    paintSingle(gs.id, next);
    paintHud(hudFor(next, panel));
    /*
     * The guides are the ONE thing on this path that still asks React for a
     * render, and only when the set actually changed — a fresh array every
     * frame would be a render every frame, which is exactly what I4 forbids and
     * what made the box lag the finger in the first place.
     */
    setGuides((current) => (sameGuides(current, gs.guides) ? current : [...gs.guides]));
  };

  /**
   * Two fingers, through the ONE model — §8 and `touchGesture.ts`.
   *
   * The intent is decided once, on the frame a dead zone is cleared, and then a
   * synthetic drive point turns the pinch or the twist into exactly the
   * `scale-se` or `rotate` gesture `applyGesture` already knows how to run,
   * snap and commit. There is no second gesture model on the phone.
   */
  const driveTwoFinger = (): void => {
    const two = twoRef.current;
    if (two === null) return;
    const points = [...pointersRef.current.values()];
    const a = points[0];
    const b = points[1];
    if (a === undefined || b === undefined) return;
    const now: TwoFingerSample = { a, b };

    if (two.intent === null) {
      const intent = twoFingerIntent(two.start, now);
      if (intent === null) return;
      two.intent = intent;
      gestureRef.current = beginGesture(
        two.layer,
        intent === 'scale' ? 'scale-se' : 'rotate',
        two.p0,
        gestureCtx(),
      );
      startMatRef.current = layerMatrix(two.layer, panel);
      paintingRef.current = true;
    }
    const gs = gestureRef.current;
    if (gs === null) return;
    const drive =
      two.intent === 'scale'
        ? scaleDrivePoint(two.centre, two.p0, pinchFactor(two.start, now))
        : rotateDrivePoint(two.centre, two.p0, twistDegrees(two.start, now));
    const next = applyGesture(gs, drive);
    preview(gs.id, next);
    paintSingle(gs.id, next);
    paintHud(hudFor(next, panel));
    setGuides((current) => (sameGuides(current, gs.guides) ? current : [...gs.guides]));
  };

  const finishGesture = (): void => {
    const gs = gestureRef.current;
    gestureRef.current = null;
    setGuides([]);
    setHud(null);
    if (gs === null) {
      paintingRef.current = false;
      startMatRef.current = null;
      return;
    }

    const settled = endGesture(gs, editor.look);
    const target = settled.layers.find((l) => l.id === gs.id);
    const from = gs.current;
    const to = target?.t ?? from;
    const clock = clockOf();

    const commit = (): void => {
      /*
       * The overlay's transform is handed back HERE, not on release.
       *
       * `paintingRef` going false is what lets the layout effect above strip the
       * attribute on the render this commit causes — synchronously, before the
       * browser paints — so there is never a frame with the box at the old
       * position and the layer at the new one.
       */
      paintingRef.current = false;
      startMatRef.current = null;
      editor.commitLook(settled);
      setTick((t) => t + 1);
    };

    /*
     * The spring settle (§7). It runs on the frame clock and writes one
     * `transform` per tick; React is told once, at the end. A move that landed
     * exactly where the finger left it springs over zero distance and commits
     * on the next tick, which is why there is no special case for it.
     */
    if (clock === null || gs.handle !== 'move') {
      commit();
      return;
    }
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    cancelSettleRef.current = settle({
      clock,
      from: 0,
      to: 1,
      reduced: prefersReducedMotion(),
      onFrame: (p) => {
        const t = { ...to, x: from.x + dx * p, y: from.y + dy * p };
        preview(gs.id, t);
        paintSingle(gs.id, t);
      },
      onDone: () => {
        cancelSettleRef.current = null;
        commit();
      },
    });
  };

  const onStagePointerDown = (event: ReactPointerEvent): void => {
    if (event.button !== 0) return;
    const point = toPanel(event);
    if (point === null) return;
    /*
     * A locked layer is not hit-testable (§2.2, M3).
     *
     * Done by hiding it from `hitTest` rather than by ignoring the answer,
     * because "not hit-testable" has to mean the thing UNDERNEATH it is: a
     * locked backdrop that swallowed every click on everything below it would
     * be a worse lock than no lock at all.
     */
    const id = hitTest(unlockedLook(editor.look), point, panel);

    if (touch) {
      pointersRef.current.set(event.pointerId, toUnits(point));
      /*
       * The second finger. It cancels whatever the first one was doing —
       * putting the layer back where it started, so a pinch does not also
       * silently move the layer by however far the first finger had travelled —
       * and opens a two-finger gesture on the layer under the hand.
       */
      if (pointersRef.current.size === 2) {
        clearPress();
        const gs = gestureRef.current;
        const layer =
          gs === null
            ? (editor.look.layers.find((l) => editor.isSelected(l.id) && l.id !== BASE_LAYER_ID) ??
              null)
            : (editor.look.layers.find((l) => l.id === gs.id) ?? null);
        abandonGesture();
        const points = [...pointersRef.current.values()];
        const a = points[0];
        const b = points[1];
        if (layer !== null && a !== undefined && b !== undefined) {
          const centre = { x: layer.t.x, y: layer.t.y };
          twoRef.current = {
            layer,
            start: { a, b },
            /*
             * A synthetic grab one unit to the right of the layer's centre.
             *
             * `applyGesture` measures a scale as the ratio of the grab's
             * distance from the centre and a rotation as the angle it has
             * swept, so a grab at radius 1 makes the drive point's arithmetic
             * exactly the factor and exactly the angle. Using a real finger
             * position would work too, right up until a finger landed ON the
             * centre and every ratio became a division by zero.
             */
            p0: { x: centre.x + 1, y: centre.y },
            centre,
            intent: null,
          };
        }
        return;
      }
    }

    if (id === null) {
      // Tap empty deselects; drag empty is a marquee (§2.1) — and a marquee is
      // a mouse gesture, so on a phone an empty tap simply deselects.
      if (!event.shiftKey) editor.select(null);
      if (touch) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      setMarquee({ x0: point.x, y0: point.y, x: point.x, y: point.y });
      return;
    }
    /*
     * Dragging INSIDE a multi-selection moves the whole group (F7).
     *
     * Without this, picking up one of four selected layers to move them all
     * silently collapsed the selection to that one — which is what made ⌘A
     * followed by a drag feel like the selection had never happened.
     */
    if (!event.shiftKey && selected.length >= 2 && editor.isSelected(id)) {
      startGroupGesture(event, 'move');
      return;
    }

    editor.select(id, event.shiftKey);
    const layer = editor.look.layers.find((l) => l.id === id);
    if (layer === undefined) return;

    /*
     * The long press (§8): the phone's right-click.
     *
     * It is armed alongside the move rather than instead of it — the finger has
     * not decided yet, and `onPointerMove` disarms this the moment it travels
     * further than a fingertip. When it does fire, the move is abandoned, so
     * the layer is exactly where it was when the hand came down.
     */
    if (touch && onContext !== undefined && layer.id !== BASE_LAYER_ID) {
      const from = toUnits(point);
      pressRef.current = {
        layer,
        from,
        timer: setTimeout(() => {
          pressRef.current = null;
          abandonGesture();
          onContext(layer);
        }, LONG_PRESS_MS),
      };
    }
    if (!event.shiftKey) startGesture(event, layer, 'move');
  };

  const onStagePointerUp = (event?: ReactPointerEvent): void => {
    if (groupRef.current !== null) {
      finishGroup(event);
      return;
    }
    if (touch) {
      clearPress();
      if (event !== undefined) pointersRef.current.delete(event.pointerId);
      if (twoRef.current !== null && pointersRef.current.size < 2) {
        twoRef.current = null;
        finishGesture();
        return;
      }
      if (twoRef.current !== null) return;
    }
    if (marquee !== null) {
      const inside = editor.look.layers
        .slice(1)
        .filter((l) => l.on && l.locked !== true && withinMarquee(l, marquee, panel))
        .map((l) => l.id);
      if (inside.length > 0) editor.selectMany(inside);
      setMarquee(null);
    }
    finishGesture();
  };

  const selected = editor.look.layers.filter(
    (l) => editor.isSelected(l.id) && l.id !== BASE_LAYER_ID,
  );
  const one = selected.length === 1 ? selected[0] : undefined;
  const bounds = one === undefined ? null : layerBounds(one, panel);
  const cut = one !== undefined && outsideSafeCircle(one, panel, render);

  const handleR = (coarsePointer ? HANDLE_TOUCH_PX : HANDLE_PX) / 2 / k;
  const drawnR = HANDLE_PX / 2 / k;

  /*
   * F7: a box PER selected layer, and one around the lot of them.
   *
   * The audit found ⌘A, a marquee and a shift-tap all marking rail rows while
   * the canvas showed zero selection boxes and offered no group operations —
   * three separate gestures whose entire visible result was in the other
   * column. Every member gets its own box so the selection is legible, and the
   * union gets the handles so the selection is operable.
   */
  const groupBoxes =
    selected.length < 2 ? [] : selected.map((l) => ({ id: l.id, b: layerBounds(l, panel) }));
  const groupRect = groupBoxes.length < 2 ? null : unionRect(groupBoxes.map((g) => g.b.rect));
  const groupCorners: [number, number][] | null =
    groupRect === null
      ? null
      : [
          [groupRect.x, groupRect.y],
          [groupRect.x + groupRect.w, groupRect.y],
          [groupRect.x + groupRect.w, groupRect.y + groupRect.h],
          [groupRect.x, groupRect.y + groupRect.h],
        ];

  return (
    <>
      <svg
        className="kh-ed-overlay"
        data-testid="editor-overlay"
        data-touch={touch ? 'true' : 'false'}
        viewBox={`0 0 ${String(panel.width)} ${String(panel.height)}`}
        role="application"
        aria-label="Layer editor"
        onPointerDown={onStagePointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onStagePointerUp}
        onPointerCancel={onStagePointerUp}
      >
        {/* Guides exist only while the finger is down (§2.1). */}
        {guides.map((guide, i) => (
          <GuideLine key={`${guide.kind}-${String(i)}`} guide={guide} panel={panel} />
        ))}

        {marquee !== null && (
          <rect
            className="kh-ed-marquee"
            x={Math.min(marquee.x0, marquee.x)}
            y={Math.min(marquee.y0, marquee.y)}
            width={Math.abs(marquee.x - marquee.x0)}
            height={Math.abs(marquee.y - marquee.y0)}
          />
        )}

        {groupCorners !== null && (
          <g
            className="kh-ed-sel kh-ed-sel--group"
            data-testid="editor-selection-group"
            ref={multiRef}
          >
            {groupBoxes.map(({ id, b }) => (
              <polygon
                key={id}
                className="kh-ed-box kh-ed-box--member"
                data-testid={`editor-selection-${id}`}
                points={b.corners.map((c) => c.join(',')).join(' ')}
              />
            ))}
            <polygon
              className="kh-ed-box"
              data-testid="editor-group-box"
              points={groupCorners.map((c) => c.join(',')).join(' ')}
            />
            {SCALE_HANDLES.map(({ handle, corner }) => {
              const point = groupCorners[corner];
              /* c8 ignore next */
              if (point === undefined) return null;
              return (
                <g key={handle}>
                  <circle className="kh-ed-handle" cx={point[0]} cy={point[1]} r={drawnR} />
                  <circle
                    className="kh-ed-hit"
                    data-testid={`editor-group-handle-${handle}`}
                    data-hit-px={String(coarsePointer ? HANDLE_TOUCH_PX : HANDLE_PX)}
                    cx={point[0]}
                    cy={point[1]}
                    r={handleR}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      startGroupGesture(e, handle);
                    }}
                    onPointerMove={onPointerMove}
                    onPointerUp={onStagePointerUp}
                  />
                </g>
              );
            })}
            <Lollipop
              bounds={{ corners: groupCorners }}
              stem={LOLLIPOP_PX / k}
              drawn={drawnR}
              hit={handleR}
              coarse={coarsePointer}
              testId="editor-group-handle-rotate"
              onDown={(e) => {
                e.stopPropagation();
                startGroupGesture(e, 'rotate');
              }}
              onMove={onPointerMove}
              onUp={onStagePointerUp}
            />
          </g>
        )}

        {bounds !== null && one !== undefined && (
          <g
            className={cut ? 'kh-ed-sel kh-ed-sel--cut' : 'kh-ed-sel'}
            data-testid="editor-selection"
            ref={selRef}
          >
            <polygon
              className="kh-ed-box"
              points={bounds.corners.map((c) => c.join(',')).join(' ')}
            />
            {SCALE_HANDLES.map(({ handle, corner }) => {
              const point = bounds.corners[corner];
              if (point === undefined) return null;
              return (
                <g key={handle}>
                  <circle className="kh-ed-handle" cx={point[0]} cy={point[1]} r={drawnR} />
                  <circle
                    className="kh-ed-hit"
                    data-testid={`editor-handle-${handle}`}
                    data-hit-px={String(coarsePointer ? HANDLE_TOUCH_PX : HANDLE_PX)}
                    cx={point[0]}
                    cy={point[1]}
                    r={handleR}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      startGesture(e, one, handle);
                    }}
                    onPointerMove={onPointerMove}
                    onPointerUp={onStagePointerUp}
                  />
                </g>
              );
            })}
            <Lollipop
              bounds={bounds}
              stem={LOLLIPOP_PX / k}
              drawn={drawnR}
              hit={handleR}
              coarse={coarsePointer}
              onDown={(e) => {
                e.stopPropagation();
                startGesture(e, one, 'rotate');
              }}
              onMove={onPointerMove}
              onUp={onStagePointerUp}
            />
          </g>
        )}
      </svg>

      {/*
        The HUD reads UPRIGHT whatever the layer is doing (§2.1). It is a
        DOM node rather than SVG text for exactly that reason: an SVG label
        inside the rotated group would be as unreadable as the rotation.
      */}
      {hud !== null && (
        <p className="kh-ed-hud kh-tnum" data-testid="editor-hud" aria-live="off" ref={hudRef}>
          {hud}
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// The canvas — CAM's mirror, and the compositor inside it
// ---------------------------------------------------------------------------

export interface EditorCanvasProps {
  editor: EditorApi;
  state: AppState;
  /** The panel this halo is standing in for, at its own pixel size. */
  panel: Geometry;
  /** The latest monitoring snapshot off the wire, and when it was sampled. */
  monitor: MonitorSnapshot | null;
  monitorAt: number;
  /** Position of the video base, 0..1, for the stand-in's arc. `null` = unknown. */
  progress: number | null;
  /** Whether this window may run the real display page at all (A1). */
  coarsePointer: boolean;
}

export function EditorCanvas({
  editor,
  state,
  panel,
  monitor,
  monitorAt,
  progress,
  coarsePointer,
}: EditorCanvasProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<LayerHost | null>(null);
  const monitoringRef = useRef<ReturnType<typeof createPreviewMonitoring> | null>(null);
  const clockRef = useRef<ReturnType<typeof createFrameClock> | null>(null);

  const [zoom, setZoom] = useState(1);
  /**
   * The LCD's drawn width, MEASURED rather than computed.
   *
   * The size is a CSS decision — `min(the column, the row)`, so the canvas is as
   * large as the window allows and never larger (principle 1). Reading it back
   * is what lets the gesture maths convert screen pixels to panel pixels without
   * this component and the stylesheet having to agree about a number in two
   * places. It is the LIT area, inside the bezel: the stage and the overlay are
   * both `inset: 0` in that box, so anything measured on the frame around it is
   * a scale factor two bezel walls too big.
   */
  const [sizePx, setSizePx] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  const registry = useMemo(() => previewRegistry(getModule), []);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return undefined;
    const measure = (): void => {
      setSizePx(frame.getBoundingClientRect().width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => {
      observer.disconnect();
    };
  }, []);

  /**
   * Panel px per CSS px. Everything screen-side divides by it.
   *
   * Before the first measurement the halo has no width, and a zero scale would
   * make every conversion `Infinity`; the fallback keeps the maths finite for
   * the one frame between mount and layout.
   */
  const k = ((sizePx > 0 ? sizePx : panel.width) / panel.width) * zoom;

  // -- the compositor -------------------------------------------------------

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return undefined;

    const monitoring = createPreviewMonitoring({ snapshot: monitor, at: monitorAt });
    monitoringRef.current = monitoring;
    const clock = createFrameClock(() => panel.targetFps);
    clockRef.current = clock;

    const host = new LayerHost(stage, {
      registry,
      panel,
      clock,
      render: () => state.render,
      monitoring: monitoring.source,
    });
    hostRef.current = host;
    const off = monitoring.source.subscribe((n, raw) => {
      host.setMonitoring(n, raw);
    });

    return () => {
      off();
      host.destroy();
      clock.stop();
      monitoring.stop();
      hostRef.current = null;
      clockRef.current = null;
      monitoringRef.current = null;
    };
    // The host is created once per panel: a geometry change is `setPanel`, not
    // a remount, or every module would lose its state when the window resized.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, registry]);

  useEffect(() => {
    hostRef.current?.setPanel(panel);
  }, [panel]);

  useEffect(() => {
    monitoringRef.current?.push({ snapshot: monitor, at: monitorAt });
  }, [monitor, monitorAt]);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    host.setLook(editor.look, configsOf(editor.look, state, getModule));
  }, [editor.look, state]);

  useEffect(() => {
    hostRef.current?.command('progress', progress, BASE_LAYER_ID);
  }, [progress]);

  /**
   * The preview channel: ONE style write, no React (§2.6, I4).
   *
   * The compositor owns the host element; this borrows its `transform` for the
   * duration of the drag and hands it back by committing, at which point
   * `setLook` writes the same string from the document.
   */
  const preview = (id: LayerId, t: Transform): void => {
    const host = stageRef.current?.querySelector<HTMLElement>(`[data-layer="${id}"]`);
    host?.style.setProperty('transform', transformCss(t, panel));
  };

  // -- zoom and pan ---------------------------------------------------------

  const onWheel = (event: ReactWheelEvent): void => {
    if (!event.ctrlKey && !event.metaKey) return;
    setZoom((z) => clamp(z * (1 - event.deltaY * ZOOM_STEP), ZOOM_MIN, ZOOM_MAX));
  };

  const fit = (): void => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  return (
    <div
      className="kh-ed-canvas"
      data-testid="editor-canvas"
      data-zoom={zoom.toFixed(2)}
      onWheel={onWheel}
      onDoubleClick={fit}
    >
      <div
        className={panel.shape === 'circle' ? 'kh-halo' : 'kh-halo kh-halo--square'}
        data-testid="mirror"
        data-mirror-mode="editor"
        style={
          {
            '--kh-ed-scale': String(k),
            '--kh-ed-panel-w': `${String(panel.width)}px`,
            '--kh-ed-panel-h': `${String(panel.height)}px`,
            '--kh-ed-pan-x': `${String(pan.x)}px`,
            '--kh-ed-pan-y': `${String(pan.y)}px`,
          } as CSSProperties
        }
      >
        {/*
          Measured HERE, not on the bezel.

          `.kh-halo__lcd` is the halo inside its 7 px rim, and it is the box the
          stage and the overlay SVG are both `inset: 0` within — so it, not the
          frame around it, is the "one CSS px" every conversion below divides
          by. Measuring the frame made `k` 3.5% too large, and the thing that
          noticed was the handles: 24 px of drawn radius came out as 23.2 on
          screen, under §2.1's floor, on a halo that was otherwise correct.
        */}
        <div className="kh-halo__lcd" ref={frameRef}>
          {/*
            The compositor's root. Sized to the PANEL and scaled down by the
            wrapper, so every module lays itself out exactly as it does on the
            LCD. Nothing the editor draws goes in here.
          */}
          <div className="kh-ed-stage kh-stage" ref={stageRef} aria-hidden="true" />

          <EditorOverlay
            editor={editor}
            panel={panel}
            render={state.render}
            k={k}
            rectOf={() => stageRef.current?.getBoundingClientRect() ?? null}
            preview={preview}
            clockOf={() => clockRef.current}
            coarsePointer={coarsePointer}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * The readable value, in the units a person thinks in — round 10's M1.
 *
 * It read `0.04, −0.68` while you dragged. Those are the MODEL's units — a
 * transform is written in diameters, so the panel is two units across and the
 * centre is the origin — and they are the right units for a look file, the wire
 * and every clamp in `ops.ts`. They are nobody's units for a readout: a person
 * dragging a clock face onto a 640 px panel is thinking in pixels, and a HUD
 * that prints two thirds of a diameter as `-0.68` is a debug print with a font.
 *
 * The sign is a real one (round 11's M-f): `signed()` prints U+2212, not the
 * hyphen `String()` reaches for, because the readout is set in tabular figures
 * and a hyphen among them is visibly the wrong glyph.
 *
 * So the conversion happens HERE, at the edge, and nowhere else: the model stays
 * in units, `panel` supplies the only two numbers the conversion needs, and each
 * of the four quantities gets the unit it is actually measured in — pixels from
 * the centre, per cent of natural size, degrees.
 *
 * All four, on every gesture, rather than one per handle. A scale changes where
 * a layer's edges are as surely as a drag does, and the number a person wants to
 * see while they are matching two layers up is usually not the one attached to
 * the handle they happen to be holding.
 */
function hudFor(t: Transform, panel: { width: number; height: number }): string {
  // A frame is written in DIAMETER units and the panel is 2 units across, so
  // half the panel's pixel span is one unit. (`modules/stack.ts` says the same
  // thing on the way to an area.)
  const x = Math.round(t.x * (panel.width / 2));
  const y = Math.round(t.y * (panel.height / 2));
  return `x ${signed(x)} · y ${signed(y)} · ${String(Math.round(t.s * 100))}% · ${String(
    Math.round(t.r),
  )}°`;
}

/**
 * Are these the same guides? — the test that keeps a drag React-free.
 *
 * `applyGesture` hands back the same guide set on nearly every frame of a
 * gesture, and `setGuides(gs.guides)` used to re-render on all of them because
 * the array was a fresh object each time. Comparing the values is what turns
 * "a render per frame" into "a render when a guide appears or disappears".
 */
function sameGuides(a: readonly Guide[], b: readonly Guide[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((g, i) => {
    const other = b[i];
    return g.kind === other?.kind && g.at === other.at;
  });
}

/** The union of some boxes, in panel px — the group selection's own box. */
function unionRect(
  rects: readonly { x: number; y: number; w: number; h: number }[],
): { x: number; y: number; w: number; h: number } | null {
  const first = rects[0];
  if (first === undefined) return null;
  let x0 = first.x;
  let y0 = first.y;
  let x1 = first.x + first.w;
  let y1 = first.y + first.h;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function withinMarquee(layer: Layer, m: Marquee, panel: Geometry): boolean {
  const { rect } = layerBounds(layer, panel);
  const x0 = Math.min(m.x0, m.x);
  const x1 = Math.max(m.x0, m.x);
  const y0 = Math.min(m.y0, m.y);
  const y1 = Math.max(m.y0, m.y);
  return rect.x >= x0 && rect.y >= y0 && rect.x + rect.w <= x1 && rect.y + rect.h <= y1;
}

function GuideLine({ guide, panel }: { guide: Guide; panel: Geometry }) {
  const r = panel.radiusPx;
  const cx = panel.width / 2;
  const cy = panel.height / 2;

  if (guide.kind === 'ring' || guide.kind === 'tangent') {
    return <circle className="kh-ed-guide" cx={cx} cy={cy} r={guide.at * r} fill="none" />;
  }
  if (guide.kind === 'rotation' || guide.kind === 'clock') {
    const rad = (guide.at * Math.PI) / 180;
    return (
      <line
        className="kh-ed-guide"
        x1={cx}
        y1={cy}
        x2={cx + Math.cos(rad) * r}
        y2={cy + Math.sin(rad) * r}
      />
    );
  }
  if (guide.axis === 'x') {
    const x = cx + guide.at * r;
    return <line className="kh-ed-guide" x1={x} y1={0} x2={x} y2={panel.height} />;
  }
  const y = cy + guide.at * r;
  return <line className="kh-ed-guide" x1={0} y1={y} x2={panel.width} y2={y} />;
}

function Lollipop({
  bounds,
  stem,
  drawn,
  hit,
  coarse,
  testId = 'editor-handle-rotate',
  onDown,
  onMove,
  onUp,
}: {
  bounds: { corners: [number, number][] };
  stem: number;
  drawn: number;
  hit: number;
  coarse: boolean;
  /** The group's lollipop needs its own id, or the suite's strict mode trips. */
  testId?: string;
  onDown: (e: ReactPointerEvent) => void;
  onMove: (e: ReactPointerEvent) => void;
  onUp: (e: ReactPointerEvent) => void;
}) {
  const nw = bounds.corners[0];
  const ne = bounds.corners[1];
  const sw = bounds.corners[3];
  if (nw === undefined || ne === undefined || sw === undefined) return null;

  // Above the box's TOP EDGE in the layer's own frame, so the lollipop rotates
  // with the layer rather than always sitting due north of a rotated box.
  const midX = (nw[0] + ne[0]) / 2;
  const midY = (nw[1] + ne[1]) / 2;
  const ux = nw[0] - sw[0];
  const uy = nw[1] - sw[1];
  const len = Math.hypot(ux, uy) || 1;
  const tipX = midX + (ux / len) * stem;
  const tipY = midY + (uy / len) * stem;

  return (
    <g>
      <line className="kh-ed-stem" x1={midX} y1={midY} x2={tipX} y2={tipY} />
      <circle className="kh-ed-handle" cx={tipX} cy={tipY} r={drawn} />
      <circle
        className="kh-ed-hit"
        data-testid={testId}
        data-hit-px={String(coarse ? HANDLE_TOUCH_PX : HANDLE_PX)}
        cx={tipX}
        cy={tipY}
        r={hit}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
      />
    </g>
  );
}
