/**
 * STEP 2 (docs/modules.md §4) — the curated glyph set, as data.
 *
 * Forty-eight glyphs, all of them drawn here, on one 24×24 grid. There is no
 * icon font and no external set: a font is a network request on the display
 * path (there is no network in CAM) and a third-party set is a licence file
 * somebody has to keep true. These are simple geometry — lines, rects, circles
 * and a few arcs — and they are MIT with the rest of the repository.
 *
 * ## Two paints, one grid
 *
 * A glyph is either DRAWN (`paint: 'stroke'`: `fill="none"`, one stroke whose
 * width is the config's weight) or SOLID (`paint: 'fill'`: filled, no stroke).
 * The distinction is per glyph rather than per config because a heart with a
 * hole in it is not a lighter heart, it is a different symbol — so `weight`
 * moves the stroke glyphs and leaves the solid ones alone, and the panel says
 * so.
 *
 * Everything is on the 24 grid and nothing here knows a pixel: `svg.ts` puts
 * the grid in a `viewBox` and the box the layer got decides how big that is.
 */

/** The five drawers of the picker, in the order the panel shows them. */
export type GlyphCategory = 'hardware' | 'ambient' | 'symbols' | 'arrows' | 'shapes';

export const GLYPH_CATEGORIES: readonly GlyphCategory[] = [
  'hardware',
  'ambient',
  'symbols',
  'arrows',
  'shapes',
];

export const CATEGORY_LABELS: Readonly<Record<GlyphCategory, string>> = {
  hardware: 'Hardware',
  ambient: 'Ambient',
  symbols: 'Symbols',
  arrows: 'Arrows',
  shapes: 'Shapes',
};

export interface Glyph {
  /** Stable id — it is what a stored config and a synced look carry. */
  readonly id: string;
  /** What the picker calls it, and what the accessibility tree reads. */
  readonly label: string;
  readonly category: GlyphCategory;
  /** `'stroke'` glyphs take the weight; `'fill'` glyphs are solid. */
  readonly paint: 'stroke' | 'fill';
  /** Path data on the 24×24 grid. One `d`, so one `<path>` per glyph. */
  readonly d: string;
}

