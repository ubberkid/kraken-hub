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

// ---------------------------------------------------------------------------
// The monitoring generator — a machine that occasionally does some work
// ---------------------------------------------------------------------------

/**
 * ## Why the walk grew bursts (audit 10, M10)
 *
 * The old generator was an unbiased random walk on `cpuLoad` around a per-profile
 * base, and `cpuTemp` was `35 + load × 55` lagged six seconds behind it. On the
 * `load` profile that asymptotes at about **71 °C**, and the stats module's
 * default warm point is **80 °C** — so nothing the simulator has ever produced
 * could turn a face amber. Every threshold, every chip, every `[data-state]`
 * rule in `stats.css` and the whole colour-never-travels-alone contract was
 * unreachable on the only data anybody develops against, and the editor's sample
 * halo — which shares this generator — could not show a warm state either.
 *
 * The GPU was worse: `38 + gpuLoad × 40` tops out at 78 °C, so it could not
 * cross 80 even at a load of 1.
 *
 * A machine does not random-walk. It idles, something runs, it gets hot, the
 * work finishes and it cools. So the load has a TARGET now — the profile's base
 * most of the time, a burst peak during a burst — and approaches it with noise
 * on top, which is the same "correlated, not a sine wave" property the walk had
 * and is nearer to what a cooler actually sees.
 */

/** Every 40–90 s something runs, and it runs for 15–25 s. */
const BURST_GAP_MIN_S = 40;
const BURST_GAP_MAX_S = 90;
const BURST_LEN_MIN_S = 15;
const BURST_LEN_MAX_S = 25;
/** The `spike` profile is the same machine with a busier owner. */
const SPIKE_GAP_SCALE = 0.45;

/**
 * The load a burst drives toward, chosen so `CPU_TEMP_*` lands it in 84–88 °C
 * and the GPU that follows it in 82–86 °C — comfortably over the 80 °C warm
 * point and comfortably under the 90 °C hot one, so a burst renders `Warm` and
 * only a user who has moved their thresholds sees `Hot`.
 */
const BURST_PEAK_MIN = 0.89;
const BURST_PEAK_MAX = 0.965;

/** `cpuTemp = BASE + load × SPAN`, lagged. 90 °C flat out is a real CPU. */
const CPU_TEMP_BASE = 35;
const CPU_TEMP_SPAN = 55;
/** The GPU's own curve. The span was 40, which could not reach 80 at all. */
const GPU_TEMP_BASE = 38;
const GPU_TEMP_SPAN = 47;

/** How fast the load reaches its target — ~3 s to most of the way. */
const LOAD_APPROACH = 0.3;
/** Seconds of lag between the load and the temperature it produces. */
const CPU_TEMP_LAG_S = 6;
/** The loop is slower than the die by a wide margin, and moves in a narrow band. */
const LIQUID_LAG_S = 40;
const LIQUID_BASE = 28;
const LIQUID_SPAN = 12;

const CPU_NOISE = 0.06;
const GPU_NOISE = 0.08;
const GPU_FOLLOW = 0.2;
const RAM_NOISE = 400;
const RAM_MIN_MIB = 6000;
const RAM_MAX_MIB = 31_000;

/** A 32-bit LCG. Not cryptography — reproducibility, so a test can assert a burst. */
const LCG_A = 1_664_525;
const LCG_C = 1_013_904_223;
const LCG_M = 4_294_967_296;

function randomSource(seed: number | undefined): () => number {
  if (seed === undefined) return Math.random;
  let s = Math.abs(Math.trunc(seed)) % LCG_M;
  return () => {
    s = (LCG_A * s + LCG_C) % LCG_M;
    return s / LCG_M;
  };
}

export interface MonitoringGeneratorOptions {
  /**
   * Makes the whole walk — noise, burst timing and burst peaks — reproducible.
   *
   * Omitted everywhere the simulator actually runs: a display that showed the
   * same second of history on every reload would hide exactly the rendering
   * bugs this generator exists to expose. Tests pass one so "the CPU crosses
   * 80 °C within 180 s and comes back" is an assertion rather than a hope.
   */
  seed?: number;
}

/**
 * Correlated load with occasional bursts — a flat sine wave would hide real
 * rendering bugs, and a flat walk hid every threshold (see above).
 *
 * Exported because the CONFIGURATION window needs the same numbers: the editor's
 * halo runs the real stats renderer, and with no Kraken on the other end it has
 * to show it something. Sharing the generator is what makes "sample data" in the
 * editor and `?sim=` on the display the same fiction rather than two — and the
 * editor labels it as sample data through the claims spine, so nobody mistakes
 * this walk for their machine.
 */
export function createMonitoringGenerator(
  profile: MonitorProfile,
  options: MonitoringGeneratorOptions = {},
): () => NzxtV1.MonitoringData {
  const rand = randomSource(options.seed);
  const between = (lo: number, hi: number): number => lo + rand() * (hi - lo);

  const base = profile === 'load' ? 0.65 : profile === 'spike' ? 0.35 : 0.12;
  const gapScale = profile === 'spike' ? SPIKE_GAP_SCALE : 1;

  let cpuLoad = base;
  let cpuTemp = CPU_TEMP_BASE + base * CPU_TEMP_SPAN;
  let gpuLoad = base * 0.8;
  let liquid = 30;
  let ramUsed = 12_000;
  let tick = 0;

  /** The burst currently scheduled: when it starts, when it ends, how hard. */
  let burstAt = between(BURST_GAP_MIN_S, BURST_GAP_MAX_S) * gapScale;
  let burstUntil = burstAt + between(BURST_LEN_MIN_S, BURST_LEN_MAX_S);
  let burstPeak = between(BURST_PEAK_MIN, BURST_PEAK_MAX);

  return () => {
    tick += 1;

    if (tick > burstUntil) {
      burstAt = tick + between(BURST_GAP_MIN_S, BURST_GAP_MAX_S) * gapScale;
      burstUntil = burstAt + between(BURST_LEN_MIN_S, BURST_LEN_MAX_S);
      burstPeak = between(BURST_PEAK_MIN, BURST_PEAK_MAX);
    }
    const target = tick >= burstAt ? burstPeak : base;

    cpuLoad = Math.min(
      1,
      Math.max(0, cpuLoad + (target - cpuLoad) * LOAD_APPROACH + (rand() - 0.5) * CPU_NOISE),
    );
    // Temperature lags load with a ~6 s time constant.
    cpuTemp += (CPU_TEMP_BASE + cpuLoad * CPU_TEMP_SPAN - cpuTemp) / CPU_TEMP_LAG_S;
    gpuLoad = Math.min(
      1,
      Math.max(0, gpuLoad * (1 - GPU_FOLLOW) + cpuLoad * GPU_FOLLOW + (rand() - 0.5) * GPU_NOISE),
    );
    // Liquid temperature lags CPU temperature with a ~40 s constant, narrow band.
    liquid += (LIQUID_BASE + cpuLoad * LIQUID_SPAN - liquid) / LIQUID_LAG_S;
    ramUsed = Math.min(RAM_MAX_MIB, Math.max(RAM_MIN_MIB, ramUsed + (rand() - 0.5) * RAM_NOISE));

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
          temperature: Math.round((GPU_TEMP_BASE + gpuLoad * GPU_TEMP_SPAN) * 10) / 10,
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
  const nextSample = createMonitoringGenerator(opts.monitor ?? 'idle');

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
