import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEVICE_PRESETS } from '../../platform/devicePresets';
import { DEFAULT_GEOMETRY_RENDER, deriveGeometry } from '../../platform/geometry';

import { createRenderer } from './display';
import { FONT_LINK_ATTR } from './fonts';
import { TEXT_DEFAULTS, TEXT_FACES, type TextConfig } from './schema';

import type { Geometry } from '../../platform/geometry';
import type { ModuleContext } from '../types';

/**
 * The renderer, in a document.
 *
 * jsdom lays nothing out — every `getBoundingClientRect()` is zero — which is
 * exactly the environment the renderer's `ctx.geometry()` fallback exists for,
 * and it is why the box under test is driven through the geometry rather than
 * through a fake layout. The `ResizeObserver` half is checked separately, with
 * a stub, because jsdom does not implement one.
 */

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

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  host.remove();
  for (const el of document.head.querySelectorAll(`link[${FONT_LINK_ATTR}]`)) el.remove();
});

function mount(cfg: Partial<TextConfig>, box = { w: PRESET.width, h: PRESET.height }) {
  const renderer = createRenderer();
  const g = geometryFor(box.w, box.h);
  void renderer.mount(host, contextFor(g), { ...TEXT_DEFAULTS, ...cfg });
  return renderer;
}

const line = (): HTMLElement | null => host.querySelector('.kh-text__line');
const rootEl = (): HTMLElement | null => host.querySelector('.kh-text');

