import { describe, expect, it } from 'vitest';

import {
  PLACEHOLDER,
  buildTile,
  cToF,
  dialLabelRepeats,
  formatLoad,
  formatRpm,
  formatTemp,
  normalizeRange,
  secondaryFor,
  statsPaintKey,
  tilesFor,
} from './format';
import { STATS_DEFAULTS, validateStatsConfig, type StatsConfig } from './schema';

import type { NormalizedMonitoring } from '../../platform/monitoring';

function feed(over: Partial<NormalizedMonitoring> = {}): NormalizedMonitoring {
  return {
    cpu: {},
    gpu: {},
    ram: {},
    kraken: {},
    at: 0,
    simulated: true,
    ...over,
  };
}

const cfg: StatsConfig = { ...STATS_DEFAULTS };

describe('every field is number | undefined', () => {
  it('renders a missing temperature as the placeholder, never NaN or zero', () => {
    expect(formatTemp(undefined, 'c')).toBe(PLACEHOLDER);
    expect(formatTemp(Number.NaN, 'c')).toBe(PLACEHOLDER);
    expect(formatTemp(undefined, 'c')).not.toContain('NaN');
  });

  it('renders a missing load and a missing fan speed as the placeholder', () => {
    expect(formatLoad(undefined)).toBe(PLACEHOLDER);
    expect(formatRpm(undefined)).toBe(PLACEHOLDER);
    expect(formatLoad(Number.NaN)).toBe(PLACEHOLDER);
  });

  it('gives a null dial fraction — not 0 — for a missing reading', () => {
    expect(normalizeRange(undefined, 20, 100)).toBeNull();
    expect(normalizeRange(Number.NaN, 20, 100)).toBeNull();
    // The distinction matters: 0 would draw an empty arc, which reads as "0 °C".
    expect(normalizeRange(20, 20, 100)).toBe(0);
  });

  it('builds a wholly-undefined tile without throwing and without NaN', () => {
    for (const metric of [
      'cpuTemp',
      'cpuLoad',
      'gpuTemp',
      'gpuLoad',
      'liquidTemp',
      'ramPct',
      'cpuFanRpm',
    ] as const) {
      const tile = buildTile(metric, feed(), cfg);
      expect(tile.value).toBe(PLACEHOLDER);
      expect(tile.fraction).toBeNull();
    }
  });

  it('survives a null feed entirely (nothing has ever arrived)', () => {
    const tiles = tilesFor({ ...cfg, layout: 'grid' }, null);
    expect(tiles).toHaveLength(6);
    for (const t of tiles) {
      expect(t.value).toBe(PLACEHOLDER);
      expect(t.fraction).toBeNull();
    }
  });

  it('degrades PER TILE — a present sensor still reads while a missing one dashes', () => {
    const tiles = tilesFor({ ...cfg, layout: 'dual' }, feed({ cpu: { tempC: 61 } }));
    expect(tiles[0]?.value).toBe('61');
    expect(tiles[0]?.fraction).not.toBeNull();
    expect(tiles[1]?.value).toBe(PLACEHOLDER);
    expect(tiles[1]?.fraction).toBeNull();
  });
});

describe('formatting', () => {
  it('rounds temperatures to whole degrees', () => {
    expect(formatTemp(61.4, 'c')).toBe('61');
    expect(formatTemp(61.6, 'c')).toBe('62');
  });

  it('converts to Fahrenheit on request', () => {
    expect(cToF(0)).toBe(32);
    expect(cToF(100)).toBe(212);
    expect(formatTemp(50, 'f')).toBe('122');
  });

  it('renders CAM 0..1 loads as whole percent', () => {
    expect(formatLoad(0)).toBe('0');
    expect(formatLoad(0.436)).toBe('44');
    expect(formatLoad(1)).toBe('100');
    // Out-of-range input is clamped, not echoed.
    expect(formatLoad(1.5)).toBe('100');
    expect(formatLoad(-1)).toBe('0');
  });

  it('clamps a dial fraction to 0..1', () => {
    expect(normalizeRange(5, 20, 100)).toBe(0);
    expect(normalizeRange(500, 20, 100)).toBe(1);
    expect(normalizeRange(60, 20, 100)).toBeCloseTo(0.5, 10);
  });
});

