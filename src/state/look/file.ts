/**
 * The `.krakenlook` file — a Look, the configs it wears, and its media by
 * reference. Pure, total, DOM-free, storage-free.
 *
 * A look file is **KB-sized on purpose**. It carries the arrangement and the
 * settings; it never carries bytes. A picture or a clip appears as a
 * {@link MediaRef} — a content hash for something that lives in somebody's
 * library, or the URL it came from — and the importer resolves it against the
 * receiving machine's own library. That is what makes a Look shareable in a
 * pull request (§9 of docs/design/design-editor-ux.md) rather than a 10 MB JSON
 * by surprise. The optional `.krakenlook.zip` bundle that embeds the referenced
 * media is a later wave; nothing here assumes it.
 *
 * Four functions, one each for the four things a file is for:
 *
 *  - {@link exportLook} — document → file. Local media refs are lifted OUT of
 *    the configs into `media`, because `kraken-hub-clip:<id>` names a row in the
 *    exporter's IndexedDB and means nothing on anybody else's machine.
 *  - {@link parseLookFile} — bytes → file. **Total**: bad JSON, a foreign
 *    format, an oversized payload and a file from a newer build are typed
 *    refusals; everything else is repaired and NOTED. It never rejects a file
 *    for an optional field it did not understand.
 *  - {@link resolveMedia} — file + library → what can actually be shown, plus
 *    the placeholders for what cannot. A missing picture is DATA (§4: "missing →
 *    placeholder layer with a clear card"), not a thrown error and not a
 *    silently blank layer.
 *  - {@link applyLookFile} — resolved → the document patch. The caller commits
 *    it, so import is one history entry and one undo step.
 *
 * ## Two caps, deliberately different numbers
 *
 * `MAX_LOOK_BYTES` (3072) is the cap on the **look inside a document** — it is
 * a wire budget, because `look` rides every 8 kB sync envelope
 * (design-layers-architecture §6.2), and it is unchanged here.
 * {@link MAX_LOOK_FILE_BYTES} (64 kB) is the cap on the **file**, which is a
 * different object: it also carries the base kind's whole config bank (a video
 * config alone is ≈ 650 bytes), the media table, and the name/author/description
 * a gallery entry needs. One number could not have served both without either
 * refusing legal files or admitting looks the wire cannot carry.
 *
 * ## Migration is borrowed, never forked
 *
 * A file records the `SCHEMA_VERSION` it was written at. An older file is
 * stepped forward by `migrate()` — the document migration, on a minimal wrapper
 * document — rather than by a second ladder maintained here. A second ladder is
 * how a v6 file ends up migrated one way by the importer and another way by the
 * store, and only one of them gets the fixture test.
 *
 * ## Deliberately not in the file
 *
 * `carousel?: { lookIds: string[]; intervalSec: number }` (§10 parity) shipped,
 * but on `AppState` rather than here: a file describes ONE arrangement, and a
 * rotation is a property of the machine showing them — its ids name rows in one
 * browser's saved-Looks store and mean nothing to a reader of the file.
 *
 * See docs/design/design-editor-ux.md §4 and §9, and docs/looks.md.
 */

import { isPlainObject } from '../../lib/clamp';
import { DEFAULT_MODULE_ID } from '../defaults';
import { migrate } from '../migrations';
import { SCHEMA_VERSION } from '../schema';
import { MODULE_ID_RE, type ValidationNote } from '../validate';

import { selectBaseKind, type LookState } from './selectors';
import { BASE_LAYER_ID, type LayerId, type Look } from './types';
import { validateLook } from './validate';

import type { ModuleId, ModuleSlot } from '../schema';

// ---------------------------------------------------------------------------
// The format
// ---------------------------------------------------------------------------

/** The magic string. A file without it is not ours and is refused, not repaired. */
export const LOOK_FILE_FORMAT = 'kraken-hub-look';

/** Including the dot, so it can be concatenated onto a name. */
export const LOOK_FILE_EXTENSION = '.krakenlook';

