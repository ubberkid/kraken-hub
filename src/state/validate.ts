/**
 * Hand-rolled coerce/clamp validators. No runtime dependency, deliberately.
 *
 * zod would add ~14 KB gzip to the *display* chunk to do a job that is a few
 * hundred lines of clamping, and the display budget is the one that matters.
 *
 * Contract: these functions NEVER throw. An invalid leaf falls back to its
 * default and records a `ValidationNote`, which the diagnostics view renders —
 * a corrupt state file must degrade to a working display, not a black screen.
 */

import { clamp, isFiniteNumber, isPlainObject } from '../lib/clamp';

import { DEFAULT_MODULE_ID, defaultAppState } from './defaults';
import {
  SCHEMA_VERSION,
  type AppState,
  type DiagnosticsPrefs,
  type ModuleSlot,
  type PlatformPrefs,
  type PlaybackState,
  type RenderSettings,
  type Role,
  type SyncSettings,
} from './schema';

export interface ValidationNote {
  path: string;
  got: unknown;
  used: unknown;
}

export interface ValidationResult {
  state: AppState;
  notes: ValidationNote[];
}

class Notes {
  readonly items: ValidationNote[] = [];
  add(path: string, got: unknown, used: unknown): void {
    if (got === undefined) return; // absent is not an error; it is a default
    this.items.push({ path, got, used });
  }
}

// ---- combinators -----------------------------------------------------------

function bool(raw: unknown, def: boolean, path: string, n: Notes): boolean {
  if (typeof raw === 'boolean') return raw;
  n.add(path, raw, def);
  return def;
}

function num(raw: unknown, def: number, min: number, max: number, path: string, n: Notes): number {
  if (isFiniteNumber(raw)) {
    const clamped = clamp(raw, min, max);
    if (clamped !== raw) n.add(path, raw, clamped);
    return clamped;
  }
  n.add(path, raw, def);
  return def;
}

function str(raw: unknown, def: string, path: string, n: Notes, maxLen = 512): string {
  if (typeof raw === 'string' && raw.length <= maxLen) return raw;
  n.add(path, raw, def);
  return def;
}

function enum_<T extends string>(
  raw: unknown,
  def: T,
  allowed: readonly T[],
  path: string,
  n: Notes,
): T {
  if (typeof raw === 'string' && (allowed as readonly string[]).includes(raw)) return raw as T;
  n.add(path, raw, def);
  return def;
}

function nullableNum(
  raw: unknown,
  def: number | null,
  min: number,
  max: number,
  path: string,
  n: Notes,
): number | null {
  if (raw === null) return null;
  if (raw === undefined) return def;
  if (isFiniteNumber(raw)) return clamp(raw, min, max);
  n.add(path, raw, def);
  return def;
}

// ---- section validators ----------------------------------------------------

const MAX_SECONDS = 86_400;

type Rotation = 0 | 90 | 180 | 270;

function validateRotate(raw: unknown, def: Rotation, n: Notes): Rotation {
  if (raw === 0 || raw === 90 || raw === 180 || raw === 270) return raw;
  n.add('render.rotate', raw, def);
  return def;
}

function validateRender(raw: unknown, def: RenderSettings, n: Notes): RenderSettings {
  const o = isPlainObject(raw) ? raw : {};
  if (raw !== undefined && !isPlainObject(raw)) n.add('render', raw, def);
  return {
    fit: enum_(o['fit'], def.fit, ['cover', 'contain', 'contain-circle', 'fill'], 'render.fit', n),
    zoom: num(o['zoom'], def.zoom, 0.25, 4, 'render.zoom', n),
    offsetX: num(o['offsetX'], def.offsetX, -1, 1, 'render.offsetX', n),
    offsetY: num(o['offsetY'], def.offsetY, -1, 1, 'render.offsetY', n),
    rotate: validateRotate(o['rotate'], def.rotate, n),
    safeAreaPct: num(o['safeAreaPct'], def.safeAreaPct, 0, 0.2, 'render.safeAreaPct', n),
    safeRadiusPct: num(o['safeRadiusPct'], def.safeRadiusPct, 0.5, 1, 'render.safeRadiusPct', n),
    maskCircle: enum_(o['maskCircle'], def.maskCircle, ['auto', 'on', 'off'], 'render.mask', n),
    background: str(o['background'], def.background, 'render.background', n, 64),
  };
}

const MAX_ENDPOINT_LEN = 256;

function validateSync(raw: unknown, def: SyncSettings, n: Notes): SyncSettings {
  const o = isPlainObject(raw) ? raw : {};
  const code = o['roomCode'];
  return {
    enabled: bool(o['enabled'], def.enabled, 'sync.enabled', n),
    roomCode: typeof code === 'string' && code.length > 0 ? code.slice(0, 32) : null,
    transport: enum_(
      o['transport'],
      def.transport,
      ['auto', 'mqtt', 'ntfy', 'off', 'fake'],
      'sync.transport',
      n,
    ),
    mqttUrl: str(o['mqttUrl'], def.mqttUrl, 'sync.mqttUrl', n, MAX_ENDPOINT_LEN),
    ntfyBase: str(o['ntfyBase'], def.ntfyBase, 'sync.ntfyBase', n, MAX_ENDPOINT_LEN),
    persistRemote: bool(o['persistRemote'], def.persistRemote, 'sync.persistRemote', n),
    publishTelemetry: bool(o['publishTelemetry'], def.publishTelemetry, 'sync.publishTelemetry', n),
  };
}

