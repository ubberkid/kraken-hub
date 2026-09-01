/**
 * Forward-only state migrations, keyed by the `schema` number.
 *
 * Two rules that outlive v1:
 *  - A state written by a NEWER build is never destroyed. It is stashed under
 *    `kraken-hub:v1:state:future` and the config UI offers to update instead.
 *  - Every future migration ships with a fixture test. Silent data loss on
 *    somebody's cooler is not recoverable.
 */

import { isPlainObject } from '../lib/clamp';

import { SCHEMA_VERSION } from './schema';

export type MigrationNote =
  'missing-schema' | 'future-schema' | 'not-an-object' | `no-migration-from-${string}`;

export interface MigrationResult {
  raw: unknown;
  notes: MigrationNote[];
  /** Set when the stored document came from a newer build. */
  future: string | null;
}

type Migration = (s: Record<string, unknown>) => Record<string, unknown>;

/**
 * v1 is the baseline: there is nothing before it.
 *
 * 1 → 2 (video module, M1): `render.fit` gained `'contain-circle'`. The change
 * is additive, so nothing in a v1 document needs rewriting — but a v1 *reader*
 * would reject the new value, and that is exactly what the version number is
 * for: a v1 build stashes a v2 document under `…:state:future` rather than
 * silently dropping the fit mode. The `modules` map is untouched; module
 * configs carry their own `configVersion` and are migrated by the module.
 *
 * 2 → 3 (sync layer, M2): `sync` gained `mqttUrl` / `ntfyBase` endpoint
 * overrides and `transport` gained the test-only `fake` value. Both are
 * additive and the validator fills the new keys from defaults, so the step is a
 * version bump — but it is a REAL bump, because a v2 build would reject
 * `transport: 'fake'` and must stash a v3 document rather than silently
 * rewriting the user's transport preference.
 *
 * 3 → 4 (M3): the `clock-lite` placeholder became the real `clock` module. This
 * is the first step that RENAMES something, and it is the reason a module id
 * rename needs a *state* migration rather than a `configVersion` bump: the id
 * appears both as `activeModuleId` and as a key in `modules`, neither of which a
 * module can reach. `clock-lite` was dropped rather than aliased — an alias
 * would have kept a second id alive in every picker, URL and synced snapshot
 * forever, to preserve a module that existed only because M0 needed something
 * to render.
 *
 * 4 → 5: the video module's `quality` setting. Additive and defaulted, so no
 * document needs rewriting — the module's own `configVersion` (1 → 2) is what
 * carries the change, and `validateVideoConfig` fills the key from
 * `{ mode: 'auto', height: null }`, which is what every existing install was
 * already doing. The state version moves for the same reason as 2 → 3: a v4
 * build must stash a v5 document rather than write it back with the user's
 * pinned resolution silently removed.
 *
 * 5 → 6: the settings census. The design audit killed six controls outright and
 * cut a seven-option picker to three, so this step retires the values those
 * controls could write. It is the first step that DELETES user data, and every
 * deletion below is a value the user can no longer reach and no longer change —
 * leaving them stored would mean somebody's cooler kept rendering with a setting
 * that has no control, no default and no way back. Each key is either dropped
 * (the validator refills it from the default) or pinned to the one answer the
 * audit named. See `docs/design` and the panel headers for the reasoning.
 */
const MIGRATIONS: Readonly<Record<number, Migration>> = {
  1: (s) => ({ ...s, schema: 2 }),
  2: (s) => ({ ...s, schema: 3 }),
  3: (s) => renameClockLite({ ...s, schema: 4 }),
  4: (s) => ({ ...s, schema: 5 }),
  5: (s) => settingsCensus({ ...s, schema: 6 }),
};

/**
 * The three aspect values the shape override still offers.
 *
 * Written as numbers rather than imported from `modules/video/types`: this file
 * is core state, it is on the display's critical path, and pulling the video
 * module's whole type surface in here to compare two ratios would put it there
 * too. The tolerance is the same one `sourceAspectKey` uses.
 */
