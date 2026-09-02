/**
 * The twelve effects as the settings page sees them: a human name, what each
 * colour well is FOR, and the author's own Unity materials as presets.
 *
 * Generated in W7a from `docs/design/effects-ports/<port>.json`, which is itself
 * generated from the `*_material.mat` files in the author's project — the names
 * (Graphite, Bubblegum, Sunburst) and the hex values are theirs, converted once
 * from Unity's linear storage to sRGB. Nothing here was invented.
 *
 * **Not eager, and not on the display path.** The renderer reads
 * `EffectConfig.colors`; a preset is what WROTE those colours, not what resolves
 * them. So this table is downloaded by the settings page and by nothing else.
 */

import { EFFECT_IDS, type EffectId } from './schema';

export interface EffectPreset {
  /** Lower-cased `name`; the value stored in `EffectConfig.preset`. */
  id: string;
  /** The material's own name in the author's project. */
  name: string;
  colors: readonly string[];
}

export interface EffectDescriptor {
  id: EffectId;
  /** What the picker calls it. `plasma` is "Lava lamp", as the port's notes ask. */
  name: string;
  /** One label per colour well, in uniform order (uColor0 first). */
  slots: readonly string[];
  presets: readonly EffectPreset[];
  /** PORTS.md: never diffed against the Unity original. Shown as such. */
  experimental?: boolean;
}

