/**
 * Identity helper with DEV-only shape assertions.
 *
 * It exists for two reasons: type inference (so a module author writes
 * `defaults` once and everything else is inferred), and failing loudly in
 * development instead of silently on a cooler.
 */

import { createLogger } from '../lib/log';
import { IDENTITY, TRANSFORM_LIMITS } from '../state/look/types';

import { MAX_STRIP_CONTROLS, stripIsWellFormed } from './stripContract';

import type { KrakenModule, LayerCost, LayerPlacement } from './types';

const log = createLogger('modules');

export const MODULE_ID_PATTERN = /^[a-z][a-z0-9-]{1,23}$/;
const MAX_DEFAULTS_BYTES = 4096;

/**
 * `cost()` runs on every keystroke in the editor and once per layer whenever the
 * home screen redraws its budget bar. A kilobyte of source is a generous ceiling
 * for "a table lookup and a multiply", and a function that needs more than that
 * is doing work that belongs in `validate()`.
 */
const MAX_COST_SOURCE_BYTES = 1024;
/** Frame diameters are clamped to this by the validator; a default outside it is a bug. */
const FRAME_LIMITS = { min: 0.1, max: 3 } as const;
const FRAME_MIN: number = FRAME_LIMITS.min;
const FRAME_MAX: number = FRAME_LIMITS.max;

function checkCostShape(id: string, cost: LayerCost, when: string): void {
  const cadences = ['static', 'tick', 'frame'];
  const entropies = ['low', 'mid', 'high'];
  if (!cadences.includes(cost.cadence)) {
    log.error(`module "${id}": cost().cadence must be one of ${cadences.join('|')} (${when})`);
  }
  if (!entropies.includes(cost.entropy)) {
    log.error(`module "${id}": cost().entropy must be one of ${entropies.join('|')} (${when})`);
  }
  if (!(cost.coverage > 0 && cost.coverage <= 1)) {
    log.error(`module "${id}": cost().coverage must be in (0, 1] (${when})`);
  }
  const decoders: number = cost.decoders;
  const gl: number = cost.gl;
  if (decoders !== 0 && decoders !== 1) {
    log.error(`module "${id}": cost().decoders must be 0 or 1 (${when})`);
  }
  if (gl !== 0 && gl !== 1) {
    log.error(`module "${id}": cost().gl must be 0 or 1 (${when})`);
  }
}

/**
 * The placement half of the DEV assertions (§9, W2).
 *
 * Everything here is a mistake that would otherwise surface as a layer in the
 * wrong place on somebody's cooler: an empty `roles` (a module nothing can
 * mount), an `overlayDefault` off the edge of the panel, a `cost()` that is not
 * a pure function of its two arguments.
 */
function checkPlacement(id: string, layer: LayerPlacement, defaults: unknown): void {
  if (layer.roles.length === 0) {
    log.error(`module "${id}": layer.roles must name at least one of 'base' | 'overlay'`);
  }
  const roles: readonly string[] = ['base', 'overlay'];
  for (const role of layer.roles) {
    if (!roles.includes(role)) {
      log.error(`module "${id}": layer.roles has an unknown role "${role}"`);
    }
  }
  if (!Number.isFinite(layer.maxInstances) || layer.maxInstances < 1) {
    log.error(`module "${id}": layer.maxInstances must be >= 1`);
  }
  const resizes: readonly string[] = ['frame', 'scale'];
  if (!resizes.includes(layer.resize)) {
    log.error(`module "${id}": layer.resize must be 'frame' or 'scale'`);
  }
  if (!(layer.minFrame >= FRAME_MIN && layer.minFrame <= FRAME_MAX)) {
    log.error(
      `module "${id}": layer.minFrame must be within [${String(FRAME_MIN)}, ${String(FRAME_MAX)}]`,
    );
  }

  const { frame, t } = layer.overlayDefault;
  if (!(
    frame.w >= FRAME_MIN &&
    frame.w <= FRAME_MAX &&
    frame.h >= FRAME_MIN &&
    frame.h <= FRAME_MAX
  )) {
    log.error(
      `module "${id}": layer.overlayDefault.frame is outside [${String(FRAME_MIN)}, ${String(FRAME_MAX)}]`,
    );
  }
  const { pos, sMin, sMax, rot } = TRANSFORM_LIMITS;
  if (Math.abs(t.x) > pos || Math.abs(t.y) > pos) {
    log.error(`module "${id}": layer.overlayDefault.t is outside ±${String(pos)} units`);
  }
  if (t.s < sMin || t.s > sMax || Math.abs(t.r) > rot || t.a < 0 || t.a > 1) {
    log.error(`module "${id}": layer.overlayDefault.t is outside TRANSFORM_LIMITS`);
  }

  const source = layer.cost.toString();
  if (source.length > MAX_COST_SOURCE_BYTES) {
    log.error(
      `module "${id}": layer.cost() is ${String(source.length)} bytes of source (max ${String(MAX_COST_SOURCE_BYTES)})`,
    );
  }

  // Purity, as far as it can be checked from the outside: same arguments in,
  // deep-equal result out, twice, with nothing thrown.
  const probe = { frame: 'panel' as const, t: IDENTITY };
  try {
    const once = layer.cost(defaults, probe);
    const twice = layer.cost(defaults, probe);
    checkCostShape(id, once, 'defaults on the panel frame');
    if (JSON.stringify(once) !== JSON.stringify(twice)) {
      log.error(`module "${id}": layer.cost() is not pure — two identical calls disagreed`);
    }
    checkCostShape(
      id,
      layer.cost(defaults, { frame: layer.overlayDefault.frame, t: layer.overlayDefault.t }),
      'defaults on the overlay frame',
    );
  } catch (err) {
    log.error(`module "${id}": layer.cost() threw`, err);
  }
}

