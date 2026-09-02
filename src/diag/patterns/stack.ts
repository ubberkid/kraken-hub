/*
 * `?kraken=1&diag=1&pattern=stack&stack=a|b|c|d|e` — five layer stacks of
 * increasing cost, so the per-layer and whole-page costs of DOM stacking can be
 * MEASURED on real hardware (docs/design/design-layers-architecture.md §9 W0,
 * docs/hardware-checklist.md H24–H28).
 *
 *   a  video base + one stats strip
 *   b  video base + stats + clock + text
 *   c  effect base + stats
 *   d  effect base + 4 overlays at a:0.8 (every one its own surface)
 *   e  eight layers — MAX_LAYERS, the worst legal stack
 *
 * W0 drove these through a throwaway compositor and through two throwaway
 * KINDS — a canvas gradient called `plasma` and a bare DOM node called `label` —
 * because `effect` and `text` were W7 work that did not exist yet. Both halves
 * of that scaffolding are now gone. The stacks run through the real compositor
 * (`src/render/LayerHost`) and through the real registry, so every number filmed
 * off the panel is a number for code that ships.
 *
 * The measurement semantics are unchanged, which is the whole point of swapping
 * rather than rewriting (docs/design/w0-measurements.md):
 *   - the `plasma` stand-in occupied a full-frame, every-tick, GPU-uploading
 *     cost slot, and the `effect` module in its Lava lamp / Classic preset is
 *     that slot for real — `cadence:'frame'`, `coverage:1`, one GL context;
 *   - the `label` stand-in was a single static DOM node, and the `text` module
 *     is one too: `cadence:'static'`, no `frame()` at all. What the stacks test
 *     is the SUBSTRATE, and text's substrate is `dom`, exactly as the stand-in's
 *     was.
 * The stack ids, the layer ids and the per-stack surface counts are untouched,
 * so a run against this build is comparable with the W0 tables.
 *
 * Every stack draws the H09 large rAF counter LAST (so it is on top), so the
 * maintainer can film the LCD at 60 fps and count distinct values — the only way
 * capture-side FPS can be measured at all.
 *
 * Reached ONLY through a dynamic import in `DiagOverlay`, so none of this is on
 * the display's critical path.
 */

import { getModule } from '../../modules/registry';
import { LayerHost } from '../../render/LayerHost';
import { configsOf } from '../../render/lookOf';
import { IDENTITY, type Layer, type Look, type Transform } from '../../state/look/types';

import type { DisplayRuntime } from '../../app/display/runtime';
import type { GetModule } from '../../modules/stack';
import type { ModuleSlot } from '../../state/schema';

export type StackId = 'a' | 'b' | 'c' | 'd' | 'e';

export const STACK_IDS: readonly StackId[] = ['a', 'b', 'c', 'd', 'e'];

