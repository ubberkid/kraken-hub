/**
 * `ProviderId` → lazy adapter factory (design-videoEngine.md §0, §1.1).
 *
 * Every entry is a `() => import(...)` so a display that plays a local clip
 * never parses the code for a provider it will not use — and so hls.js/dash.js,
 * when they land, cost nothing until a manifest URL is actually pasted.
 *
 * Providers not in this table are not built yet. `loadAdapter` returns `null`
 * for them rather than throwing, so the caller can render a specific,
 * non-retrying card instead of a stack trace on a screen nobody can click.
 */

import type { VideoAdapter } from './VideoAdapter';
import type { ProviderId } from '../types';

interface AdapterModule {
  createAdapter: () => VideoAdapter;
}

type AdapterLoader = () => Promise<AdapterModule>;

/**
 * Every provider in the design's capability matrix (§1.2), complete.
 *
 * The two file-backed adapters carry the download-first path; `youtube-embed`
 * is the geometry engine; `hls`/`dash` each drag a library that is bigger than
 * the rest of the app put together and are therefore chunked separately
 * (`provider-*` in `vite.config.ts`) as well as lazily imported here.
 */
const LOADERS: Partial<Record<ProviderId, AdapterLoader>> = {
  'direct-file': () => import('./directFile.adapter'),
  'local-file': () => import('./localFile.adapter'),
  'youtube-embed': () => import('./youtubeEmbed.adapter'),
  hls: () => import('./hls.adapter'),
  dash: () => import('./dash.adapter'),
  reddit: () => import('./reddit.adapter'),
  twitch: () => import('./twitch.adapter'),
  vimeo: () => import('./vimeo.adapter'),
  streamable: () => import('./streamable.adapter'),
  resolver: () => import('./resolver.adapter'),
};

export function hasAdapter(id: ProviderId): boolean {
  return Object.hasOwn(LOADERS, id);
}

export function implementedProviders(): ProviderId[] {
  return Object.keys(LOADERS) as ProviderId[];
}

/** `null` when the provider has no adapter in this build. */
export async function loadAdapter(id: ProviderId): Promise<VideoAdapter | null> {
  const loader = LOADERS[id];
  if (loader === undefined) return null;
  const mod = await loader();
  return mod.createAdapter();
}
