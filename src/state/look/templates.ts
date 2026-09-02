/**
 * The Looks that ship with the app — §4's "Templates", as real look files.
 *
 * Each one is a {@link LookFile} exactly as `exportLook` would have written it,
 * which is the whole point: a template is not a second kind of thing with its
 * own loader. It goes through `parseLookFile` → `resolveMedia` →
 * `applyLookFile` like anything a user drags in, so the path the app's own
 * content takes is the path a stranger's Look takes, and a bug in it is visible
 * on first run rather than on somebody else's machine.
 *
 * They are also written to disk, one file each, under `public/looks/` — the curated
 * gallery of §9. `templates.test.ts` asserts the two are byte-identical, so a
 * pull request that edits one and not the other fails rather than shipping a
 * gallery that disagrees with the app.
 *
 * ## The configs are deliberately PARTIAL
 *
 * A template names the settings it is *about* — `layout: 'triple'`, this
 * palette, seconds off — and nothing else. Two reasons, and both are load
 * bearing:
 *
 *  1. **A module's `validate()` fills the rest at point of use.** That is how
 *     every stored config in this codebase already works, so a partial config
 *     is not a special case; it is the ordinary one.
 *  2. **Overlay configs live inside `look`, and `look` rides the 8 kB sync
 *     envelope.** A full stats config is ≈ 250 bytes against a `MAX_LOOK_BYTES`
 *     of 3072. Templates that spelled out every default would spend a third of
 *     the wire budget restating `thresholds.cpu.warm = 80`.
 *
 * The drift guard in `templates.test.ts` is written to match: it asserts that
 * every field a template *sets* survives its module's `validate()` unchanged.
 * A palette that stops being a legal preset, a layout that gets renamed, a hex
 * in the wrong case — each is a failing test naming the template.
 *
 * ## No media, on purpose
 *
 * Not one template references a picture or a clip. The repo ships no video and
 * no photograph, and a template that pointed at somebody's CDN would be a Look
 * that breaks when a link rots. The two templates built around media — *Sunset
 * loop + clock* and *Photo + date* — ship with an EMPTY source and say so in
 * their description: the arrangement is the gift, the content is yours.
 *
 * See docs/looks.md and public/looks/README.md.
 */

import { SCHEMA_VERSION } from '../schema';

import { LOOK_FILE_FORMAT, type LookFile } from './file';
import { BASE_LAYER_ID, IDENTITY, type Layer, type Look, type Transform } from './types';

/** Every shipped Look is ours, and the gallery prints it under each card. */
export const TEMPLATE_AUTHOR = 'kraken-hub';

/**
 * One date for all of them.
 *
 * `createdAt` on a template is not a fact about when somebody designed it — it
 * is a field the format requires. A per-template date would be invented data,
 * and a `Date.now()` would make the on-disk files change every time they were
 * regenerated, which is precisely what the byte-identity test exists to catch.
 */
const TEMPLATE_CREATED_AT = '2026-09-02T00:00:00.000Z';

/**
 * A shipped Look, plus the id the gallery and the file name are keyed by.
 *
 * The id is NOT in the file format. A `.krakenlook` is a document, and a
 * document does not know what a catalogue chose to call it — `public/looks/index.json`
 * owns that, and a Look exported by a user has no id at all.
 */
export interface LookTemplate {
  /** Stable and `tpl-`-prefixed; also the file name (`public/looks/<id>.krakenlook`). */
  id: string;
  file: LookFile;
}

// ---------------------------------------------------------------------------
// Construction helpers — these keep the table below readable, nothing more
// ---------------------------------------------------------------------------

/** A transform that differs from identity only where a template says so. */
function at(over: Partial<Transform>): Transform {
  return { ...IDENTITY, ...over };
}

/** A box frame, in DIAMETER units: `w: 2` is the full panel width. */
function box(w: number, h: number, shape: 'square' | 'circle' = 'square'): Layer['frame'] {
  return { w, h, shape };
}

function base(kind: string, name?: string): Layer {
  const layer: Layer = { id: BASE_LAYER_ID, kind, on: true, frame: 'panel', t: IDENTITY };
  if (name !== undefined) layer.name = name;
  return layer;
}

