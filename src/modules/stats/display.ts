/**
 * The stats module's display renderer.
 *
 * Three properties are deliberate and each one is a rule from
 * `docs/modules.md`:
 *
 *  - **It never subscribes to the frame clock.** `needsFrameLoop` is false and
 *    `frame()` is not implemented. The data source is CAM's 1 Hz monitoring
 *    feed, so painting faster than 1 Hz cannot produce a different pixel —
 *    whatever the panel's `targetFps` happens to be.
 *  - **Low-entropy rendering.** Flat fills, one flat arc per dial, no gradient,
 *    no blur, no shadow, no transition. The Elite re-compresses every captured
 *    frame and charges for change; a dial that redraws one arc segment per
 *    second costs almost nothing, and a glowing gauge costs the frame rate.
 *  - **Every reading may be `undefined`.** `format.ts` turns that into `--` and
 *    a `null` dial fraction, and a `null` fraction draws the TRACK ONLY. An
 *    empty arc would read as "0 °C", which is worse than saying nothing.
 *
 * When no sample has arrived for `WAITING_AFTER_MS`, the module says so
 * explicitly rather than showing a wall of dashes: a stale feed is a different
 * problem from a missing sensor, and the user can act on it (CAM not running,
 * the integration reloaded, the watchdog mid-recovery).
 */

import { clamp } from '../../lib/clamp';

import { PLACEHOLDER, secondaryFor, statsPaintKey, tilesFor, type StatsTile } from './format';
import { STATS_PALETTES, type StatsConfig } from './schema';

import type { Geometry } from '../../platform/geometry';
import type { NormalizedMonitoring } from '../../platform/monitoring';
import type { RenderSettings } from '../../state/schema';
import type { DisplayRenderer, ModuleContext } from '../types';

import './stats.css';

/**
 * No sample for this long and the module says "waiting for CAM data".
 *
 * Five seconds, not the platform's 8 s staleness threshold: the watchdog's job
 * is to decide when to RECOVER, and being conservative there is right. Telling
 * the user what is going on is cheap and should happen sooner.
 */
export const WAITING_AFTER_MS = 5000;
const TICK_MS = 1000;

/** The arc is drawn with `pathLength="100"`, so the dash array is a percentage. */
const PATH_LENGTH = 100;
const DIAL_RADIUS = 40;
const DIAL_STROKE = 9;
const DIAL_VIEW = 50;
const DIAL_VIEW_BOX = `${String(-DIAL_VIEW)} ${String(-DIAL_VIEW)} ${String(DIAL_VIEW * 2)} ${String(DIAL_VIEW * 2)}`;
/** Starts the arc at twelve o'clock instead of three. */
const DIAL_START_DEG = -90;
const ARC_DECIMALS = 2;

const HALF = 0.5;
const SQUARE_INSET_MAX = 0.16;

/** Fraction of the safe box each layout's tile column may use. */
const SINGLE_DIAL_FILL = 0.86;
const DUAL_DIAL_FILL = 0.46;
const GRID_COLUMNS = 2;
const GRID_ROWS = 3;

/**
 * How much bigger the dial box may be than the inscribed square, and where that
 * growth starts and finishes.
 *
 * `safeSidePx()` returns the largest square inside the safe area, which is the
 * right bound for the text-first grid layout — text needs corners. A **dial** is
 * a circle, and a circle does not need the corners of that square: on a round
 * panel it may use the whole visible disc, which is `√2` wider than the square
 * it contains. The 0.86 / 0.46 fills were tuned on small panels, where the
 * difference costs a few pixels; on the largest panel it leaves the dials as an
 * island in the middle of the glass with a third of the diameter unused.
 *
 * So the box grows toward the disc as the panel gets bigger — smoothly, and
 * nowhere near the full `√2`, because the labels and the sub-readouts sit at the
 * box's top and bottom edges and those DO have to stay inside the circle. The
 * two thresholds are a ramp, not a device table: small panels are left exactly
 * as they were, and the largest gets the whole growth.
 */
const BOX_GROWTH_MAX = 1.28;
const GROWTH_START_PX = 336;
const GROWTH_FULL_PX = 600;

/** 0 on a small panel, 1 on the largest one, linear in between. */
function boxGrowth(shortSidePx: number): number {
  const span = GROWTH_FULL_PX - GROWTH_START_PX;
  return clamp((shortSidePx - GROWTH_START_PX) / span, 0, 1);
}

/**
 * The dial layouts get the grown box; the grid layout keeps the inscribed
 * square, because six tiles of text want the corners the dials do not.
 */
export function statsBoxPx(g: Geometry, render: RenderSettings, layout: string): number {
  const side = safeSidePx(g, render);
  if (layout === 'grid') return side;
  const scale = 1 + (BOX_GROWTH_MAX - 1) * boxGrowth(Math.min(g.width, g.height));
  // Never wider than the panel itself: a box that overflows would push the
  // labels off the glass, whatever the safe-area maths said.
  return Math.min(side * scale, Math.min(g.width, g.height));
}