/**
 * The cap on a whole file, in `JSON.stringify` length units — the same unit
 * `lookBytes` counts in, so the two caps are comparable at a glance.
 *
 * 64 kB is roughly twenty times the largest legal file the app itself can
 * write (8 layers at `MAX_LOOK_BYTES`, a full video bank, a media table).
 * Generous on purpose: the cap exists to stop a hostile or corrupt paste from
 * being parsed at all, not to police how elaborate somebody's Look is.
 */
export const MAX_LOOK_FILE_BYTES = 65_536;

/** A Look's name, as long as a gallery card can show. */
export const MAX_LOOK_NAME = 60;

/** Author and description: one line each. */
export const MAX_LOOK_TEXT = 200;

/** The `role` a media reference wears when it belongs to the base layer's config. */
export const BASE_ROLE = 'base';

/**
 * What the file says about one piece of media.
 *
 * `role` locates it: {@link BASE_ROLE} for the base layer (whose config lives in
 * `configs`), or an overlay's `LayerId` (whose config lives on the layer). It is
 * always the `url` field of that config — the one field every media-bearing
 * module in this codebase agrees on.
 *
 * `kind` says how it can be found again: `'hash'` is a content hash, which only
 * resolves against a library that happens to hold the same bytes; `'url'` is
 * where the bytes came from, which anybody can fetch. A file prefers `'hash'`
 * when the library knows one, because a hash survives a link going dead.
 */
export interface MediaRef {
  role: string;
  kind: 'url' | 'hash';
  value: string;
  /** The file name, for the card the UI shows when the media cannot be found. */
  name?: string;
}

/**
 * One row of the receiving (or exporting) machine's media library, flattened.
 *
 * A structural slice rather than `ClipRecord | ImageRecord`: this file is core
 * state and must not import a module, and what it needs from a library row is
 * four fields. The caller merges the clip store and the image store into one
 * list — hence "merged media store".
 */
export interface MediaEntry {
  /** The local id — what `kraken-hub-clip:<id>` / `kraken-hub-image:<id>` names. */
  id: string;
  kind: 'clip' | 'image';
  name: string;
  /** A content hash, when the library knows one. Clips carry a sha256 prefix; pictures do not. */
  hash: string | null;
  /** Where the bytes came from, when they were fetched rather than added by hand. */
  sourceUrl: string | null;
}

export type MediaIndex = readonly MediaEntry[];

export interface LookFile {
  format: typeof LOOK_FILE_FORMAT;
  /** The `SCHEMA_VERSION` this file was written at. */
  version: number;
  name: string;
  author?: string;
  description?: string;
  /** ISO 8601. */
  createdAt: string;
  look: Look;
  /**
   * The base layer's config, by kind.
   *
   * The base wears `state.modules[kind].cfg` — the per-kind bank — so a file
   * that carried only `look` would carry a Look with its base setting missing.
   * Overlays are not here: they carry their own `cfg` inside `look`.
   */
  configs: Record<ModuleId, unknown>;
  /**
   * The `v` half of each `ModuleSlot` in {@link configs} — the module's own
   * `configVersion` at write time, which is what tells a reader whether the cfg
   * needs the module's own migration before use.
   *
   * Optional because a hand-written file will not have it, and a missing config
   * version is not a reason to refuse a Look. {@link applyLookFile} then keeps
   * the receiving document's own `v` for that kind.
   */
  configVersions?: Record<ModuleId, number>;
  media: MediaRef[];
}

// ---------------------------------------------------------------------------
// Local media schemes
// ---------------------------------------------------------------------------

/*
 * Restated rather than imported from `src/modules/video/routing/patterns.ts`
 * and `src/modules/image/schema.ts`.
 *
 * Core state pulling a module in would put the module's whole eager surface in
 * the `core` chunk, which is on the display's critical path. What is needed
 * here is two prefixes, and `file.test.ts` asserts these two equal the module
 * constants — so the duplication is pinned by a test rather than by hope.
 */
const CLIP_SCHEME = 'kraken-hub-clip:';
const IMAGE_SCHEME = 'kraken-hub-image:';