function validatePlatform(raw: unknown, def: PlatformPrefs, n: Notes): PlatformPrefs {
  const o = isPlainObject(raw) ? raw : {};
  return {
    audioOptIn: bool(o['audioOptIn'], def.audioOptIn, 'platform.audioOptIn', n),
    allowWatchdogReload: bool(
      o['allowWatchdogReload'],
      def.allowWatchdogReload,
      'platform.allowWatchdogReload',
      n,
    ),
    fallbackTargetFps: Math.round(
      num(o['fallbackTargetFps'], def.fallbackTargetFps, 1, 60, 'platform.fallbackTargetFps', n),
    ),
    lowFpsThreshold: Math.round(
      num(o['lowFpsThreshold'], def.lowFpsThreshold, 0, 60, 'platform.lowFpsThreshold', n),
    ),
  };
}

function validateDiagnostics(raw: unknown, def: DiagnosticsPrefs, n: Notes): DiagnosticsPrefs {
  const o = isPlainObject(raw) ? raw : {};
  return {
    showDebugOverlay: bool(
      o['showDebugOverlay'],
      def.showDebugOverlay,
      'diagnostics.showDebugOverlay',
      n,
    ),
    lowFpsBannerDismissedForFps: nullableNum(
      o['lowFpsBannerDismissedForFps'],
      def.lowFpsBannerDismissedForFps,
      1,
      60,
      'diagnostics.lowFpsBannerDismissedForFps',
      n,
    ),
    logLevel: enum_(
      o['logLevel'],
      def.logLevel,
      ['error', 'warn', 'info', 'debug'],
      'diagnostics.logLevel',
      n,
    ),
  };
}

function validatePlayback(raw: unknown, n: Notes): PlaybackState | null {
  if (raw === null || raw === undefined) return null;
  if (!isPlainObject(raw)) {
    n.add('playback', raw, null);
    return null;
  }
  const loopRaw = isPlainObject(raw['loop']) ? raw['loop'] : {};
  return {
    ownerModuleId: str(raw['ownerModuleId'], DEFAULT_MODULE_ID, 'playback.ownerModuleId', n, 32),
    paused: bool(raw['paused'], false, 'playback.paused', n),
    posSec: num(raw['posSec'], 0, 0, MAX_SECONDS, 'playback.posSec', n),
    posAtTs: num(raw['posAtTs'], 0, 0, Number.MAX_SAFE_INTEGER, 'playback.posAtTs', n),
    durationSec: nullableNum(raw['durationSec'], null, 0, MAX_SECONDS, 'playback.durationSec', n),
    rate: num(raw['rate'], 1, 0.25, 4, 'playback.rate', n),
    muted: bool(raw['muted'], true, 'playback.muted', n),
    volume: num(raw['volume'], 1, 0, 1, 'playback.volume', n),
    loop: {
      enabled: bool(loopRaw['enabled'], false, 'playback.loop.enabled', n),
      startSec: num(loopRaw['startSec'], 0, 0, MAX_SECONDS, 'playback.loop.startSec', n),
      endSec: nullableNum(loopRaw['endSec'], null, 0, MAX_SECONDS, 'playback.loop.endSec', n),
    },
  };
}

/** Module ids are kebab-case; anything else is dropped rather than trusted. */
export const MODULE_ID_RE = /^[a-z][a-z0-9-]{1,23}$/;

function validateModules(raw: unknown, n: Notes): Record<string, ModuleSlot> {
  const out: Record<string, ModuleSlot> = {};
  if (!isPlainObject(raw)) {
    if (raw !== undefined) n.add('modules', raw, {});
    return out;
  }
  for (const [id, slot] of Object.entries(raw)) {
    if (!MODULE_ID_RE.test(id)) {
      n.add(`modules.${id}`, slot, undefined);
      continue;
    }
    if (!isPlainObject(slot)) {
      n.add(`modules.${id}`, slot, undefined);
      continue;
    }
    // `cfg` is passed through VERBATIM: a fork's module config must survive a
    // round-trip through the upstream build (design-architecture.md §2.5).
    const v = slot['v'];
    out[id] = { v: isFiniteNumber(v) ? v : 1, cfg: slot['cfg'] };
  }
  return out;
}

// ---- the document ----------------------------------------------------------

const ROLES: readonly Role[] = ['display', 'config', 'remote'];

/** Coerce any input into a valid `AppState`. Never throws. */
export function validateAppState(raw: unknown): ValidationResult {
  const n = new Notes();
  const def = defaultAppState();
  const o = isPlainObject(raw) ? raw : {};
  if (raw !== undefined && !isPlainObject(raw)) n.add('$', raw, 'defaults');

  const activeRaw = o['activeModuleId'];
  const activeModuleId =
    typeof activeRaw === 'string' && MODULE_ID_RE.test(activeRaw)
      ? activeRaw
      : ((): string => {
          n.add('activeModuleId', activeRaw, def.activeModuleId);
          return def.activeModuleId;
        })();

  const state: AppState = {
    schema: SCHEMA_VERSION,
    rev: Math.round(num(o['rev'], 0, 0, Number.MAX_SAFE_INTEGER, 'rev', n)),
    updatedAt: num(o['updatedAt'], 0, 0, Number.MAX_SAFE_INTEGER, 'updatedAt', n),
    writerId: str(o['writerId'], '', 'writerId', n, 32),
    writerRole: enum_(o['writerRole'], def.writerRole, ROLES, 'writerRole', n),
    activeModuleId,
    modules: validateModules(o['modules'], n),
    playback: validatePlayback(o['playback'], n),
    render: validateRender(o['render'], def.render, n),
    sync: validateSync(o['sync'], def.sync, n),
    platform: validatePlatform(o['platform'], def.platform, n),
    diagnostics: validateDiagnostics(o['diagnostics'], def.diagnostics, n),
  };

  return { state, notes: n.items };
}