const ASPECT_16_9 = 16 / 9;
const ASPECT_9_16 = 9 / 16;
const ASPECT_EPS = 0.005;

/** A module's stored `cfg` object, or `null` when the slot is not one. */
function moduleCfg(s: Record<string, unknown>, id: string): Record<string, unknown> | null {
  const modules = s['modules'];
  if (!isPlainObject(modules)) return null;
  const slot = modules[id];
  if (!isPlainObject(slot)) return null;
  const cfg = slot['cfg'];
  return isPlainObject(cfg) ? cfg : null;
}

/** Replace one module's `cfg`, leaving every other slot verbatim. */
function withCfg(
  s: Record<string, unknown>,
  id: string,
  cfg: Record<string, unknown>,
): Record<string, unknown> {
  const modules = s['modules'];
  if (!isPlainObject(modules)) return s;
  const slot = modules[id];
  if (!isPlainObject(slot)) return s;
  return { ...s, modules: { ...modules, [id]: { ...slot, cfg } } };
}

/** Drop `keys` from `o`, returning `o` itself when there was nothing to drop. */
function drop(o: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const present = keys.filter((k) => Object.hasOwn(o, k));
  if (present.length === 0) return o;
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (!present.includes(k)) next[k] = v;
  }
  return next;
}

/**
 * 5 → 6 — what the settings census retired.
 *
 * Every retired key is **deleted rather than rewritten**, and the reason is that
 * the validators already default each one to precisely the answer the audit
 * named. `perf` defaults to `auto`, `loop.mode` to `hard`, `pauseStrategy` to
 * `microloop`, `sourceAspect` to `auto`, `background` to black. Deleting is
 * therefore the same outcome as pinning, with two advantages: a document that
 * never used the control is returned untouched (so the step is a no-op for
 * almost everybody), and there is no second copy of the default living in this
 * file to drift away from the one in the module.
 *
 * **video**
 *  - `perf` — the picture-quality picker is gone; `fpsGovernor` and the perf
 *    promoter already choose from measured frames, and a stored
 *    `quality`/`performance` would have overridden them forever with no visible
 *    control saying so.
 *  - `youtube.pauseStrategy` — the alternative calls YouTube's own pause, which
 *    raises a grid of suggested videos *inside* the picture, where cropping
 *    cannot reach it.
 *  - `youtube.mode` and `youtube.portraitWidth` — compositor internals, and the
 *    portrait-width control's own help text admitted its alternative was
 *    unverified on hardware.
 *  - `youtube.sourceAspect` — only when it is one of the four exotic ratios
 *    (4:3, 1:1, 21:9, 2.39:1) the three-segment override can no longer show. A
 *    value with no segment leaves the control displaying nothing selected.
 *  - `loop.mode` and `loop.crossfadeMs` — the crossfade already switched itself
 *    off under load, and cost a second video decoder when it did not.
 *
 * **image**
 *  - `background` — a free-form hex field for the strip around a picture, on a
 *    device whose bezel is black.
 */
function settingsCensus(s: Record<string, unknown>): Record<string, unknown> {
  let next = s;

  const video = moduleCfg(next, 'video');
  if (video !== null) {
    let cfg = drop(video, ['perf']);

    const loop = cfg['loop'];
    if (isPlainObject(loop)) {
      const trimmed = drop(loop, ['mode', 'crossfadeMs']);
      if (trimmed !== loop) cfg = { ...cfg, loop: trimmed };
    }

    const yt = cfg['youtube'];
    if (isPlainObject(yt)) {
      const aspect = yt['sourceAspect'];
      const showable =
        !Object.hasOwn(yt, 'sourceAspect') ||
        aspect === 'auto' ||
        (typeof aspect === 'number' &&
          (Math.abs(aspect - ASPECT_16_9) < ASPECT_EPS ||
            Math.abs(aspect - ASPECT_9_16) < ASPECT_EPS));
      const trimmed = drop(yt, [
        'mode',
        'portraitWidth',
        'pauseStrategy',
        ...(showable ? [] : ['sourceAspect']),
      ]);
      if (trimmed !== yt) cfg = { ...cfg, youtube: trimmed };
    }

    if (cfg !== video) next = withCfg(next, 'video', cfg);
  }

  const image = moduleCfg(next, 'image');
  if (image !== null) {
    const trimmed = drop(image, ['background']);
    if (trimmed !== image) next = withCfg(next, 'image', trimmed);
  }

  return next;
}

