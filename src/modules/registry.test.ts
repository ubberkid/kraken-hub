import { describe, expect, it } from 'vitest';

import { DEFAULT_SAFE_RADIUS_PCT } from '../platform/devicePresets';
import { IDENTITY, MAX_LAYERS } from '../state/look/types';

import { MODULE_ID_PATTERN } from './defineModule';
import { DEFAULT_MODULE_ID, MODULES, getModule, resolveModule } from './registry';
import { placementOf } from './stack';
import { MAX_STRIP_CONTROLS, readPath, stripIsWellFormed } from './stripContract';

import type { LayerCost, ModuleCapabilities } from './types';
import type { Layer } from '../state/look/types';

const MAX_DEFAULTS_BYTES = 4096;
/** Mirrored from `defineModule.ts`: `cost()` runs per keystroke in the editor. */
const MAX_COST_SOURCE_BYTES = 1024;
const TRANSFORM_POS_LIMIT = 1.5;
const FRAME_MIN = 0.1;
const FRAME_MAX = 3;
/** Floating-point slack: `stats` sits at the chord's exact equality case. */
const EPSILON = 1e-9;

const BASE: Pick<Layer, 'frame' | 't'> = { frame: 'panel', t: IDENTITY };

/**
 * Conformance suite — runs over every registered module automatically, so a
 * contributor who adds one gets these guarantees without writing a test.
 */
