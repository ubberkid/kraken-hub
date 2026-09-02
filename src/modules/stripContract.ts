/**
 * The selection strip's two rules, as code.
 *
 * Split from `./types.ts` because that file is types-only — every importer says
 * `import type` — and these are values: the cap, and the predicate that decides
 * whether a declared strip obeys it.
 *
 * It lives under `src/modules/` rather than beside the editor because
 * `defineModule` checks it in DEV and the registry conformance test asserts it,
 * and neither of those may reach into `src/app/config` (invariant I8). The
 * editor imports it from here; nothing flows the other way.
 *
 * See docs/design/design-editor-ux.md §2.3.
 */

import { isPlainObject } from '../lib/clamp';

import type { StripControl } from './types';

/**
 * The most controls a selection strip may carry, `More` included.
 *
 * Five is not a style preference. The strip sits under a ≥ 400 px halo in an
 * 866 px window, it is the ONLY thing on the screen that changes when the
 * selection changes (principle 3), and a sixth control is how a strip becomes a
 * settings panel that happens to be horizontal. `More` opens the inspector,
 * which is where everything else lives, so nothing is lost by the cap — the
 * question a kind has to answer is only ever "which four matter most".
 */
export const MAX_STRIP_CONTROLS = 5;

/**
 * Is this a legal strip?
 *
 * One function, so the enumeration test, the DEV assertion and the renderer
 * cannot disagree about what "≤ 5 with More last" means.
 */
export function stripIsWellFormed(
  strip: readonly StripControl[],
  max: number = MAX_STRIP_CONTROLS,
): boolean {
  if (strip.length === 0 || strip.length > max) return false;
  if (strip[strip.length - 1]?.control !== 'more') return false;
  // `More` is the last control and only the last control.
  if (strip.slice(0, -1).some((c) => c.control === 'more')) return false;
  return new Set(strip.map((c) => c.id)).size === strip.length;
}

/**
 * Read a dot path — `'render.fit'` — out of whatever a config happens to be.
 *
 * Here rather than beside the editor because the registry conformance test uses
 * it to assert that every declared path resolves against the module's own
 * defaults, and a test of `src/modules` may not import `src/app/config` (I8).
 * Total: a path that does not resolve is `undefined`, never a throw — the
 * config arrives from storage as `unknown`, and a strip that crashed on a
 * half-migrated document would take the whole editor with it.
 */
export function readPath(root: unknown, path: string): unknown {
  let cursor: unknown = root;
  for (const key of path.split('.')) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

/**
 * Write a dot path, immutably, creating the objects on the way down.
 *
 * Copies only the spine it touches, so `{ render: { fit } }` shares every other
 * branch with the original — which is what keeps `diffPaths` in the compositor
 * reporting one changed path for one control press instead of `['*']`.
 */
export function writePath(root: unknown, path: string, value: unknown): unknown {
  const [key, ...rest] = path.split('.');
  if (key === undefined) return root;
  const base = isPlainObject(root) ? root : {};
  const next: Record<string, unknown> = { ...base };
  next[key] = rest.length === 0 ? value : writePath(base[key], rest.join('.'), value);
  return next;
}
