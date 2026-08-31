/**
 * STEP 3 (docs/modules.md §5) — the clock's imperative display renderer.
 *
 * Shape of the file, and why:
 *
 *  - **`build()` runs once per face change.** The analog dial's ring and its
 *    twelve ticks never move, so they are created once and then never touched
 *    again. A tick is three `setAttribute('transform', …)` calls — no layout, no
 *    reflow, and every untouched pixel of the face is *literally* unchanged,
 *    which is what CAM's frame compressor rewards.
 *  - **`layout()` is separate from `paint()`.** Layout writes sizes derived from
 *    `Geometry` and runs on mount, on `update()` and on `geometry()`. Paint
 *    writes values and runs per frame.
 *  - **`paint()` guards on `paintKey()`.** `frame()` fires up to 40 times a
 *    second; the clock changes once a second. 39 of those 40 calls cost one
 *    string compare and produce zero DOM mutations.
 *  - **Every non-frame entry point clears the guard.** `update()`, `geometry()`
 *    and `reinit()` all invalidate it — forgetting one is the classic bug where
 *    a config change appears to do nothing until the next second ticks over.
 *
 * There is no animation anywhere in here. Every visual state is a function of
 * the current wall-clock second, so the module is correct at `targetFps = 1`
 * (CAM's factory default, and the Kraken Z's hard ceiling) and identical at 40.
 */

import { clamp } from '../../lib/clamp';

import { CLOCK_DEFAULTS, CLOCK_PALETTES, type ClockConfig } from './schema';
import { DEG_PER_HOUR, formatDate, formatTime, handAngles, paintKey } from './time';

import type { Geometry } from '../../platform/geometry';
import type { RenderSettings } from '../../state/schema';
import type { DisplayRenderer, ModuleContext } from '../types';

import './clock.css';

/** The dial is drawn in a −50..50 box, so every length below is a percentage. */
const VIEW_HALF = 50;
const VIEW_BOX = `${String(-VIEW_HALF)} ${String(-VIEW_HALF)} ${String(VIEW_HALF * 2)} ${String(VIEW_HALF * 2)}`;

const TICK_COUNT = 12;
const TICK_OUTER = 46;
const TICK_INNER_MAJOR = 38;
const TICK_INNER_MINOR = 41;
const TICK_WIDTH_MAJOR = 3.2;
const TICK_WIDTH_MINOR = 1.6;
/** 12, 3, 6, 9 get the long tick — the only orientation cue a bezel-less dial has. */
const TICK_MAJOR_EVERY = 3;

const RING_RADIUS = 47.5;
const RING_WIDTH = 1.2;
const HUB_RADIUS = 2.4;

const HAND_HOUR_LEN = 27;
const HAND_MINUTE_LEN = 39;
const HAND_SECOND_LEN = 43;
const HAND_TAIL = 7;
const HAND_HOUR_WIDTH = 5;
const HAND_MINUTE_WIDTH = 3.4;
const HAND_SECOND_WIDTH = 1.4;
const HAND_CAP = 'round';
/** Enough precision for the hour hand's creep; short enough to keep the attribute stable. */
const DEG_DECIMALS = 3;

/**
 * Fraction of the panel's short edge the analog dial occupies, INSIDE the safe
 * area. `1` would put the ring exactly on the measured visible radius; 0.96
 * leaves a hair of margin for the H20 calibration being optimistic.
 */
const DIAL_FILL = 0.96;

/**
 * Digit sizing. `tabular-nums` advances at roughly 0.6 em per glyph, so the
 * font that exactly fills a box of width `W` with `n` characters is
 * `W / (n · 0.6)`. `FONT_CAP` stops a two-character string (`1:04` with the
 * colon) from producing a font taller than the box.
 */
const CHAR_ADVANCE_EM = 0.62;
const FONT_CAP = 0.46;
const DATE_SCALE = 0.26;
const MERIDIEM_SCALE = 0.3;
const ANALOG_DATE_SCALE = 0.11;

const HALF = 0.5;
const SQUARE_INSET_FALLBACK = 0.08;

/** The largest square that is genuinely visible, per panel shape. */
function safeSidePx(g: Geometry, render: RenderSettings): number {
  const short = Math.min(g.width, g.height);
  if (g.shape === 'circle') {
    // The inscribed square of the visible disc: nothing in it can be clipped,
    // whatever the real bezel radius turns out to be (H20).
    return short * clamp(render.safeRadiusPct, HALF, 1) * Math.SQRT1_2;
  }
  return short * (1 - 2 * clamp(render.safeAreaPct, 0, SQUARE_INSET_FALLBACK * 2));
}

