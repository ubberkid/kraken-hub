/**
 * The typed view of a layer's config.
 *
 * A `Layer.cfg` is `unknown` in the model and it has to be: a look is read out
 * of localStorage, off a sync wire, or out of a file somebody exported from a
 * newer build, and none of those can be trusted to hold a `ClockConfig`. But
 * every caller that is about to USE one has a `kind` in hand, and this is where
 * that pair becomes a discriminated union — through the module's own
 * `validate()`, which is total and never throws, so narrowing is a runtime fact
 * rather than a cast.
 *
 * A fork adds its kinds by declaration merging, with no edit to this file:
 *
 * ```ts
 * declare module 'kraken-hub/src/modules/layerKinds' {
 *   interface LayerConfigs { aquarium: AquariumConfig }
 * }
 * ```
 *
 * W7's `text`, `shape` and `effect` join the interface below when they land.
 *
 * See docs/design/design-layers-architecture.md §1.3.
 */

import { getModule as registryGetModule } from './registry';

import type { ClockConfig } from './clock/schema';
import type { ImageModuleConfig } from './image/schema';
import type { StatsConfig } from './stats/schema';
import type { AnyKrakenModule } from './types';
import type { VideoModuleConfig } from './video/types';
import type { Layer } from '../state/look/types';

/** An INTERFACE, not a type alias, precisely so a fork can merge into it. */
export interface LayerConfigs {
  video: VideoModuleConfig;
  image: ImageModuleConfig;
  clock: ClockConfig;
  stats: StatsConfig;
}

/** A layer whose kind this build understands, with its config already validated. */
export type KnownLayer = {
  [K in keyof LayerConfigs]: Omit<Layer, 'kind' | 'cfg'> & { kind: K; cfg: LayerConfigs[K] };
}[keyof LayerConfigs];

/**
 * A layer this build has never heard of.
 *
 * It keeps its `cfg` verbatim and is skipped at render (`normalizeLook`), which
 * is what lets a look pass through an older build and come out intact.
 */
export type UnknownLayer = Layer & { unknown: true };

export function isKnownLayer(l: KnownLayer | UnknownLayer): l is KnownLayer {
  return !('unknown' in l);
}

/**
 * Narrow a layer against the registry.
 *
 * `cfg` is passed in rather than read off the layer because the two homes for a
 * config are positional (§0.2): the base wears `state.modules[kind].cfg`, an
 * overlay wears its own `layer.cfg`. The caller knows which it is holding; this
 * function only knows how to check it.
 */
export function narrowLayer(
  layer: Layer,
  cfg: unknown,
  getModule: (id: string) => AnyKrakenModule | null = registryGetModule,
): KnownLayer | UnknownLayer {
  const mod = getModule(layer.kind);
  if (mod === null) return { ...layer, unknown: true };
  return { ...layer, cfg: mod.validate(cfg) } as KnownLayer;
}