export const GLYPHS: readonly Glyph[] = [
  // ----- hardware ---------------------------------------------------------
  {
    id: 'cpu',
    label: 'Processor',
    category: 'hardware',
    paint: 'stroke',
    d: 'M6 6h12v12H6z M9.5 9.5h5v5h-5z M9 3v3 M15 3v3 M9 18v3 M15 18v3 M3 9h3 M3 15h3 M18 9h3 M18 15h3',
  },
  {
    id: 'gpu',
    label: 'Graphics card',
    category: 'hardware',
    paint: 'stroke',
    d: 'M2 7h18a2 2 0 012 2v6a2 2 0 01-2 2H2z M6 11h4 M6 14h4 M16 15.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7z',
  },
  {
    id: 'fan',
    label: 'Fan',
    category: 'hardware',
    paint: 'fill',
    d: 'M12 12V5a3.5 3.5 0 013.5 3.5c0 2-1.6 3.5-3.5 3.5z M12 12h7a3.5 3.5 0 01-3.5 3.5c-2 0-3.5-1.6-3.5-3.5z M12 12v7a3.5 3.5 0 01-3.5-3.5c0-2 1.6-3.5 3.5-3.5z M12 12H5a3.5 3.5 0 013.5-3.5c2 0 3.5 1.6 3.5 3.5z M12 10.6a1.4 1.4 0 100 2.8 1.4 1.4 0 000-2.8z',
  },
  {
    id: 'drop',
    label: 'Coolant',
    category: 'hardware',
    paint: 'fill',
    d: 'M12 3c3.5 4.2 6 7.2 6 10a6 6 0 01-12 0c0-2.8 2.5-5.8 6-10z',
  },
  {
    id: 'thermometer',
    label: 'Thermometer',
    category: 'hardware',
    paint: 'stroke',
    d: 'M14 14.8V5a2 2 0 10-4 0v9.8a4 4 0 104 0z M12 8v7',
  },
  {
    id: 'bolt',
    label: 'Power draw',
    category: 'hardware',
    paint: 'fill',
    d: 'M13 2L5 13h5l-1 9 9-12h-5l1-8z',
  },
  {
    id: 'memory',
    label: 'Memory',
    category: 'hardware',
    paint: 'stroke',
    d: 'M3 8h18v8H3z M6 16v3 M10 16v3 M14 16v3 M18 16v3 M7 11h10',
  },
  {
    id: 'disk',
    label: 'Disk',
    category: 'hardware',
    paint: 'stroke',
    d: 'M3 6h18v12H3z M12 15.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z M6 9h3',
  },

  // ----- ambient ----------------------------------------------------------
  {
    id: 'sun',
    label: 'Sun',
    category: 'ambient',
    paint: 'stroke',
    d: 'M16 12a4 4 0 11-8 0 4 4 0 018 0z M12 2v3 M12 19v3 M2 12h3 M19 12h3 M4.9 4.9l2.1 2.1 M17 17l2.1 2.1 M19.1 4.9L17 7 M7 17l-2.1 2.1',
  },
  {
    id: 'moon',
    label: 'Moon',
    category: 'ambient',
    paint: 'fill',
    d: 'M20 14.5A8.5 8.5 0 019.5 4 8.5 8.5 0 1020 14.5z',
  },
  {
    id: 'star',
    label: 'Star',
    category: 'ambient',
    paint: 'fill',
    d: 'M12 3l2.7 5.9 6.3.7-4.7 4.3 1.3 6.2L12 17l-5.6 3.1 1.3-6.2L3 9.6l6.3-.7L12 3z',
  },
  {
    id: 'cloud',
    label: 'Cloud',
    category: 'ambient',
    paint: 'stroke',
    d: 'M6.5 18h11a3.5 3.5 0 00.5-7 5.5 5.5 0 00-10.6-1.3A3.6 3.6 0 006.5 18z',
  },
  {
    id: 'flame',
    label: 'Flame',
    category: 'ambient',
    paint: 'fill',
    d: 'M12 2c1 4-3 5-3 9a3 3 0 006 0c0-1.5-.6-2.4-.6-3.5 2 1.3 3.6 3.3 3.6 5.5a6 6 0 11-12 0C6 8 12 7 12 2z',
  },
  {
    id: 'snowflake',
    label: 'Snowflake',
    category: 'ambient',
    paint: 'stroke',
    d: 'M12 2v20 M3.5 7l17 10 M20.5 7l-17 10 M12 6l-2.5-2.5 M12 6l2.5-2.5 M12 18l-2.5 2.5 M12 18l2.5 2.5',
  },

  // ----- symbols ----------------------------------------------------------
  {
    id: 'heart',
    label: 'Heart',
    category: 'symbols',
    paint: 'fill',
    d: 'M12 20.5C5.9 15 3 12 3 8.5 3 5.9 5 4 7.5 4c1.7 0 3.4.9 4.5 2.3C13.1 4.9 14.8 4 16.5 4 19 4 21 5.9 21 8.5c0 3.5-2.9 6.5-9 12z',
  },
  { id: 'check', label: 'Check', category: 'symbols', paint: 'stroke', d: 'M4 12.5l5.5 5.5L20 7' },
  {
    id: 'alert',
    label: 'Alert',
    category: 'symbols',
    paint: 'stroke',
    d: 'M12 3.5L22 20H2L12 3.5z M12 9.5v4.5 M12 17v.01',
  },
  {
    id: 'info',
    label: 'Info',
    category: 'symbols',
    paint: 'stroke',
    d: 'M21 12a9 9 0 11-18 0 9 9 0 0118 0z M12 11v6 M12 7.5v.01',
  },
  { id: 'play', label: 'Play', category: 'symbols', paint: 'fill', d: 'M7 4l13 8-13 8V4z' },
  {
    id: 'pause',
    label: 'Pause',
    category: 'symbols',
    paint: 'fill',
    d: 'M7 4h4v16H7V4z M13 4h4v16h-4V4z',
  },
  {
    id: 'music',
    label: 'Music',
    category: 'symbols',
    paint: 'stroke',
    d: 'M9 18V5l12-2v13 M9 18a3 3 0 11-6 0 3 3 0 016 0z M21 16a3 3 0 11-6 0 3 3 0 016 0z',
  },
  {
    id: 'headphones',
    label: 'Headphones',
    category: 'symbols',
    paint: 'stroke',
    d: 'M4 15v-3a8 8 0 1116 0v3 M4 15h3v6H6a2 2 0 01-2-2v-4z M20 15h-3v6h1a2 2 0 002-2v-4z',
  },
  {
    id: 'gamepad',
    label: 'Gamepad',
    category: 'symbols',
    paint: 'stroke',
    d: 'M6 8h12a4 4 0 014 4v3a3 3 0 01-5.4 1.8L15 15H9l-1.6 1.8A3 3 0 012 15v-3a4 4 0 014-4z M7 12h3 M8.5 10.5v3 M15.5 12v.01 M17.5 14v.01',
  },
  {
    id: 'wifi',
    label: 'Wi-Fi',
    category: 'symbols',
    paint: 'stroke',
    d: 'M2.5 9a15 15 0 0119 0 M6 12.5a10 10 0 0112 0 M9.5 16a5 5 0 015 0 M12 19.5v.01',
  },
  {
    id: 'bluetooth',
    label: 'Bluetooth',
    category: 'symbols',
    paint: 'stroke',
    d: 'M7 7l10 10-5 4V3l5 4L7 17',
  },
  {
    id: 'power',
    label: 'Power',
    category: 'symbols',
    paint: 'stroke',
    d: 'M12 3v9 M6.8 6.8a8 8 0 1010.4 0',
  },
  {
    id: 'clock',
    label: 'Clock',
    category: 'symbols',
    paint: 'stroke',
    d: 'M21 12a9 9 0 11-18 0 9 9 0 0118 0z M12 7v5.5l3.5 2',
  },
  {
    id: 'calendar',
    label: 'Calendar',
    category: 'symbols',
    paint: 'stroke',
    d: 'M4 6h16v15H4z M4 10h16 M8 3v4 M16 3v4',
  },

  // ----- arrows -----------------------------------------------------------
  {
    id: 'arrow-up',
    label: 'Arrow up',
    category: 'arrows',
    paint: 'stroke',
    d: 'M12 20V4 M5 11l7-7 7 7',
  },
  {
    id: 'arrow-down',
    label: 'Arrow down',
    category: 'arrows',
    paint: 'stroke',
    d: 'M12 4v16 M5 13l7 7 7-7',
  },
  {
    id: 'arrow-left',
    label: 'Arrow left',
    category: 'arrows',
    paint: 'stroke',
    d: 'M20 12H4 M11 5l-7 7 7 7',
  },
  {
    id: 'arrow-right',
    label: 'Arrow right',
    category: 'arrows',
    paint: 'stroke',
    d: 'M4 12h16 M13 5l7 7-7 7',
  },
  {
    id: 'chevron-up',
    label: 'Chevron up',
    category: 'arrows',
    paint: 'stroke',
    d: 'M5 15l7-7 7 7',
  },
  {
    id: 'chevron-down',
    label: 'Chevron down',
    category: 'arrows',
    paint: 'stroke',
    d: 'M5 9l7 7 7-7',
  },
  {
    id: 'chevron-left',
    label: 'Chevron left',
    category: 'arrows',
    paint: 'stroke',
    d: 'M15 5l-7 7 7 7',
  },
  {
    id: 'chevron-right',
    label: 'Chevron right',
    category: 'arrows',
    paint: 'stroke',
    d: 'M9 5l7 7-7 7',
  },
  {
    id: 'refresh',
    label: 'Refresh',
    category: 'arrows',
    paint: 'stroke',
    d: 'M19.5 12a7.5 7.5 0 11-2.2-5.3 M20 4v4h-4',
  },
  {
    id: 'expand',
    label: 'Expand',
    category: 'arrows',
    paint: 'stroke',
    d: 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5',
  },

  // ----- shapes -----------------------------------------------------------
  {
    id: 'circle',
    label: 'Circle',
    category: 'shapes',
    paint: 'stroke',
    d: 'M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  },
  { id: 'square', label: 'Square', category: 'shapes', paint: 'stroke', d: 'M4 4h16v16H4z' },
  {
    id: 'triangle',
    label: 'Triangle',
    category: 'shapes',
    paint: 'stroke',
    d: 'M12 4l9 16H3L12 4z',
  },
  {
    id: 'diamond',
    label: 'Diamond',
    category: 'shapes',
    paint: 'stroke',
    d: 'M12 3l9 9-9 9-9-9 9-9z',
  },
  {
    id: 'hexagon',
    label: 'Hexagon',
    category: 'shapes',
    paint: 'stroke',
    d: 'M8 3.5h8l4 8.5-4 8.5H8l-4-8.5L8 3.5z',
  },
  {
    id: 'ring',
    label: 'Ring',
    category: 'shapes',
    paint: 'stroke',
    d: 'M21 12a9 9 0 11-18 0 9 9 0 0118 0z M16 12a4 4 0 11-8 0 4 4 0 018 0z',
  },
  { id: 'plus', label: 'Plus', category: 'shapes', paint: 'stroke', d: 'M12 4v16 M4 12h16' },
  { id: 'minus', label: 'Minus', category: 'shapes', paint: 'stroke', d: 'M4 12h16' },
  { id: 'cross', label: 'Cross', category: 'shapes', paint: 'stroke', d: 'M5 5l14 14 M19 5L5 19' },
  {
    id: 'dot',
    label: 'Dot',
    category: 'shapes',
    paint: 'fill',
    d: 'M12 7a5 5 0 110 10 5 5 0 010-10z',
  },
];

/** The whole set, by id. Built once: the picker and the renderer both read it. */
const BY_ID: ReadonlyMap<string, Glyph> = new Map(GLYPHS.map((g) => [g.id, g]));

export const GLYPH_IDS: readonly string[] = GLYPHS.map((g) => g.id);

/** Total: an unknown id is `null`, never a throw — config arrives as `unknown`. */
export function getGlyph(id: string): Glyph | null {
  return BY_ID.get(id) ?? null;
}

export function glyphsIn(category: GlyphCategory): readonly Glyph[] {
  return GLYPHS.filter((g) => g.category === category);
}