/** The local id a config's `url` names, and which store it lives in. */
function localRef(url: string): { kind: 'clip' | 'image'; id: string } | null {
  if (url.startsWith(CLIP_SCHEME)) return { kind: 'clip', id: url.slice(CLIP_SCHEME.length) };
  if (url.startsWith(IMAGE_SCHEME)) return { kind: 'image', id: url.slice(IMAGE_SCHEME.length) };
  return null;
}

/** The URL that addresses a library row on THIS machine. */
function localUrl(entry: MediaEntry): string {
  return `${entry.kind === 'clip' ? CLIP_SCHEME : IMAGE_SCHEME}${entry.id}`;
}

// ---------------------------------------------------------------------------
// Stable serialisation
// ---------------------------------------------------------------------------

/** Recursively key-sorted, `undefined` dropped: two equal files serialise equal. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const inner = value[key];
    if (inner !== undefined) out[key] = canonical(inner);
  }
  return out;
}

/**
 * The one way a look file is written: sorted keys, two-space indent, one
 * trailing newline.
 *
 * Stability is not cosmetic. `public/looks/*.krakenlook` are checked into the repo and
 * diffed in pull requests, and export → import → export is asserted
 * byte-identical — a reordered key would turn "I changed the description" into a
 * forty-line diff, and would make the drift guard in `templates.test.ts`
 * unable to tell a real edit from a re-serialisation.
 */
export function serializeLookFile(file: LookFile): string {
  return `${JSON.stringify(canonical(file), null, 2)}\n`;
}