describe('module registry', () => {
  it('registers the default module', () => {
    expect(getModule(DEFAULT_MODULE_ID)).not.toBeNull();
    expect(resolveModule('no-such-module').id).toBe(DEFAULT_MODULE_ID);
  });

  it.each(MODULES.map((m) => [m.id, m] as const))('%s conforms', (_id, mod) => {
    expect(mod.id).toMatch(MODULE_ID_PATTERN);
    expect(mod.name.length).toBeGreaterThan(0);
    expect(mod.summary.length).toBeGreaterThan(0);
    expect(mod.icon.length).toBeGreaterThan(0);
    expect(mod.configVersion).toBeGreaterThanOrEqual(1);
    // configVersion > 1 requires a migration path; v1 modules must not need one.
    expect(mod.configVersion > 1 ? typeof mod.migrateConfig : 'function').toBe('function');

    // validate() is idempotent on its own defaults.
    expect(mod.validate(mod.defaults)).toEqual(mod.defaults);
    expect(mod.validate(mod.validate(mod.defaults))).toEqual(mod.defaults);

    // validate() never throws, whatever garbage storage hands it.
    for (const junk of [undefined, null, 0, '', [], {}, { deeply: { wrong: [1, 2] } }]) {
      expect(() => mod.validate(junk)).not.toThrow();
    }

    expect(JSON.stringify(mod.defaults).length).toBeLessThan(MAX_DEFAULTS_BYTES);
  });

  it('has unique ids', () => {
    const ids = MODULES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/**
 * The placement half of the contract (§9, W2).
 *
 * `layer` is OPTIONAL in the type so a fork's module still compiles — the type
 * cannot know what is in somebody else's build. It is REQUIRED here, because
 * this build's modules are the ones whose placement the editor, the compositor
 * and the cost bar all read, and a module that does not declare one silently
 * falls back to "base only, one instance" and is never offered as an overlay.
 */
describe('every registered module declares where it may sit', () => {
  it.each(MODULES.map((m) => [m.id, m] as const))('%s declares a valid layer', (id, mod) => {
    expect(mod.layer, `${id} must declare layer: { roles, … }`).toBeDefined();
    const placement = placementOf(mod);

    expect(placement.roles.length).toBeGreaterThan(0);
    for (const role of placement.roles) expect(['base', 'overlay']).toContain(role);
    expect(placement.maxInstances).toBeGreaterThanOrEqual(1);
    expect(placement.maxInstances).toBeLessThanOrEqual(MAX_LAYERS);
    expect(['frame', 'scale']).toContain(placement.resize);
    expect(placement.minFrame).toBeGreaterThanOrEqual(FRAME_MIN);
    expect(placement.minFrame).toBeLessThanOrEqual(FRAME_MAX);

    // A default that lands off the panel is a layer nobody can find again.
    const { frame, t } = placement.overlayDefault;
    expect(frame.w).toBeGreaterThanOrEqual(placement.minFrame);
    expect(frame.h).toBeGreaterThanOrEqual(FRAME_MIN);
    expect(frame.w).toBeLessThanOrEqual(FRAME_MAX);
    expect(frame.h).toBeLessThanOrEqual(FRAME_MAX);
    expect(['square', 'circle']).toContain(frame.shape);
    expect(Math.abs(t.x)).toBeLessThanOrEqual(TRANSFORM_POS_LIMIT);
    expect(Math.abs(t.y)).toBeLessThanOrEqual(TRANSFORM_POS_LIMIT);

    // Small enough to run on every keystroke, and pure enough to be cached.
    expect(placement.cost.toString().length).toBeLessThan(MAX_COST_SOURCE_BYTES);
  });

  /**
   * Where a fresh overlay lands has to be somewhere the panel HAS.
   *
   * Audit 11 (M-i) photographed the failure this pins: `date` shipped
   * `1.2 × 0.28` at `y = 0.78`, whose bottom edge is at `0.92` — outside the
   * 0.88 safe ring, and a wider box than the chord a round panel offers at that
   * height once any margin is taken off it. Nothing caught it, because every
   * other check here is about the FRAME's size and the TRANSFORM's limits, and
   * neither of those is wrong on its own; it is the two together, against a
   * circle, that put the band half off the glass.
   *
   * Two rules, and both are about the box's AXIS extents — the midpoints of its
   * four edges — never its corners. That distinction is the whole design
   * (`placement.ts`, `centreOnPanel`): several kinds' defaults are wide strips
   * whose corners are outside the safe ring deliberately, because a stats scrim
   * at `1.6 × 0.5` along the bottom is meant to bleed to the bezel. A rule about
   * corners would reject every default this app ships.
   *
   *  1. **Chord.** The box's horizontal extent fits inside the panel disc at the
   *     box's own centre row, and its vertical extent inside the disc at its
   *     centre column. `stats` and `shape` sit at exactly the equality case:
   *     `1.6` wide at `y = 0.6` IS the chord `2·√(1 − 0.6²)`.
   *  2. **Safe ring.** Those same extents stay inside `safeRadiusPct`, so the
   *     edge a reader's eye lands on is never in the bezel's margin.
   *
   * `t.s` is folded in because a default may ship a scale, and the box the user
   * sees is the scaled one.
   */
  it.each(MODULES.map((m) => [m.id, m] as const))(
    '%s: overlayDefault fits the safe circle',
    (id, mod) => {
      const { frame, t } = placementOf(mod).overlayDefault;
      const hw = (frame.w / 2) * t.s;
      const hh = (frame.h / 2) * t.s;
      const cx = Math.abs(t.x);
      const cy = Math.abs(t.y);
      // Half the panel's chord at a given offset along the other axis.
      const chord = (offset: number): number => Math.sqrt(Math.max(0, 1 - offset * offset));

      expect(
        cx + hw,
        `${id}: ${String(frame.w)} wide at y ${String(t.y)} overflows the panel`,
      ).toBeLessThanOrEqual(chord(cy) + EPSILON);
      expect(
        cy + hh,
        `${id}: ${String(frame.h)} tall at x ${String(t.x)} overflows the panel`,
      ).toBeLessThanOrEqual(chord(cx) + EPSILON);

      expect(cx + hw, `${id}: right/left edge outside the safe ring`).toBeLessThanOrEqual(
        DEFAULT_SAFE_RADIUS_PCT + EPSILON,
      );
      expect(cy + hh, `${id}: top/bottom edge outside the safe ring`).toBeLessThanOrEqual(
        DEFAULT_SAFE_RADIUS_PCT + EPSILON,
      );
    },
  );

  it.each(MODULES.map((m) => [m.id, m] as const))('%s costs something valid', (_id, mod) => {
    const placement = placementOf(mod);
    const probes: Pick<Layer, 'frame' | 't'>[] = [
      BASE,
      { frame: placement.overlayDefault.frame, t: placement.overlayDefault.t },
    ];
    for (const probe of probes) {
      const cost: LayerCost = placement.cost(mod.defaults, probe);
      expect(['static', 'tick', 'frame']).toContain(cost.cadence);
      expect(['low', 'mid', 'high']).toContain(cost.entropy);
      expect(cost.coverage).toBeGreaterThan(0);
      expect(cost.coverage).toBeLessThanOrEqual(1);
      expect([0, 1]).toContain(cost.decoders);
      expect([0, 1]).toContain(cost.gl);
    }
    // Pure: the same two arguments twice give the same answer.
    expect(placement.cost(mod.defaults, BASE)).toEqual(placement.cost(mod.defaults, BASE));
  });

  /**
   * `motionLevel` and `cadence` are two answers to one question, so they may not
   * disagree — a module that paints every frame while claiming to be static
   * would suppress the low-FPS advisory on exactly the thing 1 FPS ruins.
   *
   * The mapping is not a bijection, deliberately. `'frame'` means "ruined at
   * 1 FPS" and `'full'` is the only honest advisory for it; `'static'` is free
   * both ways. `'tick'` — a repaint at most once a second — may be declared
   * `'low'` (the clock: legible, a second late) or `'static'` (stats: the FEED
   * is 1 Hz, so at 1 FPS the module is not degraded at all, it is exactly
   * right). Both of those are true statements about the advisory.
   */
  const ALLOWED: Readonly<Record<LayerCost['cadence'], ModuleCapabilities['motionLevel'][]>> = {
    frame: ['full'],
    tick: ['low', 'static'],
    static: ['static'],
  };

  it.each(MODULES.map((m) => [m.id, m] as const))(
    '%s: motionLevel agrees with cost().cadence',
    (id, mod) => {
      const { cadence } = placementOf(mod).cost(mod.defaults, BASE);
      expect(
        ALLOWED[cadence],
        `${id} declares cadence '${cadence}' and motionLevel '${mod.capabilities.motionLevel}'`,
      ).toContain(mod.capabilities.motionLevel);
    },
  );

  /** §11.3 — the rule that removes the second decoder and the moved `<iframe>`. */
  it('keeps video base-only and single-instance', () => {
    const video = getModule('video');
    expect(video).not.toBeNull();
    if (video === null) return;
    const placement = placementOf(video);
    expect(placement.roles).toEqual(['base']);
    expect(placement.maxInstances).toBe(1);
    expect(placement.cost(video.defaults, BASE).decoders).toBe(1);
  });

  /** At least one kind can be an overlay, or the whole feature is unreachable. */
  it('ships something that can be an overlay', () => {
    const overlayable = MODULES.filter((m) => placementOf(m).roles.includes('overlay'));
    expect(overlayable.length).toBeGreaterThan(0);
  });
});

/**
 * The strip enumeration — `design-editor-ux.md` §2.3's ✓, over every kind.
 *
 * Principle 3 is "one selection, a few controls", and the number is the whole
 * of it: selecting a layer shows THAT KIND's three-to-five essential controls
 * and everything else is behind `More`. A cap that is only written in a design
 * document is a cap that lasts until the next module wants six things.
 *
 * The rule runs over `MODULES`, so a kind added later inherits it without
 * anybody writing a test — which is the same shape the placement suite above
 * takes, and for the same reason: the old `OpsStrip` knew four modules by name
 * and the three that shipped after it had no strip at all.
 *
 * The declaration is LAZY now (`EditorContract.loadStrip`, so nine kinds' option
 * tables stay off the LCD's critical path), and the enumeration is what has to
 * survive that: every one of these iterates `MODULES` and AWAITS each kind's
 * loader, so a kind cannot slip the cap by being behind a dynamic import. A
 * loader that rejects fails the test it was hiding from.
 */
describe('every registered module declares a selection strip', () => {
  it.each(MODULES.map((m) => [m.id, m] as const))('%s declares a legal strip', async (id, mod) => {
    const editor = mod.editor;
    expect(editor, `${id} must declare editor: { loadStrip }`).toBeDefined();
    if (editor === undefined) return;
    expect(typeof editor.loadStrip, `${id}: editor.loadStrip must be a function`).toBe('function');

    const { strip } = await editor.loadStrip();
    expect(strip, `${id}: loadStrip() must resolve to { strip: [...] }`).toBeDefined();

    expect(strip.length, `${id}: a strip of ${String(strip.length)} controls`).toBeLessThanOrEqual(
      MAX_STRIP_CONTROLS,
    );
    expect(strip.at(-1)?.control, `${id}: the last control must be More`).toBe('more');
    expect(stripIsWellFormed(strip), `${id}: ${JSON.stringify(strip.map((c) => c.id))}`).toBe(true);

    for (const control of strip) {
      // A control with no label is a control nobody can name to a support
      // thread, and the label is what the accessibility tree reads out.
      expect(control.label.length, `${id}/${control.id}: needs a label`).toBeGreaterThan(0);
      if (!('path' in control)) continue;
      expect(['cfg', 'layer']).toContain(control.target);
      expect(control.path.length).toBeGreaterThan(0);
      /*
       * A `'layer'` control may only address the transform.
       *
       * `frame` belongs to the resize gesture (§3.2) and `id`/`kind`/`on` are
       * structural: a strip that could rewrite them would be a way to change
       * what a layer IS from a control labelled "Opacity".
       */
      const addressesTransform = control.target === 'cfg' || control.path.startsWith('t.');
      expect(addressesTransform, `${id}/${control.id}: a layer control must address t.*`).toBe(
        true,
      );
      /*
       * The declared path must resolve against the module's own defaults, or
       * the control renders empty on a fresh layer and nobody finds out until
       * somebody adds one. A `'layer'` path is exempt: `t.a` resolves against a
       * LAYER, and a module's defaults are a config.
       */
      const resolves =
        control.target === 'layer' || readPath(mod.defaults, control.path) !== undefined;
      expect(resolves, `${id}/${control.id}: "${control.path}" does not resolve in defaults`).toBe(
        true,
      );
    }
  });

  /**
   * A choice control must offer the value it is currently showing.
   *
   * The failure this catches is a manifest whose swatch list and whose
   * `validate()` disagree — the strip then renders with nothing selected on a
   * perfectly valid config, which reads as "the app does not know what it is
   * showing" and is the loudest small bug an editor can have.
   */
  it.each(MODULES.map((m) => [m.id, m] as const))(
    '%s: every choice on the strip includes the default',
    async (id, mod) => {
      const strip = mod.editor === undefined ? [] : (await mod.editor.loadStrip()).strip;
      for (const control of strip) {
        if (control.control !== 'segmented' && control.control !== 'swatches') continue;
        const current = readPath(mod.defaults, control.path);
        expect(
          control.options.map((o) => o.value),
          `${id}/${control.id}: options do not include the default (${String(current)})`,
        ).toContain(current);
      }
    },
  );

  /**
   * Every kind's loader resolves, and every one of them is a DIFFERENT strip.
   *
   * The `it.each` suites above enumerate `MODULES`, so they already cover every
   * registered kind — this is the assertion that the coverage is real rather
   * than nine tests that all silently short-circuited on an `undefined`
   * `editor`. It is the one thing laziness could take away: a strip that fails
   * to load is a strip that renders as nothing, and a test that skipped it
   * would report green on an editor with no controls in it.
   *
   * The identity check is the second half. Nine loaders that all resolved to
   * the SAME array would mean a copy-pasted `import('./editor')` pointing at
   * somebody else's kind, which typechecks perfectly and puts the clock's
   * controls on a video layer.
   */
  it('loads a distinct strip for every registered kind', async () => {
    const strips = await Promise.all(
      MODULES.map(async (mod) => {
        expect(mod.editor, `${mod.id} must declare editor: { loadStrip }`).toBeDefined();
        return [mod.id, (await mod.editor?.loadStrip())?.strip] as const;
      }),
    );

    expect(strips.map(([id]) => id)).toEqual(MODULES.map((m) => m.id));
    for (const [id, strip] of strips) {
      expect(strip, `${id}: loadStrip() resolved to nothing`).toBeDefined();
    }
    // Nine kinds, nine distinct declarations.
    expect(new Set(strips.map(([, strip]) => strip)).size).toBe(MODULES.length);
  });
});
