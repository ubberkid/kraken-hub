/**
 * The eight faces, in a document.
 *
 * jsdom lays nothing out — every `getBoundingClientRect()` is zero — so the box
 * under test is driven through `ctx.geometry()`, which is the same path the
 * renderer takes on a real panel and the reason it has no size of its own. What
 * this file can therefore assert is exactly what matters: the STRUCTURE each
 * face builds, that every size the renderer writes is a function of the frame
 * it was given, and that the glide, the thresholds and the governor tiers
 * behave the way the pure tests say they should once a DOM is attached to them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEVICE_PRESETS } from '../../platform/devicePresets';
import { DEFAULT_RENDER } from '../../state/defaults';

import { createRenderer } from './display';
import { PLACEHOLDER, tilesFor } from './format';
import {
  STATS_DEFAULTS,
  STATS_LAYOUTS,
  STATS_SLOTS,
  STATS_THRESHOLD_DEFAULTS,
  metricLabel,
  metricLongLabel,
  type StatsConfig,
  type StatsMetric,
} from './schema';
import { TWEEN_MS } from './tween';

import type { FrameInfo } from '../../platform/fpsGovernor';
import type { Geometry } from '../../platform/geometry';
import type { NormalizedMonitoring } from '../../platform/monitoring';
import type { ModuleContext } from '../types';

/** The three frames the brief names: full panel, small panel, overlay-sized. */
const ELITE = DEVICE_PRESETS.elite;
const SMALL = DEVICE_PRESETS.kraken2023;
const OVERLAY_SCALE = 0.6;

function geometryFor(width: number, height: number, shape: Geometry['shape']): Geometry {
  const short = Math.min(width, height);
  return {
    width,
    height,
    shape,
    targetFps: ELITE.targetFps,
    dpr: 1,
    source: 'sim',
    safeInsetPx: Math.round(short * DEFAULT_RENDER.safeAreaPct),
    inscribedSquarePx: Math.round(short * Math.SQRT1_2),
    radiusPx: short / 2,
  };
}

const FRAMES: readonly { name: string; g: Geometry }[] = [
  { name: 'full panel', g: geometryFor(ELITE.width, ELITE.height, 'circle') },
  {
    name: 'overlay scale',
    g: geometryFor(ELITE.width * OVERLAY_SCALE, ELITE.height * OVERLAY_SCALE, 'circle'),
  },
  { name: 'smallest preset', g: geometryFor(SMALL.width, SMALL.height, 'square') },
];

function feed(over: Partial<NormalizedMonitoring> = {}): NormalizedMonitoring {
  return { cpu: {}, gpu: {}, ram: {}, kraken: {}, at: 0, simulated: true, ...over };
}

function contextFor(g: Geometry, initial: NormalizedMonitoring | null): ModuleContext {
  return {
    geometry: () => g,
    frameClock: { subscribe: () => () => undefined } as unknown as ModuleContext['frameClock'],
    monitoring: {
      latest: () => (initial === null ? null : { norm: initial, raw: {} as NzxtV1.MonitoringData }),
      lastUpdateAt: () => (initial === null ? 0 : Date.now()),
      subscribe: () => () => undefined,
    } as unknown as ModuleContext['monitoring'],
    render: () => DEFAULT_RENDER,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    signal: new AbortController().signal,
  };
}

const FRAME_MS = 1000 / 60;

function frameInfo(i: number, dt = FRAME_MS): FrameInfo {
  return { t: i * dt, dt, frame: i, targetFps: ELITE.targetFps, budgetMs: dt, achievedFps: 60 };
}

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  host.remove();
});

function mount(
  cfg: Partial<StatsConfig>,
  g = FRAMES[0]?.g,
  sample: NormalizedMonitoring | null = null,
) {
  const renderer = createRenderer();
  void renderer.mount(host, contextFor(g ?? FRAMES[0]!.g, sample), { ...STATS_DEFAULTS, ...cfg });
  return renderer;
}

const root = (): HTMLElement | null => host.querySelector('.kh-stats');
const tiles = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('.kh-stats__tile')];
const values = (): string[] =>
  [...host.querySelectorAll('.kh-stats__value')].map((n) => n.textContent);