/** A file's size in the units {@link MAX_LOOK_FILE_BYTES} is expressed in. */
export function lookFileBytes(file: LookFile): number {
  return JSON.stringify(canonical(file)).length;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface LookFileMeta {
  name: string;
  author?: string;
  description?: string;
  /** ISO 8601. Passed in rather than read from the clock, so export stays pure. */
  createdAt?: string;
}

/** Read a config's media URL, if it has one. Module-agnostic: `url` is the shared field. */
function urlOf(cfg: unknown): string | null {
  if (!isPlainObject(cfg)) return null;
  const url = cfg['url'];
  return typeof url === 'string' && url !== '' ? url : null;
}

/** How a URL that lives on THIS machine should be named in a file anybody can read. */
function refFor(role: string, url: string, index: MediaIndex): MediaRef {
  const local = localRef(url);
  if (local === null) return { role, kind: 'url', value: url };

  const entry = index.find((e) => e.id === local.id && e.kind === local.kind);
  if (entry?.hash != null && entry.hash !== '') {
    return { role, kind: 'hash', value: entry.hash, name: entry.name };
  }
  if (entry?.sourceUrl != null && entry.sourceUrl !== '') {
    return { role, kind: 'url', value: entry.sourceUrl, name: entry.name };
  }
  // Nothing portable is known about it. The local id is recorded anyway so the
  // importing machine can say WHICH piece of media is missing rather than
  // showing a blank layer with no explanation.
  const ref: MediaRef = { role, kind: 'hash', value: local.id };
  if (entry !== undefined) ref.name = entry.name;
  return ref;
}

/** The url a config keeps once its media has been lifted into the media table. */
function urlAfterExport(ref: MediaRef): string {
  return ref.kind === 'url' ? ref.value : '';
}

/**
 * Document → file. Pure over the document and the merged media index.
 *
 * The index is an argument rather than a lookup because this function has to be
 * runnable in a unit test, on a phone, and inside `templates.ts` — none of which
 * has an IndexedDB handle. An empty index is legal: every local reference then
 * exports as an unresolvable hash, which is exactly what it is.
 */
export function exportLook(state: LookState, meta: LookFileMeta, index: MediaIndex = []): LookFile {
  const { look } = validateLook(state.look);
  const baseKind = selectBaseKind({ look, modules: state.modules });
  const media: MediaRef[] = [];

  /** Lift a config's media into `media`, and give back the config it keeps. */
  const lift = (role: string, cfg: unknown): unknown => {
    const url = urlOf(cfg);
    if (url === null || !isPlainObject(cfg)) return cfg;
    const ref = refFor(role, url, index);
    media.push(ref);
    return { ...cfg, url: urlAfterExport(ref) };
  };

  const configs: Record<ModuleId, unknown> = {};
  const configVersions: Record<ModuleId, number> = {};
  if (baseKind !== null) {
    const slot = state.modules[baseKind];
    configs[baseKind] = lift(BASE_ROLE, slot?.cfg) ?? {};
    if (slot !== undefined) configVersions[baseKind] = slot.v;
  }

  const layers = look.layers.map((layer, i) =>
    i === 0 ? layer : { ...layer, cfg: lift(layer.id, layer.cfg) },
  );

  const file: LookFile = {
    format: LOOK_FILE_FORMAT,
    version: SCHEMA_VERSION,
    name: meta.name.slice(0, MAX_LOOK_NAME),
    createdAt: meta.createdAt ?? new Date().toISOString(),
    look: { layers },
    configs,
    media,
  };
  if (meta.author !== undefined) file.author = meta.author.slice(0, MAX_LOOK_TEXT);
  if (meta.description !== undefined) file.description = meta.description.slice(0, MAX_LOOK_TEXT);
  if (Object.keys(configVersions).length > 0) file.configVersions = configVersions;
  return file;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * The four ways a file is refused outright — and there are only four.
 *
 * Everything else a file can get wrong is repaired and noted, because "this
 * Look has a layer I do not understand" is not a reason to hand somebody back
 * nothing. These four are refusals because in each case there is no Look to
 * repair: no JSON, no object, not our format, or a payload we will not parse.
 */
export type LookFileRefusal =
  | { code: 'not-json'; detail: string }
  | { code: 'not-an-object' }
  | { code: 'wrong-format'; got: unknown }
  | { code: 'too-big'; bytes: number; max: number }
  | { code: 'future-version'; got: number; max: number };

export type LookFileResult =
  { ok: true; file: LookFile; notes: ValidationNote[] } | { ok: false; reason: LookFileRefusal };

/** No clock in the parser: a file with no usable `createdAt` gets a fixed, obvious one. */
const EPOCH_ISO = new Date(0).toISOString();

class Notes {
  readonly items: ValidationNote[] = [];
  add(path: string, got: unknown, used: unknown): void {
    if (got === undefined) return;
    this.items.push({ path, got, used });
  }
}

function readText(raw: unknown, path: string, max: number, n: Notes): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    n.add(path, raw, undefined);
    return undefined;
  }
  if (raw.length <= max) return raw;
  const cut = raw.slice(0, max);
  n.add(path, raw, cut);
  return cut;
}

/** `media`, entry by entry. A malformed entry is dropped and noted; the file survives. */
function readMedia(raw: unknown, n: Notes): MediaRef[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    n.add('media', raw, []);
    return [];
  }
  const out: MediaRef[] = [];
  for (const [i, entry] of raw.entries()) {
    const at = `media[${String(i)}]`;
    if (!isPlainObject(entry)) {
      n.add(at, entry, undefined);
      continue;
    }
    const role = entry['role'];
    const kind = entry['kind'];
    const value = entry['value'];
    if (
      typeof role !== 'string' ||
      (kind !== 'url' && kind !== 'hash') ||
      typeof value !== 'string'
    ) {
      n.add(at, entry, undefined);
      continue;
    }
    const ref: MediaRef = { role, kind, value };
    const name = readText(entry['name'], `${at}.name`, MAX_LOOK_TEXT, n);
    if (name !== undefined) ref.name = name;
    out.push(ref);
  }
  return out;
}

/** `configs` / `configVersions`: known-shaped module ids only, values verbatim. */
function readConfigs(raw: unknown, n: Notes): Record<ModuleId, unknown> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    n.add('configs', raw, {});
    return {};
  }
  const out: Record<ModuleId, unknown> = {};
  for (const [id, cfg] of Object.entries(raw)) {
    if (!MODULE_ID_RE.test(id)) {
      n.add(`configs.${id}`, cfg, undefined);
      continue;
    }
    out[id] = cfg;
  }
  return out;
}

