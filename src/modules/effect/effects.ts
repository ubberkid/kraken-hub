/**
 * The lazy registry — **the second of the two lines that add an effect.**
 *
 * Each entry is a dynamic `import()` of one file that holds one fragment
 * source and nothing else, so the bundler gives every effect its own chunk and
 * the panel downloads exactly the one that is on screen. Twelve template
 * literals eagerly imported would be ~19 kB of GLSL on the LCD's first paint,
 * eleven twelfths of it for a picture it is not showing.
 *
 * (The other line is the descriptor in `catalog.ts`. Nothing else in the module
 * knows how many effects there are.)
 */

import type { EffectId } from './schema';

interface FragmentModule {
  FRAG: string;
}

type FragmentLoader = () => Promise<FragmentModule>;

const LOADERS: Readonly<Record<EffectId, FragmentLoader>> = {
  plasma: () => import('./effects/plasma'),
  'twisted-nebula': () => import('./effects/twistedNebula'),
  'satin-swirl': () => import('./effects/satinSwirl'),
  'triad-nexus': () => import('./effects/triadNexus'),
  voronoi: () => import('./effects/voronoi'),
  interference: () => import('./effects/interference'),
  'wave-ripple': () => import('./effects/waveRipple'),
  'wavy-gradient': () => import('./effects/wavyGradient'),
  classic: () => import('./effects/classic'),
  'colour-spiral': () => import('./effects/colourSpiral'),
  'infinite-rings': () => import('./effects/infiniteRings'),
  prism: () => import('./effects/prism'),
};

/** The GLSL ES 3.00 fragment source for one effect, fetched on first use. */
export async function loadFragment(id: EffectId): Promise<string> {
  const mod = await LOADERS[id]();
  return mod.FRAG;
}

/** Test seam: the loader table, so a suite can assert every id resolves. */
export const FRAGMENT_LOADERS: Readonly<Record<EffectId, FragmentLoader>> = LOADERS;
