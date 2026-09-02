/**
 * The selection strip, as data — reading and writing a declared control.
 *
 * `design-editor-ux.md` §2.3 says a selected layer shows *its kind's* three to
 * five essential controls and nothing else changes on the screen. The old home
 * screen's `OpsStrip` implemented that with a chain of `if (activeId === …)`
 * branches: it knew four modules by name, and the three that shipped after it
 * (text, shape, effect) had no strip at all, because a view cannot grow a case
 * for a module that did not exist when it was written.
 *
 * So the strip is DECLARED (`KrakenModule.editor.strip`, `src/modules/types.ts`)
 * and RENDERED generically. This module is the half in between: it knows how to
 * walk a dot path into a config or a layer, and nothing about React.
 *
 * Two targets, because a control can be about either half of a layer:
 *
 *  - `'cfg'` — the module's own config (`render.fit`, `face`, `theme`). Written
 *    through the caller's `withLayerConfig`, so the base lands in the bank and
 *    an overlay lands on the layer, exactly as §4.1 requires.
 *  - `'layer'` — the layer itself (`t.a` for opacity). Written through
 *    `ops.setTransform`, and REFUSED on the base, whose transform is `IDENTITY`
 *    by definition. The editor renders such a control disabled rather than
 *    hiding it: the control is a property of the kind, and a picture used as a
 *    base genuinely has no opacity to set.
 *
 * Pure, DOM-free, unit-tested.
 */

import { getModule } from '../../../modules/registry';
import { readPath, writePath } from '../../../modules/stripContract';

import type { StripControl } from '../../../modules/types';
import type { Layer } from '../../../state/look/types';

/** A value a strip control can hold. Anything else is not a strip control. */
export type StripValue = string | number | boolean | undefined;

// ---------------------------------------------------------------------------
// Loading a kind's strip
// ---------------------------------------------------------------------------

/**
 * Strips that have already loaded, keyed by kind.
 *
 * The cache lives HERE rather than on `EditorContract`, which is the manifest's
 * type and therefore a type the display compiles against: a mutable field on it
 * said that a kind's strip is a property of the module, when it is really a
 * property of this page's session. The contract is now the loader and nothing
 * else, and the one module that knows when to call it owns the memory.
 *
 * Module-scoped, so a re-selection of a kind already seen is answered
 * synchronously by `loadedStrip()` — no effect, no state, no re-flow — from
 * whichever of the editor's mounts asks.
 */
const LOADED = new Map<string, readonly StripControl[]>();

/**
 * The strip a kind has ALREADY loaded, or `undefined`.
 *
 * A strip is config-only data — five control declarations, a swatch table, a
 * font list — and declaring it in the (eager) manifest put nine kinds' worth of
 * it in the display's `core` chunk, which the LCD downloads before it can show
 * a frame and never reads: there is no editor on the display. So the
 * declaration moved behind `KrakenModule.editor.loadStrip()` and this file is
 * the half that knows when to call it.
 *
 * A kind this build does not have, and one whose chunk has not been fetched
 * yet, are the same answer — `undefined` — on purpose: every caller renders the
 * reserved-height placeholder for both.
 */
export function loadedStrip(kind: string): readonly StripControl[] | undefined {
  return LOADED.get(kind);
}

/**
 * In-flight loads, keyed by kind.
 *
 * Selecting three text layers in a row must be ONE request. The map is
 * module-scoped rather than per-component for the same reason: the home screen
 * and the remote editor are two mounts of the same strip, and a page that
 * fetched the same 400 bytes twice because two views asked at once would be a
 * page that does the wrong thing quietly.
 */
const INFLIGHT = new Map<string, Promise<readonly StripControl[] | undefined>>();

/**
 * Load a kind's strip, once.
 *
 * Resolves immediately (already-resolved promise) when the kind is cached, so a
 * caller can always `void loadStripFor(kind)` without checking first. A kind
 * this build does not have, or one with no `editor`, resolves to `undefined`
 * rather than throwing — an unknown kind reaches the editor from a synced
 * document written by a newer build, and it must render an empty strip, not
 * take the page down.
 */
export function loadStripFor(kind: string): Promise<readonly StripControl[] | undefined> {
  const cached = loadedStrip(kind);
  if (cached !== undefined) return Promise.resolve(cached);

  const inflight = INFLIGHT.get(kind);
  if (inflight !== undefined) return inflight;

  const editor = getModule(kind)?.editor;
  if (editor === undefined) return Promise.resolve(undefined);

  const load = editor
    .loadStrip()
    .then(({ strip }) => {
      LOADED.set(kind, strip);
      return strip;
    })
    .finally(() => {
      INFLIGHT.delete(kind);
    });
  INFLIGHT.set(kind, load);
  return load;
}

/** Does this control write somewhere, or does it merely open something? */
export function isValueControl(
  control: StripControl,
): control is Extract<StripControl, { path: string }> {
  return 'path' in control;
}

/**
 * The value a control is currently showing.
 *
 * `'toggle'` coerces, because a boolean stored as `undefined` on a config that
 * predates the field is `false` to the reader and must be `false` to the switch.
 */
export function stripValue(control: StripControl, layer: Layer, cfg: unknown): StripValue {
  if (!isValueControl(control)) return undefined;
  const raw = readPath(control.target === 'layer' ? layer : cfg, control.path);
  if (control.control === 'toggle') return raw === true;
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return raw;
  return undefined;
}

/**
 * The config a control's new value produces. `null` when the control does not
 * write a config at all (a `'layer'` target, an action, `More`).
 *
 * The return type is `unknown` rather than `unknown | null` because a union with
 * `unknown` IS `unknown`; the null is documented here and checked at the one
 * call site, which is what the type could not have said anyway.
 */
export function configWith(control: StripControl, cfg: unknown, value: StripValue): unknown {
  if (!isValueControl(control) || control.target !== 'cfg') return null;
  return writePath(cfg, control.path, value);
}

/**
 * The `Transform` patch a `'layer'`-target control produces.
 *
 * Only `t.*` is addressable: `frame` is the resize gesture's business (§3.2)
 * and `id`/`kind`/`on` are not things a strip may quietly rewrite.
 */
export function transformPatchOf(
  control: StripControl,
  value: StripValue,
): Record<string, number> | null {
  if (!isValueControl(control) || control.target !== 'layer') return null;
  if (!control.path.startsWith('t.')) return null;
  const key = control.path.slice(2);
  if (key === '' || key.includes('.')) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return { [key]: value };
}

export {
  MAX_STRIP_CONTROLS,
  readPath,
  stripIsWellFormed,
  writePath,
} from '../../../modules/stripContract';
