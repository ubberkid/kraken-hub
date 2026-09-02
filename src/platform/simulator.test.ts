/**
 * The monitoring generator's bursts (audit 10, M10).
 *
 * The thing being asserted is not "the numbers look plausible" — it is that the
 * stats module's DEFAULT warm point is reachable on the only data anybody
 * develops against. Before this, `load` asymptoted at about 71 °C against a
 * warm point of 80 °C and the GPU's curve topped out at 78 °C, so every
 * threshold, every state chip and the whole colour-never-travels-alone contract
 * was dead code on the simulator and in the editor's sample halo.
 *
 * A seed makes that an assertion rather than a hope: the walk, the burst timing
 * and the burst peaks all come off one deterministic source.
 */

import { describe, expect, it } from 'vitest';

import { createMonitoringGenerator } from './simulator';

import type { MonitorProfile } from './simulator';

/** Three minutes at the feed's 1 Hz — the window the audit asked about. */
const WINDOW_S = 180;
/** `STATS_THRESHOLD_DEFAULTS.cpu.warm` / `.gpu.warm`. */
const WARM_C = 80;
/** `STATS_THRESHOLD_DEFAULTS.cpu.hot`. A burst must not read as an emergency. */
const HOT_C = 90;

interface Trace {
  cpu: number[];
  gpu: number[];
}

function trace(profile: MonitorProfile, seed: number, seconds = WINDOW_S): Trace {
  const next = createMonitoringGenerator(profile, { seed });
  const cpu: number[] = [];
  const gpu: number[] = [];
  for (let s = 0; s < seconds; s += 1) {
    const sample = next();
    cpu.push(sample.cpus?.[0]?.temperature ?? Number.NaN);
    gpu.push(sample.gpus?.[0]?.temperature ?? Number.NaN);
  }
  return { cpu, gpu };
}

describe('the monitoring generator burns hot occasionally', () => {
  it.each([
    ['idle', 7],
    ['load', 7],
    ['spike', 7],
    ['idle', 20_260_902],
    ['load', 20_260_902],
    ['spike', 20_260_902],
  ] as const)(
    '%s (seed %i) crosses the warm point within 180 s and comes back',
    (profile, seed) => {
      const { cpu } = trace(profile, seed);
      const peakAt = cpu.findIndex((c) => c >= WARM_C);
      expect(peakAt).toBeGreaterThanOrEqual(0);
      // And it is a BURST, not a new plateau: the reading returns under the warm
      // point afterwards, so the face goes amber and then goes back.
      expect(cpu.slice(peakAt).some((c) => c < WARM_C)).toBe(true);
    },
  );

  it('takes the GPU over the warm point too — its old curve could not reach it', () => {
    const { gpu } = trace('load', 7);
    expect(Math.max(...gpu)).toBeGreaterThanOrEqual(WARM_C);
  });

  it('never reads as an emergency: a burst is Warm, not Hot', () => {
    for (const profile of ['idle', 'load', 'spike'] as const) {
      const { cpu, gpu } = trace(profile, 7, WINDOW_S * 4);
      expect(Math.max(...cpu)).toBeLessThan(HOT_C);
      expect(Math.max(...gpu)).toBeLessThan(HOT_C);
    }
  });

  it('spends most of its time below the warm point — a burst is an event', () => {
    const { cpu } = trace('load', 7, WINDOW_S * 4);
    const warm = cpu.filter((c) => c >= WARM_C).length;
    expect(warm).toBeGreaterThan(0);
    expect(warm).toBeLessThan(cpu.length / 2);
  });

  it('is reproducible under a seed, and only under a seed', () => {
    const a = trace('load', 99, 30);
    const b = trace('load', 99, 30);
    expect(a.cpu).toEqual(b.cpu);
    expect(trace('load', 100, 30).cpu).not.toEqual(a.cpu);
  });

  it('still reports every field, and never a NaN', () => {
    const next = createMonitoringGenerator('load', { seed: 3 });
    for (let s = 0; s < WINDOW_S; s += 1) {
      const sample = next();
      const cpu = sample.cpus?.[0];
      const gpu = sample.gpus?.[0];
      expect(Number.isFinite(cpu?.temperature ?? Number.NaN)).toBe(true);
      expect(Number.isFinite(cpu?.load ?? Number.NaN)).toBe(true);
      expect(Number.isFinite(gpu?.temperature ?? Number.NaN)).toBe(true);
      expect(Number.isFinite(sample.ram?.inUse ?? Number.NaN)).toBe(true);
      expect(Number.isFinite(sample.kraken?.liquidTemperature ?? Number.NaN)).toBe(true);
    }
  });

  it('keeps `missing` missing: bursts do not fill in a sensor CAM dropped', () => {
    const next = createMonitoringGenerator('missing', { seed: 5 });
    const absent = { cpus: 0, gpus: 0, ram: 0, kraken: 0 };
    for (let s = 0; s < WINDOW_S; s += 1) {
      const sample = next();
      if ((sample.cpus?.length ?? 0) === 0) absent.cpus += 1;
      if (sample.gpus === undefined) absent.gpus += 1;
      if (sample.ram === undefined) absent.ram += 1;
      if (sample.kraken?.liquidTemperature === undefined) absent.kraken += 1;
    }
    expect(absent.cpus).toBeGreaterThan(0);
    expect(absent.gpus).toBeGreaterThan(0);
    expect(absent.ram).toBeGreaterThan(0);
    expect(absent.kraken).toBeGreaterThan(0);
  });
});