function readVersions(raw: unknown, n: Notes): Record<ModuleId, number> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    n.add('configVersions', raw, {});
    return {};
  }
  const out: Record<ModuleId, number> = {};
  for (const [id, v] of Object.entries(raw)) {
    if (MODULE_ID_RE.test(id) && typeof v === 'number' && Number.isFinite(v)) out[id] = v;
    else n.add(`configVersions.${id}`, v, undefined);
  }
  return out;
}

/**
 * Step an older file forward, by wrapping it in the smallest document the
 * document migration understands and running THAT.
 *
 * The wrapper is minimal on purpose — `schema`, `activeModuleId`, `look`,
 * `modules` — because those are the only fields any migration to date reads,
 * and a wrapper that invented a whole `AppState` would be a second set of
 * defaults to keep in step with `src/state/defaults.ts`.
 *
 * The `activeModuleId` hint matters for exactly one step: a v6 file predates
 * `look` entirely, and 6 → 7 turns the single active module into the base layer.
 */
function migrateFile(
  version: number,
  look: unknown,
  configs: Record<ModuleId, unknown>,
  versions: Record<ModuleId, number>,
  activeHint: ModuleId,
): { look: unknown; configs: Record<ModuleId, unknown>; versions: Record<ModuleId, number> } {
  const modules: Record<ModuleId, ModuleSlot> = {};
  for (const [id, cfg] of Object.entries(configs)) modules[id] = { v: versions[id] ?? 1, cfg };

  const doc: Record<string, unknown> = { schema: version, activeModuleId: activeHint, modules };
  if (look !== undefined) doc['look'] = look;

  const { raw } = migrate(doc);
  if (!isPlainObject(raw)) return { look, configs, versions };

  const outConfigs: Record<ModuleId, unknown> = {};
  const outVersions: Record<ModuleId, number> = {};
  const migrated = raw['modules'];
  if (isPlainObject(migrated)) {
    for (const [id, slot] of Object.entries(migrated)) {
      if (!isPlainObject(slot)) continue;
      outConfigs[id] = slot['cfg'];
      const v = slot['v'];
      if (typeof v === 'number' && Number.isFinite(v)) outVersions[id] = v;
    }
  }
  return { look: raw['look'], configs: outConfigs, versions: outVersions };
}

/**
 * Bytes (or an already-parsed object) → a canonical {@link LookFile}.
 *
 * Total over every input: the only way out other than a file is one of the five
 * typed refusals in {@link LookFileRefusal}. Unknown fields are ignored, an
 * older `version` is migrated through the schema history, and a Look that does
 * not satisfy the positional rules is repaired by `validateLook` with a note
 * per repair.
 */
