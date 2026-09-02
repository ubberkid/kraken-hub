import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEVICE_PRESETS } from '../../platform/devicePresets';
import { DEFAULT_GEOMETRY_RENDER, deriveGeometry } from '../../platform/geometry';

import { createRenderer } from './display';
import { ICON_DEFAULTS, type IconConfig } from './schema';

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

function mount(cfg: Partial<IconConfig> = {}) {
  const renderer = createRenderer();
  void renderer.mount(host, contextFor(geometryFor(PRESET.width, PRESET.height)), {
    ...ICON_DEFAULTS,
    ...cfg,
  });
  return renderer;
}

describe('the icon renderer', () => {
  it('mounts one inline svg inside one root, and takes it away again', () => {
    const r = mount();
    expect(host.querySelector('.kh-icon')).not.toBeNull();
    expect(host.querySelectorAll('svg')).toHaveLength(1);
    // The HTML parser puts `<svg>` in the SVG namespace by itself, which is why
    // the renderer never has to name the namespace URI (invariant 4).
    expect(host.querySelector('svg')?.namespaceURI).toContain('svg');
    r.unmount();
    expect(host.children).toHaveLength(0);
  });

  it('centres the glyph: the root is a grid that places its one child centrally', () => {
    const r = mount();
    const root = host.querySelector('.kh-icon');
    expect(root).not.toBeNull();
    // The class is the contract; `icon.css` is what implements it, and the
    // stylesheet is not loaded in jsdom. What CAN be asserted here is that the
    // renderer produced exactly one centred child of that root rather than
    // positioning the glyph itself in pixels.
    expect(root?.children).toHaveLength(1);
    expect(root?.firstElementChild?.tagName.toLowerCase()).toBe('svg');
    r.unmount();
  });

  it('repaints when the glyph changes and stands still when it does not', () => {
    const r = mount({ icon: 'bolt' });
    const before = host.innerHTML;

    r.update({ ...ICON_DEFAULTS, icon: 'bolt' }, { changed: [], origin: 'local' });
    expect(host.innerHTML).toBe(before);

    r.update({ ...ICON_DEFAULTS, icon: 'flame' }, { changed: ['icon'], origin: 'local' });
    expect(host.innerHTML).not.toBe(before);
    r.unmount();
  });

  it('carries the glow flag on the root rather than in the markup', () => {
    const r = mount({ glow: true });
    expect(host.querySelector('.kh-icon')?.classList.contains('kh-icon--glow')).toBe(true);
    r.update({ ...ICON_DEFAULTS, glow: false }, { changed: ['glow'], origin: 'local' });
    expect(host.querySelector('.kh-icon')?.classList.contains('kh-icon--glow')).toBe(false);
    r.unmount();
  });

  it('is idempotent under reinit — the watchdog may call it repeatedly', () => {
    const r = mount();
    const before = host.innerHTML;
    r.reinit?.('manual');
    r.reinit?.('manual');
    expect(host.innerHTML).toBe(before);
    r.unmount();
  });

  it('re-fits when the shell reports a new box', () => {
    const r = mount();
    const before = host.innerHTML;
    r.geometry?.(geometryFor(240, 240));
    expect(host.innerHTML).not.toBe(before);
    r.unmount();
  });
});