const prop = (name: string): string => root()?.style.getPropertyValue(name).trim() ?? '';
const px = (name: string): number => Number.parseFloat(prop(name));

/** Advance `ms` of 60 Hz frames through the renderer. */
function run(renderer: ReturnType<typeof createRenderer>, ms: number, dt = FRAME_MS): void {
  const steps = Math.ceil(ms / dt);
  for (let i = 0; i < steps; i += 1) renderer.frame?.(frameInfo(i, dt));
}

const HOT_C = STATS_THRESHOLD_DEFAULTS.cpu.hot + 2;
const WARM_C = STATS_THRESHOLD_DEFAULTS.cpu.warm + 1;

describe('each face builds the structure the prototype shows', () => {
  const EXPECTED: readonly [StatsConfig['layout'], number][] = [
    ['single', 1],
    ['dual', 2],
    ['triple', 3],
    ['grid', 6],
    ['strip', 3],
    ['bar', 3],
    ['vertical', 3],
    ['chart', 3],
  ];

  it('covers every registered face — a new one cannot be added untested', () => {
    expect(EXPECTED.map(([l]) => l)).toEqual([...STATS_LAYOUTS]);
  });

  it.each(EXPECTED)('%s draws %d meters', (layout, count) => {
    const r = mount({ layout });
    expect(root()?.dataset['layout']).toBe(layout);
    expect(tiles()).toHaveLength(count);
    // Every tile carries its slot, which is what the face CSS positions by.
    tiles().forEach((t, i) => {
      expect(t.dataset['slot']).toBe(String(i));
      expect(t.dataset['state']).toBe('normal');
      expect(t.querySelector('.kh-stats__value')).not.toBeNull();
      /*
       * A gauge, in whichever shape this face draws one, over a recessive
       * track. The `chart` face draws neither on purpose — sixty seconds of
       * history IS its mark, and a gauge beside it would be the same number
       * said twice — so the expectation is stated as an equality rather than a
       * branch, and the face that has no gauge is as pinned as the ones that do.
       */
      const gauged = layout !== 'chart';
      expect(t.querySelector('[data-arc]') !== null).toBe(gauged);
      expect(t.querySelector('.kh-stats__track, .kh-stats__bar-track') !== null).toBe(gauged);
      // Every face carries the history markup; only some of them show it.
      expect(t.querySelector('.kh-stats__spark-line')).not.toBeNull();
    });
    r.unmount();
    expect(host.children).toHaveLength(0);
  });

  /**
   * The linear faces write a PERCENTAGE, the ring faces a dash — one tween,
   * one guard, two shapes. `meterFill` is the only place that knows which.
   */
  it.each(['bar', 'vertical'] as const)('%s fills a straight gauge, not an arc', (layout) => {
    const r = mount({ layout }, FRAMES[0]?.g, feed({ cpu: { tempC: 60 }, gpu: { tempC: 60 } }));
    run(r, 1000);
    const fill = tiles()[0]?.querySelector<HTMLElement>('[data-arc]');
    expect(fill?.classList.contains('kh-stats__bar-fill')).toBe(true);
    expect(fill?.style.getPropertyValue('--kh-stats-fill')).toMatch(/^\d+\.\d\d%$/);
  });

  /*
   * The arc is a percentage of `pathLength`, so no frame computes a
   * circumference and the same string is correct at every radius. The TRACK is
   * dashed to the same sweep, which is what keeps an open face open.
   */
  it('draws every arc against a pathLength, never a measured circumference', () => {
    mount({ layout: 'triple' });
    for (const t of tiles()) {
      const arc = t.querySelector('.kh-stats__arc');
      const track = t.querySelector('.kh-stats__track');
      expect(arc?.getAttribute('pathLength')).toBe('100');
      expect(track?.getAttribute('pathLength')).toBe('100');
      expect(arc?.getAttribute('stroke-linecap')).toBe('round');
      expect(arc?.getAttribute('transform')).toBe(track?.getAttribute('transform'));
    }
  });

  it('nests the triple face and mirrors the dual one', () => {
    mount({ layout: 'triple' });
    const radii = tiles().map((t) =>
      Number(t.querySelector('.kh-stats__arc')?.getAttribute('r') ?? 0),
    );
    expect(radii[0]).toBeGreaterThan(radii[1] ?? 0);
    expect(radii[1]).toBeGreaterThan(radii[2] ?? 0);

    host.replaceChildren();
    mount({ layout: 'dual' });
    const turns = tiles().map((t) => t.querySelector('.kh-stats__arc')?.getAttribute('transform'));
    expect(turns[0]).not.toBe(turns[1]);
  });

  /*
   * ## The strip's reading hangs off the ring, not off the tile
   *
   * The face used to centre its reading by giving it the ring's GRID AREA
   * (`position: absolute; grid-row: 1`) on the claim that an absolutely-
   * positioned grid child is laid out inside that area. Chromium does not do
   * that — the readout's containing block came back as the whole TILE (`top:
   * 49.05px` and `bottom: 49.06px`, the two summing to the tile's height), so
   * the reading sat 12.2 px below the ring's centre on every panel.
   *
   * jsdom computes no layout, so the pixels are not what is asserted here: the
   * STRUCTURE is. The ring and the reading are one positioned box, and that is
   * the whole of the fix — a wrapper the stylesheet makes `position: relative`
   * cannot resolve to anything but the ring, at any size, with no offset to
   * keep in step. If a later change moves the readout back out into the stack,
   * the centring silently goes back to being a claim, and this fails.
   */
  it('hangs the strip reading off the ring itself, not off the tile (audit 11)', () => {
    mount({ layout: 'strip' });
    for (const t of tiles()) {
      const ring = t.querySelector('.kh-stats__ring');
      expect(ring).not.toBeNull();
      // One box, holding both pieces: the mark, and the number drawn on it.
      expect(ring?.querySelector('.kh-stats__dial')).not.toBeNull();
      expect(t.querySelector('.kh-stats__readout')?.parentElement).toBe(ring);
      // And the words stay in the tile's own flow, under the ring.
      expect(t.querySelector('.kh-stats__label')?.closest('.kh-stats__ring')).toBeNull();
      expect(t.querySelector('.kh-stats__chip')?.closest('.kh-stats__ring')).toBeNull();
    }
  });

  /*
   * The wrapper is the STRIP's, and only the strip's. Every other face centres
   * its reading with the stack, whose `left`/`top` move all four pieces
   * together — that is how `dual` puts two heroes on one ring — and a wrapper
   * around the mark would take the readout out of that block.
   */
  it.each(STATS_LAYOUTS.filter((l) => l !== 'strip').map((l) => [l] as const))(
    '%s keeps its reading in the stack',
    (layout) => {
      mount({ layout });
      for (const t of tiles()) {
        expect(t.querySelector('.kh-stats__ring')).toBeNull();
        expect(t.querySelector('.kh-stats__readout')?.parentElement?.className).toBe(
          'kh-stats__stack',
        );
      }
    },
  );
});

