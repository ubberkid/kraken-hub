/**
 * Thresholds, the placeholder, and the sparkline — the three pure additions the
 * face redesign made, and the one rule that binds them:
 *
 * **A colour never travels without its word.** Every state that changes a
 * stroke has a non-empty {@link stateLabel}, and the only state with an empty
 * label is the one that changes nothing. That is asserted as a property over
 * the whole state set rather than as three string comparisons, so a fourth
 * state cannot be added with a colour and no caption.
 */

import { describe, expect, it } from 'vitest';

import { RETIRED_PHRASES } from '../../config/vocabulary';

import {
  PLACEHOLDER,
  SPARK_SAMPLES,
  buildTile,
  emptyHistory,
  formatMetric,
  metricRange,
  pushSample,
  readMetric,
  ringDash,
  ringFor,
  ringSpan,
  sparkPath,
  stateFor,
  stateLabel,
  thresholdFor,
  type StatsState,
} from './format';
import {
  STATS_DEFAULTS,
  STATS_LAYOUTS,
  STATS_METRICS,
  STATS_RING_LAYOUTS,
  STATS_SLOTS,
  STATS_THRESHOLD_DEFAULTS,
  THRESHOLD_MAX_C,
  THRESHOLD_MIN_C,
  validateStatsConfig,
  type StatsConfig,
  type StatsMetric,
} from './schema';

import type { NormalizedMonitoring } from '../../platform/monitoring';

const cfg: StatsConfig = { ...STATS_DEFAULTS };

function feed(over: Partial<NormalizedMonitoring> = {}): NormalizedMonitoring {
  return { cpu: {}, gpu: {}, ram: {}, kraken: {}, at: 0, simulated: true, ...over };
}

const ALL_STATES: readonly StatsState[] = ['normal', 'warm', 'hot'];

describe('a colour never travels without its word', () => {
  it('labels every state that changes a colour, and only those', () => {
    for (const state of ALL_STATES) {
      const word = stateLabel(state);
      expect(word === '').toBe(state === 'normal');
    }
  });

  it('names the two warm states in words a reader can act on', () => {
    expect(stateLabel('warm')).toBe('Warm');
    expect(stateLabel('hot')).toBe('Hot');
  });
});

describe('which readings have a warm point at all', () => {
  it('gives one to the three temperatures and to nothing else', () => {
    const withThreshold = STATS_METRICS.filter((m) => thresholdFor(m, cfg) !== null);
    expect(withThreshold).toEqual(['cpuTemp', 'gpuTemp', 'liquidTemp']);
  });

  /*
   * A CPU at 100 % is a CPU doing its job. Painting that amber spends the one
   * alarming colour the face has on the least alarming thing it shows, and
   * teaches the reader to ignore it on the meter where it matters.
   */
  it('never warns about a load, a fan or memory', () => {
    for (const metric of ['cpuLoad', 'gpuLoad', 'ramPct', 'cpuFanRpm'] as const) {
      expect(stateFor(metric, THRESHOLD_MAX_C, cfg)).toBe('normal');
    }
  });
});

describe('the threshold table', () => {
  const rows: readonly [StatsMetric, number, StatsState][] = [
    ['cpuTemp', 40, 'normal'],
    ['cpuTemp', STATS_THRESHOLD_DEFAULTS.cpu.warm - 1, 'normal'],
    ['cpuTemp', STATS_THRESHOLD_DEFAULTS.cpu.warm, 'warm'],
    ['cpuTemp', STATS_THRESHOLD_DEFAULTS.cpu.hot - 1, 'warm'],
    ['cpuTemp', STATS_THRESHOLD_DEFAULTS.cpu.hot, 'hot'],
    ['gpuTemp', STATS_THRESHOLD_DEFAULTS.gpu.warm, 'warm'],
    ['gpuTemp', STATS_THRESHOLD_DEFAULTS.gpu.hot + 1, 'hot'],
    ['liquidTemp', STATS_THRESHOLD_DEFAULTS.liquid.warm - 1, 'normal'],
    ['liquidTemp', STATS_THRESHOLD_DEFAULTS.liquid.warm, 'warm'],
    ['liquidTemp', STATS_THRESHOLD_DEFAULTS.liquid.hot, 'hot'],
  ];

  it.each(rows)('%s at %d °C is %s', (metric, celsius, state) => {
    expect(stateFor(metric, celsius, cfg)).toBe(state);
  });

  it('is normal when the sensor is not reporting — no reading is not an alarm', () => {
    expect(stateFor('cpuTemp', undefined, cfg)).toBe('normal');
    expect(stateFor('cpuTemp', Number.NaN, cfg)).toBe('normal');
  });

  /*
   * Thresholds are stored in Celsius so that flipping the unit switch cannot
   * move the alarm. A face showing °F crosses at exactly the same silicon
   * temperature as one showing °C.
   */
  it('does not move when the face switches to Fahrenheit', () => {
    const f: StatsConfig = { ...cfg, unit: 'f' };
    const at = STATS_THRESHOLD_DEFAULTS.cpu.hot;
    expect(stateFor('cpuTemp', at, f)).toBe('hot');
    expect(buildTile('cpuTemp', feed({ cpu: { tempC: at } }), f).state).toBe('hot');
    // …and it is the SAME reading, said in the other unit.
    expect(buildTile('cpuTemp', feed({ cpu: { tempC: at } }), f).value).not.toBe(
      buildTile('cpuTemp', feed({ cpu: { tempC: at } }), cfg).value,
    );
  });

  it('carries the state onto the tile the renderer paints', () => {
    const hot = buildTile('cpuTemp', feed({ cpu: { tempC: THRESHOLD_MAX_C } }), cfg);
    expect(hot.state).toBe('hot');
    expect(stateLabel(hot.state)).not.toBe('');
  });
});

