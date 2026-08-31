/**
 * Hardware simulator: a mock `window.nzxt` plus a monitoring generator, so the
 * entire app is developable and testable without owning a Kraken.
 *
 * Two hard rules:
 *  1. It NEVER runs when a real `window.nzxt` is present (`?sim=` is ignored
 *     inside CAM), so it can never clobber real injection.
 *  2. It uses exactly the same property-assignment discipline as production
 *     code — the simulator must not model a footgun we forbid everywhere else.
 *
 * `?inject=late` reproduces the documented case where CAM injects *after* the
 * page has already booted; that path is otherwise impossible to exercise.
 */

import { createLogger } from '../lib/log';

import { DEVICE_PRESETS, type DevicePresetId } from './devicePresets';

const log = createLogger('platform/simulator');

export type MonitorProfile = 'idle' | 'load' | 'spike' | 'missing';

export const LATE_INJECTION_DELAY_MS = 1500;
const TICK_MS = 1000;

export interface SimulatorOptions {
  preset: DevicePresetId;
  /** Overrides the preset's `targetFps` (`?fps=`). */
  targetFps?: number;
  monitor?: MonitorProfile;
  /** `?inject=late`: delay injection by 1.5 s. */
  late?: boolean;
}

export interface SimulatorHandle {
  stop(): void;
  /** Resolves once the mock has actually been injected (immediately, or after 1.5 s). */
  injected: Promise<void>;
}

/** Correlated random walks — a flat sine wave would hide real rendering bugs. */
function createGenerator(profile: MonitorProfile): () => NzxtV1.MonitoringData {
  const base = profile === 'load' ? 0.65 : profile === 'spike' ? 0.35 : 0.12;
  let cpuLoad = base;
  let cpuTemp = 40;
  let gpuLoad = base * 0.8;
  let liquid = 30;
  let ramUsed = 12_000;
  let tick = 0;

  return () => {
    tick += 1;
    const spike = profile === 'spike' && tick % 12 < 3 ? 0.5 : 0;
    cpuLoad = Math.min(1, Math.max(0, cpuLoad + (Math.random() - 0.5) * 0.12 + spike * 0.2));
    // Temperature lags load with a ~6 s time constant.
    cpuTemp += (35 + cpuLoad * 55 - cpuTemp) / 6;
    gpuLoad = Math.min(
      1,
      Math.max(0, gpuLoad * 0.8 + cpuLoad * 0.2 + (Math.random() - 0.5) * 0.08),
    );
    // Liquid temperature lags CPU temperature with a ~40 s constant, narrow band.
    liquid += (28 + cpuLoad * 12 - liquid) / 40;
    ramUsed = Math.min(31_000, Math.max(6000, ramUsed + (Math.random() - 0.5) * 400));

    if (profile === 'missing') {
      // Rotate which fields are absent, so modules are forced to handle undefined.
      const phase = tick % 4;
      return {
        cpus: phase === 0 ? [] : [{ name: 'Simulated CPU', load: cpuLoad }],
        gpus: phase === 1 ? undefined : [{ name: 'Simulated GPU', load: gpuLoad }],
        ram: phase === 2 ? undefined : { totalSize: 32_768, inUse: Math.round(ramUsed) },
        kraken: phase === 3 ? {} : { liquidTemperature: Math.round(liquid * 10) / 10 },
      };
    }

    return {
      cpus: [
        {
          name: 'Simulated CPU',
          load: Math.round(cpuLoad * 1000) / 1000,
          temperature: Math.round(cpuTemp * 10) / 10,
          frequency: Math.round(3600 + cpuLoad * 1400),
          power: Math.round(35 + cpuLoad * 120),
          numCores: 8,
          numThreads: 16,
          fanSpeed: Math.round(700 + cpuLoad * 1200),
        },
      ],
      gpus: [
        {
          name: 'Simulated GPU',
          load: Math.round(gpuLoad * 1000) / 1000,
          temperature: Math.round((38 + gpuLoad * 40) * 10) / 10,
          frequency: Math.round(1400 + gpuLoad * 1200),
          power: Math.round(30 + gpuLoad * 250),
          fanSpeed: Math.round(900 + gpuLoad * 1400),
        },
      ],
      ram: { totalSize: 32_768, inUse: Math.round(ramUsed) },
      kraken: { liquidTemperature: Math.round(liquid * 10) / 10 },
    };
  };
}

/**
 * Installs the mock. Returns `null` when a real `window.nzxt` exists — the
 * caller must treat that as "we are on real hardware" and change nothing.
 */
export function installSimulator(opts: SimulatorOptions): SimulatorHandle | null {
  if (window.nzxt?.v1 !== undefined) {
    log.info('real window.nzxt present — simulator disabled');
    return null;
  }

  const preset = DEVICE_PRESETS[opts.preset];
  const targetFps = Math.min(Math.max(Math.round(opts.targetFps ?? preset.targetFps), 1), 60);
  const nextSample = createGenerator(opts.monitor ?? 'idle');

  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const inject = (): void => {
    if (stopped) return;
    const w = window;
    // Property assignment only — never `window.nzxt = {...}` (invariant I2).
    w.nzxt ??= {};
    w.nzxt.v1 ??= {
      width: preset.width,
      height: preset.height,
      shape: preset.shape,
      targetFps,
    };
    const api = w.nzxt.v1;
    api.width = preset.width;
    api.height = preset.height;
    api.shape = preset.shape;
    api.targetFps = targetFps;
    log.info(
      `simulating ${preset.label} at ${String(targetFps)} fps (monitor=${opts.monitor ?? 'idle'})`,
    );
    timer = setInterval(() => {
      window.nzxt?.v1?.onMonitoringDataUpdate?.(nextSample());
    }, TICK_MS);
  };

  let injected: Promise<void>;
  if (opts.late === true) {
    injected = new Promise<void>((resolve) => {
      setTimeout(() => {
        inject();
        resolve();
      }, LATE_INJECTION_DELAY_MS);
    });
  } else {
    inject();
    injected = Promise.resolve();
  }

  return {
    injected,
    stop() {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
