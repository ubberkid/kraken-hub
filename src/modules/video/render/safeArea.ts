/**
 * Compatibility surface: the safe-area helpers moved to `src/render/safeArea.ts`
 * in M3 so the clock, image and stats modules can lay overlays out against the
 * same box without importing the video module (invariant I6).
 *
 * Kept as a re-export because the video engine's own tests and docs reference
 * this path, and because §4.3 of design-videoEngine.md is where the 398×398
 * number is derived.
 */

export {
  DETAIL_FONT_PX,
  MIN_OVERLAY_FONT_PX,
  TITLE_FONT_PX,
  circleSafeInsetPx,
  isInsideSafeCircle,
  safeAreaBox,
  type PanelShape,
  type SafeAreaOptions,
} from '../../../render/safeArea';