/** The dial diameter: the visible disc itself on a circle, the safe box on a square. */
function dialPx(g: Geometry, render: RenderSettings): number {
  const short = Math.min(g.width, g.height);
  const usable =
    g.shape === 'circle'
      ? short * clamp(render.safeRadiusPct, HALF, 1)
      : short * (1 - 2 * clamp(render.safeAreaPct, 0, SQUARE_INSET_FALLBACK * 2));
  return Math.round(usable * DIAL_FILL);
}

interface DigitalNodes {
  kind: 'digital';
  time: HTMLElement;
  meridiem: HTMLElement;
  date: HTMLElement;
}

interface AnalogNodes {
  kind: 'analog';
  svg: SVGSVGElement;
  hour: SVGLineElement;
  minute: SVGLineElement;
  second: SVGLineElement;
  date: HTMLElement;
}

type FaceNodes = DigitalNodes | AnalogNodes;

function buildDigital(root: HTMLElement): DigitalNodes {
  const wrap = document.createElement('div');
  wrap.className = 'kh-clock__digital';
  const time = document.createElement('div');
  time.className = 'kh-clock__time';
  const meridiem = document.createElement('div');
  meridiem.className = 'kh-clock__meridiem';
  const date = document.createElement('div');
  date.className = 'kh-clock__date';
  wrap.append(time, meridiem, date);
  root.append(wrap);
  return { kind: 'digital', time, meridiem, date };
}

/**
 * The dial's static markup, built once as a string.
 *
 * `innerHTML` rather than `createElementNS`: the HTML parser puts `<svg>` in
 * the SVG namespace by itself, so this avoids naming the namespace URI (which
 * invariant 4's "no hardcoded origins" rule cannot tell from a real origin, and
 * rightly refuses to special-case). It also happens to be less code, and it
 * runs once per face change rather than per frame.
 */
function dialMarkup(): string {
  const ticks: string[] = [];
  for (let i = 0; i < TICK_COUNT; i += 1) {
    const major = i % TICK_MAJOR_EVERY === 0;
    ticks.push(
      `<line class="kh-clock__tick${major ? ' kh-clock__tick--major' : ''}" x1="0" y1="${String(-TICK_OUTER)}" x2="0" y2="${String(major ? -TICK_INNER_MAJOR : -TICK_INNER_MINOR)}" stroke-width="${String(major ? TICK_WIDTH_MAJOR : TICK_WIDTH_MINOR)}" stroke-linecap="${HAND_CAP}" transform="rotate(${String(i * DEG_PER_HOUR)})" />`,
    );
  }
  const hand = (cls: string, len: number, width: number): string =>
    `<line class="kh-clock__hand kh-clock__hand--${cls}" data-hand="${cls}" x1="0" y1="${String(HAND_TAIL)}" x2="0" y2="${String(-len)}" stroke-width="${String(width)}" stroke-linecap="${HAND_CAP}" transform="rotate(0)" />`;

  return [
    `<svg class="kh-clock__dial" viewBox="${VIEW_BOX}" aria-hidden="true">`,
    `<circle class="kh-clock__ring" cx="0" cy="0" r="${String(RING_RADIUS)}" fill="none" stroke-width="${String(RING_WIDTH)}" />`,
    ...ticks,
    hand('hour', HAND_HOUR_LEN, HAND_HOUR_WIDTH),
    hand('minute', HAND_MINUTE_LEN, HAND_MINUTE_WIDTH),
    hand('second', HAND_SECOND_LEN, HAND_SECOND_WIDTH),
    `<circle class="kh-clock__hub" cx="0" cy="0" r="${String(HUB_RADIUS)}" />`,
    '</svg>',
  ].join('');
}

function buildAnalog(root: HTMLElement): AnalogNodes | null {
  const wrap = document.createElement('div');
  wrap.className = 'kh-clock__analog';
  wrap.innerHTML = dialMarkup();

  const svg = wrap.querySelector('svg');
  const hour = wrap.querySelector<SVGLineElement>('[data-hand="hour"]');
  const minute = wrap.querySelector<SVGLineElement>('[data-hand="minute"]');
  const second = wrap.querySelector<SVGLineElement>('[data-hand="second"]');
  if (svg === null || hour === null || minute === null || second === null) return null;

  const date = document.createElement('div');
  date.className = 'kh-clock__date kh-clock__date--analog';
  wrap.append(date);
  root.append(wrap);
  return { kind: 'analog', svg, hour, minute, second, date };
}

