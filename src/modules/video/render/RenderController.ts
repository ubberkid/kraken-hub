/**
 * The DOM stack and the imperative transform writer (design-videoEngine.md §4).
 *
 * ```
 * .kh-video__viewport      W×H, overflow:hidden, position:relative, black
 *   .kh-video__rotor       W×H, transform-origin:50% 50%, rotate(θ)
 *     .kh-video__stage     position:absolute; top:0; left:0; transform-origin:0 0
 *       <video> | <iframe> ← the adapter surface, at NATURAL layout size
 *   .kh-video__mask        z-index 2
 *   .kh-video__overlays    z-index 3 — error card, hints, badges
 * ```
 *
 * Deviation from the doc, deliberate: the class names are `kh-video__*` rather
 * than the doc's bare `kh-viewport`/`kh-stage`/`kh-mask`. `.kh-stage` is already
 * the display shell's own root element (`src/app/display/display.css`), where it
 * carries `contain: strict` — reusing the name would have clipped the
 * transformed media the moment the two stylesheets met. Structure, nesting and
 * z-order are exactly as specified.
 *
 * Two invariants live here:
 *  - **Transforms are written imperatively, never through React.** A re-render
 *    that recreated the `<video>`/`<iframe>` would restart playback, so config
 *    changes call `setConfig()` + `apply()` and touch nothing else (§4.4).
 *  - **`sourcerect`-driven, not per-frame.** `apply()` runs on a config change,
 *    a geometry change, or an adapter's `sourcerect` event. Never in rAF.
 */

import { clamp } from '../../../lib/clamp';
import { ZOOM_MAX, ZOOM_MAX_PERFORMANCE, ZOOM_MIN } from '../types';

import { computeFit, effectiveFit, pickSourceRect, toTransformCss } from './fit';

import type { MaskSurface } from '../adapters/VideoAdapter';
import type { ProviderCapabilities, RenderConfig, SourceRect } from '../types';

const MASK_FADE_MS = 180;
const RIGHT_ANGLE = 90;
const THREE_QUARTER_TURN = 270;
const HALF = 0.5;

export interface RenderControllerOptions {
  /** The module host div; the viewport is appended to it. */
  host: HTMLElement;
  perf: 'quality' | 'performance';
  /** Flat colour behind everything. Low entropy is an FPS win (§8.2). */
  background?: string;
}

export interface RenderController {
  /** Where an adapter appends its surface. Owned by this controller. */
  readonly stage: HTMLElement;
  readonly mask: HTMLElement;
  readonly overlays: HTMLElement;
  setViewport(width: number, height: number): void;
  setSourceRect(rect: SourceRect): void;
  setCapabilities(caps: ProviderCapabilities): void;
  setConfig(config: RenderConfig): void;
  setPerf(perf: 'quality' | 'performance'): void;
  /** Recompute and write the transform. Cheap; still never called per frame. */
  apply(): void;
  showMask(color?: string): void;
  hideMask(fadeMs?: number): void;
  isMaskVisible(): boolean;
  /**
   * §2.6 — the mask's poster image, as a CSS `background-image` value. Only
   * adapters that own the mask set one; `null` restores the flat colour.
   */
  setMaskPoster(image: string | null): void;
  /** The `MaskSurface` handed to an adapter through `MountContext.mask`. */
  maskSurface(): MaskSurface;
  destroy(): void;
}

