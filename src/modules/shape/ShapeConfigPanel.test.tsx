import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NO_PAINT, SHAPE_DEFAULTS, SHAPE_KINDS, validateShape } from './schema';
import { ConfigPanel } from './ShapeConfigPanel';

/**
 * The panel, in a document — same two rules as the Text panel's suite: the
 * round-2 control vocabulary (no native picker on this surface), and the strip
 * parity of design-editor-ux.md §2.3, which for a Shape is **shape · fill ·
 * stroke · More**.
 */

let host: HTMLDivElement;
let root: Root;
let last: unknown;

function draw(config: unknown = SHAPE_DEFAULTS): void {
  act(() => {
    root.render(
      <ConfigPanel
        config={config}
        onChange={(next) => {
          last = next;
        }}
      />,
    );
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  last = undefined;
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

describe('the Shape panel', () => {
  it('validates whatever storage hands it before rendering a control', () => {
    draw({ shape: 'triangle', fill: 'chartreuse' });
    const checked = host.querySelector('#shape-kind [aria-checked="true"]');
    expect(checked?.getAttribute('data-testid')).toBe(`shape-kind-${SHAPE_DEFAULTS.shape}`);
  });

  it('carries the strip’s three controls, in the strip’s order', () => {
    draw();
    const ids = ['shape-kind', 'shape-fill', 'shape-stroke'];
    for (const id of ids) expect(host.querySelector(`#${id}`)).not.toBeNull();
    const positions = ids.map((id) => host.innerHTML.indexOf(`"${id}"`));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('puts everything else behind the one Advanced door', () => {
    draw();
    expect(host.querySelectorAll('[data-testid="shape-advanced"]')).toHaveLength(1);
    for (const id of ['shape-fill-opacity', 'shape-stroke-width', 'shape-radius', 'shape-dash']) {
      expect(host.querySelector(`#${id}`)).not.toBeNull();
    }
  });

  it('offers every registered primitive and no other', () => {
    draw();
    const offered = [...host.querySelectorAll('#shape-kind [role="radio"]')].map(
      (el) => el.getAttribute('data-testid') ?? '',
    );
    expect(offered).toEqual(SHAPE_KINDS.map((s) => `shape-kind-${s}`));
  });

  /**
   * "No fill" is a value of the fill setting, not a second setting: the strip
   * has room for one control per paint, so the choice and the colour live in
   * one field and the well simply is not there when there is nothing to pick.
   */
  it('folds "none" into the paint control rather than adding one', () => {
    draw({ ...SHAPE_DEFAULTS, fill: NO_PAINT });
    expect(host.querySelector('#shape-fill-hex')).toBeNull();
    draw({ ...SHAPE_DEFAULTS, fill: '#123456' });
    expect(host.querySelector<HTMLInputElement>('#shape-fill-hex')?.value).toBe('#123456');
  });

  it('hands back a whole, valid config when a control is used', () => {
    draw();
    act(() => {
      host.querySelector<HTMLElement>('[data-testid="shape-kind-ring"]')?.click();
    });
    expect(last).toEqual({ ...SHAPE_DEFAULTS, shape: 'ring' });
    expect(validateShape(last)).toEqual(last);
  });

  it('turns a paint off without inventing a colour value for "none"', () => {
    draw();
    act(() => {
      host.querySelector<HTMLElement>('[data-testid="shape-fill-none"]')?.click();
    });
    expect(last).toEqual({ ...SHAPE_DEFAULTS, fill: NO_PAINT });
  });

  /** Corners are a rectangle setting, and the control says so instead of lying. */
  it('disables the corner slider for a shape that has no corners', () => {
    draw({ ...SHAPE_DEFAULTS, shape: 'circle' });
    expect(host.querySelector<HTMLInputElement>('#shape-radius')?.disabled).toBe(true);
    draw({ ...SHAPE_DEFAULTS, shape: 'rect' });
    expect(host.querySelector<HTMLInputElement>('#shape-radius')?.disabled).toBe(false);
  });

  it('uses no native picker but the colour wells', () => {
    draw();
    expect(host.querySelectorAll('select')).toHaveLength(0);
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(host.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    // One per paint that is a colour; the default has a fill and no stroke.
    expect(host.querySelectorAll('input[type="color"]')).toHaveLength(1);
  });

  it('names every control it renders', () => {
    draw();
    for (const input of host.querySelectorAll('input')) {
      const named =
        input.getAttribute('aria-label') !== null ||
        host.querySelector(`label[for="${input.id}"]`) !== null;
      expect(named).toBe(true);
    }
    for (const group of host.querySelectorAll('[role="radiogroup"]')) {
      const by = group.getAttribute('aria-labelledby');
      expect(by).not.toBeNull();
      expect(host.querySelector(`#${String(by)}`)).not.toBeNull();
    }
  });
});