describe('every size comes from the frame, and none from a literal', () => {
  it.each(FRAMES.map((f) => [f.name, f.g] as const))('%s', (_name, g) => {
    mount({ layout: 'single' }, g);
    for (const name of [
      '--kh-stats-box',
      '--kh-stats-dial',
      '--kh-stats-value',
      '--kh-stats-label',
    ])
      expect(px(name)).toBeGreaterThan(0);
    // Everything is a fraction of the box, so nothing can exceed the frame.
    expect(px('--kh-stats-box')).toBeLessThanOrEqual(Math.min(g.width, g.height));
  });

  it('shrinks with the frame rather than snapping to a breakpoint', () => {
    const seen = FRAMES.map((f) => {
      host.replaceChildren();
      mount({ layout: 'single' }, f.g);
      return px('--kh-stats-value');
    });
    // Full panel, then the 0.6 overlay, then the smallest preset: three frames,
    // three different type sizes, strictly ordered.
    expect(seen[0]).toBeGreaterThan(seen[1] ?? 0);
    expect(seen[1]).toBeGreaterThan(seen[2] ?? 0);
  });

  it('holds every face to three type sizes', () => {
    for (const layout of ['single', 'dual', 'triple', 'grid', 'strip'] as const) {
      host.replaceChildren();
      mount({ layout }, FRAMES[0]?.g);
      expect(px('--kh-stats-value')).toBeGreaterThan(px('--kh-stats-unit'));
      expect(px('--kh-stats-unit')).toBeGreaterThan(px('--kh-stats-label'));
      // The sub-line is not a fourth size: it IS the small one.
      expect(prop('--kh-stats-sub')).toBe(prop('--kh-stats-label'));
    }
  });
});