describe('a missing reading', () => {
  it('renders the placeholder for every metric, with no raw value and no arc', () => {
    for (const metric of STATS_METRICS) {
      const tile = buildTile(metric, feed(), cfg);
      expect(tile.value).toBe(PLACEHOLDER);
      expect(tile.raw).toBeNull();
      expect(tile.fraction).toBeNull();
      expect(tile.state).toBe('normal');
    }
  });

  it('reads back as undefined rather than as zero', () => {
    for (const metric of STATS_METRICS) {
      expect(readMetric(metric, feed())).toBeUndefined();
      expect(readMetric(metric, null)).toBeUndefined();
    }
  });

  it('formats a null or undefined raw value as the placeholder', () => {
    expect(formatMetric('cpuTemp', null, cfg)).toBe(PLACEHOLDER);
    expect(formatMetric('cpuLoad', undefined, cfg)).toBe(PLACEHOLDER);
    expect(formatMetric('cpuFanRpm', Number.NaN, cfg)).toBe(PLACEHOLDER);
  });

  /** There is no pump RPM, and no amount of config may conjure one. */
  it('offers no pump reading on any face', () => {
    for (const layout of STATS_LAYOUTS) {
      expect(JSON.stringify(layout)).not.toMatch(/pump/i);
    }
    expect(STATS_METRICS.join(' ')).not.toMatch(/pump/i);
  });
});

describe('the arc, as arithmetic', () => {
  // Only the faces that HAVE a ring: `bar` and `vertical` draw a straight line
  // and `chart` draws a history, and asking those for a radius is a question
  // with no answer rather than an answer nobody looked at.
  it('gives every ring face a stroke that is 2–3 % of its own diameter', () => {
    for (const layout of STATS_RING_LAYOUTS) {
      for (let i = 0; i < STATS_SLOTS; i += 1) {
        const ring = ringFor(layout, i);
        const ratio = ring.stroke / (ring.r * 2);
        expect(ratio).toBeGreaterThan(0.019);
        expect(ratio).toBeLessThan(0.032);
      }
    }
  });

  it('mirrors the dual face: two equal sweeps, half a turn apart', () => {
    const left = ringFor('dual', 0);
    const right = ringFor('dual', 1);
    expect(left.sweepDeg).toBe(right.sweepDeg);
    expect(right.startDeg - left.startDeg).toBe(180);
  });

  it('nests the triple face: three radii, outermost first, none overlapping', () => {
    const rings = [0, 1, 2].map((i) => ringFor('triple', i));
    for (let i = 1; i < rings.length; i += 1) {
      const outer = rings[i - 1];
      const inner = rings[i];
      expect(inner?.r ?? 0).toBeLessThan(outer?.r ?? 0);
      // A clear gap between the strokes, or the three read as one thick band.
      expect((outer?.r ?? 0) - (inner?.r ?? 0)).toBeGreaterThan(outer?.stroke ?? 0);
    }
  });

  it('dashes a fraction of the sweep, not of the whole circle', () => {
    const ring = ringFor('single', 0);
    const span = ringSpan(ring.sweepDeg);
    expect(ringDash(ring.sweepDeg, 1)).toBe(`${span.toFixed(2)} 100`);
    expect(ringDash(ring.sweepDeg, 0.5)).toBe(`${(span / 2).toFixed(2)} 100`);
  });

  it('draws nothing for a missing reading — an empty arc would read as zero', () => {
    expect(ringDash(ringFor('single', 0).sweepDeg, null)).toBe('0.00 100');
  });

  it('clamps an out-of-range fraction instead of overrunning the ring', () => {
    const ring = ringFor('single', 0);
    expect(ringDash(ring.sweepDeg, 2)).toBe(ringDash(ring.sweepDeg, 1));
    expect(ringDash(ring.sweepDeg, -1)).toBe(ringDash(ring.sweepDeg, 0));
  });
});