export const EFFECT_CATALOG: Readonly<Record<EffectId, EffectDescriptor>> = {
  plasma: {
    id: 'plasma',
    name: 'Lava lamp',
    slots: ['Lava', 'Glow', 'Background', 'Background 2'],
    presets: [
      { id: 'classic', name: 'Classic', colors: ['#D6B700', '#F0FF00', '#00FFAF', '#A900FF'] },
      { id: 'graphite', name: 'Graphite', colors: ['#C0C0C0', '#FFFFFF', '#666666', '#808080'] },
      { id: 'ice', name: 'Ice', colors: ['#C9C9C9', '#00FFF2', '#0070B0', '#009DFF'] },
      { id: 'lime', name: 'Lime', colors: ['#BDBDBD', '#FFFF00', '#00A15C', '#E1FF00'] },
      { id: 'bubblegum', name: 'Bubblegum', colors: ['#C3C3C3', '#0067FF', '#FF00EB', '#DC00FF'] },
      { id: 'amethyst', name: 'Amethyst', colors: ['#C3C3C3', '#FF00E9', '#D800FF', '#B400FF'] },
      { id: 'ember', name: 'Ember', colors: ['#C6C6C6', '#000000', '#C60074', '#FF0000'] },
      { id: 'snow', name: 'Snow', colors: ['#CFCFCF', '#FFACEC', '#FFFFFF', '#BDBDBD'] },
      { id: 'sunburst', name: 'Sunburst', colors: ['#FF9500', '#FFFF00', '#FFFF00', '#FFD200'] },
    ],
  },
  'twisted-nebula': {
    id: 'twisted-nebula',
    name: 'Twisted nebula',
    slots: ['Nebula', 'Highlight', 'Background', 'Background 2'],
    presets: [
      { id: 'classic', name: 'Classic', colors: ['#00BCFF', '#E1FFFF', '#000089', '#00003E'] },
      { id: 'lime', name: 'Lime', colors: ['#00FF21', '#FFFF00', '#008900', '#003E00'] },
      { id: 'snow', name: 'Snow', colors: ['#7E7E7E', '#FFFFFF', '#A5A5A5', '#4A4A4A'] },
    ],
  },
  'satin-swirl': {
    id: 'satin-swirl',
    name: 'Satin swirl',
    slots: ['Aurora A', 'Aurora B', 'Background top', 'Background bottom'],
    presets: [
      { id: 'classic', name: 'Classic', colors: ['#65EDFE', '#E66FFA', '#505989', '#273050'] },
      { id: 'bubblegum', name: 'Bubblegum', colors: ['#FFFFFF', '#FF00FF', '#4F5189', '#DE00FF'] },
      { id: 'snow', name: 'Snow', colors: ['#FFFFFF', '#FFFFFF', '#FFFFFF', '#CBCBCB'] },
    ],
  },
  'triad-nexus': {
    id: 'triad-nexus',
    name: 'Triad nexus',
    slots: ['Triangles', 'Triangle shade', 'Background', 'Background 2'],
    presets: [
      { id: 'classic', name: 'Classic', colors: ['#FFFB00', '#737100', '#FF00B5', '#FFA600'] },
      { id: 'ice', name: 'Ice', colors: ['#00FFFF', '#007373', '#0089FF', '#0089FF'] },
      { id: 'snow', name: 'Snow', colors: ['#FFFFFF', '#737373', '#BCBCBC', '#B8B8B8'] },
    ],
  },
  voronoi: {
    id: 'voronoi',
    name: 'Voronoi cells',
    slots: ['Contours', 'Cells', 'Rim', 'Rim 2'],
    presets: [
      { id: 'classic', name: 'Classic', colors: ['#FFFF00', '#FF00F6', '#FFFF00', '#999900'] },
      { id: 'graphite', name: 'Graphite', colors: ['#000000', '#7E7E7E', '#000000', '#000000'] },
      { id: 'ice', name: 'Ice', colors: ['#007BB7', '#00E2FF', '#007BB7', '#004A6E'] },
      { id: 'lime', name: 'Lime', colors: ['#41B300', '#B7FF00', '#41B300', '#276B00'] },
      { id: 'bubblegum', name: 'Bubblegum', colors: ['#BA00B1', '#FF00F6', '#BA00B1', '#70006A'] },
      { id: 'amethyst', name: 'Amethyst', colors: ['#9600BC', '#C700FF', '#9600BC', '#5A0071'] },
      { id: 'ember', name: 'Ember', colors: ['#BC0000', '#FF0000', '#BC0000', '#710000'] },
      { id: 'snow', name: 'Snow', colors: ['#000000', '#FFFFFF', '#000000', '#000000'] },
      { id: 'sunburst', name: 'Sunburst', colors: ['#B37200', '#FFFF00', '#B37200', '#6B4400'] },
    ],
  },
  interference: {
    id: 'interference',
    name: 'Interference',
    slots: ['Glow A', 'Glow B', 'Background', 'Edge tint'],
    presets: [
      { id: 'classic', name: 'Classic', colors: ['#85F5FF', '#FF4126', '#B000BE', '#FF8000'] },
    ],
  },
  'wave-ripple': {
    id: 'wave-ripple',
    name: 'Wave ripple',
    slots: ['Rings', 'Ring highlight', 'Edges', 'Edges 2'],
    presets: [
      { id: 'classic', name: 'Classic', colors: ['#FFFF00', '#FFFF40', '#FFDAFF', '#8C788C'] },
      { id: 'graphite', name: 'Graphite', colors: ['#7E7E7E', '#9E9E9E', '#BCBCBC', '#676767'] },
      { id: 'ice', name: 'Ice', colors: ['#00FFFF', '#40FFFF', '#DADBFF', '#78788C'] },
    ],
  },
  'wavy-gradient': {
    id: 'wavy-gradient',
    name: 'Wavy gradient',
    slots: ['Gradient start', 'Gradient mid', 'Gradient mid 2', 'Gradient end'],
    presets: [
      { id: 'classic', name: 'Classic', colors: ['#6700D0', '#9200E0', '#BE00EF', '#E900FF'] },
      { id: 'graphite', name: 'Graphite', colors: ['#5B5B5B', '#7B7B7B', '#9C9C9C', '#BCBCBC'] },
      { id: 'ice', name: 'Ice', colors: ['#00529E', '#0084BE', '#00B5DF', '#00E7FF'] },
      { id: 'lime', name: 'Lime', colors: ['#238800', '#44A600', '#66C500', '#87E300'] },
      { id: 'bubblegum', name: 'Bubblegum', colors: ['#9F009A', '#BB00B8', '#D700D5', '#F300F3'] },
      { id: 'ember', name: 'Ember', colors: ['#9E0000', '#B80000', '#D10000', '#EB0000'] },
      { id: 'snow', name: 'Snow', colors: ['#BCBCBC', '#D2D2D2', '#E9E9E9', '#FFFFFF'] },
      { id: 'sunburst', name: 'Sunburst', colors: ['#E96600', '#F09300', '#F8C100', '#FFEE00'] },
    ],
  },
  classic: {
    id: 'classic',
    name: 'Classic',
    slots: ['Top', 'Bottom', 'Gloss', 'Accent'],
    presets: [
      { id: 'classic', name: 'Classic', colors: ['#00DEFC', '#00FFFE', '#FFFFFF', '#FFFFFF'] },
      { id: 'graphite', name: 'Graphite', colors: ['#999999', '#5F5F5F', '#FFFFFF', '#FFFFFF'] },
      { id: 'lime', name: 'Lime', colors: ['#D3F67D', '#00D062', '#FFFFFF', '#FFFFFF'] },
      { id: 'bubblegum', name: 'Bubblegum', colors: ['#FFBBD2', '#F98ABD', '#FFFFFF', '#FFFFFF'] },
      { id: 'amethyst', name: 'Amethyst', colors: ['#DBC1FA', '#B351EC', '#FFFFFF', '#FFFFFF'] },
      { id: 'ember', name: 'Ember', colors: ['#FF0000', '#F47474', '#FFFFFF', '#FFFFFF'] },
      { id: 'snow', name: 'Snow', colors: ['#FFFFFF', '#DDDDDD', '#FFFFFF', '#FFFFFF'] },
      { id: 'sunburst', name: 'Sunburst', colors: ['#FFFF00', '#FFD700', '#FFFFFF', '#FFFFFF'] },
    ],
  },
  'colour-spiral': {
    id: 'colour-spiral',
    name: 'Colour spiral',
    slots: ['Shadow', 'Mid', 'Light', 'Peak'],
    presets: [
      { id: 'classic', name: 'Classic', colors: ['#050510', '#B4123C', '#37D6FF', '#FFFFFF'] },
    ],
  },
  'infinite-rings': {
    id: 'infinite-rings',
    name: 'Infinite rings',
    slots: ['Background', 'Rings', 'Rings 2', 'Background 2'],
    presets: [
      { id: 'classic', name: 'Classic', colors: ['#FFFFFF', '#FF2D9B', '#00D5FF', '#E6E6E6'] },
      { id: 'graphite', name: 'Graphite', colors: ['#191919', '#FFFFFF', '#989898', '#0F0F0F'] },
      { id: 'lime', name: 'Lime', colors: ['#229E00', '#00FF00', '#0FD300', '#145F00'] },
    ],
  },
  prism: {
    id: 'prism',
    name: 'Prism',
    slots: ['Glow', 'Glow 2', 'Background', 'Background 2'],
    presets: [
      { id: 'classic', name: 'Classic', colors: ['#BCBCBC', '#BCBCBC', '#E9C1FF', '#B4B1FF'] },
      { id: 'graphite', name: 'Graphite', colors: ['#3D3D3D', '#FFFFFF', '#9C9C9C', '#4E4E4E'] },
      { id: 'ice', name: 'Ice', colors: ['#000000', '#BEFFFF', '#00F6FF', '#AF6BFF'] },
      { id: 'lime', name: 'Lime', colors: ['#000000', '#FFFF00', '#00FFA2', '#0E9E00'] },
      { id: 'bubblegum', name: 'Bubblegum', colors: ['#000000', '#FFFFFF', '#FF00FF', '#BC00FF'] },
      { id: 'amethyst', name: 'Amethyst', colors: ['#000000', '#FFFFFF', '#AD00FF', '#BE00FF'] },
      { id: 'ember', name: 'Ember', colors: ['#000000', '#FFFF96', '#FF0000', '#D20000'] },
      { id: 'snow', name: 'Snow', colors: ['#000000', '#FFFFFF', '#FFFFFF', '#B3B3B3'] },
      { id: 'sunburst', name: 'Sunburst', colors: ['#000000', '#FFFFBC', '#FFFF00', '#FFBC00'] },
    ],
    experimental: true,
  },
};

/** The catalogue in picker order. */
export const EFFECT_LIST: readonly EffectDescriptor[] = EFFECT_IDS.map((id) => EFFECT_CATALOG[id]);

/** The colours a preset id names, or `null` when it is `'custom'`/unknown. */
export function presetColours(effect: EffectId, preset: string): readonly string[] | null {
  return EFFECT_CATALOG[effect].presets.find((p) => p.id === preset)?.colors ?? null;
}

/**
 * The preset whose palette these colours ARE, or `'custom'`.
 *
 * Editing a well by hand and editing it back should not leave the panel
 * insisting the palette is custom, so the match is recomputed from the colours
 * rather than latched.
 */
export function matchPreset(effect: EffectId, colors: readonly string[]): string {
  const found = EFFECT_CATALOG[effect].presets.find(
    (p) =>
      p.colors.length === colors.length &&
      p.colors.every((c, i) => c.toUpperCase() === colors[i]?.toUpperCase()),
  );
  return found?.id ?? 'custom';
}
