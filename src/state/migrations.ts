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
 */
const MIGRATIONS: Readonly<Record<number, Migration>> = {
  1: (s) => ({ ...s, schema: 2 }),
  2: (s) => ({ ...s, schema: 3 }),
  3: (s) => renameClockLite({ ...s, schema: 4 }),
};

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