describe('a reading that is not there', () => {
  it('shows the placeholder, no unit, and no arc', () => {
    mount({ layout: 'dual' }, FRAMES[0]?.g, feed());
    expect(values()).toEqual([PLACEHOLDER, PLACEHOLDER]);
    for (const t of tiles()) {
      expect(t.querySelector('.kh-stats__unit')?.textContent).toBe('');
      // The track alone. An empty arc would read as a measurement of zero.
      expect(t.querySelector('.kh-stats__arc')?.getAttribute('visibility')).toBe('hidden');
    }
  });

  it('degrades per meter — a present sensor still reads while a missing one dashes', () => {
    const r = mount({ layout: 'dual' }, FRAMES[0]?.g, feed({ cpu: { tempC: 61 } }));
    run(r, 1000);
    expect(values()[0]).toBe('61');
    expect(values()[1]).toBe(PLACEHOLDER);
  });
});

describe('the values glide rather than chunk', () => {
  it('walks the hero number from one sample to the next', () => {
    const r = mount(
      { layout: 'single', primary: 'cpuTemp' },
      FRAMES[0]?.g,
      feed({ cpu: { tempC: 40 } }),
    );
    run(r, 1000);
    expect(values()[0]).toBe('40');

    r.monitoring?.(feed({ cpu: { tempC: 80 } }), {});
    // One frame in it has moved, and it has NOT arrived — that is the glide.
    r.frame?.(frameInfo(1));
    const first = Number(values()[0]);
    expect(first).toBeGreaterThan(40);
    expect(first).toBeLessThan(80);

    // …and 600 ms of frames later it has.
    run(r, 600);
    expect(values()[0]).toBe('80');
  });

  it('lengthens the arc as it goes, in the same direction', () => {
    const arcSpan = (): number =>
      Number.parseFloat(
        host.querySelector('.kh-stats__arc')?.getAttribute('stroke-dasharray')?.split(' ')[0] ??
          '0',
      );
    const r = mount({ layout: 'single' }, FRAMES[0]?.g, feed({ cpu: { tempC: 40 } }));
    run(r, 1000);
    const before = arcSpan();
    r.monitoring?.(feed({ cpu: { tempC: 80 } }), {});
    r.frame?.(frameInfo(1));
    const mid = arcSpan();
    run(r, 600);
    const after = arcSpan();
    expect(mid).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(mid);
  });

  /**
   * The audit's **F4**, as an assertion.
   *
   * The measured symptom was one arc value per second on a panel showing stats
   * and nothing else — a 420 ms tween that only ran when something ELSE in the
   * stack happened to shift the module's own 1 Hz timer off the feed's phase.
   * The cause was that timer settling every glide with a `dt` of a whole second
   * the instant a sample landed.
   *
   * What has to be true for the fix to be real is this: given a sample and the
   * frames a real host delivers, the arc must take MANY distinct values on the
   * way to the new reading, all of them inside one tween.
   */
  it('paints at least eight distinct arc values inside one tween', () => {
    const arcDash = (): string =>
      host.querySelector('.kh-stats__arc')?.getAttribute('stroke-dasharray') ?? '';
    const r = mount({ layout: 'single' }, FRAMES[0]?.g, feed({ cpu: { tempC: 40 } }));
    run(r, 1000);

    r.monitoring?.(feed({ cpu: { tempC: 80 } }), {});
    const seen = new Set<string>();
    const steps = Math.ceil(TWEEN_MS / FRAME_MS);
    for (let i = 0; i < steps; i += 1) {
      r.frame?.(frameInfo(i));
      seen.add(arcDash());
    }
    expect(seen.size).toBeGreaterThanOrEqual(8);
  });

  /**
   * …and the other half of F4: the 1 Hz timer must not undo it.
   *
   * The timer exists so a host that never calls `frame()` still paints. Where
   * frames ARE flowing it has to keep its hands off the glide, so the module
   * asks whether one has arrived recently rather than being told which kind of
   * host it is in. A frame delivered a moment ago means "not mine to settle".
   */
  it('leaves the glide alone while the host is delivering frames', async () => {
    /*
     * Timers only — `performance` stays real, because that clock is precisely
     * what the renderer reads to answer "has a frame arrived recently?". Faking
     * it would advance a second between the frame and the interval tick and
     * test the opposite branch.
     */
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    try {
      const r = mount({ layout: 'single' }, FRAMES[0]?.g, feed({ cpu: { tempC: 40 } }));
      run(r, 1000);
      r.monitoring?.(feed({ cpu: { tempC: 80 } }), {});
      // One frame's worth of glide, then the second tick the timer fires on.
      r.frame?.(frameInfo(1));
      const midGlide = values()[0];
      await vi.advanceTimersByTimeAsync(1000);
      // Still mid-glide: the interval noticed nothing new and settled nothing.
      expect(values()[0]).toBe(midGlide);
      expect(Number(values()[0])).toBeLessThan(80);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops writing once it has settled — most frames paint nothing at all', () => {
    const r = mount({ layout: 'single' }, FRAMES[0]?.g, feed({ cpu: { tempC: 40 } }));
    run(r, 1000);
    const arc = host.querySelector('.kh-stats__arc');
    const before = arc?.getAttribute('stroke-dasharray');
    run(r, 500);
    expect(arc?.getAttribute('stroke-dasharray')).toBe(before);
  });
});

/**
 * The audit's **M8**, the half a unit test can hold.
 *
 * The geometry half — three rings that do not strike through their own labels,
 * a group centred on the box — lives in `stats.css` and is measured against a
 * real layout engine. What is assertable here is the half that made the face
 * look WRONG even where it did not overlap: whether the word beside a number
 * names the sensor that number came from. The report described a face reading
 * "CPU" twice, so the mapping from slot to label is pinned for every face, at
 * a set of metrics deliberately unlike the defaults.
 */
describe('every meter is labelled with the metric it is showing', () => {
  const SLOTTED: readonly StatsMetric[] = ['gpuTemp', 'liquidTemp', 'cpuFanRpm'];

  it.each(STATS_LAYOUTS.map((l) => [l] as const))('%s', (layout) => {
    host.replaceChildren();
    const cfg: Partial<StatsConfig> = { layout, metrics: SLOTTED, primary: 'ramPct' };
    mount(cfg, FRAMES[0]?.g, feed({ cpu: { tempC: 61, fanRpm: 900 }, ram: { pct: 0.5 } }));

    const shown = tiles().map((t) => t.querySelector('.kh-stats__label')?.textContent ?? '');
    const long = layout === 'grid';
    const nameOf = (m: StatsMetric): string => (long ? metricLongLabel(m) : metricLabel(m));

    /*
     * `single` reads its own `primary`; the text-first face shows every metric
     * and so is its own answer; everything else reads the slot list in order.
     * Worked out as a value rather than as a branch around `expect`, so one
     * assertion covers all eight faces and none of them can slip past on a
     * `return`.
     */
    const slots = layout === 'dual' ? 2 : STATS_SLOTS;
    const expected =
      layout === 'single'
        ? [nameOf('ramPct')]
        : layout === 'grid'
          ? tilesFor({ ...STATS_DEFAULTS, ...cfg }, null).map((t) => nameOf(t.metric))
          : SLOTTED.slice(0, slots).map(nameOf);

    expect(shown).toEqual(expected);
    // No metric labelled twice unless it was CONFIGURED twice.
    expect(new Set(shown).size).toBe(shown.length);
  });

  it('does label the same metric twice when the same metric is chosen twice', () => {
    mount({ layout: 'triple', metrics: ['cpuTemp', 'cpuTemp', 'gpuTemp'] });
    const shown = tiles().map((t) => t.querySelector('.kh-stats__label')?.textContent ?? '');
    expect(shown).toEqual(['CPU', 'CPU', 'GPU']);
  });

  /**
   * And the label is always THERE. It used to be suppressed whenever the old
   * sub-line opened with the same component's name, which on the one-meter face
   * left the panel's hero with no name on it at all.
   */
  it('never hides the hero label — the prototype names the reading it leads with', () => {
    mount({ layout: 'single', primary: 'cpuTemp' }, FRAMES[0]?.g, feed({ cpu: { tempC: 61 } }));
    const label = host.querySelector<HTMLElement>('.kh-stats__label');
    expect(label?.hidden).toBe(false);
    expect(label?.textContent).toBe('CPU');
  });
});

describe('the governor tiers', () => {
  it('snaps straight to the sample at hz1, with no glide to sample', () => {
    const r = mount({ layout: 'single' }, FRAMES[0]?.g, feed({ cpu: { tempC: 40 } }));
    run(r, 1000);
    r.budget?.('hz1');
    r.monitoring?.(feed({ cpu: { tempC: 80 } }), {});
    // The sample lands on the glass without waiting for a single frame.
    expect(values()[0]).toBe('80');
  });

  it('still arrives at full and reduced, just at different cadences', () => {
    for (const tier of ['full', 'reduced'] as const) {
      host.replaceChildren();
      const r = mount({ layout: 'single' }, FRAMES[0]?.g, feed({ cpu: { tempC: 40 } }));
      run(r, 1000);
      r.budget?.(tier);
      r.monitoring?.(feed({ cpu: { tempC: 80 } }), {});
      run(r, 1000);
      expect(values()[0]).toBe('80');
    }
  });
});

describe('a threshold is a word as well as a colour', () => {
  it('says nothing and changes nothing while the reading is normal', () => {
    mount({ layout: 'single' }, FRAMES[0]?.g, feed({ cpu: { tempC: 40 } }));
    const chip = host.querySelector<HTMLElement>('.kh-stats__chip');
    expect(tiles()[0]?.dataset['state']).toBe('normal');
    expect(chip?.hidden).toBe(true);
    expect(chip?.textContent).toBe('');
  });

  it.each([
    [WARM_C, 'warm', 'Warm'],
    [HOT_C, 'hot', 'Hot'],
  ])('at %d °C the face is %s and says so', (tempC, state, word) => {
    host.replaceChildren();
    mount({ layout: 'single' }, FRAMES[0]?.g, feed({ cpu: { tempC } }));
    const chip = host.querySelector<HTMLElement>('.kh-stats__chip');
    expect(tiles()[0]?.dataset['state']).toBe(state);
    expect(chip?.hidden).toBe(false);
    expect(chip?.textContent).toBe(word);
  });

  it('takes the word back down again when the reading cools', () => {
    const r = mount({ layout: 'single' }, FRAMES[0]?.g, feed({ cpu: { tempC: HOT_C } }));
    r.monitoring?.(feed({ cpu: { tempC: 40 } }), {});
    expect(tiles()[0]?.dataset['state']).toBe('normal');
    expect(host.querySelector<HTMLElement>('.kh-stats__chip')?.hidden).toBe(true);
  });

  /*
   * Text wears text colours. The digits are inked from `--kh-stats-ink`, which
   * is the same in every palette and at every state, so a crossed threshold
   * cannot repaint the number the reader came for.
   */
  it('never colours the digits with the series colour', () => {
    mount({ layout: 'single', theme: 'amber' }, FRAMES[0]?.g, feed({ cpu: { tempC: HOT_C } }));
    expect(prop('--kh-stats-ink')).not.toBe('');
    expect(prop('--kh-stats-ink')).not.toBe(prop('--kh-stats-fg'));
  });
});

describe('the sparkline', () => {
  it('is absent until it is asked for', () => {
    mount({ layout: 'single', sparkline: false }, FRAMES[0]?.g, feed({ cpu: { tempC: 40 } }));
    expect(root()?.dataset['spark']).toBe('off');
    expect(host.querySelector('.kh-stats__spark')?.hasAttribute('hidden')).toBe(true);
  });

  it('draws the last minute once there are two seconds of it', () => {
    const r = mount(
      { layout: 'single', sparkline: true },
      FRAMES[0]?.g,
      feed({ cpu: { tempC: 40 } }),
    );
    expect(root()?.dataset['spark']).toBe('on');
    r.monitoring?.(feed({ cpu: { tempC: 41 } }), {});
    r.monitoring?.(feed({ cpu: { tempC: 44 } }), {});
    const spark = host.querySelector('.kh-stats__spark');
    expect(spark?.hasAttribute('hidden')).toBe(false);
    expect(host.querySelector('.kh-stats__spark-line')?.getAttribute('d')).toMatch(/^M/);
    // No axis, no gridlines, no labels — one line and its endpoint.
    expect(spark?.querySelectorAll('*')).toHaveLength(2);
  });
});

describe('the replica path', () => {
  /*
   * `src/app/config/replica.ts` mounts this very renderer on the config page
   * and drives `frame()` from its own 1 Hz timer, so a `dt` of a whole second
   * has to settle the glide in one step rather than leaving the ring stuck a
   * fraction of the way there.
   */
  it('is correct when frames arrive once a second', () => {
    const r = mount({ layout: 'dual' }, FRAMES[0]?.g, feed({ cpu: { tempC: 40 } }));
    r.monitoring?.(feed({ cpu: { tempC: 70 }, gpu: { tempC: 55 } }), {});
    r.frame?.(frameInfo(1, 1000));
    expect(values()).toEqual(['70', '55']);
  });

  it('says so, rather than showing dashes, when the feed has never arrived', () => {
    mount({ layout: 'dual' }, FRAMES[0]?.g, null);
    const waiting = host.querySelector<HTMLElement>('.kh-stats__waiting');
    expect(waiting?.hidden).toBe(false);
    expect(waiting?.textContent).toContain('CAM');
    expect(host.querySelector<HTMLElement>('.kh-stats__grid')?.hidden).toBe(true);
  });

  /**
   * Stats publishes no replica thumbnail, and that is the correct answer rather
   * than a gap: `setReplicaThumb` is for the module that knows which BLOB is on
   * the panel, and a face made of type and SVG has none. The remote renders it
   * by mounting this renderer, which is what the tests above exercise.
   */
  it('publishes no thumbnail, because a face is not a picture', () => {
    const r = mount({ layout: 'single' }, FRAMES[0]?.g, feed({ cpu: { tempC: 40 } }));
    run(r, 1000);
    expect(values()[0]).toBe('40');
  });
});

describe('reconfiguring in place', () => {
  it('rebuilds the meters when the face changes and keeps painting', () => {
    const r = mount({ layout: 'single' }, FRAMES[0]?.g, feed({ cpu: { tempC: 61 } }));
    run(r, 1000);
    expect(tiles()).toHaveLength(1);
    r.update({ ...STATS_DEFAULTS, layout: 'triple' }, { changed: ['layout'], origin: 'local' });
    expect(tiles()).toHaveLength(3);
    expect(root()?.dataset['layout']).toBe('triple');
    run(r, 1000);
    expect(values()[0]).toBe('61');
  });

  it('follows a metric slot to a different reading', () => {
    const sample = feed({ cpu: { tempC: 61 }, ram: { pct: 0.5 } });
    const r = mount({ layout: 'dual' }, FRAMES[0]?.g, sample);
    run(r, 1000);
    r.update(
      { ...STATS_DEFAULTS, layout: 'dual', metrics: ['ramPct', 'cpuTemp'] },
      { changed: ['metrics'], origin: 'local' },
    );
    r.monitoring?.(sample, {});
    run(r, 1000);
    expect(values()).toEqual(['50', '61']);
  });

  it('switches unit without moving the threshold', () => {
    const r = mount({ layout: 'single' }, FRAMES[0]?.g, feed({ cpu: { tempC: HOT_C } }));
    run(r, 1000);
    const celsius = values()[0];
    r.update(
      { ...STATS_DEFAULTS, layout: 'single', unit: 'f' },
      { changed: ['unit'], origin: 'local' },
    );
    run(r, 1000);
    expect(values()[0]).not.toBe(celsius);
    // Same silicon, same alarm.
    expect(tiles()[0]?.dataset['state']).toBe('hot');
  });
});