export function parseLookFile(input: unknown): LookFileResult {
  let parsed: unknown;

  if (typeof input === 'string') {
    if (input.length > MAX_LOOK_FILE_BYTES) {
      return {
        ok: false,
        reason: { code: 'too-big', bytes: input.length, max: MAX_LOOK_FILE_BYTES },
      };
    }
    try {
      parsed = JSON.parse(input);
    } catch (error) {
      return { ok: false, reason: { code: 'not-json', detail: String(error) } };
    }
  } else {
    parsed = input;
    // Only an object can be a look file, and only an object can be measured —
    // anything else falls through to the `not-an-object` refusal below.
    if (isPlainObject(parsed)) {
      let text: string;
      try {
        text = JSON.stringify(parsed);
      } catch (error) {
        return { ok: false, reason: { code: 'not-json', detail: String(error) } };
      }
      if (text.length > MAX_LOOK_FILE_BYTES) {
        return {
          ok: false,
          reason: { code: 'too-big', bytes: text.length, max: MAX_LOOK_FILE_BYTES },
        };
      }
    }
  }

  if (!isPlainObject(parsed)) return { ok: false, reason: { code: 'not-an-object' } };
  if (parsed['format'] !== LOOK_FILE_FORMAT) {
    return { ok: false, reason: { code: 'wrong-format', got: parsed['format'] } };
  }

  const n = new Notes();

  const rawVersion = parsed['version'];
  let version = SCHEMA_VERSION;
  if (typeof rawVersion === 'number' && Number.isFinite(rawVersion)) {
    if (rawVersion > SCHEMA_VERSION) {
      return {
        ok: false,
        reason: { code: 'future-version', got: rawVersion, max: SCHEMA_VERSION },
      };
    }
    version = rawVersion < 1 ? 1 : Math.floor(rawVersion);
    if (version !== rawVersion) n.add('version', rawVersion, version);
  } else {
    n.add('version', rawVersion, SCHEMA_VERSION);
  }

  let configs = readConfigs(parsed['configs'], n);
  let versions = readVersions(parsed['configVersions'], n);
  let look = parsed['look'];

  if (version < SCHEMA_VERSION) {
    const hint = baseKindHint(look, configs);
    const stepped = migrateFile(version, look, configs, versions, hint);
    look = stepped.look;
    configs = stepped.configs;
    versions = stepped.versions;
    n.add('version', version, SCHEMA_VERSION);
  }

  const validated = validateLook(look);
  n.items.push(...validated.notes);

  const file: LookFile = {
    format: LOOK_FILE_FORMAT,
    version: SCHEMA_VERSION,
    name: readText(parsed['name'], 'name', MAX_LOOK_NAME, n) ?? '',
    createdAt: readText(parsed['createdAt'], 'createdAt', MAX_LOOK_TEXT, n) ?? EPOCH_ISO,
    look: validated.look,
    configs,
    media: readMedia(parsed['media'], n),
  };
  if (parsed['name'] === undefined) n.add('name', null, '');
  if (parsed['createdAt'] === undefined) n.add('createdAt', null, EPOCH_ISO);

  const author = readText(parsed['author'], 'author', MAX_LOOK_TEXT, n);
  if (author !== undefined) file.author = author;
  const description = readText(parsed['description'], 'description', MAX_LOOK_TEXT, n);
  if (description !== undefined) file.description = description;
  if (Object.keys(versions).length > 0) file.configVersions = versions;

  return { ok: true, file, notes: n.items };
}

/** The base kind an old file implies: its own look, else its one config, else the default. */
function baseKindHint(look: unknown, configs: Record<ModuleId, unknown>): ModuleId {
  const layers: unknown = isPlainObject(look) ? look['layers'] : undefined;
  if (Array.isArray(layers)) {
    const first: unknown = layers[0];
    if (
      isPlainObject(first) &&
      typeof first['kind'] === 'string' &&
      MODULE_ID_RE.test(first['kind'])
    ) {
      return first['kind'];
    }
  }
  return Object.keys(configs)[0] ?? DEFAULT_MODULE_ID;
}

// ---------------------------------------------------------------------------
// Media resolution
// ---------------------------------------------------------------------------

/**
 * Why a layer cannot show what the file said it should.
 *
 * One value today, and a union rather than a boolean because the card the UI
 * draws is a sentence: the next reason (a bundle whose entry failed to unpack)
 * needs different words, not a second flag.
 */
export type PlaceholderReason = 'not-in-library';

/** A missing piece of media, as DATA — §4's "placeholder layer with a clear card". */
export interface LookPlaceholder {
  layerId: LayerId;
  ref: MediaRef;
  reason: PlaceholderReason;
}

export interface ResolvedLook {
  look: Look;
  configs: Record<ModuleId, unknown>;
  configVersions: Record<ModuleId, number>;
  placeholders: LookPlaceholder[];
}