function t(x: number, y: number, a = 1): Transform {
  return { ...IDENTITY, x, y, a };
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * The REAL registry, unwrapped.
 *
 * It used to be the real one plus two stand-in kinds defined in this file. Both
 * are gone: `effect` and `text` are registered modules now, so the indirection
 * would only hide which code the measurement is measuring. It is still a named
 * export because `normalizeLook`, `configsOf` and `LayerHost` all take the
 * registry as a parameter, and the diagnostic must pass the same one to all
 * three or the plan and the mounted DOM could disagree.
 */
export const stackRegistry: GetModule = getModule;

// ---------------------------------------------------------------------------
// The five looks
// ---------------------------------------------------------------------------

const STATS_STRIP = { w: 1.6, h: 0.5, shape: 'square' } as const;
const CLOCK_BOX = { w: 1, h: 0.5, shape: 'square' } as const;
const TEXT_BOX = { w: 1.2, h: 0.3, shape: 'square' } as const;
const EFFECT_BOX = { w: 1.2, h: 1.2, shape: 'circle' } as const;

/**
 * `size` is the share of the box's WIDTH one em takes (text/display.ts), and
 * `TEXT_BOX` is 1.2 units of a 2-unit panel — so 0.33 puts one em at
 * `0.33 × 0.6 × panel ≈ panel / 5`, which is exactly the font size the W0
 * `label` stand-in laid out. The glyphs on screen are the same size as the ones
 * the recorded numbers were taken from.
 */
const TEXT_SIZE = 0.33;

function base(kind: string): Layer {
  return { id: 'base', kind, on: true, frame: 'panel', t: IDENTITY };
}

function overlay(id: string, kind: string, frame: Layer['frame'], tr: Transform, cfg: unknown) {
  return { id, kind, on: true, frame, t: tr, cfg } satisfies Layer;
}

function statsStrip(id: string, y: number, a = 1, primary = 'cpuTemp'): Layer {
  return overlay(id, 'stats', STATS_STRIP, t(0, y, a), {
    layout: 'single',
    primary,
    theme: 'mono',
    showLabels: true,
  });
}

function clockBox(id: string, y: number, a = 1): Layer {
  return overlay(id, 'clock', CLOCK_BOX, t(0, y, a), {
    face: 'digital',
    showSeconds: true,
    theme: 'mono',
  });
}

/**
 * One line of white type on the `system` face — a single DOM node with no
 * `frame()`, which is the claim stacks (b), (d) and (e) exist to test.
 *
 * `system` deliberately: a curated face would have the layer fetch a stylesheet
 * from Google Fonts, and what is being measured is the substrate, not a font
 * request the maintainer's CAM may not even be able to make.
 */
function textBox(id: string, tr: Transform, text: string): Layer {
  return overlay(id, 'text', TEXT_BOX, tr, {
    text,
    size: TEXT_SIZE,
    weight: 800,
    font: 'system',
    color: '#f2f4f8',
    align: 'center',
    letterSpacing: 0,
    uppercase: false,
    shadow: true,
  });
}

/**
 * Lava lamp in its Classic material — the effect module's own defaults, so what
 * the panel shows is the picture a fresh install shows, at the cost the cost
 * model charges for it (`cadence:'frame'`, `coverage:1`, `entropy:'mid'`, one
 * GL context).
 */
const EFFECT_CFG = {
  effect: 'plasma',
  preset: 'classic',
  colors: ['#D6B700', '#F0FF00', '#00FFAF', '#A900FF'],
  speed: 1,
  scale: 1,
  brightness: 1,
  reactsToTemp: false,
  tempSource: 'cpu',
} as const;

/** The base configs the stacks need. Overlays carry their own `cfg` in the look. */
const BANK: Record<string, ModuleSlot> = {
  video: { v: 1, cfg: { url: '', demoWhenEmpty: true, audioEnabled: false } },
  effect: { v: 1, cfg: EFFECT_CFG },
};

/** The five stacks, in the order §9 W0 lists them. */
export function stackLook(stack: StackId): Look {
  switch (stack) {
    case 'a':
      return { layers: [base('video'), statsStrip('ovr1', 0.6)] };
    case 'b':
      return {
        layers: [
          base('video'),
          statsStrip('ovr1', 0.6),
          clockBox('ovr2', -0.2),
          textBox('ovr3', t(0, -0.6), 'KRAKEN'),
        ],
      };
    case 'c':
      return { layers: [base('effect'), statsStrip('ovr1', 0.6)] };
    case 'd':
      return {
        layers: [
          base('effect'),
          overlay('ovr1', 'effect', EFFECT_BOX, t(0, 0, 0.8), EFFECT_CFG),
          statsStrip('ovr2', 0.6, 0.8),
          clockBox('ovr3', -0.2, 0.8),
          textBox('ovr4', t(0, -0.6, 0.8), 'KRAKEN'),
        ],
      };
    case 'e':
      return {
        layers: [
          base('effect'),
          overlay('ovr1', 'effect', EFFECT_BOX, t(0, 0, 0.8), EFFECT_CFG),
          statsStrip('ovr2', 0.6),
          clockBox('ovr3', -0.2),
          textBox('ovr4', t(0, -0.6), 'KRAKEN'),
          overlay('ovr5', 'stats', { w: 0.7, h: 0.4, shape: 'square' }, t(-0.62, 0), {
            layout: 'single',
            primary: 'gpuTemp',
            theme: 'cyan',
            showLabels: false,
          }),
          overlay('ovr6', 'clock', { w: 0.7, h: 0.4, shape: 'square' }, t(0.62, 0), {
            face: 'analog',
            theme: 'amber',
          }),
          textBox('ovr7', t(0, 0.25), 'HUB'),
        ],
      };
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** The H09 counter: one increment per rAF, drawn over everything. */
function startCounter(root: HTMLElement): () => void {
  const node = document.createElement('span');
  node.className = 'kh-diag__counter';
  root.append(node);
  let n = 0;
  let raf = requestAnimationFrame(function step() {
    n += 1;
    node.textContent = String(n);
    raf = requestAnimationFrame(step);
  });
  return () => {
    cancelAnimationFrame(raf);
    node.remove();
  };
}

export function startStackPattern(
  root: HTMLElement,
  runtime: DisplayRuntime,
  stack: StackId,
): () => void {
  const host = new LayerHost(root, {
    registry: stackRegistry,
    panel: runtime.geometry.get(),
    clock: runtime.frameClock,
    render: () => runtime.store.getSnapshot().render,
    monitoring: runtime.monitoring,
  });

  const look = stackLook(stack);
  host.setLook(look, configsOf(look, { modules: BANK }, stackRegistry));

  // The same hook the configured stage uses, so `?debug=1` prints one line per
  // layer here too without knowing which of the two owns the stage.
  runtime.layers.current = host;

  const offGeometry = runtime.geometry.subscribe(() => {
    host.setPanel(runtime.geometry.get());
  });
  const offMonitoring = runtime.monitoring.subscribe((n, raw) => {
    host.setMonitoring(n, raw);
  });
  const stopCounter = startCounter(root);

  return () => {
    offGeometry();
    offMonitoring();
    stopCounter();
    if (runtime.layers.current === host) runtime.layers.current = null;
    host.destroy();
  };
}
