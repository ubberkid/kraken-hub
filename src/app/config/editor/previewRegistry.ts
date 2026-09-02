/**
 * The registry the EDITOR's halo composites through.
 *
 * The halo is a real `LayerHost` rendering the real `Look` at halo size, with
 * the real module renderers — which is the whole reason a drag on this surface
 * lands where the drag on the panel would. It is the same compositor, the same
 * `layerBox` maths and the same modules; only two things differ, and both of
 * them are decisions rather than shortcuts:
 *
 *  1. **`video` is swapped for a poster-and-arc stand-in** (`videoStandIn.ts`).
 *     Never an `<iframe>`, never a second decoder, on the configuration window.
 *     See that file for the three reasons.
 *  2. Everything else is passed through UNCHANGED — deliberately. A "preview
 *     version" of the clock is a second clock to keep in step with the first,
 *     and the moment the two disagree the editor is lying about the panel.
 *
 * A swap rather than a fork: `previewRegistry` wraps whatever `GetModule` it is
 * given, so the editor's tests can hand it a table and the app hands it
 * `getModule`. The wrapper preserves the module's identity in every other
 * respect — id, `validate`, `layer`, `editor` — so `normalizeLook`, `lookCost`
 * and the placement rules all see the same video module the display does.
 */

import { createVideoStandIn } from './videoStandIn';

import type { GetModule } from '../../../modules/stack';
import type { AnyKrakenModule } from '../../../modules/types';

/** The one kind that may not run for real on this window. */
export const PREVIEW_STAND_IN_KIND = 'video';

/**
 * Wrap a registry so the configuration window's compositor is safe to mount.
 *
 * Memoised per underlying module object: `LayerHost.setLook` compares the plan
 * by identity in places, and handing back a fresh wrapper on every call would
 * make a no-op reconcile look like a kind change.
 */
export function previewRegistry(base: GetModule): GetModule {
  const cache = new Map<AnyKrakenModule, AnyKrakenModule>();
  return (id) => {
    const mod = base(id);
    if (mod?.id !== PREVIEW_STAND_IN_KIND) return mod;
    const cached = cache.get(mod);
    if (cached !== undefined) return cached;
    const wrapped: AnyKrakenModule = {
      ...mod,
      loadDisplay: () => Promise.resolve({ createRenderer: createVideoStandIn }),
    };
    cache.set(mod, wrapped);
    return wrapped;
  };
}

/** Does this window run the real renderer for this kind? Used by the copy. */
export function isStandIn(kind: string): boolean {
  return kind === PREVIEW_STAND_IN_KIND;
}