const VALUE_SCALE_SINGLE = 0.3;
const VALUE_SCALE_DUAL = 0.16;
const VALUE_SCALE_GRID = 0.11;
const LABEL_RATIO = 0.34;
const UNIT_RATIO = 0.42;
const SUB_RATIO = 0.36;

/** The largest square that is genuinely visible, per panel shape. */
function safeSidePx(g: Geometry, render: RenderSettings): number {
  const short = Math.min(g.width, g.height);
  if (g.shape === 'circle') {
    return short * clamp(render.safeRadiusPct, HALF, 1) * Math.SQRT1_2;
  }
  return short * (1 - 2 * clamp(render.safeAreaPct, 0, SQUARE_INSET_MAX));
}

interface TileNodes {
  root: HTMLElement;
  arc: SVGCircleElement;
  value: HTMLElement;
  unit: HTMLElement;
  label: HTMLElement;
  sub: HTMLElement;
}

/**
 * The dial's static markup.
 *
 * `innerHTML` rather than `createElementNS`, for the same reason as the clock's
 * dial: the HTML parser puts `<svg>` in the SVG namespace by itself, so nothing
 * here has to name the namespace URI — which invariant 4's "no hardcoded
 * origins" rule cannot distinguish from a real origin, and rightly refuses to
 * special-case.
 *
 * `pathLength="100"` is the trick that makes the arc a percentage: the dash
 * array is then literally "how much of the ring is filled", with no
 * circumference arithmetic and nothing to get wrong when the radius changes.
 */
const DIAL_MARKUP = [
  `<svg class="kh-stats__dial" viewBox="${DIAL_VIEW_BOX}" aria-hidden="true">`,
  `<circle class="kh-stats__track" cx="0" cy="0" r="${String(DIAL_RADIUS)}" fill="none" stroke-width="${String(DIAL_STROKE)}" />`,
  `<circle class="kh-stats__arc" data-arc cx="0" cy="0" r="${String(DIAL_RADIUS)}" fill="none" stroke-width="${String(DIAL_STROKE)}" stroke-linecap="butt" pathLength="${String(PATH_LENGTH)}" stroke-dasharray="0 ${String(PATH_LENGTH)}" transform="rotate(${String(DIAL_START_DEG)})" />`,
  '</svg>',
].join('');

function buildTileNode(): TileNodes | null {
  const root = document.createElement('div');
  root.className = 'kh-stats__tile';
  root.innerHTML = DIAL_MARKUP;
  const arc = root.querySelector<SVGCircleElement>('[data-arc]');
  if (arc === null) return null;

  const readout = document.createElement('div');
  readout.className = 'kh-stats__readout';
  const value = document.createElement('span');
  value.className = 'kh-stats__value';
  const unit = document.createElement('span');
  unit.className = 'kh-stats__unit';
  readout.append(value, unit);

  const label = document.createElement('div');
  label.className = 'kh-stats__label';
  const sub = document.createElement('div');
  sub.className = 'kh-stats__sub';

  root.append(readout, label, sub);
  return { root, arc, value, unit, label, sub };
}

