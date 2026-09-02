import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EFFECT_CATALOG, EFFECT_LIST } from './catalog';
import { ConfigPanel } from './ConfigPanel';
import { EFFECT_DEFAULTS, validateEffect } from './schema';

/**
 * The Effects panel, in a document — the same three rules the Shape and Text
 * suites hold, plus the two shapes audit 9's M6 was about.
 *
 * Layout itself is not assertable in jsdom (no layout engine), so what is
 * asserted here is the STRUCTURE the layout depends on: the strip is one
 * scrollable radiogroup that owns its own row, the wells are a row of labelled
 * wells, and the arrow keys move the focus with the selection. The pixels are
 * checked by eye at 866×537 and 560×800.
 */

let host: HTMLDivElement;
let root: Root;
let last: unknown;

function draw(config: unknown = EFFECT_DEFAULTS): void {
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

describe('the Effects panel', () => {
  it('validates whatever storage hands it before rendering a control', () => {
    draw({ effect: 'not-an-effect', colors: 7 });
    const checked = host.querySelector('#effect-pick [aria-checked="true"]');
    expect(checked?.getAttribute('data-testid')).toBe(`effect-pick-${EFFECT_DEFAULTS.effect}`);
  });

  /** §2.3: effect · preset · colours · reacts-to-temp, in that order. */
  it('carries the strip’s four controls, in the strip’s order', () => {
    draw();
    const ids = ['effect-pick', 'effect-preset', 'effect-colours', 'effect-temp'];
    for (const id of ids) expect(host.querySelector(`#${id}-label`)).not.toBeNull();
    const positions = ids.map((id) => host.innerHTML.indexOf(`"${id}-label"`));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('puts everything else behind the one Advanced door', () => {
    draw();
    expect(host.querySelectorAll('[data-testid="effect-advanced"]')).toHaveLength(1);
    for (const id of ['effect-temp-source', 'effect-speed', 'effect-scale', 'effect-brightness']) {
      expect(host.querySelector(`#${id}`)).not.toBeNull();
    }
  });

  it('offers every registered effect and no other', () => {
    draw();
    const offered = [...host.querySelectorAll('#effect-pick [role="radio"]')].map(
      (el) => el.getAttribute('data-testid') ?? '',
    );
    expect(offered).toEqual(EFFECT_LIST.map((d) => `effect-pick-${d.id}`));
  });

  it('hands back a whole, valid config when a card is pressed', () => {
    draw();
    act(() => {
      host.querySelector<HTMLElement>('[data-testid="effect-pick-voronoi"]')?.click();
    });
    expect((last as { effect: string }).effect).toBe('voronoi');
    expect(validateEffect(last)).toEqual(last);
  });

  it('uses no native control but the colour wells', () => {
    draw();
    expect(host.querySelectorAll('select')).toHaveLength(0);
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(host.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(host.querySelectorAll('input[type="color"]')).toHaveLength(
      EFFECT_DEFAULTS.colors.length,
    );
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

  /**
   * The vocabulary spine, on the one surface most likely to leak it: these are
   * fragment programs, and the twelve of them are called **effects** wherever a
   * person can read the word.
   */
  it('says effect, and never the technical word for one', () => {
    draw();
    expect(host.textContent.toLowerCase()).not.toMatch(/shader|uniform|fragment|glsl|webgl/);
    expect(host.textContent).toContain('Effect');
  });

  // ── audit 9, M6 ──────────────────────────────────────────────────────────

  /**
   * M6b: the strip was clipped at the panel's right edge, with nothing to say
   * there were six more effects behind it.
   */
  it('makes the card strip one scroller that owns its row, with a measured fade', () => {
    draw();
    const strip = host.querySelector<HTMLElement>('#effect-pick');
    expect(strip?.className).toBe('kh-effect-cards');
    // Measured, not assumed: jsdom reports every box as zero, so the panel's own
    // measurement resolves to "nothing more either way" and says so.
    expect(strip?.dataset['more']).toBe('none');
  });

  /** M6a: four wells stacked in a column against the right margin. */
  it('lays the colours out as a row of labelled wells, each captioned under it', () => {
    draw();
    const wells = [...host.querySelectorAll('.kh-effect-well')];
    expect(wells).toHaveLength(EFFECT_DEFAULTS.colors.length);
    const slots = EFFECT_CATALOG[EFFECT_DEFAULTS.effect].slots;
    for (const [i, well] of wells.entries()) {
      const kids = [...well.children];
      // The swatch first, its caption second — a label under the control.
      expect(kids[0]?.getAttribute('type')).toBe('color');
      expect(kids[1]?.tagName).toBe('LABEL');
      expect(kids[1]?.textContent).toBe(slots[i]);
      expect(kids[1]?.getAttribute('for')).toBe(`effect-colour-${String(i)}`);
    }
  });

  /**
   * A roving tabindex has to rove. Before this, → changed the selection while
   * the focus ring stayed put, so the selected card could be off-screen with no
   * way to walk back to it.
   */
  it('moves the focus with the selection when an arrow key walks the strip', () => {
    draw();
    const first = host.querySelector<HTMLElement>(
      `[data-testid="effect-pick-${EFFECT_DEFAULTS.effect}"]`,
    );
    expect(first?.tabIndex).toBe(0);
    act(() => {
      first?.focus();
      first?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    const next = EFFECT_LIST[1]?.id ?? '';
    expect((last as { effect: string }).effect).toBe(next);

    // The panel is controlled, so the host re-renders it with the new config —
    // which is when the focus follows.
    draw(last);
    expect(document.activeElement?.getAttribute('data-testid')).toBe(`effect-pick-${next}`);
  });

  /** Every card is reachable by keyboard: one tab stop, then the arrows. */
  it('keeps exactly one tab stop in the strip', () => {
    draw();
    const stops = [...host.querySelectorAll<HTMLElement>('#effect-pick [role="radio"]')].filter(
      (el) => el.tabIndex === 0,
    );
    expect(stops).toHaveLength(1);
  });
});
