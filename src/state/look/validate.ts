/**
 * `validateLook` — structural, total, module-agnostic.
 *
 * Same contract as the rest of `src/state/validate.ts`: it NEVER throws, an
 * invalid leaf falls back to its default and records a `ValidationNote`, and a
 * corrupt document degrades to a working display rather than a black screen.
 *
 * Two things it deliberately does NOT do:
 *
 *  - **It knows nothing about the registry.** Roles, `maxInstances` and cost are
 *    decided at point of use by `normalizeLook` (§3.4). An unknown kind is
 *    preserved verbatim here — a fork's module must survive a round-trip
 *    through the upstream build.
 *  - **It never drops a layer for being too big.** `MAX_LOOK_BYTES` is a
 *    refusal at op time with a typed reason (§8); at read time an oversized
 *    look is NOTED and kept whole. Silently deleting somebody's overlay because
 *    the JSON grew is not a recovery, it is data loss.
 *
 * The positional rules are the interesting half. `layers[0]` is the base:
 * `id:'base'`, `frame:'panel'`, `t:IDENTITY`, and **no `cfg`/`v`** (it wears the
 * `modules` bank). Overlays are the mirror image: a real id, a box frame, their
 * own `cfg`. Forcing that by INDEX is what makes "a config has exactly one
 * home" structural — no code path can produce a base with a config, so no code
 * path has to decide which of two configs wins.
 *
 * See docs/design/design-layers-architecture.md §4.1.
 */

import { clamp, isFiniteNumber, isPlainObject } from '../../lib/clamp';
import { DEFAULT_MODULE_ID } from '../defaults';
import { MODULE_ID_RE, type ValidationNote } from '../validate';

import {
  BASE_LAYER_ID,
  IDENTITY,
  LAYER_ID_RE,
  MAX_LAYERS,
  MAX_LAYER_NAME,
  MAX_LOOK_BYTES,
  TRANSFORM_LIMITS,
  baseLook,
  lookBytes,
  type Frame,
  type Layer,
  type Look,
  type Transform,
} from './types';

import type { ModuleId } from '../schema';

export interface LookValidation {
  look: Look;
  notes: ValidationNote[];
}

/**
 * What an overlay gets when it arrives claiming `frame:'panel'` (only the base
 * may wear the whole LCD). The registry's per-kind `overlayDefault` is a better
 * box, but the validator is module-agnostic by design — the editor reseeds from
 * `placementOf(mod).overlayDefault` when it creates a layer for real.
 */
export const DEFAULT_OVERLAY_FRAME = { w: 1, h: 1, shape: 'square' } as const;

const FRAME_MIN = 0.1;
const FRAME_MAX = 3;

class Notes {
  readonly items: ValidationNote[] = [];
  add(path: string, got: unknown, used: unknown): void {
    if (got === undefined) return; // absent is not an error; it is a default
    this.items.push({ path, got, used });
  }
}

function validateTransform(raw: unknown, path: string, n: Notes): Transform {
  if (!isPlainObject(raw)) {
    n.add(path, raw, IDENTITY);
    return { ...IDENTITY };
  }
  const { pos, sMin, sMax, rot } = TRANSFORM_LIMITS;
  const axis = (key: 'x' | 'y' | 's' | 'r' | 'a', min: number, max: number): number => {
    const v = raw[key];
    if (!isFiniteNumber(v)) {
      n.add(`${path}.${key}`, v, IDENTITY[key]);
      return IDENTITY[key];
    }
    const clamped = clamp(v, min, max);
    if (clamped !== v) n.add(`${path}.${key}`, v, clamped);
    return clamped;
  };
  return {
    x: axis('x', -pos, pos),
    y: axis('y', -pos, pos),
    s: axis('s', sMin, sMax),
    r: axis('r', -rot, rot),
    a: axis('a', 0, 1),
  };
}

function isIdentity(t: Transform): boolean {
  return t.x === 0 && t.y === 0 && t.s === 1 && t.r === 0 && t.a === 1;
}

/** Box frames only — `'panel'` is decided positionally by the caller. */
function validateBoxFrame(raw: unknown, path: string, n: Notes): Exclude<Frame, 'panel'> {
  const fallback = { ...DEFAULT_OVERLAY_FRAME };
  if (!isPlainObject(raw)) {
    n.add(path, raw, fallback);
    return fallback;
  }
  const side = (key: 'w' | 'h'): number => {
    const v = raw[key];
    if (!isFiniteNumber(v)) {
      n.add(`${path}.${key}`, v, fallback[key]);
      return fallback[key];
    }
    const clamped = clamp(v, FRAME_MIN, FRAME_MAX);
    if (clamped !== v) n.add(`${path}.${key}`, v, clamped);
    return clamped;
  };
  const shapeRaw = raw['shape'];
  let shape: 'square' | 'circle' = fallback.shape;
  if (shapeRaw === 'circle' || shapeRaw === 'square') shape = shapeRaw;
  else n.add(`${path}.shape`, shapeRaw, fallback.shape);
  return { w: side('w'), h: side('h'), shape };
}

function validateName(raw: unknown, path: string, n: Notes): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    n.add(path, raw, undefined);
    return undefined;
  }
  if (raw.length <= MAX_LAYER_NAME) return raw;
  const cut = raw.slice(0, MAX_LAYER_NAME);
  n.add(path, raw, cut);
  return cut;
}

function validateKind(
  raw: unknown,
  path: string,
  fallback: ModuleId | null,
  n: Notes,
): string | null {
  // Unknown-but-well-formed ids pass straight through: this validator has no
  // registry, and a fork's module id is not an error.
  if (typeof raw === 'string' && MODULE_ID_RE.test(raw)) return raw;
  n.add(path, raw, fallback ?? undefined);
  return fallback;
}

