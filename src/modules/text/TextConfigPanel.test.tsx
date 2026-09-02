import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEXT_DEFAULTS, TEXT_FONTS, validateText } from './schema';
import { ConfigPanel } from './TextConfigPanel';

/**
 * The panel, in a document.
 *
 * Two rules are being enforced here rather than described. First, the round-2
 * control vocabulary: `src/ui/` has no `Select` and no `Toggle`, so a native
 * `<select>` or a bare checkbox on this surface is a control from somebody
 * else's app. Second, the strip parity of design-editor-ux.md §2.3 — text ·
 * size · colour · font · More — because a panel and a selection strip that
 * offer different settings are two settings surfaces for one module.
 */

let host: HTMLDivElement;
let root: Root;
let last: unknown;

function draw(config: unknown = TEXT_DEFAULTS): void {
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

describe('the Text panel', () => {
  it('validates whatever storage hands it before rendering a control', () => {
    // Junk in, defaults on screen — never a crash and never an empty field.
    draw({ size: 'enormous', font: 'comic', color: 'chartreuse' });
    const body = host.querySelector<HTMLInputElement>('#text-body');
    expect(body?.value).toBe(TEXT_DEFAULTS.text);
  });

  it('carries the strip’s four controls, in the strip’s order', () => {
    draw();
    const ids = ['text-body', 'text-size', 'text-colour', 'text-font'];
    for (const id of ids) expect(host.querySelector(`#${id}`)).not.toBeNull();

    // …and in that order in the DOM, because the strip is a row and a row has one.
    const positions = ids.map((id) => host.innerHTML.indexOf(`"${id}"`));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  /**
   * The fifth control is the door, and there is exactly one of it. Everything
   * that is not on the strip is behind it — one level, for every module.
   */
  it('puts everything else behind the one Advanced door', () => {
    draw();
    expect(host.querySelectorAll('[data-testid="text-advanced"]')).toHaveLength(1);
    for (const id of ['text-weight', 'text-align', 'text-tracking', 'text-upper', 'text-shadow']) {
      expect(host.querySelector(`#${id}`)).not.toBeNull();
    }
  });

  it('offers every registered face and no other', () => {
    draw();
    const offered = [...host.querySelectorAll('#text-font [role="radio"]')].map(
      (el) => el.getAttribute('data-testid') ?? '',
    );
    expect(offered).toEqual(TEXT_FONTS.map((f) => `text-font-${f}`));
  });

  it('hands back a whole, valid config when a control is used', () => {
    draw();
    act(() => {
      host.querySelector<HTMLElement>('[data-testid="text-font-serif"]')?.click();
    });
    expect(last).toEqual({ ...TEXT_DEFAULTS, font: 'serif' });
    // The host re-validates on the way in; the panel must not hand it garbage.
    expect(validateText(last)).toEqual(last);
  });

  /**
   * Round 2 deleted every native picker from this surface. The colour well is
   * the one deliberate exception and it is `type="color"` — a colour is not an
   * enumeration and cannot be a segmented row.
   */
  it('uses no native picker but the colour well', () => {
    draw();
    expect(host.querySelectorAll('select')).toHaveLength(0);
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(host.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(host.querySelectorAll('input[type="color"]')).toHaveLength(1);
  });

  it('names every control it renders', () => {
    draw();
    // A control nobody can read the name of is a control an assistive
    // technology cannot offer, and this panel is the ONLY place a cause can be
    // read at all — the LCD has no input and no scrollbar.
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
