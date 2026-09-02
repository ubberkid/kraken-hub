import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEVICE_PRESETS } from '../../platform/devicePresets';
import { DEFAULT_GEOMETRY_RENDER, deriveGeometry } from '../../platform/geometry';

import { createRenderer } from './display';
import { SHAPE_DEFAULTS, SHAPE_KINDS, type ShapeConfig } from './schema';

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

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  host.remove();
});

function mount(cfg: Partial<ShapeConfig>) {
  const renderer = createRenderer();
  void renderer.mount(host, contextFor(geometryFor(PRESET.width, PRESET.height)), {
    ...SHAPE_DEFAULTS,
    ...cfg,
  });
  return renderer;
}

const svg = (): SVGSVGElement | null => host.querySelector('svg');

describe('the shape renderer', () => {
  it.each(SHAPE_KINDS)('mounts %s as one inline svg inside one root', (shape) => {
    const r = mount({ shape });
    expect(host.querySelector('.kh-shape')).not.toBeNull();
    expect(host.querySelectorAll('svg')).toHaveLength(1);
    // The HTML parser puts `<svg>` in the SVG namespace by itself, which is why
    // the renderer never has to name the namespace URI (invariant 4).
    expect(svg()?.namespaceURI).toContain('svg');
    r.unmount();
    expect(host.children).toHaveLength(0);
  });

  it.each([
    ['rect', 'rect'],
    ['circle', 'circle'],
    ['ring', 'circle'],
    ['line', 'line'],
  ] as const)('%s puts a <%s> on the panel', (shape, tag) => {
    const r = mount({ shape });
    expect(svg()?.querySelector(tag)).not.toBeNull();
    r.unmount();
  });

  it('repaints on a config change', () => {
    const r = mount({ shape: 'rect' });
    expect(svg()?.querySelector('rect')).not.toBeNull();
    r.update({ ...SHAPE_DEFAULTS, shape: 'line' }, { changed: ['shape'], origin: 'local' });
    expect(svg()?.querySelector('rect')).toBeNull();
    expect(svg()?.querySelector('line')).not.toBeNull();
    r.unmount();
  });

  /**
   * The repaint guard. A shape is static, so the overwhelmingly common case is
   * "asked to repaint, nothing changed" — and rewriting identical markup would
   * hand CAM's compressor a whole new subtree for no visible difference.
   */
  it('writes nothing when nothing changed', () => {
    const r = mount({});
    const before = svg();
    r.update(SHAPE_DEFAULTS, { changed: [], origin: 'local' });
    expect(svg()).toBe(before);
    r.unmount();
  });

  it('re-lays out when the reported geometry changes', () => {
    const r = mount({});
    const before = svg()?.getAttribute('viewBox');
    r.geometry?.(geometryFor(PRESET.width / 2, PRESET.height / 2));
    expect(svg()?.getAttribute('viewBox')).not.toBe(before);
    r.unmount();
  });

  it('is idempotent under reinit — the watchdog may call it repeatedly', () => {
    const r = mount({});
    const before = svg()?.outerHTML;
    r.reinit?.('manual');
    r.reinit?.('manual');
    expect(svg()?.outerHTML).toBe(before);
    r.unmount();
  });

  describe('with a ResizeObserver', () => {
    let fire: (() => void) | null = null;
    let disconnected = 0;

    class FakeResizeObserver {
      constructor(cb: () => void) {
        fire = cb;
      }
      observe(): void {
        /* the host is the only thing observed */
      }
      disconnect(): void {
        disconnected += 1;
      }
      unobserve(): void {
        /* not used */
      }
    }

    beforeEach(() => {
      fire = null;
      disconnected = 0;
      vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('repaints from the host box when it changes, and lets the host go', () => {
      const r = mount({});
      const before = svg()?.getAttribute('viewBox');
      host.getBoundingClientRect = () => ({ width: 120, height: 40 }) as DOMRect;
      fire?.();
      expect(svg()?.getAttribute('viewBox')).toBe('0 0 120.00 40.00');
      expect(svg()?.getAttribute('viewBox')).not.toBe(before);
      r.unmount();
      expect(disconnected).toBe(1);
    });
  });
});