function validateOn(raw: unknown, path: string, n: Notes): boolean {
  if (typeof raw === 'boolean') return raw;
  n.add(path, raw, true);
  return true;
}

/**
 * Coerce any input into a valid `Look`. Never throws. Idempotent:
 * `validateLook(validateLook(x).look).look` deep-equals `validateLook(x).look`.
 */
export function validateLook(raw: unknown, path = 'look'): LookValidation {
  const n = new Notes();

  const layersRaw = isPlainObject(raw) ? raw['layers'] : undefined;
  if (raw !== undefined && !isPlainObject(raw)) n.add(path, raw, 'defaults');
  if (isPlainObject(raw) && layersRaw !== undefined && !Array.isArray(layersRaw)) {
    n.add(`${path}.layers`, layersRaw, 'defaults');
  }

  const entries = Array.isArray(layersRaw) ? layersRaw : [];
  const kept: Record<string, unknown>[] = [];
  for (const [i, entry] of entries.entries()) {
    if (isPlainObject(entry)) kept.push(entry);
    else n.add(`${path}.layers[${String(i)}]`, entry, undefined);
  }
  if (kept.length > MAX_LAYERS) {
    // Only reachable from a corrupt or foreign document — the editor's ops
    // refuse a ninth layer long before it can be written.
    n.add(`${path}.layers.length`, kept.length, MAX_LAYERS);
    kept.length = MAX_LAYERS;
  }

  const layers: Layer[] = [];
  const seen = new Set<string>();

  for (const [i, entry] of kept.entries()) {
    const at = `${path}.layers[${String(i)}]`;
    const isBase = i === 0;

    const kind = validateKind(entry['kind'], `${at}.kind`, isBase ? DEFAULT_MODULE_ID : null, n);
    if (kind === null) continue; // an overlay with no usable kind is nothing to render

    const rawId = entry['id'];
    let id = BASE_LAYER_ID;
    if (isBase) {
      if (rawId !== BASE_LAYER_ID) n.add(`${at}.id`, rawId, BASE_LAYER_ID);
    } else {
      if (typeof rawId !== 'string' || !LAYER_ID_RE.test(rawId)) {
        n.add(`${at}.id`, rawId ?? null, undefined);
        continue;
      }
      if (seen.has(rawId)) {
        n.add(`${at}.id`, rawId, undefined); // duplicate: the later one loses
        continue;
      }
      id = rawId;
    }
    seen.add(id);

    const on = validateOn(entry['on'], `${at}.on`, n);
    const name = validateName(entry['name'], `${at}.name`, n);

    let frame: Frame;
    if (isBase) {
      if (entry['frame'] !== undefined && entry['frame'] !== 'panel') {
        n.add(`${at}.frame`, entry['frame'], 'panel');
      }
      frame = 'panel';
    } else if (entry['frame'] === 'panel') {
      frame = { ...DEFAULT_OVERLAY_FRAME };
      n.add(`${at}.frame`, 'panel', frame);
    } else {
      frame = validateBoxFrame(entry['frame'], `${at}.frame`, n);
    }

    let t: Transform;
    if (isBase) {
      const raw0 = entry['t'];
      if (raw0 !== undefined) {
        const asked = validateTransform(raw0, `${at}.t`, new Notes());
        if (!isIdentity(asked)) n.add(`${at}.t`, raw0, IDENTITY);
      }
      t = { ...IDENTITY };
    } else {
      t = validateTransform(entry['t'], `${at}.t`, n);
    }

    const layer: Layer = { id, kind, on, frame, t };
    if (name !== undefined) layer.name = name;

    /*
     * `locked` is written ONLY when it is `true` (§8, M3).
     *
     * Absent is the default and `false` is the same fact in more bytes, so a
     * `false` on the way in becomes an absence on the way out — which is also
     * what keeps this idempotent. Anything that is not a boolean is repaired to
     * absent WITH a note: a corrupt value must never be able to lock a person
     * out of their own layer, and it must not do it silently either.
     */
    const lockedRaw = entry['locked'];
    if (lockedRaw === true) layer.locked = true;
    else if (lockedRaw !== undefined && lockedRaw !== false) {
      n.add(`${at}.locked`, lockedRaw, undefined);
    }

    if (isBase) {
      // The base wears `state.modules[kind].cfg`. A cfg here is a second home
      // for the same setting, so it goes.
      if (entry['cfg'] !== undefined) n.add(`${at}.cfg`, entry['cfg'], undefined);
      if (entry['v'] !== undefined) n.add(`${at}.v`, entry['v'], undefined);
    } else {
      layer.cfg = entry['cfg'] === undefined ? {} : entry['cfg']; // verbatim
      const v = entry['v'];
      if (isFiniteNumber(v)) layer.v = v;
      else if (v !== undefined) n.add(`${at}.v`, v, undefined);
    }

    layers.push(layer);
  }

  const look: Look = layers.length > 0 ? { layers } : baseLook(DEFAULT_MODULE_ID);
  if (layers.length === 0 && entries.length > 0) n.add(`${path}.layers`, layersRaw, look.layers);

  const bytes = lookBytes(look);
  if (bytes > MAX_LOOK_BYTES) {
    // NOTE ONLY. The wire never truncates `layers` (§6.2) and neither do we.
    n.add(`${path}.bytes`, bytes, MAX_LOOK_BYTES);
  }

  return { look, notes: n.items };
}