export function defineModule<C>(mod: KrakenModule<C>): KrakenModule<C> {
  if (import.meta.env.DEV) {
    if (!MODULE_ID_PATTERN.test(mod.id)) {
      log.error(`module id "${mod.id}" must match ${MODULE_ID_PATTERN.source}`);
    }
    if (mod.configVersion < 1) {
      log.error(`module "${mod.id}": configVersion must be >= 1`);
    }
    if (mod.configVersion > 1 && mod.migrateConfig === undefined) {
      log.error(`module "${mod.id}": configVersion > 1 requires migrateConfig()`);
    }
    const bytes = JSON.stringify(mod.defaults).length;
    if (bytes > MAX_DEFAULTS_BYTES) {
      log.error(
        `module "${mod.id}": defaults are ${String(bytes)} bytes (max ${String(MAX_DEFAULTS_BYTES)})`,
      );
    }
    if (mod.layer !== undefined) {
      checkPlacement(mod.id, mod.layer, mod.defaults);
      /*
       * The one hardcoded kind, and it earns it (§11.3).
       *
       * One decoder, one `videoTelemetry` context, one promoted stage, and an
       * `<iframe>` that re-navigates if it is ever moved in the DOM. "Video is
       * the base, and there is one of it" is what removes all four problems at
       * once, so it is asserted here rather than left to a code review.
       */
      if (mod.id === 'video') {
        const baseOnly = mod.layer.roles.length === 1 && mod.layer.roles[0] === 'base';
        if (!baseOnly || mod.layer.maxInstances !== 1) {
          log.error(`module "video": must declare roles ['base'] and maxInstances 1`);
        }
      }
    }
    /*
     * The strip's cap, checked where the author will see it (§2.3).
     *
     * The conformance suite asserts the same thing in CI; this is the version
     * that fires in the browser console while somebody is writing the manifest,
     * which is three hours earlier.
     *
     * The declaration is LAZY now (`EditorContract.loadStrip`), so the check is
     * too: it awaits the loader instead of reading a field. DEV-only, so the
     * nine tiny chunks it pulls in are nine dev-server requests and nothing at
     * all in a production build — `import.meta.env.DEV` is statically false
     * there and the whole block, this `await` included, is dropped.
     *
     * Both halves of the promise are handled. An unhandled rejection here would
     * be a module author's typo arriving as a red box with no module id in it.
     */
    const { editor } = mod;
    if (editor !== undefined) {
      void editor.loadStrip().then(
        ({ strip }) => {
          if (!stripIsWellFormed(strip)) {
            log.error(
              `module "${mod.id}": editor.strip must be 1..${String(MAX_STRIP_CONTROLS)} controls with unique ids and 'more' last`,
            );
          }
        },
        (err: unknown) => {
          log.error(`module "${mod.id}": editor.loadStrip() failed`, err);
        },
      );
    }
  }
  return mod;
}