function div(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

export function createRenderController(opts: RenderControllerOptions): RenderController {
  let perf = opts.perf;
  let viewportW = 0;
  let viewportH = 0;
  let sourceRect: SourceRect | null = null;
  let caps: ProviderCapabilities | null = null;
  let config: RenderConfig | null = null;
  let maskVisible = true;

  const viewport = div('kh-video__viewport');
  viewport.style.position = 'absolute';
  viewport.style.inset = '0';
  viewport.style.overflow = 'hidden';
  viewport.style.background = opts.background ?? '#000';

  let rotor: HTMLDivElement | null = div('kh-video__rotor');
  const stage = div('kh-video__stage');
  stage.style.position = 'absolute';
  stage.style.top = '0';
  stage.style.left = '0';
  stage.style.transformOrigin = '0 0';
  // §4.4 — exactly ONE promoted layer, and it is this one. Never the mask,
  // never the viewport: each extra `will-change` is another surface to raster.
  stage.style.willChange = 'transform';

  const mask = div('kh-video__mask');
  mask.style.position = 'absolute';
  mask.style.inset = '0';
  mask.style.zIndex = '2';
  mask.style.pointerEvents = 'none';
  mask.style.background = '#000';
  mask.style.backgroundSize = 'cover';
  mask.style.backgroundPosition = 'center';
  mask.style.opacity = '1';

  const overlays = div('kh-video__overlays');
  overlays.style.position = 'absolute';
  overlays.style.inset = '0';
  overlays.style.zIndex = '3';
  overlays.style.pointerEvents = 'none';

  function mountRotor(): void {
    if (rotor === null) {
      viewport.prepend(stage);
      return;
    }
    rotor.style.position = 'absolute';
    rotor.style.transformOrigin = '50% 50%';
    rotor.append(stage);
    viewport.prepend(rotor);
  }

  mountRotor();
  viewport.append(mask, overlays);
  opts.host.append(viewport);

  /**
   * §4.2 — all Kraken panels are square, so 90/270 need no dimension swap. The
   * guard runs anyway: on a non-square panel the rotor is sized `H×W` and
   * offset by half the difference before rotating.
   */
  function applyRotor(): void {
    const rotate = config?.rotate ?? 0;
    // §8.3 — in performance mode an identity rotor is removed from the DOM
    // outright rather than left behind as a spare compositor layer.
    const wanted = !(perf === 'performance' && rotate === 0);
    if (wanted && rotor === null) {
      rotor = div('kh-video__rotor');
      stage.remove();
      mountRotor();
    } else if (!wanted && rotor !== null) {
      stage.remove();
      rotor.remove();
      rotor = null;
      viewport.prepend(stage);
    }
    if (rotor === null) return;

    const quarter = rotate === RIGHT_ANGLE || rotate === THREE_QUARTER_TURN;
    const w = quarter ? viewportH : viewportW;
    const h = quarter ? viewportW : viewportH;
    rotor.style.width = `${String(w)}px`;
    rotor.style.height = `${String(h)}px`;
    rotor.style.left = `${String((viewportW - w) * HALF)}px`;
    rotor.style.top = `${String((viewportH - h) * HALF)}px`;
    rotor.style.transform = rotate === 0 ? 'none' : `rotate(${String(rotate)}deg)`;
  }

  const controller: RenderController = {
    stage,
    mask,
    overlays,

    setViewport(width, height) {
      viewportW = width;
      viewportH = height;
    },

    setSourceRect(rect) {
      sourceRect = rect;
    },

    setCapabilities(next) {
      caps = next;
    },

    setConfig(next) {
      config = next;
    },

    setPerf(next) {
      perf = next;
    },

    apply() {
      applyRotor();
      if (sourceRect === null || config === null || viewportW <= 0 || viewportH <= 0) return;
      // §4.1 — `contain` on a chrome-painting provider's SAFE rect is visually
      // identical to `cover`, so `fit` is forced unless chrome is allowed.
      const fit = effectiveFit(config.fit, caps ?? { hasOwnChrome: false }, config.allowChrome);
      const rect = pickSourceRect(sourceRect, { fit, allowChrome: config.allowChrome });
      if (rect.w <= 0 || rect.h <= 0) return;
      // The rotor swaps the axes for 90/270, so fit against the ROTATED box.
      const quarter = config.rotate === RIGHT_ANGLE || config.rotate === THREE_QUARTER_TURN;
      // §8.3 — the zoom clamp is a performance lever: past 1.5 the crop stops
      // supersampling on this panel and the compositor pays for nothing.
      const zoomMax = perf === 'performance' ? ZOOM_MAX_PERFORMANCE : ZOOM_MAX;
      const result = computeFit({
        viewportW: quarter ? viewportH : viewportW,
        viewportH: quarter ? viewportW : viewportH,
        rect,
        fit,
        zoom: clamp(config.zoom, ZOOM_MIN, zoomMax),
        offsetX: config.offsetX,
        offsetY: config.offsetY,
      });
      stage.style.transform = toTransformCss(result);
    },

    showMask(color) {
      // Instant on the way in: a mask that fades UP shows the frame it exists
      // to hide (§2.6).
      mask.style.transition = 'none';
      // `backgroundColor`, never the `background` shorthand: the shorthand also
      // clears `background-image`, which would throw away the poster the mask
      // controller resolved (§2.6) the first time anything raised the mask.
      if (color !== undefined) mask.style.backgroundColor = color;
      mask.style.opacity = '1';
      maskVisible = true;
    },

    hideMask(fadeMs = MASK_FADE_MS) {
      mask.style.transition = `opacity ${String(fadeMs)}ms linear`;
      mask.style.opacity = '0';
      maskVisible = false;
    },

    isMaskVisible() {
      return maskVisible;
    },

    setMaskPoster(image) {
      mask.style.backgroundImage = image ?? 'none';
    },

    maskSurface() {
      return {
        showInstant: (color) => {
          controller.showMask(color);
        },
        fadeOut: (fadeMs) => {
          controller.hideMask(fadeMs);
        },
        setPoster: (image) => {
          controller.setMaskPoster(image);
        },
      };
    },

    destroy() {
      viewport.remove();
    },
  };

  return controller;
}