describe('layouts', () => {
  it('shows one tile for single, two for dual, six for the grid', () => {
    expect(tilesFor({ ...cfg, layout: 'single' }, feed())).toHaveLength(1);
    expect(tilesFor({ ...cfg, layout: 'dual' }, feed())).toHaveLength(2);
    expect(tilesFor({ ...cfg, layout: 'grid' }, feed())).toHaveLength(6);
  });

  it('honours the chosen metric for the single layout only', () => {
    expect(tilesFor({ ...cfg, layout: 'single', primary: 'liquidTemp' }, feed())[0]?.metric).toBe(
      'liquidTemp',
    );
    expect(tilesFor({ ...cfg, layout: 'dual', primary: 'liquidTemp' }, feed())[0]?.metric).toBe(
      'cpuTemp',
    );
  });

  it('never offers a pump-speed metric — CAM has no such field', () => {
    const everything = tilesFor({ ...cfg, layout: 'grid' }, feed()).map((t) => t.metric);
    expect(everything.join(' ')).not.toMatch(/pump/i);
    expect(everything).toContain('liquidTemp');
  });

  it('drops the secondary line in the grid layout', () => {
    const grid = { ...cfg, layout: 'grid' as const };
    const tile = tilesFor(grid, feed())[0];
    expect(tile).toBeDefined();
    expect(secondaryFor(tile!, grid, feed())).toBeNull();
  });

  it('pairs a temperature dial with its load underneath', () => {
    const dual = { ...cfg, layout: 'dual' as const };
    const tile = tilesFor(dual, feed({ cpu: { tempC: 50, load: 0.5 } }))[0];
    expect(secondaryFor(tile!, dual, feed({ cpu: { tempC: 50, load: 0.5 } }))?.metric).toBe(
      'cpuLoad',
    );
  });
});

describe('statsPaintKey', () => {
  it('distinguishes waiting from live even with identical tiles', () => {
    const tiles = tilesFor(cfg, feed());
    expect(statsPaintKey(tiles, true)).not.toBe(statsPaintKey(tiles, false));
  });

  it('is stable for an unchanged sample and changes when a reading moves', () => {
    const a = tilesFor(cfg, feed({ cpu: { tempC: 50 } }));
    const b = tilesFor(cfg, feed({ cpu: { tempC: 50 } }));
    const c = tilesFor(cfg, feed({ cpu: { tempC: 51 } }));
    expect(statsPaintKey(a, false)).toBe(statsPaintKey(b, false));
    expect(statsPaintKey(a, false)).not.toBe(statsPaintKey(c, false));
  });
});

describe('validateStatsConfig', () => {
  it('fills everything from defaults for junk', () => {
    for (const junk of [undefined, null, 0, '', [], { layout: 'hologram' }]) {
      expect(validateStatsConfig(junk)).toEqual(STATS_DEFAULTS);
    }
  });

  it('keeps valid values and is idempotent', () => {
    const once = validateStatsConfig({ layout: 'grid', unit: 'f', theme: 'cyan' });
    expect(once.layout).toBe('grid');
    expect(once.unit).toBe('f');
    expect(validateStatsConfig(once)).toEqual(once);
  });
});

describe('a dial is labelled once', () => {
  /**
   * Round 7's minors. The audit's display capture shows **CPU 17%** in the arc
   * gap and **CPU** again under the number, on both dials, on the 640 px panel
   * where a repeated word costs the most.
   */
  it('drops the standalone label when the sub-line already names the same thing', () => {
    const dual: StatsConfig = { ...cfg, layout: 'dual' };
    for (const tile of tilesFor(dual, feed())) {
      const secondary = secondaryFor(tile, dual, feed());
      expect(secondary?.label).toBe(tile.label);
      expect(dialLabelRepeats(tile, secondary)).toBe(true);
    }
  });

  /** …and keeps it wherever the two lines genuinely name different things. */
  it('keeps a label the sub-line does not repeat', () => {
    const single: StatsConfig = { ...cfg, layout: 'single', primary: 'liquidTemp' };
    const [tile] = tilesFor(single, feed());
    const secondary = tile === undefined ? null : secondaryFor(tile, single, feed());
    expect(secondary?.label).not.toBe(tile?.label);
    expect(tile === undefined ? true : dialLabelRepeats(tile, secondary)).toBe(false);
  });

  /** The grid has no sub-line at all, so its long labels always stand. */
  it('always labels the grid, which has no second line', () => {
    const grid: StatsConfig = { ...cfg, layout: 'grid' };
    for (const tile of tilesFor(grid, feed())) {
      expect(dialLabelRepeats(tile, secondaryFor(tile, grid, feed()))).toBe(false);
    }
  });
});