const LEGACY_CLOCK_ID = 'clock-lite';
const CLOCK_ID = 'clock';

/**
 * `clock-lite` → `clock`, config and all.
 *
 * The old config was `{ format, showSeconds, color }`. `format` becomes
 * `hourFormat` and `showSeconds` carries over verbatim; `color` is dropped,
 * because the new module offers named palettes instead of a free-form colour,
 * and its default (`mono`) is the exact `#f2f4f8` the placeholder painted — so
 * a user who never changed the colour sees no difference at all.
 *
 * An existing `clock` slot always wins: it was written by this build and is
 * newer than anything the placeholder left behind.
 */
function renameClockLite(s: Record<string, unknown>): Record<string, unknown> {
  const next = { ...s };
  if (next['activeModuleId'] === LEGACY_CLOCK_ID) next['activeModuleId'] = CLOCK_ID;

  const modules = next['modules'];
  if (!isPlainObject(modules) || !Object.hasOwn(modules, LEGACY_CLOCK_ID)) return next;

  const legacy = modules[LEGACY_CLOCK_ID];
  // Rebuilt rather than deleted from: every OTHER module's slot is preserved
  // verbatim, including a fork's, which is the rule for the `modules` map.
  const rest: Record<string, unknown> = {};
  for (const [id, slot] of Object.entries(modules)) {
    if (id !== LEGACY_CLOCK_ID) rest[id] = slot;
  }

  if (!Object.hasOwn(rest, CLOCK_ID)) {
    const cfg = isPlainObject(legacy) ? legacy['cfg'] : undefined;
    const old = isPlainObject(cfg) ? cfg : {};
    const migrated: Record<string, unknown> = { face: 'digital' };
    if (old['format'] === '12' || old['format'] === '24') migrated['hourFormat'] = old['format'];
    if (typeof old['showSeconds'] === 'boolean') migrated['showSeconds'] = old['showSeconds'];
    rest[CLOCK_ID] = { v: 1, cfg: migrated };
  }

  next['modules'] = rest;
  return next;
}

export function migrate(raw: unknown): MigrationResult {
  const notes: MigrationNote[] = [];

  if (!isPlainObject(raw)) {
    return { raw: { schema: SCHEMA_VERSION }, notes: ['not-an-object'], future: null };
  }

  let s: Record<string, unknown> = raw;
  if (typeof s['schema'] !== 'number' || !Number.isFinite(s['schema'])) {
    s = { ...s, schema: 1 };
    notes.push('missing-schema');
  }

  let version = s['schema'] as number;

  if (version > SCHEMA_VERSION) {
    notes.push('future-schema');
    return { raw: { schema: SCHEMA_VERSION }, notes, future: JSON.stringify(raw) };
  }

  while (version < SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (step === undefined) {
      notes.push(`no-migration-from-${String(version)}`);
      return { raw: { schema: SCHEMA_VERSION }, notes, future: null };
    }
    s = step(s);
    const next = s['schema'];
    if (typeof next !== 'number' || next <= version) {
      notes.push(`no-migration-from-${String(version)}`);
      return { raw: { schema: SCHEMA_VERSION }, notes, future: null };
    }
    version = next;
  }

  return { raw: s, notes, future: null };
}