/** The url a ref resolves to here, and whether it resolved at all. */
function resolveRef(ref: MediaRef, index: MediaIndex): { url: string; found: boolean } {
  if (ref.kind === 'url') {
    // A URL is portable by definition, so this never fails — but if the same
    // bytes are already in the library, the local copy wins: it plays with the
    // network unplugged and the remote one does not.
    const kept = index.find((e) => e.sourceUrl === ref.value);
    return { url: kept === undefined ? ref.value : localUrl(kept), found: true };
  }
  const match = ref.value === '' ? undefined : index.find((e) => e.hash === ref.value);
  if (match === undefined) return { url: '', found: false };
  return { url: localUrl(match), found: true };
}

/** Write `url` into whichever config the role names; returns false if there is no such config. */
function putUrl(
  role: string,
  url: string,
  look: Look,
  configs: Record<ModuleId, unknown>,
): { look: Look; configs: Record<ModuleId, unknown>; hit: boolean } {
  if (role === BASE_ROLE) {
    const kind = look.layers[0]?.kind;
    if (kind === undefined) return { look, configs, hit: false };
    const cfg = configs[kind];
    if (!isPlainObject(cfg)) return { look, configs, hit: false };
    return { look, configs: { ...configs, [kind]: { ...cfg, url } }, hit: true };
  }
  const layers = look.layers.map((layer) =>
    layer.id === role && isPlainObject(layer.cfg)
      ? { ...layer, cfg: { ...layer.cfg, url } }
      : layer,
  );
  const hit = layers.some((layer, i) => layer !== look.layers[i]);
  return { look: hit ? { layers } : look, configs, hit };
}

/**
 * File + this machine's library → what can be shown, and what cannot.
 *
 * Three outcomes per reference, and all three are §4's:
 *  - **present in library** — the local id is substituted, so it plays offline;
 *  - **fetchable URL** — kept as a source, because anybody can get it;
 *  - **missing** — the `url` is emptied (a dead `kraken-hub-clip:` id would have
 *    the module retrying a row that is not there) and a {@link LookPlaceholder}
 *    is recorded naming the layer and the file. Nothing is deleted and no layer
 *    is switched off: the Look the user imported is the Look they get, with an
 *    honest hole in it.
 */
export function resolveMedia(file: LookFile, index: MediaIndex = []): ResolvedLook {
  let look = file.look;
  let configs = { ...file.configs };
  const placeholders: LookPlaceholder[] = [];

  for (const ref of file.media) {
    const { url, found } = resolveRef(ref, index);
    const written = putUrl(ref.role, url, look, configs);
    look = written.look;
    configs = written.configs;
    if (!found && written.hit) {
      placeholders.push({
        layerId: ref.role === BASE_ROLE ? BASE_LAYER_ID : ref.role,
        ref,
        reason: 'not-in-library',
      });
    }
  }

  return { look, configs, configVersions: { ...file.configVersions }, placeholders };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/** The document fields an import writes. The caller commits it — one op, one undo step. */
export interface LookPatch {
  look: Look;
  modules: Record<ModuleId, ModuleSlot>;
}

/** A cfg written by a build that never said which version it was. */
const ASSUMED_CONFIG_VERSION = 1;

/**
 * Resolved file → the document patch.
 *
 * **Layer ids are kept, not re-minted.** A Look replaces the whole stack, so
 * there is nothing for a file's ids to collide with — and keeping them makes an
 * import DETERMINISTIC, which is the same argument the 6 → 7 migration makes
 * about its own base id: two CAM browsers importing the same file must not end
 * up with two stacks that differ by a generated id, because last-writer-wins
 * would then pick one at random. It also keeps the ids in
 * {@link LookPlaceholder} pointing at real layers.
 *
 * Every other kind's config in the bank is left exactly where it was: importing
 * a Look with a clock base is not a reason to lose the video settings.
 */
export function applyLookFile(state: LookState, resolved: ResolvedLook): LookPatch {
  const modules: Record<ModuleId, ModuleSlot> = { ...state.modules };
  for (const [kind, cfg] of Object.entries(resolved.configs)) {
    const v = resolved.configVersions[kind] ?? state.modules[kind]?.v ?? ASSUMED_CONFIG_VERSION;
    modules[kind] = { v, cfg };
  }
  return { look: validateLook(resolved.look).look, modules };
}