export function createRenderer(): DisplayRenderer<StatsConfig> {
  let root: HTMLElement | null = null;
  let grid: HTMLElement | null = null;
  let waitingNode: HTMLElement | null = null;
  let ctxRef: ModuleContext | null = null;
  let cfg: StatsConfig | null = null;

  let tiles: TileNodes[] = [];
  let latest: NormalizedMonitoring | null = null;
  let lastSampleAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastKey = '';

  const isWaiting = (): boolean =>
    lastSampleAt === 0 || Date.now() - lastSampleAt > WAITING_AFTER_MS;

  const layout = (): void => {
    if (root === null || ctxRef === null || cfg === null) return;
    const g = ctxRef.geometry();
    // The dial layouts get a box grown toward the visible disc; `grid` keeps
    // the inscribed square. Every size below is a fraction of that one number,
    // so the whole module scales with the panel and nothing else changes.
    const side = statsBoxPx(g, ctxRef.render(), cfg.layout);

    const dial = cfg.layout === 'single' ? side * SINGLE_DIAL_FILL : side * DUAL_DIAL_FILL;
    const valueScale =
      cfg.layout === 'single'
        ? VALUE_SCALE_SINGLE
        : cfg.layout === 'dual'
          ? VALUE_SCALE_DUAL
          : VALUE_SCALE_GRID;
    const valuePx = Math.round(side * valueScale);

    root.style.setProperty('--kh-stats-box', `${String(Math.round(side))}px`);
    root.style.setProperty('--kh-stats-dial', `${String(Math.round(dial))}px`);
    root.style.setProperty('--kh-stats-value', `${String(valuePx)}px`);
    root.style.setProperty('--kh-stats-unit', `${String(Math.round(valuePx * UNIT_RATIO))}px`);
    root.style.setProperty('--kh-stats-label', `${String(Math.round(valuePx * LABEL_RATIO))}px`);
    root.style.setProperty('--kh-stats-sub', `${String(Math.round(valuePx * SUB_RATIO))}px`);
    root.style.setProperty('--kh-stats-cols', String(cfg.layout === 'grid' ? GRID_COLUMNS : 1));
    root.style.setProperty('--kh-stats-rows', String(cfg.layout === 'grid' ? GRID_ROWS : 1));
  };

  const build = (): void => {
    if (grid === null || cfg === null) return;
    const wanted = tilesFor(cfg, latest).length;
    grid.replaceChildren();
    tiles = [];
    for (let i = 0; i < wanted; i += 1) {
      const node = buildTileNode();
      if (node === null) continue;
      tiles.push(node);
      grid.append(node.root);
    }
    if (root !== null) {
      root.dataset['layout'] = cfg.layout;
      const palette = STATS_PALETTES[cfg.theme];
      root.style.setProperty('--kh-stats-fg', palette.fg);
      root.style.setProperty('--kh-stats-dim', palette.dim);
      root.style.setProperty('--kh-stats-track', palette.track);
      root.dataset['labels'] = cfg.showLabels ? 'on' : 'off';
    }
    lastKey = '';
  };

  const paint = (): void => {
    if (cfg === null || waitingNode === null || grid === null) return;
    const waiting = isWaiting();
    const data = tilesFor(cfg, waiting ? null : latest);
    const key = statsPaintKey(data, waiting);
    if (key === lastKey) return;
    lastKey = key;

    waitingNode.hidden = !waiting;
    grid.hidden = waiting;
    if (waiting) return;

    data.forEach((tile: StatsTile, i: number) => {
      const node = tiles[i];
      if (node === undefined || cfg === null) return;
      node.value.textContent = tile.value;
      // A missing reading has no unit either: `-- °C` implies we know it is a
      // temperature reading that happens to be absent, which is a stronger claim
      // than we can make when the sensor is simply not there.
      node.unit.textContent = tile.value === PLACEHOLDER ? '' : tile.unit;
      node.label.textContent = cfg.layout === 'grid' ? tile.longLabel : tile.label;

      const secondary = secondaryFor(tile, cfg, latest);
      node.sub.textContent =
        secondary === null
          ? ''
          : `${secondary.label} ${secondary.value}${secondary.value === PLACEHOLDER ? '' : secondary.unit}`;
      node.sub.hidden = secondary === null;

      const pct = tile.fraction === null ? 0 : tile.fraction * PATH_LENGTH;
      node.arc.setAttribute(
        'stroke-dasharray',
        `${pct.toFixed(ARC_DECIMALS)} ${String(PATH_LENGTH)}`,
      );
      // `null` draws the track alone. An empty arc would read as zero.
      node.arc.setAttribute('visibility', tile.fraction === null ? 'hidden' : 'visible');
    });
  };

  return {
    mount(host: HTMLElement, ctx: ModuleContext, config: StatsConfig) {
      ctxRef = ctx;
      cfg = config;

      root = document.createElement('div');
      root.className = 'kh-stats';

      grid = document.createElement('div');
      grid.className = 'kh-stats__grid';

      waitingNode = document.createElement('div');
      waitingNode.className = 'kh-stats__waiting';
      waitingNode.textContent = 'Waiting for CAM data…';
      waitingNode.hidden = true;

      root.append(grid, waitingNode);
      host.append(root);

      // A sample may already be in hand — `ModuleHost` subscribes us AFTER
      // mount, so without this the first second on screen is a false "waiting".
      const already = ctx.monitoring.latest();
      if (already !== null) {
        latest = already.norm;
        lastSampleAt = ctx.monitoring.lastUpdateAt();
      }

      build();
      layout();
      paint();

      // The only timer in the module: it exists so the feed going AWAY is
      // noticed. Everything else is driven by `monitoring()`.
      timer = setInterval(paint, TICK_MS);
    },

    update(config: StatsConfig) {
      const rebuild = cfg?.layout !== config.layout || cfg.primary !== config.primary;
      cfg = config;
      if (rebuild) build();
      else if (root !== null) {
        const palette = STATS_PALETTES[cfg.theme];
        root.style.setProperty('--kh-stats-fg', palette.fg);
        root.style.setProperty('--kh-stats-dim', palette.dim);
        root.style.setProperty('--kh-stats-track', palette.track);
        root.dataset['labels'] = cfg.showLabels ? 'on' : 'off';
      }
      lastKey = '';
      layout();
      paint();
    },

    monitoring(norm: NormalizedMonitoring) {
      latest = norm;
      lastSampleAt = Date.now();
      paint();
    },

    geometry() {
      layout();
    },

    reinit() {
      lastKey = '';
      paint();
    },

    unmount() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      root?.remove();
      root = null;
      grid = null;
      waitingNode = null;
      ctxRef = null;
      cfg = null;
      tiles = [];
      latest = null;
      lastSampleAt = 0;
      lastKey = '';
    },
  };
}
