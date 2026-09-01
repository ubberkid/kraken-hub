import { describe, expect, it } from 'vitest';

import {
  decodeMonitorSnapshot,
  encodeMonitorSnapshot,
  snapshotToMonitoring,
} from './monitorSnapshot';
import { MAX_ENVELOPE_BYTES } from './types';

const full = {
  cpu: { load: 0.42, tempC: 61.25 },
  gpu: { load: 0.9, tempC: 71.4 },
  kraken: { liquidTempC: 33.75 },
};

describe('encodeMonitorSnapshot', () => {
  it('is a few dozen bytes, not a few hundred', () => {
    const bytes = JSON.stringify(encodeMonitorSnapshot(full)).length;
    expect(bytes).toBeLessThan(80);
    expect(bytes).toBeLessThan(MAX_ENVELOPE_BYTES);
  });

  it('rounds to one decimal — a dial cannot show more', () => {
    expect(encodeMonitorSnapshot(full)).toEqual({
      ct: 61.3,
      cl: 0.4,
      gt: 71.4,
      gl: 0.9,
      lq: 33.8,
    });
  });

  /**
   * The rule the whole thing turns on: every field of CAM's feed is
   * `number | undefined`, and a module must render `--` rather than `0` when a
   * sensor is absent. So an absent reading is an ABSENT KEY, never a zero.
   */
  it('omits an absent reading rather than sending a zero for it', () => {
    const partial = { cpu: { tempC: 55 }, gpu: {}, kraken: {} };
    expect(encodeMonitorSnapshot(partial)).toEqual({ ct: 55 });
  });

  it('omits a non-finite reading too', () => {
    const broken = {
      cpu: { tempC: Number.NaN, load: Number.POSITIVE_INFINITY },
      gpu: {},
      kraken: {},
    };
    expect(encodeMonitorSnapshot(broken)).toEqual({});
  });
});

describe('decodeMonitorSnapshot', () => {
  it('round-trips', () => {
    const decoded = decodeMonitorSnapshot(encodeMonitorSnapshot(full));
    expect(decoded).toEqual({
      cpu: { tempC: 61.3, load: 0.4 },
      gpu: { tempC: 71.4, load: 0.9 },
      liquidC: 33.8,
    });
  });

  it('puts `undefined` back, not zero, for what was never sent', () => {
    const decoded = decodeMonitorSnapshot({ ct: 55 });
    expect(decoded?.cpu.tempC).toBe(55);
    expect(decoded?.cpu.load).toBeUndefined();
    expect(decoded?.gpu.tempC).toBeUndefined();
    expect(decoded?.liquidC).toBeUndefined();
  });

  /**
   * A packet with none of our keys is somebody else's payload, not an empty
   * reading. Saying `null` keeps the replica's "waiting for CAM data" card up,
   * which is the truthful answer.
   */
  it('is null for anything that is not a snapshot', () => {
    expect(decodeMonitorSnapshot(null)).toBeNull();
    expect(decodeMonitorSnapshot(undefined)).toBeNull();
    expect(decodeMonitorSnapshot({})).toBeNull();
    expect(decodeMonitorSnapshot({ stats: {} })).toBeNull();
    expect(decodeMonitorSnapshot([1, 2])).toBeNull();
    expect(decodeMonitorSnapshot('ct')).toBeNull();
  });

  it('ignores keys whose values are not numbers', () => {
    expect(decodeMonitorSnapshot({ ct: '55' })).toBeNull();
    expect(decodeMonitorSnapshot({ ct: 55, cl: 'x' })?.cpu).toEqual({ tempC: 55 });
  });
});

describe('snapshotToMonitoring', () => {
  it('produces the platform shape the REAL stats renderer already reads', () => {
    const norm = snapshotToMonitoring(
      { cpu: { tempC: 61 }, gpu: { load: 0.5 }, liquidC: 33 },
      1234,
    );
    expect(norm.cpu.tempC).toBe(61);
    expect(norm.gpu.load).toBe(0.5);
    expect(norm.kraken.liquidTempC).toBe(33);
    expect(norm.at).toBe(1234);
  });

  it('leaves what the wire does not carry absent, so it renders as --', () => {
    const norm = snapshotToMonitoring({ cpu: {}, gpu: {}, liquidC: 33 }, 0);
    expect(norm.cpu.load).toBeUndefined();
    expect(norm.ram).toEqual({});
  });

  /**
   * These are real readings from a real machine; they just arrived by radio.
   * Marking them simulated would put a "simulated" badge on a genuine
   * temperature.
   */
  it('does not claim the readings are simulated', () => {
    expect(snapshotToMonitoring({ cpu: {}, gpu: {} }, 0).simulated).toBe(false);
  });
});