describe('the text renderer', () => {
  it('builds one line inside one root and writes the words', () => {
    const r = mount({ text: 'Kraken' });
    expect(rootEl()).not.toBeNull();
    expect(line()?.textContent).toBe('Kraken');
    r.unmount();
    expect(host.children).toHaveLength(0);
  });

  it('sizes the type from the box, at three different boxes', () => {
    const sizes = [
      { w: PRESET.width, h: PRESET.height },
      { w: PRESET.width / 2, h: PRESET.height / 2 },
      { w: PRESET.width / 4, h: PRESET.height / 4 },
    ].map((box) => {
      const r = mount({}, box);
      const px = Number.parseFloat(line()?.style.fontSize ?? '0');
      r.unmount();
      return px;
    });

    // Strictly decreasing, and in the ratio of the boxes: the rule is a pure
    // function of the box and the same look lands on every panel.
    expect(sizes[0]).toBeGreaterThan(sizes[1] ?? 0);
    expect(sizes[1]).toBeGreaterThan(sizes[2] ?? 0);
    expect(sizes[0] ?? 0).toBeCloseTo((sizes[1] ?? 0) * 2, 0);
  });

  it('writes every config field onto the DOM it owns', () => {
    const r = mount({
      text: 'Hi',
      color: '#ff0000',
      align: 'right',
      weight: 800,
      letterSpacing: 0.2,
      uppercase: true,
      shadow: true,
    });
    const root = rootEl();
    expect(root?.style.color).toBe('rgb(255, 0, 0)');
    expect(root?.style.textAlign).toBe('right');
    expect(root?.classList.contains('kh-text--upper')).toBe(true);
    expect(root?.classList.contains('kh-text--shadow')).toBe(true);
    expect(line()?.style.fontWeight).toBe('800');
    expect(line()?.style.letterSpacing).toBe('0.2em');
    r.unmount();
  });

  it('fetches a stylesheet only for a curated face', () => {
    const system = mount({ font: 'system' });
    expect(document.head.querySelectorAll(`link[${FONT_LINK_ATTR}]`)).toHaveLength(0);
    expect(line()?.style.fontFamily).toContain('system-ui');
    system.unmount();

    const serif = mount({ font: 'serif' });
    expect(document.head.querySelectorAll(`link[${FONT_LINK_ATTR}]`)).toHaveLength(1);
    // …and the family is set with its fallback stack behind it, so the layer
    // renders readable text whether or not the stylesheet ever arrives.
    // (jsdom re-quotes the value, so this compares the families, not the CSS.)
    const family = line()?.style.fontFamily ?? '';
    expect(family).toContain('Playfair Display');
    expect(family.split(',').length).toBe(TEXT_FACES.serif.stack.split(',').length);
    serif.unmount();
  });

  it('re-lays out on update and on a geometry change', () => {
    const r = createRenderer();
    void r.mount(host, contextFor(geometryFor(PRESET.width, PRESET.height)), TEXT_DEFAULTS);
    const before = line()?.style.fontSize;

    r.update({ ...TEXT_DEFAULTS, size: TEXT_DEFAULTS.size * 2 }, { changed: [], origin: 'local' });
    expect(line()?.style.fontSize).not.toBe(before);

    // `geometry()` is the other entry point that must re-measure — forgetting
    // one is the classic bug where a resize appears to do nothing.
    const wider = line()?.style.fontSize;
    r.geometry?.(geometryFor(PRESET.width / 2, PRESET.height / 2));
    expect(line()?.style.fontSize).not.toBe(wider);
    r.unmount();
  });

  describe('with a ResizeObserver', () => {
    const observed: Element[] = [];
    let fire: (() => void) | null = null;
    let disconnected = 0;

    class FakeResizeObserver {
      constructor(cb: () => void) {
        fire = cb;
      }
      observe(el: Element): void {
        observed.push(el);
      }
      disconnect(): void {
        disconnected += 1;
      }
      unobserve(): void {
        /* not used */
      }
    }

    beforeEach(() => {
      observed.length = 0;
      fire = null;
      disconnected = 0;
      vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('observes the host it was given, and lets it go on unmount', () => {
      const r = mount({});
      expect(observed).toEqual([host]);
      expect(fire).not.toBeNull();
      r.unmount();
      expect(disconnected).toBe(1);
    });

    it('re-lays out when the host box changes', () => {
      const r = mount({});
      const before = line()?.style.fontSize;
      // The host now reports a real box; the observer is what turns that into a
      // re-layout without measuring on every frame.
      host.getBoundingClientRect = () => ({ width: 80, height: 24 }) as DOMRect;
      fire?.();
      expect(line()?.style.fontSize).not.toBe(before);
      r.unmount();
    });
  });
});

/**
 * The audit's **M9**: a text layer is placed by dragging it, and a drag aims at
 * the glyphs. So the box the compositor positions and the words the reader is
 * looking at have to share a centre, or "drop it in the middle" leaves the type
 * visibly off-middle and no amount of care with the transform can fix it.
 *
 * jsdom lays nothing out, so what is assertable here is the RULE rather than
 * the pixels: the root is a flex box that centres its cross axis, and its main
 * axis follows `align`. The pixels are measured on a real engine — see the
 * preview measurement in the changelog entry for this round.
 */
describe('the layer’s visual centre is its anchor', () => {
  /*
   * The stylesheet itself, parsed into the document. Vitest hands CSS imports
   * back as a stub, so `getComputedStyle` would otherwise be asserting the UA
   * defaults — which is how a centring rule can be deleted with every test
   * still green. Reading the shipped file means this fails if the rule goes.
   */
  let sheet: HTMLStyleElement | null = null;
  beforeEach(() => {
    sheet = document.createElement('style');
    sheet.textContent = readFileSync(resolve('src/modules/text/text.css'), 'utf8');
    document.head.append(sheet);
  });
  afterEach(() => {
    sheet?.remove();
    sheet = null;
  });

  it('centres the line vertically, whatever the box or the size', () => {
    for (const box of [
      { w: 240, h: 240 },
      { w: 640, h: 640 },
    ]) {
      host.replaceChildren();
      const r = mount({ text: 'Hello', size: 0.14 }, box);
      const cs = getComputedStyle(rootEl()!);
      expect(cs.display).toBe('flex');
      expect(cs.alignItems).toBe('center');
      // Half-leading is symmetric, so the line box's centre is the type's.
      expect(getComputedStyle(line()!).lineHeight).toBe('1.1');
      r.unmount();
    }
  });

  it.each([
    ['left', 'flex-start'],
    ['center', 'center'],
    ['right', 'flex-end'],
  ] as const)('places a %s-aligned line at %s on the main axis', (align, justify) => {
    host.replaceChildren();
    const r = mount({ text: 'Hello', align });
    // Both, on purpose: `justify-content` is what makes the flex item hug the
    // words (so the rendered line's centre IS the words' centre), and
    // `text-align` is what aligns the second and third lines of one that wrapped.
    expect(rootEl()?.style.justifyContent).toBe(justify);
    expect(rootEl()?.style.textAlign).toBe(align);
    r.unmount();
  });

  it('follows the alignment through an update', () => {
    const r = mount({ align: 'center' });
    r.update({ ...TEXT_DEFAULTS, align: 'right' }, { changed: ['align'], origin: 'local' });
    expect(rootEl()?.style.justifyContent).toBe('flex-end');
    r.unmount();
  });
});
