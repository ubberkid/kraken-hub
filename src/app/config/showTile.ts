/**
 * Putting something from the shelf on the Kraken — the one commit, written once.
 *
 * A3's whole claim is that playing from the phone is not a new feature: it is
 * the state commit CAM's Library page has always made, from a window that
 * happens to be somewhere else. `AppState` travels as a full retained snapshot
 * over the ordinary state channel, so `activeModuleId` plus the module's `url`
 * IS the play command — there is no `play` op to invent, nothing to route, and
 * nothing that can be out of date on the display's side.
 *
 * It lives here rather than inside either view because two copies of this commit
 * is exactly how "the library is different" comes back: a shelf whose tiles do
 * subtly different things depending on which window you tapped them in is two
 * shelves again, however identical they look.
 */

import { imageModule } from '../../modules/image';
import { localImageUrl, validateImageConfig } from '../../modules/image/schema';
import { videoModule } from '../../modules/video';
import { LOCAL_CLIP_SCHEME } from '../../modules/video/routing/patterns';
import { validateVideoConfig } from '../../modules/video/types';
import { withModuleConfig } from '../../state/selectors';

import type { LibraryTile } from './libraryItems';
import type { Store } from '../../state/store';

/**
 * Show a tile on the Kraken. A tile with no bytes yet (a download in flight) is
 * a no-op rather than a commit of a URL nothing can resolve.
 */
export function showTile(store: Store, tile: LibraryTile): void {
  const id = tile.id;
  if (id === null) return;
  store.commit((s) => {
    if (tile.kind === 'clip') {
      return {
        ...withModuleConfig(s, videoModule.id, videoModule.configVersion, {
          ...validateVideoConfig(s.modules[videoModule.id]?.cfg),
          url: `${LOCAL_CLIP_SCHEME}${id}`,
        }),
        activeModuleId: videoModule.id,
      };
    }
    return {
      ...withModuleConfig(s, imageModule.id, imageModule.configVersion, {
        ...validateImageConfig(s.modules[imageModule.id]?.cfg),
        url: localImageUrl(id),
      }),
      activeModuleId: imageModule.id,
    };
  });
}

/**
 * Which tile is on screen right now, as a `LibraryTile.key`.
 *
 * The same derivation both shelves use to draw their "On screen" badge, for the
 * same reason the commit is shared: a badge that appears on one surface and not
 * the other is the two-libraries feeling in miniature.
 */
export function activeTileKey(
  activeModuleId: string,
  videoUrl: string,
  imageId: string | null,
): string | null {
  if (activeModuleId === videoModule.id) {
    return videoUrl.startsWith(LOCAL_CLIP_SCHEME)
      ? `clip:${videoUrl.slice(LOCAL_CLIP_SCHEME.length)}`
      : null;
  }
  if (activeModuleId === imageModule.id) return imageId === null ? null : `image:${imageId}`;
  return null;
}
