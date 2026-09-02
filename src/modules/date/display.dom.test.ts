import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEVICE_PRESETS } from '../../platform/devicePresets';
import { DEFAULT_GEOMETRY_RENDER, deriveGeometry } from '../../platform/geometry';

import { createRenderer, fontPxFor, shrinkToFit } from './display';
import { DATE_DEFAULTS, type DateConfig } from './schema';

import type { FrameInfo } from '../../platform/fpsGovernor';
import type { Geometry } from '../../platform/geometry';
import type { ModuleContext } from '../types';

const PRESET = DEVICE_PRESETS.elite;

function geometryFor(width: number, height: number): Geometry {
  return deriveGeometry(
    { width, height, shape: 'square', targetFps: PRESET.targetFps, dpr: 1, source: 'nzxt' },
    { fallbackTargetFps: PRESET.targetFps },
  );
}

function contextFor(g: Geometry): ModuleContext {
  return {
    geometry: () => g,
    frameClock: { subscribe: () => () => undefined } as unknown as ModuleContext['frameClock'],
    monitoring: { subscribe: () => () => undefined } as unknown as ModuleContext['monitoring'],
    render: () => DEFAULT_GEOMETRY_RENDER as unknown as ReturnType<ModuleContext['render']>,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    signal: new AbortController().signal,
  };
}

/** A second of frames at the panel's target rate. */
const TICKS = 40;

const FRAME: FrameInfo = { t: 1000, dt: 25, frame: 1, targetFps: 40 } as FrameInfo;

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  host.remove();
});

function mount(cfg: Partial<DateConfig> = {}) {
  const renderer = createRenderer();
  void renderer.mount(host, contextFor(geometryFor(PRESET.width, PRESET.height)), {
    ...DATE_DEFAULTS,
    ...cfg,
  });
  return renderer;
}

const line = (): HTMLElement | null => host.querySelector('.kh-date__line');

/**
 * The size rule, at three host sizes and with no device literal in sight — the
 * shape `text/size.test.ts` set.
 */
describe('fontPxFor', () => {
  it('is a share of the box WIDTH, capped by its height', () => {
    expect(fontPxFor(0.2, { w: 640, h: 640 })).toBeCloseTo(128, 10);
    expect(fontPxFor(0.2, { w: 240, h: 240 })).toBeCloseTo(48, 10);
    // A short banner: the height cap wins.
    expect(fontPxFor(0.5, { w: 400, h: 100 })).toBeCloseTo(82, 10);
  });

  it('is total: an unlaid-out box yields the floor, not NaN', () => {
    for (const box of [
      { w: 0, h: 0 },
      { w: Number.NaN, h: 10 },
    ]) {
      const px = fontPxFor(0.2, box);
      expect(Number.isFinite(px)).toBe(true);
      expect(px).toBeGreaterThan(0);
    }
  });
});

/**
 * The corrective pass, as arithmetic (audit 10, F7).
 *
 * The bug it fixes is not visible in a jsdom mount, because jsdom has no layout
 * and every width is 0 — so the RULE is asserted here, on the numbers measured
 * off a real 640 Elite, and the mount below only has to prove the pass is wired
 * to the line at all.
 */
describe('shrinkToFit', () => {
  it('is the exact size at which the glyphs fill the room', () => {
    // 508 px of ink at 102 px of type, with 398 px of room inside the layer's
    // safe inset: the measured "Wed, Sep 2" on a 640 round Elite.
    const px = shrinkToFit(102, 508, 398);
    expect(px).toBe(79);
    // And it is exact, not merely smaller: re-measuring at the new size fits.
    expect((508 * px) / 102).toBeLessThanOrEqual(398);
  });

  it('leaves type that already fits exactly alone', () => {
    expect(shrinkToFit(38, 192, 202)).toBe(38);
    expect(shrinkToFit(38, 202, 202)).toBe(38);
  });

  it('is total: an unmeasurable line is not shrunk to nothing', () => {
    expect(shrinkToFit(48, 0, 400)).toBe(48);
    expect(shrinkToFit(48, 400, 0)).toBe(48);
    expect(shrinkToFit(48, Number.NaN, 400)).toBe(48);
  });

  it('never goes under the floor, however long the line', () => {
    expect(shrinkToFit(48, 100_000, 10)).toBeGreaterThan(0);
  });
});

describe('the date renderer', () => {
  it('mounts one line inside one root, and takes it away again', () => {
    const r = mount();
    expect(host.querySelector('.kh-date')).not.toBeNull();
    expect(host.querySelectorAll('.kh-date__line')).toHaveLength(1);
    expect((line()?.textContent ?? '').length).toBeGreaterThan(0);
    r.unmount();
    expect(host.children).toHaveLength(0);
  });

  it('writes the same line on a frame tick within the same minute', () => {
    const r = mount();
    const before = host.innerHTML;
    // The tick guard: `frame()` up to forty times a second, one integer compare
    // each, no DOM write and no `Intl` call.
    const tick = r.frame?.bind(r);
    expect(tick).toBeDefined();
    for (let i = 0; i < TICKS; i += 1) tick?.(FRAME);
    expect(host.innerHTML).toBe(before);
    r.unmount();
  });

  it('rewrites the line when the format changes', () => {
    const r = mount({ format: 'iso' });
    const iso = line()?.textContent ?? '';
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    r.update({ ...DATE_DEFAULTS, format: 'weekday' }, { changed: ['format'], origin: 'local' });
    expect(line()?.textContent).not.toBe(iso);
    r.unmount();
  });

  it('carries colour, weight and case as style rather than as text', () => {
    const r = mount({ color: '#ffb648', weight: 800, uppercase: true });
    const root = host.querySelector<HTMLElement>('.kh-date');
    expect(root?.classList.contains('kh-date--upper')).toBe(true);
    expect(root?.style.color).not.toBe('');
    expect(line()?.style.fontWeight).toBe('800');
    // The TEXT is the date, unchanged: uppercasing is CSS, so a screen reader
    // still gets the word the locale wrote.
    expect(line()?.textContent).not.toBe('');
    r.unmount();
  });

  it('is idempotent under reinit — the watchdog may call it repeatedly', () => {
    const r = mount({ format: 'iso' });
    const before = host.innerHTML;
    r.reinit?.('manual');
    r.reinit?.('manual');
    expect(host.innerHTML).toBe(before);
    r.unmount();
  });
});
