/**
 * The bottom precedence layer. Every field here must be safe on a cold boot
 * with no hardware, no network and no stored state.
 */

import {
  SCHEMA_VERSION,
  type AppState,
  type DiagnosticsPrefs,
  type PlatformPrefs,
  type RenderSettings,
  type SyncSettings,
} from './schema';

/**
 * Module shown on a fresh install.
 *
 * M0 shipped `clock-lite` here because it was the only module that existed. M1
 * hands the slot to `video`, the flagship: with no configuration at all it
 * plays the bundled demo clip offline, which is a better first boot than a
 * clock and doubles as the "is the display alive?" answer. M3 replaced the
 * `clock-lite` placeholder with the real `clock` module (state migration
 * 3 → 4), which is one click away. The registry conformance test asserts this
 * id exists.
 */
export const DEFAULT_MODULE_ID = 'video';

export const DEFAULT_RENDER: RenderSettings = {
  fit: 'cover',
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  rotate: 0,
  safeAreaPct: 0.08,
  safeRadiusPct: 0.88,
  maskCircle: 'auto',
  background: '#000000',
};

export const DEFAULT_SYNC: SyncSettings = {
  enabled: false,
  roomCode: null,
  transport: 'auto',
  // Empty, not the literal broker URL: the default lives in one place
  // (src/sync/endpoints.ts) and a stored empty string means "whatever this
  // build's default is", so a fork changing brokers does not have to migrate
  // every user's saved settings.
  mqttUrl: '',
  ntfyBase: '',
  persistRemote: true,
  publishTelemetry: true,
};

export const DEFAULT_PLATFORM: PlatformPrefs = {
  audioOptIn: false,
  allowWatchdogReload: true,
  // Not 1: an absent nzxt object says nothing about the CAM slider, and
  // assuming 1 would cripple a display whose injection merely arrived late.
  fallbackTargetFps: 30,
  lowFpsThreshold: 5,
};

export const DEFAULT_DIAGNOSTICS: DiagnosticsPrefs = {
  showDebugOverlay: false,
  lowFpsBannerDismissedForFps: null,
  logLevel: 'info',
};

/** A fresh, valid `AppState`. Callers must not mutate the returned object. */
export function defaultAppState(): AppState {
  return {
    schema: SCHEMA_VERSION,
    rev: 0,
    updatedAt: 0,
    writerId: '',
    writerRole: 'config',
    activeModuleId: DEFAULT_MODULE_ID,
    modules: {},
    playback: null,
    render: { ...DEFAULT_RENDER },
    sync: { ...DEFAULT_SYNC },
    platform: { ...DEFAULT_PLATFORM },
    diagnostics: { ...DEFAULT_DIAGNOSTICS },
  };
}