function overlay(
  id: string,
  kind: string,
  frame: Layer['frame'],
  t: Transform,
  cfg: Record<string, unknown>,
): Layer {
  return { id, kind, on: true, frame, t, cfg, v: 1 };
}

interface TemplateSpec {
  id: string;
  name: string;
  description: string;
  layers: Layer[];
  configs: Record<string, unknown>;
  configVersions: Record<string, number>;
}

function template(spec: TemplateSpec): LookTemplate {
  const look: Look = { layers: spec.layers };
  return {
    id: spec.id,
    file: {
      format: LOOK_FILE_FORMAT,
      version: SCHEMA_VERSION,
      name: spec.name,
      author: TEMPLATE_AUTHOR,
      description: spec.description,
      createdAt: TEMPLATE_CREATED_AT,
      look,
      configs: spec.configs,
      configVersions: spec.configVersions,
      media: [],
    },
  };
}

// ---------------------------------------------------------------------------
// The palettes the templates borrow
// ---------------------------------------------------------------------------

/*
 * Restated from `src/modules/effect/catalog.ts` rather than imported, for the
 * same reason `file.ts` restates the media schemes: core state must not pull a
 * module's eager surface into the `core` chunk. `templates.test.ts` asserts
 * each of these IS the named preset's palette, via the catalogue's own
 * `matchPreset` — so a repaint of a material fails here and is fixed in one
 * place.
 *
 * Effect colours are `#RRGGBB` UPPERCASE (`validateEffect` uppercases); text
 * and shape colours are lowercase (`normalizeHex` lowercases). Both cases are
 * load bearing and the drift guard checks them.
 */
const PLASMA_CLASSIC = ['#D6B700', '#F0FF00', '#00FFAF', '#A900FF'];
const PLASMA_SUNBURST = ['#FF9500', '#FFFF00', '#FFFF00', '#FFD200'];
const NEBULA_CLASSIC = ['#00BCFF', '#E1FFFF', '#000089', '#00003E'];
const WAVY_GRAPHITE = ['#5B5B5B', '#7B7B7B', '#9C9C9C', '#BCBCBC'];

/** The one ink the flat faces share, in the case the text and shape modules store. */
const INK = '#f2f4f8';

/** The three readings a Kraken actually has. There is no pump RPM on this hardware. */
const TEMPS = ['cpuTemp', 'gpuTemp', 'liquidTemp'];

// ---------------------------------------------------------------------------
// The templates
// ---------------------------------------------------------------------------

/**
 * Ten, against §10's floor of eight.
 *
 * The four stats faces first, because they are the ones a Kraken is bought for;
 * then the two effect Looks; then the three time/media ones; then *Focus*,
 * which is the only one that is purely typographic and is here to show that the
 * text and shape layers are real layers and not a checkbox.
 */