export function createRenderer(): DisplayRenderer<ClockConfig> {
  let root: HTMLElement | null = null;
  let nodes: FaceNodes | null = null;
  let ctxRef: ModuleContext | null = null;
  let cfg: ClockConfig = CLOCK_DEFAULTS;
  let lastKey = '';

  const readRender = (): RenderSettings | null => ctxRef?.render() ?? null;

  const layout = (): void => {
    if (root === null || nodes === null || ctxRef === null) return;
    const g = ctxRef.geometry();
    const render = readRender();
    if (render === null) return;
    const side = safeSidePx(g, render);

    if (nodes.kind === 'digital') {
      const { time } = formatTime(new Date(), cfg);
      const chars = Math.max(time.length, 1);
      const px = Math.min(side / (chars * CHAR_ADVANCE_EM), side * FONT_CAP);
      nodes.time.style.fontSize = `${String(Math.round(px))}px`;
      nodes.meridiem.style.fontSize = `${String(Math.round(px * MERIDIEM_SCALE))}px`;
      nodes.date.style.fontSize = `${String(Math.round(px * DATE_SCALE))}px`;
    } else {
      const d = dialPx(g, render);
      nodes.svg.style.width = `${String(d)}px`;
      nodes.svg.style.height = `${String(d)}px`;
      nodes.date.style.fontSize = `${String(Math.round(d * ANALOG_DATE_SCALE))}px`;
    }
  };

  const paint = (now: Date): void => {
    if (nodes === null) return;
    const key = paintKey(now, cfg);
    if (key === lastKey) return;
    lastKey = key;

    const dateText = cfg.showDate ? formatDate(now) : '';

    if (nodes.kind === 'digital') {
      const { time, meridiem } = formatTime(now, cfg);
      // The digit COUNT only changes when the format does, so re-running layout
      // here is a config-change cost, not a per-second one.
      if (nodes.time.textContent !== time) nodes.time.textContent = time;
      nodes.meridiem.textContent = meridiem ?? '';
      nodes.meridiem.hidden = meridiem === null;
      nodes.date.textContent = dateText;
      nodes.date.hidden = dateText === '';
    } else {
      const a = handAngles(now, cfg.showSeconds);
      nodes.hour.setAttribute('transform', `rotate(${a.hour.toFixed(DEG_DECIMALS)})`);
      nodes.minute.setAttribute('transform', `rotate(${a.minute.toFixed(DEG_DECIMALS)})`);
      if (a.second === null) {
        nodes.second.setAttribute('visibility', 'hidden');
      } else {
        nodes.second.removeAttribute('visibility');
        nodes.second.setAttribute('transform', `rotate(${a.second.toFixed(DEG_DECIMALS)})`);
      }
      nodes.date.textContent = dateText;
      nodes.date.hidden = dateText === '';
    }
  };

  const build = (): void => {
    if (root === null) return;
    root.replaceChildren();
    // A failed query can only mean the markup above changed; falling back to
    // the digital face keeps a clock on the panel either way.
    nodes = (cfg.face === 'analog' ? buildAnalog(root) : null) ?? buildDigital(root);
    root.dataset['face'] = cfg.face;
    const palette = CLOCK_PALETTES[cfg.theme];
    root.style.setProperty('--kh-clock-fg', palette.fg);
    root.style.setProperty('--kh-clock-dim', palette.dim);
    lastKey = '';
  };

  return {
    mount(host: HTMLElement, ctx: ModuleContext, config: ClockConfig) {
      ctxRef = ctx;
      cfg = config;
      root = document.createElement('div');
      root.className = 'kh-clock';
      host.append(root);
      build();
      layout();
      paint(new Date());
    },

    update(config: ClockConfig) {
      const faceChanged = config.face !== cfg.face;
      cfg = config;
      if (faceChanged) build();
      else if (root !== null) {
        const palette = CLOCK_PALETTES[cfg.theme];
        root.style.setProperty('--kh-clock-fg', palette.fg);
        root.style.setProperty('--kh-clock-dim', palette.dim);
      }
      lastKey = '';
      layout();
      paint(new Date());
    },

    frame() {
      paint(new Date());
    },

    geometry() {
      lastKey = '';
      layout();
      paint(new Date());
    },

    reinit() {
      lastKey = '';
      paint(new Date());
    },

    unmount() {
      root?.remove();
      root = null;
      nodes = null;
      ctxRef = null;
      lastKey = '';
    },
  };
}