describe('the sparkline', () => {
  it('holds exactly one minute of a 1 Hz feed', () => {
    expect(SPARK_SAMPLES).toBe(60);
    expect(emptyHistory()).toHaveLength(SPARK_SAMPLES);
  });

  it('draws nothing until there is a shape to draw', () => {
    const h = emptyHistory();
    expect(sparkPath(h, 0, 1)).toBeNull();
    pushSample(h, 0.5);
    // One point is not a trend, and a dot that implies one is a lie.
    expect(sparkPath(h, 0, 1)).toBeNull();
    pushSample(h, 0.6);
    expect(sparkPath(h, 0, 1)).not.toBeNull();
  });

  it('keeps the history at a fixed length and drops the oldest sample', () => {
    const h = emptyHistory();
    for (let i = 0; i < SPARK_SAMPLES * 2; i += 1) pushSample(h, i);
    expect(h).toHaveLength(SPARK_SAMPLES);
    expect(h[h.length - 1]).toBe(SPARK_SAMPLES * 2 - 1);
  });

  it('records a dropped sensor as a gap rather than as a zero', () => {
    const h = emptyHistory();
    pushSample(h, 1);
    pushSample(h, undefined);
    pushSample(h, 3);
    expect(h[h.length - 2]).toBeNull();
    // Two `M` commands: the line breaks where the sensor went away.
    const path = sparkPath(h, 0, 4);
    expect((path?.d.match(/M/g) ?? []).length).toBe(2);
  });

  it('ends on the newest reading, which is the number beside it', () => {
    const h = emptyHistory();
    const { min, max } = metricRange('cpuTemp');
    pushSample(h, min);
    pushSample(h, max);
    const path = sparkPath(h, min, max);
    // Last index, so the far right of the box; and the top, because it is the
    // maximum. `y` grows downward.
    expect(path?.endX).toBeCloseTo(100, 5);
    expect(path?.endY ?? 100).toBeLessThan(50);
  });
});

describe('validateStatsConfig, with the redesign in it', () => {
  it('fills everything from defaults for junk', () => {
    for (const junk of [undefined, null, 0, '', [], { layout: 'hologram' }]) {
      expect(validateStatsConfig(junk)).toEqual(STATS_DEFAULTS);
    }
  });

  it('always produces exactly one metric per slot', () => {
    expect(validateStatsConfig({ metrics: [] }).metrics).toHaveLength(STATS_SLOTS);
    expect(validateStatsConfig({ metrics: ['nonsense', 42] }).metrics).toEqual(
      STATS_DEFAULTS.metrics,
    );
    expect(validateStatsConfig({ metrics: ['ramPct'] }).metrics[0]).toBe('ramPct');
  });

  it('clamps a warm point into a range where it means something', () => {
    const low = validateStatsConfig({ thresholds: { cpu: { warm: -500, hot: -500 } } });
    expect(low.thresholds.cpu.warm).toBe(THRESHOLD_MIN_C);
    const high = validateStatsConfig({ thresholds: { cpu: { warm: 9999, hot: 9999 } } });
    expect(high.thresholds.cpu.warm).toBe(THRESHOLD_MAX_C);
  });

  /*
   * Crossed sliders are a drag past a neighbour, not corruption. The honest
   * reading is "there is no warm band" rather than "throw the user's numbers
   * away and go back to the factory ones".
   */
  it('un-crosses a hot point dragged below its warm point', () => {
    const c = validateStatsConfig({ thresholds: { cpu: { warm: 95, hot: 60 } } });
    expect(c.thresholds.cpu.warm).toBe(95);
    expect(c.thresholds.cpu.hot).toBe(95);
    expect(stateFor('cpuTemp', 96, c)).toBe('hot');
  });

  it('is idempotent, including through the new fields', () => {
    const once = validateStatsConfig({
      layout: 'triple',
      sparkline: true,
      metrics: ['gpuTemp', 'ramPct', 'cpuFanRpm'],
      thresholds: { liquid: { warm: 38, hot: 44 } },
    });
    expect(validateStatsConfig(once)).toEqual(once);
    expect(once.layout).toBe('triple');
    expect(once.sparkline).toBe(true);
  });
});

/**
 * The vocabulary spine, from this module's side.
 *
 * `src/config/vocabulary.test.ts` greps the whole tree for these already; this
 * asserts the same thing about the strings stats actually paints, so a face
 * that grows a new caption fails here first and next to the code that added it.
 */
describe('the words on the face', () => {
  const SPOKEN: readonly string[] = [
    'Waiting for CAM data…',
    stateLabel('warm'),
    stateLabel('hot'),
    PLACEHOLDER,
  ];

  it('uses no retired phrase', () => {
    for (const line of SPOKEN) {
      for (const dead of RETIRED_PHRASES) {
        expect(line).not.toContain(dead);
      }
    }
  });
});