export const LOOK_TEMPLATES: readonly LookTemplate[] = [
  template({
    id: 'tpl-single',
    name: 'Single',
    description: 'One reading, as large as the panel will draw it, inside a thin arc.',
    layers: [base('stats')],
    configs: {
      stats: { layout: 'single', primary: 'cpuTemp', theme: 'mono', showLabels: true },
    },
    configVersions: { stats: 1 },
  }),

  template({
    id: 'tpl-dual',
    name: 'Dual',
    description: 'Two readings on one ring, as mirrored half-arcs.',
    layers: [base('stats')],
    configs: {
      stats: { layout: 'dual', metrics: TEMPS, theme: 'cyan', showLabels: true },
    },
    configVersions: { stats: 1 },
  }),

  template({
    id: 'tpl-triple',
    name: 'Triple',
    description: 'Three concentric rings around a small centre reading.',
    layers: [base('stats')],
    configs: {
      stats: { layout: 'triple', metrics: TEMPS, primary: 'liquidTemp', theme: 'amber' },
    },
    configVersions: { stats: 1 },
  }),

  template({
    id: 'tpl-overlay',
    name: 'Overlay',
    description: 'A strip of three compact meters along the bottom of a moving background.',
    layers: [
      base('effect'),
      overlay('lstrip', 'stats', box(1.9, 0.5), at({ y: 0.62 }), {
        layout: 'strip',
        metrics: TEMPS,
        theme: 'mono',
      }),
    ],
    configs: {
      effect: { effect: 'plasma', preset: 'classic', colors: PLASMA_CLASSIC },
    },
    configVersions: { effect: 1 },
  }),

  template({
    id: 'tpl-lava-temps',
    name: 'Lava lamp + temps',
    description: 'A lava lamp that warms with the loop, with the temperatures over it.',
    layers: [
      base('effect'),
      overlay('ltemps', 'stats', box(1.3, 1.3, 'circle'), IDENTITY, {
        layout: 'dual',
        metrics: TEMPS,
        theme: 'mono',
        showLabels: true,
      }),
    ],
    configs: {
      effect: {
        effect: 'plasma',
        preset: 'sunburst',
        colors: PLASMA_SUNBURST,
        reactsToTemp: true,
        tempSource: 'liquid',
      },
    },
    configVersions: { effect: 1 },
  }),

  template({
    id: 'tpl-nebula-clock',
    name: 'Nebula clock',
    description: 'A slow nebula behind the time.',
    layers: [
      base('effect'),
      overlay('lclock', 'clock', box(1.4, 0.6), IDENTITY, {
        face: 'digital',
        showSeconds: false,
        theme: 'mono',
      }),
    ],
    configs: {
      effect: { effect: 'twisted-nebula', preset: 'classic', colors: NEBULA_CLASSIC, speed: 0.75 },
    },
    configVersions: { effect: 1 },
  }),

  template({
    id: 'tpl-minimal-clock',
    name: 'Minimal clock',
    description: 'The time, and nothing else.',
    layers: [base('clock')],
    configs: {
      clock: {
        face: 'digital',
        hourFormat: '24',
        showSeconds: false,
        showDate: false,
        theme: 'mono',
      },
    },
    configVersions: { clock: 1 },
  }),

  template({
    id: 'tpl-sunset-clock',
    name: 'Sunset loop + clock',
    description: 'A looping clip with the time over it. The clip is yours to pick — none ships.',
    layers: [
      base('video', 'Your clip'),
      overlay('lclock', 'clock', box(1.3, 0.45), at({ y: 0.58 }), {
        face: 'digital',
        showSeconds: false,
        theme: 'mono',
      }),
    ],
    configs: {
      video: { url: '', demoWhenEmpty: true },
    },
    configVersions: { video: 2 },
  }),

  template({
    id: 'tpl-photo-date',
    name: 'Photo + date',
    description: 'A picture with the date and time along the bottom. The picture is yours to pick.',
    layers: [
      base('image', 'Your picture'),
      overlay('ldate', 'clock', box(1.5, 0.5), at({ y: 0.6 }), {
        face: 'digital',
        showSeconds: false,
        showDate: true,
        theme: 'mono',
      }),
    ],
    configs: {
      image: { url: '' },
    },
    configVersions: { image: 1 },
  }),

  template({
    id: 'tpl-focus',
    name: 'Focus',
    description: 'One word inside a ring, on a gradient that barely moves.',
    layers: [
      base('effect'),
      overlay('lring', 'shape', box(1.5, 1.5, 'circle'), IDENTITY, {
        shape: 'ring',
        fill: 'none',
        stroke: INK,
        strokeWidth: 0.012,
      }),
      overlay('ltext', 'text', box(1.1, 0.4), IDENTITY, {
        text: 'FOCUS',
        size: 0.16,
        weight: 600,
        font: 'condensed',
        color: INK,
        uppercase: true,
      }),
    ],
    configs: {
      effect: {
        effect: 'wavy-gradient',
        preset: 'graphite',
        colors: WAVY_GRAPHITE,
        speed: 0.5,
      },
    },
    configVersions: { effect: 1 },
  }),
];

/** By id, for the Looks menu and the gallery grid. */
export function templateById(id: string): LookTemplate | null {
  return LOOK_TEMPLATES.find((t) => t.id === id) ?? null;
}
